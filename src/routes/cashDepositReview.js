// routes/cashDepositReview.js —— 金流 → 銀存審核（2026-11-24）掛 /api/cash-deposit（模組 cash_deposit）
//   GET  /overview?ym=          每家店應繳／已通過／待審／不符／沒繳
//   GET  /deposits?status=&store=   上繳清單      GET /deposits/:id（含涵蓋的結算）
//   GET  /deposits/:id/candidates   本子裡可能是哪一筆
//   POST /deposits/:id/review   { action: approve|reject, note, bank_txn_id? }
//   POST /reconcile             立即自動對帳
//   GET  /unmatched-book?from=  本子有存入、沒對到上繳
//   GET/PUT /cash-books { ids }  現金銀存專用本子
//   GET/PUT /settings { start_date, overdue_days }   POST /sync { backfill? }
const express = require('express');
const router = express.Router();
const { authorizeModule } = require('../middleware/auth');
const S = require('../services/cashDepositReview');
const view = authorizeModule('cash_deposit', 'view');
const edit = authorizeModule('cash_deposit', 'edit');
const actor = (req) => ({ app: String((req.user && (req.user.member_id || req.user.id)) || 'operation'), name: String((req.user && req.user.name) || '營運部') });
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, e) => res.status(400).json({ success: false, message: (e && e.message) || String(e) });
const h = (fn) => async (req, res) => { try { ok(res, await fn(req)); } catch (e) { bad(res, e); } };

router.get('/overview', view, h((req) => S.market('get', '/overview', { params: { ym: req.query.ym } })));
router.get('/deposits', view, h((req) => S.market('get', '/deposits', { params: { status: req.query.status, store: req.query.store, limit: req.query.limit } })));
router.get('/deposits/:id', view, h((req) => S.market('get', `/deposits/${req.params.id}`)));
router.get('/deposits/:id/candidates', view, h((req) => S.candidates(req.params.id)));
router.post('/deposits/:id/review', edit, h((req) => S.review(req.params.id, req.body || {}, actor(req))));
router.post('/reconcile', edit, h((req) => S.reconcile(actor(req).name)));
router.get('/unmatched-book', view, h((req) => S.unmatchedBook(req.query.from)));
router.get('/cash-books', view, h(() => S.cashBooks()));
router.put('/cash-books', edit, h((req) => S.setCashBooks((req.body || {}).ids)));
router.get('/settings', view, h(() => S.market('get', '/settings')));
router.put('/settings', edit, h((req) => S.market('put', '/settings', { data: req.body || {} })));
router.post('/sync', edit, h((req) => S.market('post', '/sync', { data: req.body || {} })));
module.exports = router;
