// routes/dashboard.js
// 首頁今日重點：聚合端點，統一代理各外部系統的 Highlight API
// 前端只打一支 GET /api/dashboard/highlights，拿到所有模組資料
// 每個模組獨立 try-catch，某模組掛掉不影響其他模組

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ══════════════════════════════════════════════════════════
// GET /api/dashboard/highlights
// 聚合所有模組的今日重點
// ══════════════════════════════════════════════════════════
router.get('/highlights', async (req, res) => {
  const { date } = req.query;
  const params   = date ? { date } : {};
  const results  = {};

  // ── 教育訓練（lohas-lms-backend）──────────────────────
  try {
    const r = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      { headers: { 'x-api-key': 'lohas-highlight-2026' }, params, timeout: 10000 }
    );
    results.training = { success: true, data: r.data };
  } catch (e) {
    results.training = { success: false, message: e.response?.data?.message || e.message };
  }

  // ── 未來可在此新增其他模組 ──────────────────────────
  // try {
  //   const r = await axios.get('...', { headers: { 'x-api-key': '...' }, timeout: 10000 });
  //   results.moduleB = { success: true, data: r.data };
  // } catch (e) {
  //   results.moduleB = { success: false, message: e.message };
  // }

  res.json({ success: true, data: results });
});

module.exports = router;
