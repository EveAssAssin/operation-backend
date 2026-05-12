// services/chiFinanceLensSync.js
// 路奇天格鏡片帳單同步（chi-finance-system）
//
// 來源 API：
//   GET https://chi-finance-system.onrender.com/api/public/lens-billing?year=YYYY&month=M
//   Header: X-Api-Key: <CHI_FINANCE_API_KEY>
//
// 回傳結構：
//   { ok, data:[ { period_year, period_month, completions:[…], returns:[…], summary } ] }
//
// 每筆 completion / return 欄位：
//   seq_no, item_date, customer_order, branch_name, doc_number,
//   product_spec, quantity, markup, client_unit_price, client_total, lohas_erp_id
//
// 結算邏輯：
//   該月某門市淨額 = SUM(completions.client_total) - SUM(returns.client_total)
//
// 寫入策略：
//   - 找 billing_sources WHERE code='CHI-LENS'（請在來源單位管理新增此筆）
//   - 對每個有金額的門市 upsert bills + bill_allocations
//   - bills.source_ref = `chi-lens-<store_erpid>-<YYYY-MM>` 為唯一鍵
//   - bills.status = 'confirmed'（chi-finance 端已過帳）

const axios    = require('axios');
const supabase = require('../config/supabase');

const SOURCE_CODE = 'CHI-LENS';

const API_URL = process.env.CHI_FINANCE_API_URL
  || 'https://chi-finance-system.onrender.com/api/public/lens-billing';
const API_KEY = process.env.CHI_FINANCE_API_KEY || '';

// 把不同命名規則的門市名稱正規化成可比對的 key
//   "樂活潭子門市"  → "潭子"
//   "潭子店"        → "潭子"
//   "潭子門市"      → "潭子"
//   "中部加工中心"  → "中部加工中心"（無對應商家會落 unmapped，保留原樣）
function canonicalize(name) {
  if (!name) return '';
  let s = String(name).trim();
  s = s.replace(/^樂活/, '');           // 去前綴
  s = s.replace(/門市$|店$|分店$/, ''); // 去常見後綴
  return s;
}

// 建立 branch_name → store_erpid 對照表（用 departments.store_name）
//   為了兼容兩邊命名差異，同時建立「原樣」與「正規化」兩個查找路徑
async function buildBranchMap() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name');
  if (error) throw new Error(`[ChiLens] departments 撈不到：${error.message}`);
  const direct  = {};  // 完全相符（"潭子店" → erpid）
  const canon   = {};  // 正規化後相符（"潭子" → erpid）
  for (const d of (data || [])) {
    if (!d.store_name || !d.store_erpid) continue;
    direct[d.store_name] = d.store_erpid;
    const key = canonicalize(d.store_name);
    if (key) canon[key] = d.store_erpid;
  }
  return { direct, canon };
}

// 用兩段嘗試查 erpid：先看原樣是否吻合，再看正規化後是否吻合
function lookupStoreErpid(branchName, branchMap) {
  if (!branchName) return null;
  if (branchMap.direct[branchName]) return branchMap.direct[branchName];
  const key = canonicalize(branchName);
  if (key && branchMap.canon[key]) return branchMap.canon[key];
  return null;
}

// 取 chi-finance 該月份原始資料
async function fetchMonthData(year, month) {
  if (!API_KEY) {
    const e = new Error('[ChiLens] CHI_FINANCE_API_KEY 未設定');
    e.code = 'NO_API_KEY';
    throw e;
  }
  const resp = await axios.get(API_URL, {
    params:  { year, month },
    headers: { 'X-Api-Key': API_KEY },
    timeout: 30000,
  });
  const body = resp.data;
  if (!body || body.ok !== true || !Array.isArray(body.data)) {
    throw new Error(`[ChiLens] API 回傳格式異常：${JSON.stringify(body).slice(0, 200)}`);
  }
  // 文件上是陣列（理論上 1 筆，但保險迭代）
  return body.data;
}

/**
 * 同步指定月份（YYYY-MM）的路奇天格鏡片帳單
 * @param {string} period - 'YYYY-MM'
 * @returns {{ synced_stores, total_amount, completion_count, return_count, unmapped_branches }}
 */
