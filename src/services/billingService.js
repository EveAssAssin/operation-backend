// services/billingService.js
// 開帳系統：從市場管理系統 API 同步帳單資料並寫入本地 Supabase

const axios   = require('axios');
const supabase = require('../config/supabase');

const MARKET_BILLING_URL = process.env.MARKET_BILLING_URL
  || 'https://market-backend-0544.onrender.com/api/billing';

/**
 * 取得市場系統帳單 API 的 axios instance（帶 x-api-key）
 */
function getBillingApiClient() {
  const apiKey = process.env.BILLING_API_KEY;
  if (!apiKey) {
    throw new Error('[BillingService] 未設定環境變數 BILLING_API_KEY');
  }
  return axios.create({
    baseURL: MARKET_BILLING_URL,
    timeout: 30000,
    headers: { 'x-api-key': apiKey },
  });
}

/**
 * 從 ISO 時間字串計算帳單月份（YYYY-MM）
 * @param {string} signedAt - ISO 時間字串
 * @returns {string} YYYY-MM
 */
function toBillingMonth(signedAt) {
  const d = new Date(signedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 將 API 回傳的訂單陣列 upsert 進 billing_orders
 * @param {Array} orders - 市場 API 回傳的訂單
 * @returns {number} 成功 upsert 的筆數
 */
async function upsertOrders(orders) {
  if (!orders || orders.length === 0) return 0;

  const rows = orders.map((o) => ({
    // 市場 API 的訂單唯一識別碼欄位為 source_id（UUID）
    order_id: o.source_id || o.order_id || o.id,
    source_type:   o.source_type,
    store_erpid:   o.store_erpid,
    amount:        Number(o.amount) || 0,
    signed_at:     o.signed_at,
    billing_month: toBillingMonth(o.signed_at),
    raw_data:      o,
    updated_at:    new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('billing_orders')
    .upsert(rows, { onConflict: 'order_id' });

  if (error) throw new Error(`[BillingService] upsert 失敗：${error.message}`);
  return rows.length;
}

/**
 * 寫入同步記錄
 */
async function writeSyncLog({ sync_type, target_month, since_ts, status, orders_synced, error_message }) {
  await supabase.from('billing_sync_logs').insert({
    sync_type,
    target_month: target_month || null,
    since_ts:     since_ts     || null,
    status,
    orders_synced: orders_synced || 0,
    error_message: error_message || null,
  });
}

// ─────────────────────────────────────────────────────────────
// 公開函式
// ─────────────────────────────────────────────────────────────

/**
 * 同步指定月份的帳單資料
 * - 呼叫 GET /completed-orders?month=YYYY-MM
 * - Upsert 全部訂單
 * @param {string} month - YYYY-MM
 * @param {'manual'|'scheduled'} syncType
 * @returns {{ orders_synced: number }}
 */
async function syncMonth(month, syncType = 'manual') {
  console.log(`[BillingService] 開始同步月份：${month}`);
  let ordersCount = 0;

  try {
    const client = getBillingApiClient();
    const resp   = await client.get('/completed-orders', { params: { month } });

    // 診斷 log — 確認 status + 回傳結構
    console.log(`[BillingService] HTTP status: ${resp.status}`);
    console.log(`[BillingService] resp.data type: ${Array.isArray(resp.data) ? 'array' : typeof resp.data}`);

    // 市場 API 回傳格式：{ success: true, total_count: N, data: [...] }
    // 後端 axios 無 interceptor，resp.data 是完整物件，陣列在 resp.data.data
    const raw    = resp.data;
    const orders = Array.isArray(raw)       ? raw       :
                   Array.isArray(raw?.data) ? raw.data  : [];

    console.log(`[BillingService] 解析到訂單數：${orders.length}`);
    if (orders.length > 0) {
      console.log(`[BillingService] 第一筆 keys:`, Object.keys(orders[0]));
    }

    ordersCount = await upsertOrders(orders);

    await writeSyncLog({
      sync_type:     syncType,
      target_month:  month,
      status:        'success',
      orders_synced: ordersCount,
    });

    console.log(`[BillingService] 月份 ${month} 同步完成，共 ${ordersCount} 筆`);
    return { orders_synced: ordersCount };
  } catch (err) {
    // 若是 HTTP 錯誤，加上 status code（503=key未設定 / 401=key錯誤）
    const httpStatus = err.response?.status;
    const errMsg = httpStatus
      ? `HTTP ${httpStatus} — ${JSON.stringify(err.response?.data)}`
      : err.message;
    console.error(`[BillingService] 月份 ${month} 同步失敗：`, errMsg);
    await writeSyncLog({
      sync_type:     syncType,
      target_month:  month,
      status:        'error',
      error_message: err.message,
    });
    throw err;
  }
}

/**
 * 增量同步：只拉取 since 之後有更新的訂單
 * - 自動取上次成功同步時間作為 since
 * - 呼叫 GET /completed-orders?since=ISO
 */
async function incrementalSync() {
  console.log('[BillingService] 開始增量同步');

  // 取上次成功同步時間
  const { data: lastLog } = await supabase
    .from('billing_sync_logs')
    .select('synced_at')
    .eq('status', 'success')
    .order('synced_at', { ascending: false })
    .limit(1)
    .single();

  // 若沒有記錄，預設同步最近 2 個月
  let since;
  if (lastLog?.synced_at) {
    since = lastLog.synced_at;
  } else {
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    since = d.toISOString();
  }

  let ordersCount = 0;
  try {
    const client = getBillingApiClient();
    const resp   = await client.get('/completed-orders', { params: { since } });
    const orders = resp.data?.data || resp.data || [];

    ordersCount = await upsertOrders(orders);

    await writeSyncLog({
      sync_type:     'incremental',
      since_ts:      since,
      status:        'success',
      orders_synced: ordersCount,
    });

    console.log(`[BillingService] 增量同步完成，since=${since}，共 ${ordersCount} 筆`);
    return { orders_synced: ordersCount, since };
  } catch (err) {
    console.error('[BillingService] 增量同步失敗：', err.message);
    await writeSyncLog({
      sync_type:     'incremental',
      since_ts:      since,
      status:        'error',
      error_message: err.message,
    });
    throw err;
  }
}

/**
 * 查詢指定月份各門市彙總
 * @param {string} month - YYYY-MM
 * @returns {Array} [{ store_erpid, maintenance_count, maintenance_amount, repair_count, repair_amount, total_count, total_amount }]
 */
async function getMonthSummary(month) {
  const { data, error } = await supabase
    .from('billing_orders')
    .select('store_erpid, source_type, amount')
    .eq('billing_month', month);

  if (error) throw new Error(`[BillingService] 查詢彙總失敗：${error.message}`);

  // 手動 GROUP BY（Supabase JS client 不支援直接 GROUP BY）
  const map = {};
  for (const row of (data || [])) {
    if (!map[row.store_erpid]) {
      map[row.store_erpid] = {
        store_erpid:         row.store_erpid,
        maintenance_count:   0,
        maintenance_amount:  0,
        repair_count:        0,
        repair_amount:       0,
        total_count:         0,
        total_amount:        0,
      };
    }
    const s = map[row.store_erpid];
    if (row.source_type === 'maintenance') {
      s.maintenance_count  += 1;
      s.maintenance_amount += Number(row.amount);
    } else {
      s.repair_count  += 1;
      s.repair_amount += Number(row.amount);
    }
    s.total_count  += 1;
    s.total_amount += Number(row.amount);
  }

  return Object.values(map).sort((a, b) =>
    a.store_erpid.localeCompare(b.store_erpid)
  );
}

/**
 * 查詢指定月份（可選門市）的訂單明細
 * @param {string} month - YYYY-MM
 * @param {string} [storeErpid] - 若為空則回傳全部門市
 * @returns {Array} billing_orders 陣列
 */
async function getMonthOrders(month, storeErpid) {
  let query = supabase
    .from('billing_orders')
    .select('id, order_id, source_type, store_erpid, amount, signed_at, billing_month')
    .eq('billing_month', month)
    .order('signed_at', { ascending: true });

  if (storeErpid) {
    query = query.eq('store_erpid', storeErpid);
  }

  const { data, error } = await query;
  if (error) throw new Error(`[BillingService] 查詢明細失敗：${error.message}`);
  return data || [];
}

/**
 * 取得最近同步記錄
 * @param {number} limit
 */
async function getRecentSyncLogs(limit = 10) {
  const { data, error } = await supabase
    .from('billing_sync_logs')
    .select('*')
    .order('synced_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`[BillingService] 查詢同步記錄失敗：${error.message}`);
  return data || [];
}

module.exports = {
  syncMonth,
  incrementalSync,
  getMonthSummary,
  getMonthOrders,
  getRecentSyncLogs,
};
