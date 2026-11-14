// routes/expenseVouchers.js —— 帳單管理「🧾 報帳憑證」（2026-11-15）：列表／看一張（列印）／作廢
// 只有營運部（operation_*）與超級管理員
const express = require('express');
const router = express.Router();
const X = require('../services/expenseService');
const LV = require('../services/ledgerVouchers');
const guard = (req, res, next) => (LV.canSee(req.user) ? next() : res.status(403).json({ success: false, message: '報帳憑證只有營運部與超級管理員看得到' }));
const w = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req) }); } catch (e) { res.status(400).json({ success: false, message: e.message }); } };
router.use(guard);
router.get('/', w((req) => X.listVouchers(req.query || {})));
router.get('/:id', w(async (req) => { const v = await X.getVoucher(req.params.id); if (!v) throw new Error('找不到'); return v; }));
router.post('/:id/void', w((req) => X.voidVoucher(req.params.id, (req.user && (req.user.name || req.user.member_id)) || null)));
module.exports = router;
