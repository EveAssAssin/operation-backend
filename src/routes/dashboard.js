// routes/dashboard.js
// 首頁今日重點：聚合端點，統一代理各外部系統 + 查本地 DB
// 每個模組獨立 try-catch，某模組掛掉不影響其他

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);


// ══════════════════════════════════════════════════════════
// GET /api/dashboard/highlights
// 聚合所有模組的今日重點
// ══════════════════════════════════════════════════════════
router.get('/highlights', async (req, res) => {
  const { date, month } = req.query;
  const dateParams  = date  ? { date }  : {};
  const monthParams = month ? { month } : {};
  const results = {};

  // ── 業績系統（sales-backend）──────────────────────────
  try {
    const r = await axios.get(
      'https://sales-backend.onrender.com/api/sales/highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' }, params: monthParams, timeout: 10000 }
    );
    results.sales = { success: true, data: r.data };
  } catch (e) {
    results.sales = { success: false, message: e.response?.data?.message || e.message };
  }

  // ── 教育訓練（外部 API）────────────────────────────────
  try {
    const r = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' }, params: dateParams, timeout: 10000 }
    );
    results.training = { success: true, data: r.data };
  } catch (e) {
    results.training = { success: false, message: e.response?.data?.message || e.message };
  }

  // ── 工務部（市場系統外部 API）─────────────────────────
  try {
    const r = await axios.get(
      'https://market-backend-0544.onrender.com/external/engineering-highlight',
      { headers: { 'x-api-key': 'lohas-engineering-highlight-2026' }, params: dateParams, timeout: 10000 }
    );
    results.engineering = { success: true, data: r.data };
  } catch (e) {
    results.engineering = { success: false, message: e.response?.data?.message || e.message };
  }

  // ── 未來其他模組在此新增 ───────────────────────────────

  res.json({ success: true, data: results });
});

module.exports = router;
