// routes/permissions.js
// 分權系統 REST API
// 掛載點：/api/permissions（需登入）

const express = require('express');
const router  = express.Router();
const { authorize } = require('../middleware/auth');
const svc     = require('../services/permissionService');

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, e)  {
  console.error('[Permissions]', e.message);
  res.status(500).json({ success: false, message: e.message || '伺服器錯誤' });
}

// 任何登入者都可查自己能看的模組
router.get('/my-modules', async (req, res) => {
  try {
    ok(res, await svc.getMyModules(req.user?.role));
  } catch (e) { fail(res, e); }
});

// 列表（任何登入者可查）
router.get('/roles',       async (req, res) => { try { ok(res, await svc.listRoles()); }       catch (e) { fail(res, e); } });
router.get('/modules',     async (req, res) => { try { ok(res, await svc.listModules()); }     catch (e) { fail(res, e); } });
router.get('/permissions', async (req, res) => { try { ok(res, await svc.listPermissions()); } catch (e) { fail(res, e); } });

// 修改 — 限「全權」角色（is_admin=true）
router.use(authorize('super_admin', 'dept_head', 'operation_lead'));

router.put('/permission', async (req, res) => {
  try { ok(res, await svc.setPermission(req.body || {})); }
  catch (e) { fail(res, e); }
});

router.put('/permissions/bulk', async (req, res) => {
  try { ok(res, await svc.setPermissionsBulk(req.body?.items || [])); }
  catch (e) { fail(res, e); }
});

module.exports = router;
