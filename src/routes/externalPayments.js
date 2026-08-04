// routes/externalPayments.js
// 外部工務師（market-backend）請款事件收件端
//
// 對應規格：營運部_請款API規格.md §2.1
//   POST /api/external/repair-payments/events
//
// 認證：x-api-key header 必須等於環境變數 OPERATION_PAYMENT_API_KEY
//   （若沒設環境變數 → 直接 500，避免無認證裸奔）
// Idempotency：header "Idempotency-Key" 用 pr_id:event 格式；服務端會用它去重

const express = require('express');
const router  = express.Router();
const ingest  = require('../services/marketPaymentIngest');

const API_KEY_ENV = 'OPERATION_PAYMENT_API_KEY';

// 中介：驗證 x-api-key
function apiKeyAuth(req, res, next) {
  const expected = process.env[API_KEY_ENV];
  if (!expected) {
    console.error(`[externalPayments] ${API_KEY_ENV} 未設定，拒絕所有請求`);
    return res.status(500).json({ success: false, message: '伺服器未設定 API 金鑰' });
  }
  const provided = req.header('x-api-key');
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: 'invalid api key' });
  }
  next();
}

// POST /api/external/repair-payments/events
router.post('/events', apiKeyAuth, async (req, res) => {
  const key = req.header('idempotency-key') || null;
  try {
    const result = await ingest.ingestEvent(req.body || {}, key);
    // 200 OK；operation_ref 為選填
    return res.status(200).json({
      success:       true,
      operation_ref: result.operation_ref || null,
      reused:        !!result.reused,
    });
  } catch (err) {
    console.error(
      '[externalPayments] ingest 失敗：', err.message,
      'event=', req.body?.event,
      'pr_id=', req.body?.payment_request_id,
      'idempotency=', key,
    );
    // 4xx 客戶端錯誤：資料缺、未知 event、找不到請款單…
    // 5xx：DB 錯誤、環境問題（讓 market 側自動重試）
    const status = /找不到|缺少|未知的 event|body 必須是|已標記為已撥款/.test(err.message)
      ? 400
      : 500;
    return res.status(status).json({ success: false, message: err.message });
  }
});

// GET /api/external/repair-payments/health — 給 market 端 debug ping 用（無需 key）
router.get('/health', (_req, res) => {
  const hasKey = !!process.env[API_KEY_ENV];
  res.json({ success: true, has_api_key: hasKey });
});

module.exports = router;
