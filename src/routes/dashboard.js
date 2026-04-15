// routes/dashboard.js
// 首頁今日重點：代理各外部系統的 Highlight API
// 目的：API Key 不暴露在前端，統一由後端代理查詢

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { authenticate } = require('../middleware/auth');

// 所有路由需登入
router.use(authenticate);

// ── 工具 ─────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function err(res, e, code = 500) {
  res.status(code).json({ success: false, message: e.message || e });
}

// ══════════════════════════════════════════════════════════
// GET /api/dashboard/training-highlight
// 代理教育訓練系統的今日重點摘要
// ══════════════════════════════════════════════════════════
router.get('/training-highlight', async (req, res) => {
  try {
    const { date } = req.query;
    const params   = date ? { date } : {};

    const response = await axios.get(
      'https://lohas-lms-backend.onrender.com/external/training-highlight',
      {
        headers: { 'x-api-key': 'lohas-highlight-2026' },
        params,
        timeout: 10000,
      }
    );

    ok(res, response.data);
  } catch (e) {
    // 外部服務掛掉時不擋首頁，回傳空資料讓前端優雅降級
    if (e.code === 'ECONNABORTED' || e.code === 'ENOTFOUND') {
      return ok(res, null);
    }
    const status = e.response?.status;
    if (status >= 500) return ok(res, null); // 外部服務 5xx 也優雅降級
    err(res, e, status || 500);
  }
});

module.exports = router;
