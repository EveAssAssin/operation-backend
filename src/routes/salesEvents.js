// routes/salesEvents.js
// 業績系統活動模組 — 代理 sales-analysis-backend API
// 需登入（operation_staff 以上）

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { authorize } = require('../middleware/auth');

const SALES_BASE = 'https://sales-analysis-backend.onrender.com';
const SALES_KEY  = 'lohas-op-2026';

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ── 工具 ──────────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function bad(res, msg)  { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)   {
  console.error('[SalesEvents]', e.message);
  const status  = e.response?.status  || 500;
  const message = e.response?.data?.message || e.response?.data?.detail || e.message;
  res.status(status).json({ success: false, message });
}

async function salesReq(method, path, data, params) {
  const cfg = {
    method,
    url:     `${SALES_BASE}${path}`,
    headers: { 'X-Api-Key': SALES_KEY, 'Content-Type': 'application/json' },
  };
  if (params) cfg.params = params;
  if (data)   cfg.data   = data;
  const res = await axios(cfg);
  return res.data;
}

// ════════════════════════════════════════════════════════════
// 行事曆（唯讀，包含所有活動）
// GET /api/sales-events/calendar?month=YYYY-MM
// ════════════════════════════════════════════════════════════
router.get('/calendar', async (req, res) => {
  try {
    const { month } = req.query;
    const data = await salesReq('GET', '/operation/calendar', null, month ? { month } : {});
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 外部活動（contact_lens / special_contract）
// ════════════════════════════════════════════════════════════

// GET /api/sales-events/external-events
router.get('/external-events', async (req, res) => {
  try {
    const data = await salesReq('GET', '/operation/external-events');
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// POST /api/sales-events/external-events
router.post('/external-events', async (req, res) => {
  try {
    const { type, name, start_date, end_date, note, store_erpids } = req.body;
    if (!type || !name || !start_date || !end_date) {
      return bad(res, 'type, name, start_date, end_date 為必填');
    }
    const payload = { type, name, start_date, end_date };
    if (note !== undefined)        payload.note        = note;
    if (store_erpids !== undefined) payload.store_erpids = store_erpids;
    const data = await salesReq('POST', '/operation/external-events', payload);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// GET /api/sales-events/external-events/:id
router.get('/external-events/:id', async (req, res) => {
  try {
    const data = await salesReq('GET', `/operation/external-events/${req.params.id}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// PUT /api/sales-events/external-events/:id
router.put('/external-events/:id', async (req, res) => {
  try {
    const { type, name, start_date, end_date, note, store_erpids } = req.body;
    if (!type || !name || !start_date || !end_date) {
      return bad(res, 'type, name, start_date, end_date 為必填');
    }
    const payload = { type, name, start_date, end_date };
    if (note !== undefined)        payload.note        = note;
    if (store_erpids !== undefined) payload.store_erpids = store_erpids;
    const data = await salesReq('PUT', `/operation/external-events/${req.params.id}`, payload);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// DELETE /api/sales-events/external-events/:id
router.delete('/external-events/:id', async (req, res) => {
  try {
    const data = await salesReq('DELETE', `/operation/external-events/${req.params.id}`);
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 推播設定
// ════════════════════════════════════════════════════════════

// PATCH /api/sales-events/promotion-push/:templateId
router.patch('/promotion-push/:templateId', async (req, res) => {
  try {
    const data = await salesReq(
      'PATCH',
      `/operation/promotion-push/${req.params.templateId}`,
      req.body
    );
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// PATCH /api/sales-events/ad-push/:campaignId
router.patch('/ad-push/:campaignId', async (req, res) => {
  try {
    const data = await salesReq(
      'PATCH',
      `/operation/ad-push/${req.params.campaignId}`,
      req.body
    );
    ok(res, data);
  } catch (e) { fail(res, e); }
});

module.exports = router;
