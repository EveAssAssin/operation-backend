// routes/scheduledNotify.js
// 「排程推播」REST API
// 掛載點：/api/scheduled-notify（需登入）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/scheduledNotifyService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, e)  {
  console.error('[ScheduledNotify]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}
function actorFromReq(req) {
  return { app_number: req.user?.member_id || null, name: req.user?.name || null };
}

// 輔助
router.get('/options/system-users', async (req, res) => { try { ok(res, await svc.listSystemUsers()); } catch (e) { fail(res, e); } });
router.get('/options/roles',        async (req, res) => { try { ok(res, svc.listRoles()); }            catch (e) { fail(res, e); } });
router.get('/options/variables',    async (req, res) => { try { ok(res, svc.listVariables()); }        catch (e) { fail(res, e); } });

// 預覽：渲染訊息（不寄出）
router.post('/preview', async (req, res) => {
  try {
    const rendered = svc.renderMessage(req.body?.message || '');
    const next     = svc.computeNextRunAt(req.body?.schedule_type, req.body?.schedule_config || {});
    ok(res, { rendered, next_run_at: next });
  } catch (e) { fail(res, e); }
});

// CRUD
router.get   ('/',      async (req, res) => { try { ok(res, await svc.list()); }                                          catch (e) { fail(res, e); } });
router.get   ('/:id',   async (req, res) => { try { ok(res, await svc.get(req.params.id)); }                              catch (e) { fail(res, e); } });
router.post  ('/',      async (req, res) => { try { ok(res, await svc.create(req.body || {}, actorFromReq(req))); }       catch (e) { fail(res, e); } });
router.patch ('/:id',   async (req, res) => { try { ok(res, await svc.update(req.params.id, req.body || {}, actorFromReq(req))); } catch (e) { fail(res, e); } });
router.delete('/:id',   async (req, res) => { try { ok(res, await svc.remove(req.params.id)); }                           catch (e) { fail(res, e); } });

// 立即執行（測試用）
router.post('/:id/run-now', async (req, res) => {
  try { ok(res, await svc.executeNow(req.params.id)); }
  catch (e) { fail(res, e); }
});

// 歷史紀錄
router.get('/:id/logs', async (req, res) => {
  try { ok(res, await svc.listLogs({ notification_id: req.params.id, limit: req.query.limit })); }
  catch (e) { fail(res, e); }
});
router.get('/logs/all', async (req, res) => {
  try { ok(res, await svc.listLogs({ limit: req.query.limit })); }
  catch (e) { fail(res, e); }
});

module.exports = router;
