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
} = require('../services/billingService');

// 所有路由需 operation_lead 以上（app.js 掛載時已套 authenticate）
router.use(authorize('operation_lead', 'dept_head', 'super_admin'));

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

module.exports = router;
