// routes/systemUpdates.js
// 「系統更新」模組 REST API
// 掛載點：/api/system-updates（需登入）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/systemUpdateService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, e)  {
  console.error('[SystemUpdates]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// GET /api/system-updates/members
router.get('/members', async (req, res) => {
  try { ok(res, await svc.listMembers()); }
  catch (e) { fail(res, e); }
});

// GET /api/system-updates/members/:id/daily?days=14
router.get('/members/:id/daily', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, parseInt(req.query.days || '14', 10)));
    ok(res, await svc.dailyCommits(req.params.id, days));
  } catch (e) { fail(res, e); }
});

// GET /api/system-updates/members/:id/monthly?ym=2026-06
router.get('/members/:id/monthly', async (req, res) => {
  try {
    const ym = req.query.ym;
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
      return res.status(400).json({ success: false, message: 'ym 格式須為 YYYY-MM' });
    }
    ok(res, await svc.monthlySummary(req.params.id, ym));
  } catch (e) { fail(res, e); }
});

// GET /api/system-updates/months
router.get('/months', (req, res) => {
  ok(res, svc.listAvailableMonths());
});

module.exports = router;
