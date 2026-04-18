// services/educationBonusSync.js
// 教育訓練獎金同步
// 從教育訓練 API 拉取老師獎金記錄，寫入 billing_orders
//
// 帳單來源：教育訓練部
// 帳單對象：老師所在門市（store_name → store_erpid 對照 departments 表）

const axios    = require('axios');
const supabase = require('../config/supabase');

const EDUCATION_API_URL = 'https://api-lms.ruki-ai.com/external/bonuses';
const EDUCATION_API_KEY = process.env.EDUCATION_API_KEY || 'lohas-highlight-2026';

/**
 * 從 departments 表建立 store_name → store_erpid 對照表
 */
async function buildStoreNameMap() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name');

  if (error) throw new Error(`[EducationBonus] 建立門市對照表失敗：${error.message}`);

  const map = {};
  for (const d of (data || [])) {
    if (d.store_name) map[d.store_name] = d.store_erpid;
  }
  return map;
}

/**
 * 從教育訓練 API 取得指定月份的獎金記錄，
 * 轉換成 billing_orders 格式後 upsert。
 *
 * @param {string} month - YYYY-MM（不帶則抓全部）
 * @returns {{ synced: number }}
 */
async function syncEducationBonus(month) {
  console.log(`[EducationBonus] 開始同步月份：${month || '全部'}`);

  // ── 1. 呼叫教育訓練 API ────────────────────────────────────
  const params = {};
  if (month) params.month = month;

  const resp = await axios.get(EDUCATION_API_URL, {
    params,
    headers: { 'x-api-key': EDUCATION_API_KEY },
    timeout: 15000,
  });

  // 回傳格式：陣列，每個元素為一個門市
  const stores = Array.isArray(resp.data) ? resp.data : [];

  if (stores.length === 0) {
    console.log(`[EducationBonus] 月份 ${month} 無資料`);
    return { synced: 0 };
  }

  // ── 2. 取得門市名稱對照表 ──────────────────────────────────
  const storeNameMap = await buildStoreNameMap();

  // ── 3. 展開：store → teachers → records ───────────────────
  const rows = [];

  for (const store of stores) {
    // 優先用 store_name 比對 store_erpid；找不到才 fallback 到 API 的 store_id
    const store_erpid = storeNameMap[store.store_name] || store.store_id;

    for (const teacher of (store.teachers || [])) {
      for (const rec of (teacher.records || [])) {
        // 以 "edu-{rec.id}" 為唯一鍵，避免重複
        rows.push({
          order_id:         `edu-${rec.id}`,
          source_type:      'education_bonus',
          store_erpid,
          amount:           Number(rec.amount) || 0,
          // 以訓練結束日為帳單歸屬時間
          signed_at:        rec.training_end
            ? `${rec.training_end}T00:00:00+08:00`
            : new Date().toISOString(),
          billing_month:    rec.month || month,
          billing_category: '教育訓練部',
          // items：用老師 + 學員資訊組成項目明細（前端展開用）
          items: [{
            item_name:        rec.track_name,
            description:      `學員：${rec.employee_name}　訓練期間：${rec.training_start} ～ ${rec.training_end}`,
            completion_notes: `授課老師：${teacher.teacher_name}`,
            amount:           rec.amount,
            status:           'completed',
          }],
          remark:    `${teacher.teacher_name} → ${rec.employee_name}（${rec.track_name}）`,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  if (rows.length === 0) {
    console.log(`[EducationBonus] 月份 ${month} 展開後無明細`);
    return { synced: 0 };
  }

  // ── 4. Upsert 到 billing_orders ────────────────────────────
  const { error } = await supabase
    .from('billing_orders')
    .upsert(rows, { onConflict: 'order_id' });

  if (error) throw new Error(`[EducationBonus] upsert 失敗：${error.message}`);

  console.log(`[EducationBonus] 月份 ${month} 完成，共 ${rows.length} 筆`);
  return { synced: rows.length };
}

module.exports = { syncEducationBonus };
