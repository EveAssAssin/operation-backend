// routes/expenseExternal.js —— 市場部諮詢頻道「費用申請」→ 營運部（2026-11-15，差旅費）
// 認證：x-api-key ＝ OPERATION_PAYMENT_API_KEY（市場部→營運部同一把，跟工務請款共用）
//   GET  /api/external/expense/meta                → 開帳單位、差旅費科目、投保單位清單
//   GET  /api/external/expense/employee?erpid=&app_number= → 人資系統的投保單位
//   POST /api/external/expense/post                → 審核通過：入月報＋二次薪加項
//   POST /api/external/expense/unpost              → 撤回
//   POST /api/external/expense/vouchers            → 開報帳憑證（黏存單／支出證明單）
//   GET  /api/external/expense/vouchers/:id        → 看一張（含單據簽名網址，列印用）
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const X = require('../services/expenseService');

router.use((req, res, next) => {
  const want = process.env.OPERATION_PAYMENT_API_KEY || '';
  if (!want) return res.status(500).json({ success: false, message: '伺服器未設定 API 金鑰' });
  const a = Buffer.from(String(req.header('x-api-key') || '')), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, message: 'invalid api key' });
  next();
});
const w = (fn) => async (req, res) => { try { res.json({ success: true, data: await fn(req) }); } catch (e) { console.warn('[expense ext]', req.path, e.message); res.status(400).json({ success: false, message: e.message }); } };
router.get('/meta', w(() => X.meta()));
router.get('/employee', w((req) => X.employee(req.query || {})));
router.post('/post', w((req) => X.post(req.body || {})));
router.post('/unpost', w((req) => X.unpost(String((req.body || {}).ref || ''), (req.body || {}).by)));
router.post('/vouchers', w((req) => X.voucher(req.body || {})));
router.get('/vouchers/:id', w((req) => X.getVoucher(req.params.id)));
module.exports = router;