async function syncChiFinanceLens(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`[ChiLens] period 格式錯誤：${period}（應為 YYYY-MM）`);
  }
  const [yearStr, monthStr] = period.split('-');
  const year  = Number(yearStr);
  const month = Number(monthStr);

  console.log(`[ChiLens] 開始同步 ${period}`);

  // 1. 找 source（必須先在「來源單位管理」建好 code='CHI-LENS' 的廠商）
  const { data: source, error: srcErr } = await supabase
    .from('billing_sources')
    .select('id, name, api_start_period, sync_method, is_active')
    .eq('code', SOURCE_CODE)
    .maybeSingle();

  if (srcErr) throw new Error(`[ChiLens] billing_sources 查詢失敗：${srcErr.message}`);
  if (!source) {
    throw new Error(`[ChiLens] 找不到 code='${SOURCE_CODE}' 的來源單位，請先在「帳單管理 → 來源單位」建立路奇天格`);
  }
  if (source.is_active === false) {
    console.log(`[ChiLens] 來源單位已停用，跳過`);
    return { skipped: true, reason: 'source_inactive' };
  }
  if (source.api_start_period && period < source.api_start_period) {
    console.log(`[ChiLens] ${period} < api_start_period(${source.api_start_period})，跳過以保留手動帳單`);
    return { skipped: true, reason: 'before_api_start' };
  }

  // 2. 拉資料
  const groups = await fetchMonthData(year, month);

  // 3. 對照表
  const branchMap = await buildBranchMap();

  // 4. 彙總：依 branch_name 加總（completions 加、returns 減）
  const perBranch = {};   // branch_name → { net, completionCount, returnCount }
  let totalCompletion = 0, totalReturn = 0;
  for (const g of groups) {
    for (const c of (g.completions || [])) {
      const name = c.branch_name || '(未知門市)';
      perBranch[name] ??= { net: 0, completionCount: 0, returnCount: 0 };
      const amt = Number(c.client_total) || 0;
      perBranch[name].net += amt;
      perBranch[name].completionCount += 1;
      totalCompletion += amt;
    }
    for (const r of (g.returns || [])) {
      const name = r.branch_name || '(未知門市)';
      perBranch[name] ??= { net: 0, completionCount: 0, returnCount: 0 };
      const amt = Number(r.client_total) || 0;
      perBranch[name].net -= amt;
      perBranch[name].returnCount += 1;
      totalReturn += amt;
    }
  }

  // 5. 寫入 bills + bill_allocations（每個門市一張 bill）
  const now = new Date().toISOString();
  const unmappedBranches = [];
  let syncedStores = 0;

  for (const [branchName, stat] of Object.entries(perBranch)) {
    const store_erpid = lookupStoreErpid(branchName, branchMap);
    if (!store_erpid) {
      // 找不到對照的門市 → 記下來，這月先跳
      unmappedBranches.push({ branch_name: branchName, net: stat.net });
      continue;
    }
    if (stat.net === 0 && stat.completionCount === 0 && stat.returnCount === 0) continue;

    const sourceRef = `chi-lens-${store_erpid}-${period}`;
    const desc = `完成 ${stat.completionCount} 筆 NT$${totalCompletion.toLocaleString()}／退回 ${stat.returnCount} 筆 NT$${totalReturn.toLocaleString()}`;

    const { data: bill, error: billErr } = await supabase
      .from('bills')
      .upsert(
        {
          source_id:        source.id,
          period,
          title:            `路奇天格鏡片費用 ${period} ${branchName}`,
          total_amount:     stat.net,
          description:      `完成 ${stat.completionCount} 筆 / 退回 ${stat.returnCount} 筆`,
          status:           'confirmed',
          source_ref:       sourceRef,
          created_by_type:  'system',
          confirmed_at:     now,
          notes:            `自動同步自路奇天格 (chi-finance) ${period}`,
          updated_at:       now,
        },
        { onConflict: 'source_ref', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (billErr || !bill) {
      console.error(`[ChiLens] bills upsert 失敗 ${branchName}（${store_erpid}）：`, billErr?.message);
      continue;
    }

    const { error: allocErr } = await supabase
      .from('bill_allocations')
      .upsert(
        {
          bill_id:          bill.id,
          store_erpid,
          store_name:       branchName,
          allocated_amount: stat.net,
          confirm_status:   'confirmed',
          updated_at:       now,
        },
        { onConflict: 'bill_id, store_erpid', ignoreDuplicates: false }
      );
    if (allocErr) console.error(`[ChiLens] allocations upsert 失敗 ${branchName}：`, allocErr.message);

    syncedStores++;
  }

  const result = {
    period,
    synced_stores:        syncedStores,
    total_branches:       Object.keys(perBranch).length,
    completion_count:     groups.reduce((s, g) => s + (g.completions?.length || 0), 0),
    return_count:         groups.reduce((s, g) => s + (g.returns?.length || 0), 0),
    total_completion:     totalCompletion,
    total_return:         totalReturn,
    total_net:            totalCompletion - totalReturn,
    unmapped_branches:    unmappedBranches,
  };
  console.log(`[ChiLens] ${period} 完成`, result);
  return result;
}

module.exports = { syncChiFinanceLens, SOURCE_CODE };
