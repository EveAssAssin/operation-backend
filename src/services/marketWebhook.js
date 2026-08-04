// services/marketWebhook.js
//
// 反向 webhook：operation 端做完 approve / reject / mark-paid 後，
// 通知 market-backend 更新該筆 payment_request 的 operation_status。
//
// 對應規格：營運部_請款API規格.md §2.2
//   POST {MARKET_WEBHOOK_URL}/api/hooks/operation/payment-request/:market_id/status
//   Header: x-api-key: <OPERATION_PAYMENT_API_KEY>
//   Body  : { status, operation_note?, operation_ref, updated_at }
//
// 設計：Best-effort — 失敗只 log，不阻斷主流程；讓 operation 端的狀態變化能繼續完成。
// 沒設 MARKET_WEBHOOK_URL 時完全跳過（單機/測試環境）。

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 10000;

const VALID_STATUSES = new Set([
  'operation_approved',
  'operation_rejected',
  'operation_processing',
  'operation_completed',
]);

/**
 * @param {string} marketPaymentRequestId  market 端 payment_request UUID
 * @param {object} body
 * @param {'operation_approved'|'operation_rejected'|'operation_processing'|'operation_completed'} body.status
 * @param {string} [body.operation_note]   reject 時填原因
 * @param {string} [body.operation_ref]    營運部內部單號（vendor_payment_requests.request_no）
 * @param {string} [body.updated_at]       ISO 時間；預設 now
 * @returns {Promise<{sent:boolean, status?:number, error?:string}>}
 */
async function notifyMarketStatus(marketPaymentRequestId, body) {
  if (!marketPaymentRequestId) {
    console.warn('[marketWebhook] 缺少 marketPaymentRequestId，跳過');
    return { sent: false, error: 'missing marketPaymentRequestId' };
  }
  if (!VALID_STATUSES.has(body?.status)) {
    console.warn(`[marketWebhook] 非法 status=${body?.status}，跳過`);
    return { sent: false, error: 'invalid status' };
  }

  const base    = process.env.MARKET_WEBHOOK_URL;    // e.g. https://market-backend-xxx.onrender.com
  const apiKey  = process.env.OPERATION_PAYMENT_API_KEY;
  if (!base) {
    console.log('[marketWebhook] MARKET_WEBHOOK_URL 未設定，跳過（此環境不回推）');
    return { sent: false, error: 'MARKET_WEBHOOK_URL not set' };
  }
  if (!apiKey) {
    console.warn('[marketWebhook] OPERATION_PAYMENT_API_KEY 未設定，跳過');
    return { sent: false, error: 'API key not set' };
  }

  const pathname = `/api/hooks/operation/payment-request/${encodeURIComponent(marketPaymentRequestId)}/status`;
  const url      = new URL(pathname, base.replace(/\/+$/, '') + '/');
  const isHttps  = url.protocol === 'https:';
  const lib      = isHttps ? https : http;

  const payload = JSON.stringify({
    status:         body.status,
    operation_note: body.operation_note || null,
    operation_ref:  body.operation_ref  || null,
    updated_at:     body.updated_at     || new Date().toISOString(),
  });

  return new Promise((resolve) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key':      apiKey,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[marketWebhook] ✅ ${body.status} → market ${marketPaymentRequestId} (HTTP ${res.statusCode})`);
            resolve({ sent: true, status: res.statusCode });
          } else {
            console.warn(`[marketWebhook] ⚠️  HTTP ${res.statusCode}：${raw}`);
            resolve({ sent: false, status: res.statusCode, error: raw });
          }
        });
      }
    );

    req.on('error', (err) => {
      console.warn(`[marketWebhook] 網路錯誤：${err.message}`);
      resolve({ sent: false, error: err.message });
    });
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      req.destroy();
      console.warn('[marketWebhook] 超時（10 秒）');
      resolve({ sent: false, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { notifyMarketStatus };
