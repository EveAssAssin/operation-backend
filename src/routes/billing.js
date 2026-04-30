// routes/billing.js
// 開帳系統 API 路由
// 所有路由需 operation_lead(2) 以上才能存取

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const {
  syncMonth,
  incrementalSync,
  getMonthSummary,
  getMonthOrders,
  getRecentSyncLogs,
  getOrderDetail,
} = require('../services/billingService');

// 所有路由需 operation_staff 以上（app.js 掛載時已套 authenticate）
router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ─────────────────────────────────────────────────────────────
// GET /api/billing/summary?month=YYYY-MM
// 取得指定月份各門市帳單彙總
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'month 參數格式錯誤，請使用 YYYY-MM',
      });
    }

    const data = await getMonthSummary(month);
    res.json({ success: true, data, month });
  } catch (err) {
    console.error('[Billing] 取得彙總失敗：', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/orders?month=YYYY-MM[&store_erpid=XXX]
// 取得指定月份（可指定門市）的訂單明細
// ─────────────────────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const { month, store_erpid } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        success: false,
        message: 'month 參數格式錯誤，請使用 YYYY-MM',
      });
    }

    const data = await getMonthOrders(month, store_erpid || null);
    res.json({ success: true, data, month, store_erpid: store_erpid || null });
  } catch (err) {
    console.error('[Billing] 取得明細失敗：', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/sync
// 手動觸發帳單同步
// Body: { month?: 'YYYY-MM' }  — 指定月份時做全量月份同步；否則做增量同步
// ─────────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  const { month } = req.body || {};

  // 快速回應，背景執行
  res.json({ success: true, message: month ? `月份 ${month} 同步已啟動` : '增量同步已啟動' });

  try {
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        console.warn('[Billing] sync: month 格式錯誤', month);
        return;
      }
      const result = await syncMonth(month, 'manual');
      console.log(`[Billing] 手動月份同步完成（${month}）：${result.orders_synced} 筆`);
    } else {
      const result = await incrementalSync();
      console.log(`[Billing] 手動增量同步完成：${result.orders_synced} 筆`);
    }
  } catch (err) {
    console.error('[Billing] 手動同步失敗：', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/sync/logs
// 取得最近同步記錄（預設 10 筆）
// ─────────────────────────────────────────────────────────────
router.get('/sync/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const data  = await getRecentSyncLogs(limit);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[Billing] 取得同步記錄失敗：', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/order-detail/:sourceType/:sourceId
// 從市場 API 取得單一訂單完整明細（Method B，含 photo_urls、completion_notes）
// sourceType: repair | maintenance
// sourceId:   訂單 UUID (source_id)
// ─────────────────────────────────────────────────────────────
router.get('/order-detail/:sourceType/:sourceId', async (req, res) => {
  const { sourceType, sourceId } = req.params;
  const VALID_TYPES = ['repair', 'maintenance'];

  if (!VALID_TYPES.includes(sourceType)) {
    return res.status(400).json({
      success: false,
      message: `sourceType 必須為 repair 或 maintenance，收到：${sourceType}`,
    });
  }
  if (!sourceId || sourceId.length < 10) {
    return res.status(400).json({ success: false, message: 'sourceId 格式錯誤' });
  }

  try {
    const data = await getOrderDetail(sourceType, sourceId);
    res.json({ success: true, data });
  } catch (err) {
    const httpStatus = err.response?.status;
    console.error(`[Billing] 取得訂單明細失敗 (${sourceType}/${sourceId})：`, err.message);
    res.status(httpStatus || 500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/sync/education
// 僅同步教育訓練獎金（不觸發工程部同步）
// Body: { month?: 'YYYY-MM' }
// ─────────────────────────────────────────────────────────────
router.post('/sync/education', async (req, res) => {
  const { month } = req.body || {};
  const target = month || new Date().toISOString().slice(0, 7);

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: 'month 格式錯誤，請使用 YYYY-MM' });
  }

  res.json({ success: true, message: `教育訓練獎金同步已啟動（${target}）` });

  try {
    const { syncEducationBonus } = require('../services/educationBonusSync');
    const result = await syncEducationBonus(target);
    console.log(`[Billing] 教育訓練同步完成（${target}）：${result.synced} 筆`);
  } catch (err) {
    console.error('[Billing] 教育訓練同步失敗：', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/billing/sync/ad
// 僅同步企劃部廣告費（不觸發其他來源同步）
// Body: { month: 'YYYY-MM' }（必填）
// ─────────────────────────────────────────────────────────────
router.post('/sync/ad', async (req, res) => {
  const { month } = req.body || {};
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: 'month 必填，格式 YYYY-MM' });
  }

  res.json({ success: true, message: `企劃部廣告費同步已啟動（${month}）` });

  try {
    const { syncAdBudget } = require('../services/adBudgetSync');
    const result = await syncAdBudget(month);
    console.log(`[Billing] 廣告費同步完成（${month}）：${result.synced} 筆`);
  } catch (err) {
    console.error('[Billing] 廣告費同步失敗：', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/billing/debug?month=YYYY-MM
// 直接打市場 API，回傳原始結果，不寫 DB（除錯用）
// ─────────────────────────────────────────────────────────────
router.get('/debug', async (req, res) => {
  const { month } = req.query;
  const axios = require('axios');

  const apiKey = process.env.BILLING_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ success: false, message: 'BILLING_API_KEY 未設定' });
  }

  try {
    const resp = await axios.get(
      `${process.env.MARKET_BILLING_URL || 'https://market-backend-0544.onrender.com/api/billing'}/completed-orders`,
      {
        params:  { month: month || new Date().toISOString().slice(0, 7) },
        headers: { 'x-api-key': apiKey },
        timeout: 15000,
      }
    );

    const raw    = resp.data;
    const orders = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];

    res.json({
      success:      true,
      http_status:  resp.status,
      resp_data_type: Array.isArray(raw) ? 'array' : typeof raw,
      resp_data_keys: raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : null,
      orders_count: orders.length,
      first_order:  orders[0] || null,
    });
  } catch (err) {
    res.status(500).json({
      success:     false,
      http_status: err.response?.status || null,
      message:     err.message,
      resp_data:   err.response?.data || null,
    });
  }
});

module.exports = router;
