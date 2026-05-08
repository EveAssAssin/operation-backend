// services/lineMessagingService.js
// 新 LINE OA「樂活特約廠商綁定」整合
//   - Webhook 簽章驗證
//   - Push API（針對 line_user_id 推訊息）
//   - Reply API（webhook 收到事件後快速回覆）
//   - 取得用戶 profile（綁定流程要存 displayName / pictureUrl）
//
// ⚠️ 與 linePushService.js（共用 BOT，透過工單系統代發）不同隻

const https  = require('https');
const crypto = require('crypto');

const CHANNEL_ID     = process.env.APPOINTED_UNIT_LINE_CHANNEL_ID || '';
const CHANNEL_SECRET = process.env.APPOINTED_UNIT_LINE_CHANNEL_SECRET || '';
const ACCESS_TOKEN   = process.env.APPOINTED_UNIT_LINE_ACCESS_TOKEN || '';
const LIFF_ID        = process.env.APPOINTED_UNIT_LIFF_ID || '';
const FRONTEND_URL   = process.env.FRONTEND_URL || 'http://localhost:5173';

const BIND_LIFF_URL  = LIFF_ID ? `https://liff.line.me/${LIFF_ID}` : '';

function ensureConfigured() {
  if (!ACCESS_TOKEN) throw new Error('APPOINTED_UNIT_LINE_ACCESS_TOKEN 未設定');
}

// ── 簽章驗證（webhook 用）─────────────────────────────────────
//   參考 https://developers.line.biz/en/reference/messaging-api/#signature-validation
function verifyWebhookSignature(rawBody, signatureFromHeader) {
  if (!CHANNEL_SECRET) return false;
  if (!signatureFromHeader) return false;
  const computed = crypto
    .createHmac('sha256', CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  // 用 timingSafeEqual 比，避免時序攻擊
  const a = Buffer.from(computed);
  const b = Buffer.from(String(signatureFromHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── 通用 LINE API POST 工具 ───────────────────────────────────
function lineApiPost(pathname, body) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.line.me',
      port:     443,
      path:     pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${ACCESS_TOKEN}`,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const ok  = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (ok) return resolve(parsed);
        const err = new Error(`LINE API ${pathname} 錯誤 ${res.statusCode}：${raw}`);
        err.status = res.statusCode;
        err.payload = parsed;
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('LINE API 請求超時')); });
    req.write(payload);
    req.end();
  });
}

// ── 通用 LINE API GET 工具 ────────────────────────────────────
function lineApiGet(pathname) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.line.me',
      port:     443,
      path:     pathname,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const ok  = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (ok) return resolve(parsed);
        const err = new Error(`LINE API ${pathname} 錯誤 ${res.statusCode}：${raw}`);
        err.status = res.statusCode;
        err.payload = parsed;
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('LINE API 請求超時')); });
    req.end();
  });
}

// ── 取得使用者 profile ────────────────────────────────────────
async function getUserProfile(userId) {
  return lineApiGet(`/v2/bot/profile/${encodeURIComponent(userId)}`);
}

// ── Reply（回覆 webhook 事件）─────────────────────────────────
async function reply(replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return lineApiPost('/v2/bot/message/reply', { replyToken, messages: arr });
}

// ── Push（單一 userId）────────────────────────────────────────
async function pushToUser(userId, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return lineApiPost('/v2/bot/message/push', { to: userId, messages: arr });
}

// ── Multicast（最多 500 個 userId 同訊息）─────────────────────
async function multicast(userIds, messages) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new Error('userIds 必填');
  }
  const arr = Array.isArray(messages) ? messages : [messages];
  // LINE multicast 上限 500
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 500) chunks.push(userIds.slice(i, i + 500));
  const results = [];
  for (const c of chunks) {
    const r = await lineApiPost('/v2/bot/message/multicast', { to: c, messages: arr });
    results.push({ size: c.length, response: r });
  }
  return results;
}

// ── 常用 message helper ───────────────────────────────────────
function textMessage(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}

function bindEntryFlex({ title = '樂活特約廠商綁定', subtitle = '請點下方按鈕進入綁定頁' } = {}) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: subtitle, size: 'sm', color: '#666666', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            action: {
              type: 'uri',
              label: '前往綁定',
              uri: BIND_LIFF_URL || `${FRONTEND_URL}/liff/appointed-unit-bind`,
            },
          },
        ],
      },
    },
  };
}

function broadcastFlex({ title, message, link_url, img_url }) {
  const body = {
    type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: message, size: 'sm', color: '#444444', wrap: true, margin: 'md' },
    ],
  };
  const bubble = { type: 'bubble', body };
  if (img_url) {
    bubble.hero = { type: 'image', url: img_url, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  }
  if (link_url) {
    bubble.footer = {
      type: 'box', layout: 'vertical', contents: [
        {
          type: 'button', style: 'primary', color: '#06C755',
          action: { type: 'uri', label: '查看詳情', uri: link_url },
        },
      ],
    };
  }
  return { type: 'flex', altText: title, contents: bubble };
}

module.exports = {
  CHANNEL_ID,
  LIFF_ID,
  BIND_LIFF_URL,
  verifyWebhookSignature,
  getUserProfile,
  reply,
  pushToUser,
  multicast,
  textMessage,
  bindEntryFlex,
  broadcastFlex,
};
