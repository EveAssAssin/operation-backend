// routes/contracts.js
// 合約管理模組 REST API
// 掛載點：/api/contracts（需登入）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/contractService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data) { res.json({ success: true, data }); }
function bad(res, msg) { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)  {
  console.error('[Contracts]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// GET /api/contracts?type=rent&status=active
router.get('/', async (req, res) => {
  try {
    ok(res, await svc.listContracts({
      type:   req.query.type   || null,
      status: req.query.status || 'active',
    }));
  } catch (e) { fail(res, e); }
});

// GET /api/contracts/expiring?days=60
router.get('/expiring', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || '60', 10)));
    ok(res, await svc.listExpiring({ days, includeOverdue: req.query.include_overdue !== 'false' }));
  } catch (e) { fail(res, e); }
});

// GET /api/contracts/:id
router.get('/:id', async (req, res) => {
  try {
    const c = await svc.getContract(req.params.id);
    if (!c) return bad(res, '找不到該合約');
    ok(res, c);
  } catch (e) { fail(res, e); }
});

// POST /api/contracts
router.post('/', async (req, res) => {
  try {
    const createdBy = req.user?.member_id || null;
    ok(res, await svc.createContract(req.body, createdBy));
  } catch (e) { fail(res, e); }
});

// PATCH /api/contracts/:id
router.patch('/:id', async (req, res) => {
  try { ok(res, await svc.updateContract(req.params.id, req.body)); }
  catch (e) { fail(res, e); }
});

// DELETE /api/contracts/:id（軟刪除）
router.delete('/:id', async (req, res) => {
  try {
    await svc.deleteContract(req.params.id);
    ok(res, { archived: true });
  } catch (e) { fail(res, e); }
});

// ── Reminder ────────────────────────────────────────────
router.get('/:id/reminders',  async (req, res) => {
  try { ok(res, await svc.listReminders(req.params.id)); } catch (e) { fail(res, e); }
});
router.put('/:id/reminders',  async (req, res) => {
  try { ok(res, await svc.upsertReminders(req.params.id, req.body?.reminders || [])); }
  catch (e) { fail(res, e); }
});

module.exports = router;
