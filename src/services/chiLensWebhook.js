// services/chiLensWebhook.js
// 反向 webhook：operation → chi-finance-lens
// 對應規格：outputs/operation_chi_lens_請款整合文件.md
//   POST {CHI_LENS_WEBHOOK_URL}/api/hooks/operation/lens-request/:chi_lens_id/status
//   Header: x-api-key: <CHI_LENS_API_KEY>
//   Body  : { status, operation_note?, operation_ref, updated_at }
//
// 與 marketWebhook.js 結構相同，只是換 URL / API_KEY / path。

const https = require('https');
const http  = require('http');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 10000;
const VALID_STATUSES = new Set([
  'operation_approved', 'operation_rejected', 'operation_processing', 'operation_completed',
]);

async function notifyChiLensStatus(chiLensRequestId, body) {
  if (!chiLensRequestId) {
    console.warn('[chiLensWebhook] 缺少 chiLensRequestId，跳過');
    return { sent: false, error: 'missing chiLensRequestId' };
  }
  if (!VALID_STATUSES.has(body?.status)) {
    console.warn(`[chiLensWebhook] 非法 status=${body?.status}，跳過`);
    return { sent: false, error: 'invalid status' };
  }
  const base   = process.env.CHI_LENS_WEBHOOK_URL;
  const apiKey = process.env.CHI_LENS_API_KEY;
  if (!base) {
    console.log('[chiLensWebhook] CHI_LENS_WEBHOOK_URL 未設定，跳過');
    return { sent: false, error: 'CHI_LENS_WEBHOOK_URL not set' };
  }
  if (!apiKey) {
    console.warn('[chiLensWebhook] CHI_LENS_API_KEY 未設定，跳過');
    return { sent: false, error: 'API key not set' };
  }

  const pathname = `/api/hooks/operation/lens-request/${encodeURIComponent(chiLensRequestId)}/status`;
  const url      = new URL(pathname, base.replace(/\/+$/, '') + '/');
  const isHttps  = url.protocol === 'https:';
  const lib      = isHttps ? https : http;
  const payload  = JSON.stringify({
    status:         body.status,
    operation_note: body.operation_note || null,
    operation_ref:  body.operation_ref  || null,
    updated_at:     body.updated_at     || new Date().toISOString(),
  });

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key':      apiKey,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[chiLensWebhook] ✅ ${body.status} → chi-lens ${chiLensRequestId} (HTTP ${res.statusCode})`);
          resolve({ sent: true, status: res.statusCode });
        } else {
          console.warn(`[chiLensWebhook] ⚠️  HTTP ${res.statusCode}：${raw}`);
          resolve({ sent: false, status: res.statusCode, error: raw });
        }
      });
    });
    req.on('error', (err) => { console.warn(`[chiLensWebhook] 網路錯誤：${err.message}`); resolve({ sent: false, error: err.message }); });
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => { req.destroy(); console.warn('[chiLensWebhook] 超時'); resolve({ sent: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

module.exports = { notifyChiLensStatus };
