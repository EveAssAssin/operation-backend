// routes/chiFinanceLensPayments.js
// 路奇天格鏡片（chi-finance-lens）請款事件收件端
//
// POST /api/external/chi-finance-lens/events
//   x-api-key: <CHI_LENS_API_KEY>   （與 market 隔離，用不同金鑰）
//   Idempotency-Key: <payment_request_id>:<event>
//
// GET  /api/external/chi-finance-lens/health   免驗證，回是否設好金鑰

const express = require('express');
const router  = express.Router();
const ingest  = require('../services/chiFinanceLensIngest');

const API_KEY_ENV = 'CHI_LENS_API_KEY';

function apiKeyAuth(req, res, next) {
  const expected = process.env[API_KEY_ENV];
  if (!expected) {
    console.error(`[chiLensPayments] ${API_KEY_ENV} 未設定，拒絕所有請求`);
    return res.status(500).json({ success: false, message: '伺服器未設定 API 金鑰' });
  }
  const provided = req.header('x-api-key');
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: 'invalid api key' });
  }
  next();
}

router.post('/events', apiKeyAuth, async (req, res) => {
  const key = req.header('idempotency-key') || null;
  try {
    const result = await ingest.ingestEvent(req.body || {}, key);
    return res.status(200).json({
      success:       true,
      operation_ref: result.operation_ref || null,
      reused:        !!result.reused,
    });
  } catch (err) {
    console.error(
      '[chiLensPayments] ingest 失敗：', err.message,
      'event=', req.body?.event,
      'pr_id=', req.body?.payment_request_id,
      'vendor_code=', req.body?.vendor_code,
      'idempotency=', key,
    );
    const status = /找不到|缺少|未知的 event|body 必須是|已標記為已撥款/.test(err.message) ? 400 : 500;
    return res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/health', (_req, res) => {
  res.json({ success: true, has_api_key: !!process.env[API_KEY_ENV] });
});

module.exports = router;
