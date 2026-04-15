// services/billingService.js
// 開帳系統：從市場管理系統 API 同步帳單資料並寫入本地 Supabase

const axios   = require('axios');
const supabase = require('../config/supabase');

const MARKET_BILLING_URL = process.env.MARKET_BILLING_URL
  || 'https://market-backend-0544.onrender.com/api/billing';

// source_type → 部門分類 對應表
const BILLING_CATEGORY_MAP = {
  repair:      '工程部',
  maintenance: '工程部',
};

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
    order_id:         o.source_id || o.order_id || o.id,
    source_type:      o.source_type,
    store_erpid:      o.store_erpid,
    amount:           Number(o.amount) || 0,
    signed_at:        o.signed_at,
    billing_month:    toBillingMonth(o.signed_at),
    raw_data:         o,
    // 明細項目（include=items 時才有，否則保留空陣列）
    items:            Array.isArray(o.items) ? o.items : [],
    remark:           o.remark || null,
    billing_category: BILLING_CATEGORY_MAP[o.source_type] || o.source_type || null,
    updated_at:       new Date().toISOString(),
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
    const resp   = await client.get('/completed-orders', { params: { month, include: 'items' } });

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

    // 同步完後，自動彙總寫入 bills v2
    await syncOrdersToBills(month).catch(err =>
      console.warn(`[BillingV2Sync] syncOrdersToBills 失敗（不影響主流程）：${err.message}`)
    );

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
    const resp   = await client.get('/completed-orders', { params: { since, include: 'items' } });
    const orders = resp.data?.data || resp.data || [];

    ordersCount = await upsertOrders(orders);

    // 增量同步：找出本批訂單涉及的月份，各自同步到 bills
    if (orders.length > 0) {
      const months = [...new Set(orders.map(o => toBillingMonth(o.signed_at)))];
      for (const m of months) {
        await syncOrdersToBills(m).catch(err =>
          console.warn(`[BillingV2Sync] 增量 syncOrdersToBills(${m}) 失敗：${err.message}`)
        );
      }
    }

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
    .select('store_erpid, source_type, amount, billing_category')
    .eq('billing_month', month);

  if (error) throw new Error(`[BillingService] 查詢彙總失敗：${error.message}`);

  // 手動 GROUP BY（Supabase JS client 不支援直接 GROUP BY）
  const map = {};
  for (const row of (data || [])) {
    if (!map[row.store_erpid]) {
      map[row.store_erpid] = {
        store_erpid:         row.store_erpid,
        billing_category:    row.billing_category || null,
        maintenance_count:   0,
        maintenance_amount:  0,
        repair_count:        0,
        repair_amount:       0,
        total_count:         0,
        total_amount:        0,
      };
    }
    const s = map[row.store_erpid];
    // 若有 billing_category，以最新非 null 的值為主
    if (row.billing_category && !s.billing_category) {
      s.billing_category = row.billing_category;
    }
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
    .select('id, order_id, source_type, store_erpid, amount, signed_at, billing_month, billing_category, items, remark')
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

/**
 * 從市場 API 取得單一訂單完整明細（Method B：含 photo_urls、completion_notes）
 * @param {'repair'|'maintenance'} sourceType
 * @param {string} sourceId - order UUID (source_id)
 * @returns {Object} 市場 API 回傳的原始訂單明細
 */
async function getOrderDetail(sourceType, sourceId) {
  const client = getBillingApiClient();
  const baseUrl = process.env.MARKET_BILLING_URL
    || 'https://market-backend-0544.onrender.com/api/billing';

  // Method B endpoint: /api/billing/order-items/{sourceType}/{sourceId}
  const resp = await client.get(`/order-items/${sourceType}/${sourceId}`);

  // 市場 API 回傳 { success, data: {...} } 或直接 {...}
  const raw = resp.data;
  return raw?.data ?? raw;
}

// ─────────────────────────────────────────────────────────────
// bills 整合：將 billing_orders 同步寫入 v2 bills 表
// ─────────────────────────────────────────────────────────────

/**
 * 把指定月份的 billing_orders 彙總寫入 bills + bill_allocations
 * - 每個門市產生一張 bill（source_ref: mkt-{store_erpid}-{month}）
 * - 狀態直接設為 confirmed（已由市場系統驗收）
 * - 若金額有變化（re-sync），直接更新
 *
 * @param {string} month - YYYY-MM
 */
async function syncOrdersToBills(month) {
  // 1. 取得 DEPT-ENGINEERING 的 source_id
  const { data: source, error: srcErr } = await supabase
    .from('billing_sources')
    .select('id, name')
    .eq('code', 'DEPT-ENGINEERING')
    .maybeSingle();

  if (srcErr || !source) {
    console.warn('[BillingV2Sync] 找不到 DEPT-ENGINEERING 來源單位，跳過 bills 同步');
    return;
  }

  // 2. 取得該月份所有訂單
  const { data: orders, error: ordErr } = await supabase
    .from('billing_orders')
    .select('store_erpid, amount')
    .eq('billing_month', month);

  if (ordErr || !orders || orders.length === 0) return;

  // 3. 取得門市名稱
  const { data: depts } = await supabase
    .from('departments')
    .select('store_erpid, store_name');
  const deptMap = {};
  (depts || []).forEach(d => { deptMap[d.store_erpid] = d.store_name; });

  // 4. 依門市彙總金額
  const storeMap = {};
  for (const o of orders) {
    if (!storeMap[o.store_erpid]) storeMap[o.store_erpid] = 0;
    storeMap[o.store_erpid] += Number(o.amount) || 0;
  }

  // 5. 對每個門市 upsert bills + bill_allocations
  for (const [store_erpid, total] of Object.entries(storeMap)) {
    const store_name = deptMap[store_erpid] || store_erpid;
    const sourceRef  = `mkt-${store_erpid}-${month}`;
    const now        = new Date().toISOString();

    // upsert bill（以 source_ref 為唯一鍵）
    const { data: bill, error: billErr } = await supabase
      .from('bills')
      .upsert(
        {
          source_id:        source.id,
          period:           month,
          title:            `工程部費用 ${month} ${store_name}`,
          total_amount:     total,
          status:           'confirmed',
          source_ref:       sourceRef,
          created_by_type:  'system',
          confirmed_at:     now,
          notes:            `自動同步自市場系統（${month}）`,
          updated_at:       now,
        },
        { onConflict: 'source_ref', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (billErr || !bill) {
      console.error(`[BillingV2Sync] bills upsert 失敗 ${store_erpid}:`, billErr?.message);
      continue;
    }

    // upsert bill_allocation
    const { error: allocErr } = await supabase
      .from('bill_allocations')
      .upsert(
        {
          bill_id:          bill.id,
          store_erpid,
          store_name,
          allocated_amount: total,
          confirm_status:   'confirmed',
          updated_at:       now,
        },
        { onConflict: 'bill_id, store_erpid', ignoreDuplicates: false }
      );

    if (allocErr) {
      console.error(`[BillingV2Sync] allocations upsert 失敗 ${store_erpid}:`, allocErr.message);
    }
  }

  console.log(`[BillingV2Sync] ${month} 完成，共 ${Object.keys(storeMap).length} 個門市 bills 已同步`);
}

module.exports = {
  syncMonth,
  incrementalSync,
  getMonthSummary,
  getMonthOrders,
  getRecentSyncLogs,
  getOrderDetail,
  syncOrdersToBills,
};
