// routes/recurringExpenses.js
// 常態費用模組 REST API
// 掛載點：/api/recurring-expenses（需登入，operation_staff 以上）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/recurringExpenseService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ── 工具 ────────────────────────────────────────────────────
function ok(res, data)   { res.json({ success: true, data }); }
function bad(res, msg)   { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)    {
  console.error('[RecurringExpenses]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}


// ════════════════════════════════════════════════════════════
// 開帳對象選項
// ════════════════════════════════════════════════════════════

// GET /api/recurring-expenses/options/stores
router.get('/options/stores', async (req, res) => {
  try { ok(res, await svc.listStores()); }
  catch (e) { fail(res, e); }
});

// GET /api/recurring-expenses/options/departments
router.get('/options/departments', async (req, res) => {
  try { ok(res, await svc.listDepartments()); }
  catch (e) { fail(res, e); }
});


// ════════════════════════════════════════════════════════════
// 應付紀錄（payments）
// ════════════════════════════════════════════════════════════

// GET /api/recurring-expenses/payments?month=YYYY-MM
// 列出指定月份所有 payments（不傳 month = 本月）
// 同時會「補建」當月缺失的 payment 紀錄
router.get('/payments', async (req, res) => {
  try {
    let month = req.query.month;
    if (month && !/^\d{4}-\d{2}$/.test(month)) return bad(res, 'month 格式錯誤，請用 YYYY-MM');
    const today = svc.todayStr();
    const targetMonth = month || today.slice(0, 7);

    // 如果是本月，自動補建缺漏的 payment row
    if (targetMonth === today.slice(0, 7)) {
      await svc.ensureCurrentMonthPayments();
    }

    const payments = await svc.listPaymentsByMonth(targetMonth);
    ok(res, { month: targetMonth, payments });
  } catch (e) { fail(res, e); }
});

// GET /api/recurring-expenses/payments/today
// 今日到期且未付的 payments
router.get('/payments/today', async (req, res) => {
  try {
    await svc.ensureCurrentMonthPayments();
    const result = await svc.getTodayDuePayments();
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// POST /api/recurring-expenses/payments/:id/pay
// body: { paid_note }
router.post('/payments/:id/pay', async (req, res) => {
  try {
    const paidBy = req.user?.member_id || null;
    const data   = await svc.markPaid(req.params.id, paidBy, req.body?.paid_note);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recurring-expenses/payments/:id/unpay
router.post('/payments/:id/unpay', async (req, res) => {
  try {
    const data = await svc.unmarkPaid(req.params.id);
    ok(res, data);
  } catch (e) { fail(res, e); }
});


// ════════════════════════════════════════════════════════════
// 費用主檔 CRUD
// ════════════════════════════════════════════════════════════

// GET /api/recurring-expenses
router.get('/', async (req, res) => {
  try {
    const active = req.query.active === 'true'  ? true
                 : req.query.active === 'false' ? false
                 : null;
    ok(res, await svc.listExpenses({ active }));
  } catch (e) { fail(res, e); }
});

// GET /api/recurring-expenses/:id
router.get('/:id', async (req, res) => {
  try {
    const data = await svc.getExpense(req.params.id);
    if (!data) return bad(res, '找不到該費用項目');
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/recurring-expenses
router.post('/', async (req, res) => {
  try {
    const createdBy = req.user?.member_id || null;
    const data      = await svc.createExpense(req.body || {}, createdBy);
    ok(res, data);
  } catch (e) {
    if (e.message?.includes('必填') || e.message?.includes('必須')) return bad(res, e.message);
    fail(res, e);
  }
});

// PATCH /api/recurring-expenses/:id
router.patch('/:id', async (req, res) => {
  try {
    const data = await svc.updateExpense(req.params.id, req.body || {});
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// DELETE /api/recurring-expenses/:id  → 軟刪除（is_active = false）
router.delete('/:id', async (req, res) => {
  try {
    await svc.deleteExpense(req.params.id);
    ok(res, { id: req.params.id });
  } catch (e) { fail(res, e); }
});


module.exports = router;
