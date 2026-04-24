// routes/salesEvents.js
// 業績系統活動模組 — 代理 sales-analysis-backend API
// 需登入（operation_staff 以上）

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { authorize } = require('../middleware/auth');

const SALES_BASE = 'https://sales-analysis-backend-vc4f.onrender.com';
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

// 將前端欄位轉換為業績系統 API 格式
function toExternalEventPayload(body) {
  const {
    event_type, name, start_date, end_date,
    description, notes, store_ids,
    push_on_start, push_on_start_time,
    push_on_start_adv, push_on_start_adv_min, push_on_start_adv_time,
    push_on_end, push_on_end_time,
  } = body;

  const payload = { event_type, name, start_date, end_date };
  if (description       !== undefined) payload.description       = description;
  if (notes             !== undefined) payload.notes             = notes;
  if (store_ids         !== undefined) payload.store_ids         = store_ids;
  if (push_on_start     !== undefined) payload.push_on_start     = push_on_start;
  if (push_on_start_time !== undefined) payload.push_on_start_time = push_on_start_time;
  if (push_on_start_adv !== undefined) payload.push_on_start_adv = push_on_start_adv;
  if (push_on_start_adv_min !== undefined) payload.push_on_start_adv_min = push_on_start_adv_min;
  if (push_on_start_adv_time !== undefined) payload.push_on_start_adv_time = push_on_start_adv_time;
  if (push_on_end       !== undefined) payload.push_on_end       = push_on_end;
  if (push_on_end_time  !== undefined) payload.push_on_end_time  = push_on_end_time;
  return payload;
}

// POST /api/sales-events/external-events
router.post('/external-events', async (req, res) => {
  try {
    const { event_type, name, start_date, end_date } = req.body;
    if (!event_type || !name || !start_date || !end_date) {
      return bad(res, 'event_type, name, start_date, end_date 為必填');
    }
    const data = await salesReq('POST', '/operation/external-events', toExternalEventPayload(req.body));
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
    const { event_type, name, start_date, end_date } = req.body;
    if (!event_type || !name || !start_date || !end_date) {
      return bad(res, 'event_type, name, start_date, end_date 為必填');
    }
    const data = await salesReq('PUT', `/operation/external-events/${req.params.id}`, toExternalEventPayload(req.body));
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
