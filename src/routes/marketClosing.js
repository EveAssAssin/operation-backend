// routes/marketClosing.js —— 結帳資料（門市每月繳交清點）：代理市場部 internal API（2026-10-21）
// 資料在市場部庫（門市在營運工具填）；營運部這裡清點、通過／退回、支出憑證核對、清單設定（示範照片）、截止日
//   GET  /api/closing/overview?ym=
//   GET  /api/closing/submissions/:id[?refresh=1]      GET /api/closing/by-store?store=&ym=
//   PUT  /api/closing/submissions/:id/items/:item      { check_status, check_note }
//   POST /api/closing/submissions/:id/status           { status: reviewing|approved|returned, note }
//   POST /api/closing/submissions/:id/rating           { rating_closing, rating_expense 1～5, rating_note }（通過後；店長評核讀）
//   PUT  /api/closing/receipts/:pay_id                 { status, review_note, photos? }
//   GET/PUT /api/closing/templates   POST /api/closing/upload   GET/PUT /api/closing/settings
// 認證：登入＋operation_staff 以上；呼叫市場部帶 x-internal-key＝MARKET_INTERNAL_KEY，操作者＝x-actor／x-actor-name
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { authorize } = require('../middleware/auth');

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';
router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

async function fwd(req, res, method, path, { params, data, timeout = 90000 } = {}) {
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) return res.status(503).json({ success: false, message: '營運部沒設 MARKET_INTERNAL_KEY' });
  try {
    const r = await axios({ method, url: `${MARKET_BASE}/api/internal/closing${path}`, params, data, timeout,
      headers: { 'x-internal-key': key, 'x-actor': String(req.user?.member_id || req.user?.id || 'operation'), 'x-actor-name': encodeURIComponent(String(req.user?.name || '營運部')) } });
    res.status(r.status).json(r.data);
  } catch (e) {
    if (e.response) return res.status(e.response.status).json(e.response.data);
    res.status(502).json({ success: false, message: `市場部：${e.message}` });
  }
}
router.get('/overview', (req, res) => fwd(req, res, 'get', '/overview', { params: { ym: req.query.ym } }));
router.get('/by-store', (req, res) => fwd(req, res, 'get', '/by-store', { params: { store: req.query.store, ym: req.query.ym } }));
router.get('/submissions/:id', (req, res) => fwd(req, res, 'get', `/submissions/${req.params.id}`, { params: { refresh: req.query.refresh } }));
router.put('/submissions/:id/items/:item', (req, res) => fwd(req, res, 'put', `/submissions/${req.params.id}/items/${req.params.item}`, { data: req.body }));
router.post('/submissions/:id/status', (req, res) => fwd(req, res, 'post', `/submissions/${req.params.id}/status`, { data: req.body }));
router.post('/submissions/:id/rating', (req, res) => fwd(req, res, 'post', `/submissions/${req.params.id}/rating`, { data: req.body }));   // 會計評價（2026-10-21）
router.put('/receipts/:pay_id', (req, res) => fwd(req, res, 'put', `/receipts/${req.params.pay_id}`, { data: req.body }));
router.post('/upload', (req, res) => fwd(req, res, 'post', '/upload', { data: req.body, timeout: 60000 }));
router.get('/templates', (req, res) => fwd(req, res, 'get', '/templates'));
router.put('/templates', (req, res) => fwd(req, res, 'put', '/templates', { data: req.body }));
router.get('/settings', (req, res) => fwd(req, res, 'get', '/settings'));
router.put('/settings', (req, res) => fwd(req, res, 'put', '/settings', { data: req.body }));
module.exports = router;
