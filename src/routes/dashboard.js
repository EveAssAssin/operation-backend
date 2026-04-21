// routes/dashboard.js
// 首頁今日重點：各模組獨立端點
// 前端平行呼叫，各卡片獨立顯示，互不阻塞

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ── 工具 ─────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function fail(res, e)   { res.json({ success: false, message: e.response?.data?.message || e.message }); }

// ══════════════════════════════════════════════════════════
// 業績系統
// ══════════════════════════════════════════════════════════
router.get('/highlights/sales', async (req, res) => {
  try {
    const { month } = req.query;
    const r = await axios.get(
      'https://sales-analysis-backend-vc4f.onrender.com/sales/highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' },
        params: month ? { month } : {},
        timeout: 30000 }   // 業績系統可能冷啟動，給較長 timeout
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 教育訓練
// ══════════════════════════════════════════════════════════
router.get('/highlights/training', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 稽察
// ══════════════════════════════════════════════════════════
router.get('/highlights/audit', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://market-backend-0544.onrender.com/api/dashboard/highlight/audit',
      { headers: { Authorization: req.headers['authorization'] || '' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data?.data ?? r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 人員評價系統
// ══════════════════════════════════════════════════════════
router.get('/highlights/evaluation', async (req, res) => {
  try {
    const r = await axios.get(
      'https://review-system-backend-3zs3.onrender.com/daily-digest/today',
      { headers: { 'x-hub-key': 'lohas-ai-hub-2026' },
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════
// 工務部
// ══════════════════════════════════════════════════════════
router.get('/highlights/engineering', async (req, res) => {
  try {
    const { date } = req.query;
    const r = await axios.get(
      'https://market-backend-0544.onrender.com/external/engineering-highlight',
      { headers: { 'x-api-key': 'lohas-engineering-highlight-2026' },
        params: date ? { date } : {},
        timeout: 15000 }
    );
    ok(res, r.data);
  } catch (e) { fail(res, e); }
});

module.exports = router;
