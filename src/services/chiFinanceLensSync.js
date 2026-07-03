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

// ─── 手動別名表（chi-finance branch_name → 樂活 departments.store_name）─────
// 給自動正規化抓不到的特殊命名用。新增別名時請維持「鍵 = chi-finance 名稱」格式
const BRANCH_ALIASES = {
  '樂活高大門市': '高應大店',     // chi-finance 用「高大」，內部叫「高應大」
  '中部加工中心': '中部加工中心',  // 對應 departments.store_erpid='00010' 的內部單位
  '南部加工中心': '南部加工中心',  // 對應 departments.store_erpid='00011' 的內部單位
};

// ─── 排除清單（不算入任何門市的內部單位）─────────────────────
// 留空。未來如果有 chi-finance 端真的不想算進來的單位，加在這裡會直接忽略
const SKIP_BRANCHES = new Set([
]);

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

// 三段查 erpid：
//   1. 別名表（最高優先）
//   2. 原樣相符
//   3. 正規化後相符
function lookupStoreErpid(branchName, branchMap) {
  if (!branchName) return null;
  // 1. 別名表
  const aliased = BRANCH_ALIASES[branchName];
  if (aliased && branchMap.direct[aliased]) return branchMap.direct[aliased];
  // 2. 原樣
  if (branchMap.direct[branchName]) return branchMap.direct[branchName];
  // 3. 正規化
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

  // 1-1. 確保「以來源單位名稱」為名的會計科目存在，作為 API 同步帳單的預設分類
  let defaultCategoryId = null;
  {
    const { data: existCat } = await supabase
      .from('accounting_categories')
      .select('id')
      .eq('source_id', source.id)
      .eq('name', source.name)
      .maybeSingle();
    if (existCat?.id) {
      defaultCategoryId = existCat.id;
    } else {
      const nowIso = new Date().toISOString();
      const { data: newCat, error: catErr } = await supabase
        .from('accounting_categories')
        .insert({
          source_id: source.id,
          name: source.name,
          is_active: true,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select('id')
        .single();
      if (catErr) {
        console.warn(`[ChiLens] 自動建會計科目失敗（不影響同步）：${catErr.message}`);
      } else {
        defaultCategoryId = newCat?.id || null;
      }
    }
  }

  // 2. 拉資料
  const groups = await fetchMonthData(year, month);

  // 3. 對照表
  const branchMap = await buildBranchMap();

  // 4. 彙總：依 branch_name 加總（completions 加、returns 減）+ 收集明細
  const perBranch = {};   // branch_name → { net, completionCount, returnCount, items: [] }
  let totalCompletion = 0, totalReturn = 0;
  for (const g of groups) {
    for (const c of (g.completions || [])) {
      const name = c.branch_name || '(未知門市)';
      perBranch[name] ??= { net: 0, completionCount: 0, returnCount: 0, items: [] };
      const amt = Number(c.client_total) || 0;
      perBranch[name].net += amt;
      perBranch[name].completionCount += 1;
      perBranch[name].items.push({
        type:           'completion',
        seq_no:         c.seq_no,
        item_date:      c.item_date,
        customer_order: c.customer_order,
        doc_number:     c.doc_number,
        product_spec:   c.product_spec,
        quantity:       Number(c.quantity) || 0,
        markup:         Number(c.markup) || 0,
        unit_price:     Number(c.client_unit_price) || 0,
        total:          amt,
      });
      totalCompletion += amt;
    }
    for (const r of (g.returns || [])) {
      const name = r.branch_name || '(未知門市)';
      perBranch[name] ??= { net: 0, completionCount: 0, returnCount: 0, items: [] };
      const amt = Number(r.client_total) || 0;
      perBranch[name].net -= amt;
      perBranch[name].returnCount += 1;
      perBranch[name].items.push({
        type:           'return',
        seq_no:         r.seq_no,
        item_date:      r.item_date,
        customer_order: r.customer_order,
        doc_number:     r.doc_number,
        product_spec:   r.product_spec,
        quantity:       Number(r.quantity) || 0,
        markup:         Number(r.markup) || 0,
        unit_price:     Number(r.client_unit_price) || 0,
        total:          -amt,   // 退回用負數，呈現時方便加總
      });
      totalReturn += amt;
    }
  }
  // 把每家明細按日期 + seq 排序
  for (const b of Object.values(perBranch)) {
    b.items.sort((a, b) => {
      const d = (a.item_date || '').localeCompare(b.item_date || '');
      if (d !== 0) return d;
      return (a.seq_no || 0) - (b.seq_no || 0);
    });
  }

  // 5. 寫入 bills + bill_allocations（每個門市一張 bill）
  //    用「先查再 insert/update」明確處理，避開 partial unique index 與 onConflict 對應問題
  const now = new Date().toISOString();
  const unmappedBranches = [];
  const skippedBranches = [];      // 在 SKIP_BRANCHES 中的，已被刻意忽略
  const writeErrors = [];
  let syncedStores = 0, insertedCount = 0, updatedCount = 0;

  for (const [branchName, stat] of Object.entries(perBranch)) {
    // 排除：chi-finance 內部單位（如「中部加工中心」），不算進任何門市帳
    if (SKIP_BRANCHES.has(branchName)) {
      skippedBranches.push({ branch_name: branchName, net: stat.net });
      continue;
    }
    const store_erpid = lookupStoreErpid(branchName, branchMap);
    if (!store_erpid) {
      unmappedBranches.push({ branch_name: branchName, net: stat.net });
      continue;
    }
    if (stat.net === 0 && stat.completionCount === 0 && stat.returnCount === 0) continue;

    const sourceRef = `chi-lens-${store_erpid}-${period}`;
    const billPayload = {
      source_id:        source.id,
      accounting_category_id: defaultCategoryId,
      period,
      title:            `路奇天格鏡片費用 ${period} ${branchName}`,
      total_amount:     stat.net,
      description:      `完成 ${stat.completionCount} 筆 / 退回 ${stat.returnCount} 筆`,
      status:           'confirmed',
      source_ref:       sourceRef,
      items:            stat.items,                 // 把該門市明細存進 JSONB
      created_by_type:  'system',
      confirmed_at:     now,
      notes:            `自動同步自路奇天格 (chi-finance) ${period}`,
      updated_at:       now,
    };

    // 5-1. 找舊 bill
    const { data: oldBill, error: findErr } = await supabase
      .from('bills')
      .select('id')
      .eq('source_ref', sourceRef)
      .maybeSingle();
    if (findErr) {
      writeErrors.push({ branch: branchName, step: 'find_bill', message: findErr.message });
      continue;
    }

    let billId;
    if (oldBill) {
      // 5-2a. 更新
      const { error: updErr } = await supabase
        .from('bills')
        .update(billPayload)
        .eq('id', oldBill.id);
      if (updErr) {
        writeErrors.push({ branch: branchName, step: 'update_bill', message: updErr.message });
        continue;
      }
      billId = oldBill.id;
      updatedCount++;
    } else {
      // 5-2b. 新建
      const { data: newBill, error: insErr } = await supabase
        .from('bills')
        .insert([billPayload])
        .select('id')
        .single();
      if (insErr || !newBill) {
        writeErrors.push({ branch: branchName, step: 'insert_bill', message: insErr?.message || 'no row returned' });
        continue;
      }
      billId = newBill.id;
      insertedCount++;
    }

    // 5-3. allocation upsert（這張表 (bill_id, store_erpid) 有 UNIQUE 沒有 partial 條件，用 onConflict OK）
    const { data: oldAlloc } = await supabase
      .from('bill_allocations')
      .select('id')
      .eq('bill_id', billId)
      .eq('store_erpid', store_erpid)
      .maybeSingle();

    if (oldAlloc) {
      const { error: aUpdErr } = await supabase
        .from('bill_allocations')
        .update({
          store_name:       branchName,
          allocated_amount: stat.net,
          confirm_status:   'confirmed',
          updated_at:       now,
        })
        .eq('id', oldAlloc.id);
      if (aUpdErr) writeErrors.push({ branch: branchName, step: 'update_alloc', message: aUpdErr.message });
    } else {
      const { error: aInsErr } = await supabase
        .from('bill_allocations')
        .insert([{
          bill_id:          billId,
          store_erpid,
          store_name:       branchName,
          allocated_amount: stat.net,
          confirm_status:   'confirmed',
          updated_at:       now,
        }]);
      if (aInsErr) writeErrors.push({ branch: branchName, step: 'insert_alloc', message: aInsErr.message });
    }

    syncedStores++;
  }

  const result = {
    period,
    synced_stores:        syncedStores,
    inserted_count:       insertedCount,
    updated_count:        updatedCount,
    total_branches:       Object.keys(perBranch).length,
    completion_count:     groups.reduce((s, g) => s + (g.completions?.length || 0), 0),
    return_count:         groups.reduce((s, g) => s + (g.returns?.length || 0), 0),
    total_completion:     totalCompletion,
    total_return:         totalReturn,
    total_net:            totalCompletion - totalReturn,
    unmapped_branches:    unmappedBranches,
    skipped_branches:     skippedBranches,
    write_errors:         writeErrors,
  };
  console.log(`[ChiLens] ${period} 完成`, result);
  return result;
}

module.exports = { syncChiFinanceLens, SOURCE_CODE };
