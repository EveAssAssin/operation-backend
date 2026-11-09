// services/reviewTicket.js — 規範送審推播連結的審核票券（2026-11-09 Louis：點推播連結落到登入頁）
//   推播連結帶 t＝簽章票券，點開直接以「指定審核人」身分進入審核頁；不需登入。
//   票券內容：s＝範圍（v＝只限這一份送審版本、p＝待審清單＋低風險全過）、v＝版本 id、a＝審核人 APP 編號、e＝到期（秒）
//   驗證：簽章＋未過期＋a 必須等於「現在」設定的審核人（換審核人後舊連結失效）＋範圍。
//   密鑰：REVIEW_TICKET_SECRET（沒設就用既有的 VENDOR_JWT_SECRET／JWT_SECRET／PLANNING_REG_KEY 衍生；都沒有就不發連結）
//   票券不寫 log；API 用 header x-review-ticket 帶（不放 query），前端讀完網址就把 t 從網址列拿掉。
const crypto = require('crypto');

const TTL_SEC = 24 * 3600;
function secret() {
  const base = process.env.REVIEW_TICKET_SECRET || process.env.VENDOR_JWT_SECRET || process.env.JWT_SECRET || process.env.PLANNING_REG_KEY || '';
  if (String(base).length < 16) return null;
  return crypto.createHmac('sha256', String(base)).update('regulation-review-ticket/v1').digest();
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (body, key) => b64(crypto.createHmac('sha256', key).update(body).digest()).slice(0, 32);

/** 發票券；沒密鑰回 null（呼叫端退回舊連結） */
function issue({ scope, versionId = 0, appNumber, ttlSec = TTL_SEC }) {
  const key = secret();
  if (!key || !appNumber || !['v', 'p'].includes(scope)) return null;
  const body = b64(JSON.stringify({ s: scope, v: Number(versionId) || 0, a: String(appNumber), e: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${sign(body, key)}`;
}
const err = (msg, status, code) => Object.assign(new Error(msg), { status, code });

/** 只驗簽章與期限，回 payload；不查審核人（verify 會查） */
function parse(t) {
  const key = secret();
  if (!key) throw err('審核連結功能沒有設定', 503, 'NO_SECRET');
  const m = /^([A-Za-z0-9_-]{10,400})\.([A-Za-z0-9_-]{32})$/.exec(String(t || ''));
  if (!m) throw err('連結無效', 401, 'TICKET_BAD');
  const want = Buffer.from(sign(m[1], key)), got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw err('連結無效', 401, 'TICKET_BAD');
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { throw err('連結無效', 401, 'TICKET_BAD'); }
  if (!p || !['v', 'p'].includes(p.s) || !p.a || !p.e) throw err('連結無效', 401, 'TICKET_BAD');
  if (Date.now() / 1000 > Number(p.e)) throw err('這個審核連結已過期（24 小時）', 401, 'TICKET_EXPIRED');
  return p;
}

module.exports = { issue, parse, TTL_SEC, configured: () => !!secret() };
