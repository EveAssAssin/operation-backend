// routes/bankLedger.js —— 金流 → 銀存彙整（2026-11）
//   GET/POST/PATCH /accounts          帳戶
//   POST /import (multipart file[, account_id])   匯入網銀明細（檔案沒帳號 → 回 need_account，前端選了帳戶再送一次）
//   GET /imports  DELETE /imports/:id 撤銷整次匯入
//   GET /txns  PATCH /txns/:id  POST /txns/bulk
//   GET/POST /rules  DELETE /rules/:id  POST /rules/reapply
//   GET /stores  GET /meta  GET /summary/store-deposits?ym=  GET /summary/daily?from=&to=
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authorizeModule } = require('../middleware/auth');
const svc = require('../services/bankLedgerService');

const view = authorizeModule('bank_ledger', 'view');
const edit = authorizeModule('bank_ledger', 'edit');
const who = (req) => (req.user && (req.user.name || req.user.member_id)) || null;
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, e) => res.status(400).json({ success: false, message: (e && e.message) || String(e) });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.get('/meta', view, async (req, res) => { try { const c = await svc.categories(); ok(res, { categories: c.all, custom_categories: c.custom, stores: await svc.stores() }); } catch (e) { bad(res, e); } });
router.post('/categories', edit, async (req, res) => { try { ok(res, await svc.addCategory((req.body || {}).name)); } catch (e) { bad(res, e); } });
router.delete('/categories/:name', edit, async (req, res) => { try { ok(res, await svc.removeCategory(req.params.name)); } catch (e) { bad(res, e); } });
router.get('/stores', view, async (req, res) => { try { ok(res, await svc.stores()); } catch (e) { bad(res, e); } });

router.get('/accounts', view, async (req, res) => { try { ok(res, await svc.listAccounts()); } catch (e) { bad(res, e); } });
router.post('/accounts', edit, async (req, res) => { try { ok(res, await svc.saveAccount(null, req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.patch('/accounts/:id', edit, async (req, res) => { try { ok(res, await svc.saveAccount(req.params.id, req.body || {}, who(req))); } catch (e) { bad(res, e); } });

// 餘額核對
router.get('/accounts/:id/verify', view, async (req, res) => { try { ok(res, await svc.verifyAccount(req.params.id)); } catch (e) { bad(res, e); } });

// 網銀帳密（查看要輸入查看密碼）
const cred = require('../services/bankCredService');
const isBoss = (req) => ['super_admin', 'operation_lead'].includes(req.user && req.user.role);
router.get('/cred/status', view, async (req, res) => { try { ok(res, { ...(await cred.status()), can_reset: isBoss(req) }); } catch (e) { bad(res, e); } });
router.post('/cred/pin', edit, async (req, res) => { try { ok(res, await cred.setPin(req.body || {}, who(req), isBoss(req))); } catch (e) { bad(res, e); } });
router.post('/cred/check', view, async (req, res) => { try { await cred.checkPin((req.body || {}).pin, who(req)); ok(res, { ok: true }); } catch (e) { bad(res, e); } });
router.post('/accounts/:id/cred/reveal', view, async (req, res) => { try { ok(res, await cred.reveal(req.params.id, (req.body || {}).pin, who(req))); } catch (e) { bad(res, e); } });
router.put('/accounts/:id/cred', edit, async (req, res) => { try { ok(res, await cred.save(req.params.id, (req.body || {}).pin, (req.body || {}).fields, who(req))); } catch (e) { bad(res, e); } });
router.get('/cred/logs', edit, async (req, res) => { try { ok(res, await cred.logs(req.query.account_id)); } catch (e) { bad(res, e); } });

router.post('/import', edit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('請選檔案');
    const fileName = Buffer.from(req.file.originalname || 'file', 'latin1').toString('utf8');
    const r = await svc.importFile({ buffer: req.file.buffer, fileName, account_id: (req.body || {}).account_id || null, by: who(req) });
    // 匯入的是現金銀存專用本子 → 順手跟門市上繳回報對帳（2026-11-24）
    if (r && r.account && r.import_id) {
      try {
        const CD = require('../services/cashDepositReview');
        if ((await CD.cashBooks()).some((b) => b.id === r.account.id)) r.cash_reconcile = await CD.reconcile(who(req) ? `匯入後自動對帳（${who(req)}）` : '匯入後自動對帳');
      } catch (e) { r.cash_reconcile = { error: e.message }; }
    }
    ok(res, r);
  } catch (e) { bad(res, e); }
});
router.get('/imports', view, async (req, res) => { try { ok(res, await svc.listImports(req.query.account_id)); } catch (e) { bad(res, e); } });
router.delete('/imports/:id', edit, async (req, res) => { try { ok(res, await svc.undoImport(req.params.id, who(req))); } catch (e) { bad(res, e); } });

router.get('/txns', view, async (req, res) => { try { ok(res, await svc.listTxns(req.query || {})); } catch (e) { bad(res, e); } });
router.post('/txns', edit, async (req, res) => { try { ok(res, await svc.createManual(req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.put('/txns/:id', edit, async (req, res) => { try { ok(res, await svc.updateManual(req.params.id, req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.delete('/txns/:id', edit, async (req, res) => { try { ok(res, await svc.deleteManual(req.params.id)); } catch (e) { bad(res, e); } });
router.patch('/txns/:id', edit, async (req, res) => { try { ok(res, await svc.updateTxn(req.params.id, req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.post('/txns/bulk', edit, async (req, res) => { try { ok(res, await svc.bulkUpdate((req.body || {}).ids, req.body || {}, who(req))); } catch (e) { bad(res, e); } });

router.get('/rules', view, async (req, res) => { try { ok(res, await svc.listRules()); } catch (e) { bad(res, e); } });
router.post('/rules', edit, async (req, res) => { try { ok(res, await svc.addRule(req.body || {}, who(req))); } catch (e) { bad(res, e); } });
router.delete('/rules/:id', edit, async (req, res) => { try { ok(res, await svc.deleteRule(req.params.id)); } catch (e) { bad(res, e); } });
router.post('/rules/reapply', edit, async (req, res) => { try { ok(res, { updated: await svc.reapply() }); } catch (e) { bad(res, e); } });

router.get('/summary/store-deposits', view, async (req, res) => {
  try { ok(res, await svc.storeDeposits({ ym: req.query.ym, categories: req.query.categories ? String(req.query.categories).split(',') : null })); } catch (e) { bad(res, e); }
});
router.get('/summary/daily', view, async (req, res) => { try { ok(res, await svc.dailySummary(req.query || {})); } catch (e) { bad(res, e); } });

module.exports = router;
