// routes/pointRedemption.js
// 分數兌換模組路由
//
//   公開端點（員工自助，不需登入，用 app_number 驗證）
//     GET  /api/point-redemption/public/verify?app_number=
//     GET  /api/point-redemption/public/catalog
//     GET  /api/point-redemption/public/balance?app_number=
//     POST /api/point-redemption/public/redeem            { app_number, item_id }
//     GET  /api/point-redemption/public/redemptions?app_number=
//
//   管理端點（需登入）
//     GET    /api/point-redemption/items
//     POST   /api/point-redemption/items
//     PUT    /api/point-redemption/items/:id
//     DELETE /api/point-redemption/items/:id
//     GET    /api/point-redemption/redemptions
//     POST   /api/point-redemption/redemptions/:id/approve   審核通過（扣分+回寫MAP）
//     POST   /api/point-redemption/redemptions/:id/reject    駁回（body: reason）
//     POST   /api/point-redemption/redemptions/:id/fulfill   實體獎品標記發放
//     GET    /api/point-redemption/balance/:erpid

const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth');
const svc = require('../services/pointRedemptionService');

function ok(res, data)            { res.json({ success: true, data }); }
function fail(res, e, code = 400) {
  console.error('[PointRedemption]', e.message);
  res.status(code).json({ success: false, message: e.message || '操作失敗' });
}

// ═══════════════════════════════════════════════════════════
// 公開端點（員工自助）
// ═══════════════════════════════════════════════════════════

// 驗證員工身份
router.get('/public/verify', async (req, res) => {
  try {
    const emp = await svc.verifyEmployee(req.query.app_number);
    ok(res, emp);
  } catch (e) { fail(res, e, 404); }
});

// 兌換品項清單（只回上架中）
router.get('/public/catalog', async (req, res) => {
  try {
    const items = await svc.listItems({ activeOnly: true });
    ok(res, items);
  } catch (e) { fail(res, e); }
});

// 查餘額（含員工資料）
router.get('/public/balance', async (req, res) => {
  try {
    const emp     = await svc.verifyEmployee(req.query.app_number);
    const balance = await svc.getBalance(emp.erpid);
    ok(res, { employee: emp, balance });
  } catch (e) { fail(res, e); }
});

// 兌換
router.post('/public/redeem', async (req, res) => {
  try {
    const { app_number, item_id } = req.body || {};
    if (!app_number) throw new Error('缺少員工編號 app_number');
    if (!item_id)    throw new Error('缺少兌換品項 item_id');
    const result = await svc.redeem({ app_number, item_id });
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// 我的兌換紀錄
router.get('/public/redemptions', async (req, res) => {
  try {
    const emp  = await svc.verifyEmployee(req.query.app_number);
    const rows = await svc.listRedemptions({ erpid: emp.erpid });
    ok(res, rows);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════════════════
// 以下為管理端點，需登入
// ═══════════════════════════════════════════════════════════
router.use(authenticate);

// ── 兌換品項管理 ──────────────────────────────────────────
router.get('/items', async (req, res) => {
  try {
    const items = await svc.listItems({ activeOnly: false });
    ok(res, items);
  } catch (e) { fail(res, e); }
});

router.post('/items', async (req, res) => {
  try {
    const row = await svc.createItem(req.body || {});
    ok(res, row);
  } catch (e) { fail(res, e); }
});

router.put('/items/:id', async (req, res) => {
  try {
    const row = await svc.updateItem(req.params.id, req.body || {});
    ok(res, row);
  } catch (e) { fail(res, e); }
});

router.delete('/items/:id', async (req, res) => {
  try {
    await svc.deleteItem(req.params.id);
    ok(res, { id: req.params.id });
  } catch (e) { fail(res, e); }
});

// ── 兌換紀錄 ──────────────────────────────────────────────
router.get('/redemptions', async (req, res) => {
  try {
    const { status, erpid, limit } = req.query;
    const rows = await svc.listRedemptions({ status, erpid, limit });
    ok(res, rows);
  } catch (e) { fail(res, e); }
});

// 審核通過（扣分 + 回寫 MAP + 通知員工）
router.post('/redemptions/:id/approve', async (req, res) => {
  try {
    const approver = req.user?.name || '營運部';
    const result = await svc.approveRedemption(req.params.id, approver);
    ok(res, result);
  } catch (e) { fail(res, e); }
});

// 駁回（不扣分 + 通知員工）
router.post('/redemptions/:id/reject', async (req, res) => {
  try {
    const approver = req.user?.name || '營運部';
    const reason   = req.body?.reason;
    const row = await svc.rejectRedemption(req.params.id, approver, reason);
    ok(res, row);
  } catch (e) { fail(res, e); }
});

router.post('/redemptions/:id/fulfill', async (req, res) => {
  try {
    const by  = req.user?.name || req.body?.fulfilled_by || null;
    const row = await svc.fulfill(req.params.id, by);
    ok(res, row);
  } catch (e) { fail(res, e); }
});

// ── 管理者查任一員工餘額 ──────────────────────────────────
router.get('/balance/:erpid', async (req, res) => {
  try {
    const balance = await svc.getBalance(req.params.erpid);
    ok(res, balance);
  } catch (e) { fail(res, e); }
});

module.exports = router;
