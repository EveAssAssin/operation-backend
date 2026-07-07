// services/adBudgetSync.js
// 企劃部廣告費同步（新版）
//   來源 API：AD_BUDGET_API_URL + /ad-budgets/public/store-budget?month=YYYY-MM
//
// API 結構（新版：以「門市」為主）：
//   {
//     month, total_budget, total_actual_spend, total_meta_spend, total_google_spend, total_additional_spend, total_diff,
//     stores: [
//       {
//         store_id, store_name,
//         budget, actual_spend,
//         meta_spend, google_spend, additional_spend,
//         diff,
//         campaigns: [
//           { id, name, platform, budget_share, actual_spend_share, start_date, end_date }
//         ]
//       }
//     ]
//   }
//
// 寫入策略：
//   每間門市 × 每月 = 一筆 billing_orders
//   order_id = "ad-store-{store_id}-{YYYY-MM}"（唯一鍵，upsert）
//   amount   = actual_spend（若為 0/null 則 fallback 到 budget）
//   raw_data = 保存 Meta/Google/additional 拆分 + campaigns，供之後分析報表用

const axios    = require('axios');
const supabase = require('../config/supabase');

const AD_BUDGET_API_URL = process.env.AD_BUDGET_API_URL || '';

async function buildStoreNameMap() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name');
  if (error) throw new Error(`[AdBudget] 建立門市對照表失敗：${error.message}`);
  const map = {};
  for (const d of (data || [])) {
    if (d.store_name) map[d.store_name] = d.store_erpid;
  }
  return map;
}

/**
 * 同步指定月份的廣告費（以門市為主）
 * @param {string} month - YYYY-MM
 * @returns {{ synced, stores, meta_total, google_total, additional_total, unmapped }}
 */
async function syncAdBudget(month) {
  if (!AD_BUDGET_API_URL) {
    throw new Error('[AdBudget] 未設定環境變數 AD_BUDGET_API_URL');
  }
  console.log(`[AdBudget] 開始同步月份：${month}`);

  // 1. 撈 API
  const resp = await axios.get(`${AD_BUDGET_API_URL}/ad-budgets/public/store-budget`, {
    params:  { month },
    timeout: 20000,
  });

  const stores = resp.data?.stores;
  if (!Array.isArray(stores) || stores.length === 0) {
    console.log(`[AdBudget] 月份 ${month} 無門市資料`);
    return { synced: 0, stores: 0 };
  }

  // 2. 門市對照表
  const storeNameMap = await buildStoreNameMap();
  const unmapped = [];

  // 3. 展成 billing_orders
  const rows = [];
  for (const s of stores) {
    const store_erpid = storeNameMap[s.store_name] || `ad-store-${s.store_id}`;
    if (!storeNameMap[s.store_name]) {
      unmapped.push({ store_id: s.store_id, store_name: s.store_name });
    }

    // 金額優先用 actual_spend；為 0 或 null 時 fallback 用 budget
    const actual = Number(s.actual_spend) || 0;
    const budget = Number(s.budget) || 0;
    const useActual = actual > 0;
    const amount    = useActual ? actual : budget;

    const meta       = Number(s.meta_spend) || 0;
    const google     = Number(s.google_spend) || 0;
    const additional = Number(s.additional_spend) || 0;
    const diff       = Number(s.diff) || 0;

    // 廣告活動摘要（用作 remark）
    const campNames = Array.isArray(s.campaigns) ? s.campaigns.map(c => c.name).filter(Boolean) : [];
    const campSummary = campNames.length > 0
      ? `${campNames.slice(0, 3).join('、')}${campNames.length > 3 ? ` ...等${campNames.length}項` : ''}`
      : '（無廣告活動）';

    rows.push({
      order_id:         `ad-store-${s.store_id}-${month}`,
      source_type:      'ad_budget',
      store_erpid,
      amount,
      signed_at:        `${month}-28T23:59:59+08:00`,   // 月底作為歸屬
      billing_month:    month,
      billing_category: '企劃部',
      // items：明細展開用（每 campaign 一項）
      items: (s.campaigns || []).map(c => ({
        item_name:        c.name,
        description:      [
          c.platform ? `平台：${c.platform}` : null,
          c.start_date && c.end_date ? `${c.start_date}~${c.end_date}` : null,
        ].filter(Boolean).join('　'),
        amount:           useActual ? (Number(c.actual_spend_share) || 0) : (Number(c.budget_share) || 0),
        status:           'completed',
        budget_share:     Number(c.budget_share) || 0,
        actual_spend_share: Number(c.actual_spend_share) || 0,
        is_actual_spend:  useActual,
      })),
      remark: `${campSummary}${useActual ? '' : '【預算分攤】'}`,
      // raw_data：保留完整拆分供分析用（Meta/Google/additional + diff）
      raw_data: {
        source:          'store-budget-api',
        api_month:       month,
        api_store_id:    s.store_id,
        api_store_name:  s.store_name,
        budget, actual_spend: actual,
        meta_spend:      meta,
        google_spend:    google,
        additional_spend: additional,
        diff,
        use_actual:      useActual,
        campaigns:       s.campaigns || [],
      },
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) {
    console.log(`[AdBudget] 月份 ${month} 沒有可展開的資料`);
    return { synced: 0, stores: 0 };
  }

  // 4. Upsert
  const { error } = await supabase
    .from('billing_orders')
    .upsert(rows, { onConflict: 'order_id' });
  if (error) throw new Error(`[AdBudget] upsert 失敗：${error.message}`);

  console.log(`[AdBudget] 月份 ${month} 完成，共 ${rows.length} 筆門市${unmapped.length > 0 ? `，未對應 ${unmapped.length} 家` : ''}`);
  return {
    synced: rows.length,
    stores: rows.length,
    meta_total:       resp.data?.total_meta_spend,
    google_total:     resp.data?.total_google_spend,
    additional_total: resp.data?.total_additional_spend,
    total_actual:     resp.data?.total_actual_spend,
    total_budget:     resp.data?.total_budget,
    total_diff:       resp.data?.total_diff,
    unmapped,
  };
}

module.exports = { syncAdBudget };
