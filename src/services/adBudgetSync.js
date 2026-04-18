// services/adBudgetSync.js
// 企劃部廣告費同步
// 從廣告費 API 拉取各廣告活動的門市分攤金額，寫入 billing_orders
//
// 帳單來源：企劃部
// 帳單對象：各廣告活動涉及的門市（store_budget_detail → store_name → store_erpid）
//
// ⚠️ 需設定環境變數 AD_BUDGET_API_URL（向資訊部確認實際 Base URL）

const axios    = require('axios');
const supabase = require('../config/supabase');

const AD_BUDGET_API_URL = process.env.AD_BUDGET_API_URL || '';

/**
 * 從 departments 表建立 store_name → store_erpid 對照表
 * （與 educationBonusSync 相同的輔助函式，各自獨立不共用）
 */
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
 * 從廣告費 API 取得指定月份的廣告活動，
 * 依每筆廣告的 store_budget_detail 展開成 billing_orders。
 *
 * 對應邏輯：
 *   每筆廣告 × 每個涉及門市 = 一筆 billing_order
 *   order_id = "ad-{campaign.id}-{store_id}"（唯一鍵，可 upsert）
 *
 * @param {string} month - YYYY-MM
 * @returns {{ synced: number }}
 */
async function syncAdBudget(month) {
  if (!AD_BUDGET_API_URL) {
    throw new Error('[AdBudget] 未設定環境變數 AD_BUDGET_API_URL，無法同步廣告費帳單');
  }

  console.log(`[AdBudget] 開始同步月份：${month}`);

  // ── 1. 呼叫廣告費 API ─────────────────────────────────────
  const resp = await axios.get(`${AD_BUDGET_API_URL}/ad-budgets/public/campaigns`, {
    params:  { month },
    timeout: 15000,
  });

  const campaigns = resp.data?.campaigns;
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    console.log(`[AdBudget] 月份 ${month} 無廣告資料`);
    return { synced: 0 };
  }

  // ── 2. 取得門市名稱對照表 ──────────────────────────────────
  const storeNameMap = await buildStoreNameMap();

  // ── 3. 展開：campaign × store_budget_detail ────────────────
  const rows = [];

  for (const camp of campaigns) {
    const detail = camp.store_budget_detail || [];

    for (const sd of detail) {
      // 用 store_name 比對 store_erpid
      const store_erpid = storeNameMap[sd.store_name] || `ad-store-${sd.store_id}`;

      rows.push({
        // 唯一鍵：廣告 ID + 門市 ID（整數）
        order_id:         `ad-${camp.id}-${sd.store_id}`,
        source_type:      'ad_budget',
        store_erpid,
        amount:           Number(sd.budget_share) || 0,
        // 廣告結束日作為帳單歸屬時間；未設定則用月底
        signed_at:        camp.end_date
          ? `${camp.end_date}T23:59:59+08:00`
          : `${month}-28T23:59:59+08:00`,
        billing_month:    month,
        billing_category: '企劃部',
        // items：廣告詳情供明細展開用
        items: [{
          item_name:        camp.name,
          description:      [
            camp.platform ? `平台：${camp.platform}` : null,
            camp.channel  ? `類型：${camp.channel === 'online' ? '線上' : '線下'}` : null,
            camp.strategy ? `策略：${camp.strategy}` : null,
          ].filter(Boolean).join('　'),
          completion_notes: camp.copy_content || null,
          amount:           sd.budget_share,
          status:           'completed',
        }],
        remark: `${camp.name}（${camp.platform || camp.channel}）${camp.start_date}～${camp.end_date}`,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length === 0) {
    console.log(`[AdBudget] 月份 ${month} 廣告展開後無明細`);
    return { synced: 0 };
  }

  // ── 4. Upsert 到 billing_orders ────────────────────────────
  const { error } = await supabase
    .from('billing_orders')
    .upsert(rows, { onConflict: 'order_id' });

  if (error) throw new Error(`[AdBudget] upsert 失敗：${error.message}`);

  console.log(`[AdBudget] 月份 ${month} 完成，共 ${rows.length} 筆（${campaigns.length} 支廣告）`);
  return { synced: rows.length };
}

module.exports = { syncAdBudget };
