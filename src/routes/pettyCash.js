// routes/pettyCash.js —— 零用金管理（2026-11）
//   GET    /api/petty-cash/funds[?all=1]           金庫清單＋餘額
//   POST   /api/petty-cash/funds                    新增金庫
//   PATCH  /api/petty-cash/funds/:id                修改／停用
//   GET    /api/petty-cash/txns?fund_id=&from=&to=&direction=&keyword=&include_void=1
//   POST   /api/petty-cash/txns                     新增收入／支出（支出可同步開帳列入門市月報）
//   PATCH  /api/petty-cash/txns/:id                 改說明類欄位
//   POST   /api/petty-cash/txns/:id/void {reason}   作廢（開帳的月報列一起作廢）
//   GET/POST /api/petty-cash/txns/:id/files         單據照片（存在開帳憑證 bucket，ref_type=petty）
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authorizeModule } = require('../middleware/auth');
const svc = require('../services/pettyCashService');
const LV = require('../services/ledgerVouchers');

const view = authorizeModule('petty_cash', 'view');
const edit = authorizeModule('petty_cash', 'edit');
const who = (req) => (req.user && (req.user.name || req.user.member_id)) || null;
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, e) => res.status(400).json({ success: false, message: (e && e.message) || String(e) });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

router.get('/funds', view, async (req, res) => { try { ok(res, await svc.listFunds({ all: req.query.all === '1' })); } catch (e) { bad(res, e); } });
router.post('/funds', edit, async (req, res) => { try { ok(res, await svc.saveFund(null, req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.patch('/funds/:id', edit, async (req, res) => { try { ok(res, await svc.saveFund(req.params.id, req.body || {}, who(req))); } catch (e) { bad(res, e); } });

router.get('/txns', view, async (req, res) => {
  try { ok(res, await svc.listTxns({ ...req.query, include_void: req.query.include_void === '1' })); } catch (e) { bad(res, e); }
});
router.post('/txns', edit, async (req, res) => { try { ok(res, await svc.createTxn(req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.patch('/txns/:id', edit, async (req, res) => { try { ok(res, await svc.updateTxn(req.params.id, req.body || {})); } catch (e) { bad(res, e); } });
router.post('/txns/:id/void', edit, async (req, res) => { try { ok(res, await svc.voidTxn(req.params.id, (req.body || {}).reason, who(req))); } catch (e) { bad(res, e); } });

router.get('/txns/:id/files', view, async (req, res) => { try { ok(res, await LV.list('petty', req.params.id)); } catch (e) { bad(res, e); } });
router.post('/txns/:id/files', edit, upload.array('files', 10), async (req, res) => {
  try {
    const out = [];
    for (const f of req.files || []) out.push(await LV.upload('petty', req.params.id, f, who(req), null));
    ok(res, out);
  } catch (e) { bad(res, e); }
});
router.delete('/files/:fileId', edit, async (req, res) => { try { ok(res, await LV.voidOne(req.params.fileId, who(req))); } catch (e) { bad(res, e); } });

module.exports = router;
