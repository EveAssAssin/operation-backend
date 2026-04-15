// routes/checks.js
// 支票紀錄系統 API

const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const svc = require('../services/checkService');

// 所有路由需登入
router.use(authenticate);

// ============================================================
// 支票批次
// ============================================================

/**
 * GET /api/checks/batches
 * 查詢批次列表
 * query: payee_type, status, q, page, limit
 */
router.get('/batches', async (req, res) => {
  try {
    const { payee_type, status, q, page = 1, limit = 20 } = req.query;
    const result = await svc.getBatches({
      payee_type, status, q,
      page: parseInt(page), limit: parseInt(limit),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/checks/batches/:id
 * 取得批次詳情（含所有支票）
 */
router.get('/batches/:id', async (req, res) => {
  try {
    const data = await svc.getBatchById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/checks/batches
 * 建立支票批次（含個別支票）
 * body: {
 *   payee_name, payee_type, purpose, notes,
 *   checks: [{ check_no, bank_name, bank_account, amount, due_date, notes }]
 * }
 */
router.post('/batches', authorize('billing.create'), async (req, res) => {
  try {
    const { payee_name, payee_type, purpose, notes, checks = [] } = req.body;

    if (!payee_name) {
      return res.status(400).json({ success: false, message: '缺少必填欄位：payee_name' });
    }
    if (checks.length === 0) {
      return res.status(400).json({ success: false, message: '至少需要一張支票' });
    }

    // 驗證每張支票
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      if (!c.amount || !c.due_date) {
        return res.status(400).json({
          success: false,
          message: `第 ${i + 1} 張支票缺少 amount 或 due_date`,
        });
      }
    }

    const data = await svc.createBatch(
      { payee_name, payee_type: payee_type || 'vendor', purpose, notes },
      checks,
      req.user.id,
    );

    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/checks/batches/:id
 * 更新批次基本資訊（payee_name, purpose, notes）
 */
router.patch('/batches/:id', authorize('billing.create'), async (req, res) => {
  try {
    const data = await svc.updateBatch(req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 個別支票操作
// ============================================================

/**
 * PATCH /api/checks/:id
 * 更新支票資訊（僅 pending 狀態）
 */
router.patch('/:id', authorize('billing.create'), async (req, res) => {
  try {
    const data = await svc.updateCheck(req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) {
    const code = err.message.includes('只有待兌現') ? 422 : 500;
    res.status(code).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/checks/:id/pay
 * 標記支票為已付款
 */
router.post('/:id/pay', authorize('billing.create'), async (req, res) => {
  try {
    const data = await svc.payCheck(req.params.id, req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/checks/:id/void
 * 作廢支票
 * body: { void_reason }
 */
router.post('/:id/void', authorize('billing.confirm'), async (req, res) => {
  try {
    const { void_reason } = req.body;
    const data = await svc.voidCheck(req.params.id, void_reason, req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// 到期查詢
// ============================================================

/**
 * GET /api/checks/due
 * 取得今日（或指定日期）到期的支票
 * query: date=YYYY-MM-DD（不填則今天）
 */
router.get('/due', async (req, res) => {
  try {
    const data = await svc.getDueChecks(req.query.date || null);
    const total = data.reduce((s, c) => s + parseFloat(c.amount), 0);
    res.json({ success: true, data, total_amount: total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/checks/upcoming
 * 取得近 N 天內到期的支票
 * query: days=7
 */
router.get('/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const data = await svc.getUpcomingChecks(days);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// LINE 通知名單
// ============================================================

/**
 * GET /api/checks/notify-targets
 * 取得通知名單
 */
router.get('/notify-targets', authorize('billing.manage'), async (req, res) => {
  try {
    const data = await svc.getNotifyTargets();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/checks/notify-targets
 * 新增通知目標
 * body: { name, app_number, notes }
 */
router.post('/notify-targets', authorize('billing.manage'), async (req, res) => {
  try {
    const data = await svc.createNotifyTarget(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/checks/notify-targets/:id
 * 更新通知目標（啟用/停用）
 */
router.patch('/notify-targets/:id', authorize('billing.manage'), async (req, res) => {
  try {
    const data = await svc.updateNotifyTarget(req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/checks/notify-targets/:id
 * 刪除通知目標
 */
router.delete('/notify-targets/:id', authorize('billing.manage'), async (req, res) => {
  try {
    await svc.deleteNotifyTarget(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/checks/notify-targets/test
 * 手動觸發今日通知（測試用）
 */
router.post('/notify-targets/test', authorize('billing.manage'), async (req, res) => {
  try {
    const { sendCheckDueNotification } = require('../jobs/checkNotify');
    const result = await sendCheckDueNotification();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
