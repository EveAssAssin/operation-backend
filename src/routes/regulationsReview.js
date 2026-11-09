// routes/regulationsReview.js — 推播連結進入的規範審核（不需登入；用審核票券）2026-11-09
//   掛在 /api/regulations-review；每個請求帶 header x-review-ticket（見 services/reviewTicket.js）
//   GET  /me                 → { scope, version_id, reviewer, expires_at }
//   GET  /list               → 待審清單（票券範圍 v＝只回那一份）
//   GET  /:vid               → 審核詳情（同後台 /api/regulations/reviews/:vid）
//   POST /:vid/approve       { notify_staff, notice }   （不開放修改內容；要改內容請到後台）
//   POST /:vid/return        { reason }
//   POST /approve-low        低風險全部通過（只有範圍 p 的票券）
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const T = require('../services/reviewTicket');
const svc = require('../services/regulationService');

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, e, code = 400) => res.status(e.status || code).json({ success: false, message: e.message, ...(e.code ? { code: e.code } : {}) });
router.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { success: false, message: '操作太頻繁，請過幾分鐘再試' } }));

router.get('/status', (req, res) => ok(res, { configured: T.configured() }));   // 只回有沒有設定密鑰（不回任何值）
// 票券 → 現任審核人身分（a 必須等於現在設定的審核人）
router.use(async (req, res, next) => {
  try {
    const p = T.parse(req.headers['x-review-ticket']);
    const rv = await svc.getReviewer();
    if (!rv?.app_number || String(rv.app_number) !== String(p.a)) throw Object.assign(new Error('這個連結的審核人已經換人，請從後台審核'), { status: 403, code: 'NOT_REVIEWER' });
    req.ticket = p;
    req.user = { id: `app:${rv.app_number}`, member_id: String(rv.app_number), name: rv.name, erpid: rv.erpid, role: 'app_staff', via: 'review_ticket' };
    next();
  } catch (e) { fail(res, e, 401); }
});
const allow = (req, vid) => {
  if (req.ticket.s === 'p') return true;
  if (Number(req.ticket.v) === Number(vid)) return true;
  throw Object.assign(new Error('這個連結只能審核原本那一份'), { status: 403, code: 'SCOPE' });
};

router.get('/me', (req, res) => ok(res, { scope: req.ticket.s, version_id: req.ticket.v || null, reviewer: { name: req.user.name }, expires_at: new Date(req.ticket.e * 1000).toISOString() }));
router.get('/list', async (req, res) => {
  try {
    const rows = await svc.listReviews('pending');
    ok(res, req.ticket.s === 'p' ? rows : rows.filter((r) => Number(r.id) === Number(req.ticket.v)));
  } catch (e) { fail(res, e, 500); }
});
router.post('/approve-low', async (req, res) => {
  try { if (req.ticket.s !== 'p') return fail(res, Object.assign(new Error('這個連結只能審核原本那一份'), { status: 403 })); ok(res, await svc.approveAllLow(req.user)); } catch (e) { fail(res, e); }
});
router.get('/:vid', async (req, res) => {
  try { if (!/^\d+$/.test(req.params.vid)) return fail(res, new Error('版本錯誤'), 400); allow(req, req.params.vid); ok(res, await svc.getReview(req.params.vid)); } catch (e) { fail(res, e, 404); }
});
router.post('/:vid/approve', async (req, res) => {
  try { allow(req, req.params.vid); ok(res, await svc.approve(req.params.vid, req.user, { notifyStaff: !!req.body?.notify_staff, notice: req.body?.notice })); } catch (e) { fail(res, e); }
});
router.post('/:vid/return', async (req, res) => {
  try { allow(req, req.params.vid); ok(res, await svc.returnVersion(req.params.vid, req.user, req.body?.reason)); } catch (e) { fail(res, e); }
});

module.exports = router;
