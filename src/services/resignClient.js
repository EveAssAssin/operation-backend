// services/resignClient.js —— 營運部打市場部「離職流程」內部 API（2026-10-20）
// 市場部 /api/internal/resign（x-internal-key＝營運部 env MARKET_INTERNAL_KEY＝市場部 QUEST_INTERNAL_KEY_OPERATION）
// 帶 x-actor-app／x-actor-name 讓市場部寫操作紀錄。也提供停權名單快取（每 5 分鐘）給 middleware/auth.js 擋離職人員登入。
const axios = require('axios');
const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';

function headers(actor) {
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) throw new Error('營運部沒設 MARKET_INTERNAL_KEY');
  const h = { 'x-internal-key': key };
  if (actor) { h['x-actor-app'] = String(actor.member_id || actor.app || ''); h['x-actor-name'] = encodeURIComponent(String(actor.name || '')); }
  return h;
}
async function call(method, path, { params, data, actor } = {}) {
  try {
    const r = await axios({ method, url: `${MARKET_BASE}/api/internal/resign${path}`, params, data, headers: headers(actor), timeout: 30000 });
    return r.data && r.data.data;
  } catch (e) {
    const msg = e.response ? (e.response.data && e.response.data.message) || `市場部 ${e.response.status}` : e.message;
    const err = new Error(msg); err.status = e.response ? e.response.status : 502; throw err;
  }
}

// ── 停權名單 ──
let blocked = new Set();
let loadedAt = 0;
async function refreshBlocked() {
  try { const list = await call('get', '/blocked'); blocked = new Set((list || []).map(String)); loadedAt = Date.now(); }
  catch (e) { if (Date.now() - loadedAt > 60 * 60 * 1000) console.warn('[resignClient] 停權名單抓不到：', e.message); }
}
function isBlocked(memberId) { return !!memberId && blocked.has(String(memberId)); }
let started = false;
function startBlockedSync() {
  if (started) return; started = true;
  refreshBlocked();
  setInterval(refreshBlocked, 5 * 60 * 1000).unref();
}

module.exports = { call, isBlocked, refreshBlocked, startBlockedSync };
