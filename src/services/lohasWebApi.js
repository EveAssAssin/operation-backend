// services/lohasWebApi.js
// 樂活搜點子 webapi 整合（lohas.realtime.tw / lohastest.realtime.tw）
// 與 leftHandApi.js（內部 ERP 員工同步、AES 加密）是不同系統，請勿混用
//
// 支援的 API：
//   23 getUnitList                       — 取得特約單位列表
//   25 getAppointedUnitByCode            — 用代碼或類別查單一廠商
//   26 getAppointedUnitMembers           — 用代碼查廠商旗下會員
//   27 getAppointedUnitCategoryMembers   — 用類別查整個類別下會員
//   12 multipleLeftMessagePush           — 多筆顧客推播（樂活 APP 推播通道）
//   13 CSLeftMessagePush                 — 左手客服聊天推播（單筆）
//
// 認證方式：apikey 直接放在 request body 內，無需加密

const https = require('https');
const http  = require('http');

const USE_TEST = String(process.env.LOHAS_WEBAPI_USE_TEST || 'false').toLowerCase() === 'true';
const BASE_URL = USE_TEST
  ? (process.env.LOHAS_WEBAPI_TEST_URL || 'https://lohastest.realtime.tw/webapi/v010')
  : (process.env.LOHAS_WEBAPI_URL      || 'https://lohas.realtime.tw/webapi/v010');
const API_KEY  = USE_TEST
  ? (process.env.LOHAS_WEBAPI_KEY_TEST || 'ch856m30xangih8r')
  : (process.env.LOHAS_WEBAPI_KEY      || 'bfjY2jssj9dDajq0');
const API_VER  = process.env.LOHAS_WEBAPI_VER || '0.1.0';

const DEFAULT_TIMEOUT_MS = 20000;

// ── 通用 POST（支援 http / https）──────────────────────────────
function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(BASE_URL + pathname);
    const payload = JSON.stringify(body);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch {
          reject(new Error(`回應非 JSON：${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`搜點子 API 請求超時（${pathname}）`));
    });
    req.write(payload);
    req.end();
  });
}

// ── 包成統一格式的 helper ─────────────────────────────────────
//   依文件兩種格式：
//   (A) member/*、discountapi/* 等：       { apikey, apiver, data: {...} }
//   (B) officialWed/*（特約模組相關）：     { data: { apikey, apiver, data: {...} } }   ← 多一層 data 包
async function callApi(pathname, params = {}) {
  const inner = {
    apikey: API_KEY,
    apiver: API_VER,
    data:   params,
  };
  const isOfficialWed = pathname.startsWith('/officialWed');
  const body = isOfficialWed ? { data: inner } : inner;
  const res = await post(pathname, body);
  // 文件 code 為 string 200 才算正常
  const code = String(res.code ?? '');
  if (code !== '200') {
    const err = new Error(`搜點子 API 錯誤：${pathname} code=${code} msg=${res.message || res.errmessage || ''}`);
    err.code = code;
    err.payload = res;
    throw err;
  }
  return res;
}

// ───────────────────────────────────────────────────────────────
// API 23: 取得特約單位列表
// ───────────────────────────────────────────────────────────────
async function getUnitList({ bindstore, page = 1, paginate = 200 } = {}) {
  const params = { page, paginate };
  if (bindstore !== undefined && bindstore !== null) params.bindstore = bindstore;
  const res = await callApi('/officialWed/getUnitList', params);
  // 回傳 { count, page_count, last_page, per_page, current_page, info: [] }
  const d = res.data || {};
  return {
    count:        Number(d.count        || 0),
    pageCount:    Number(d.page_count   || 0),
    lastPage:     Number(d.last_page    || 1),
    perPage:      Number(d.per_page     || 0),
    currentPage:  Number(d.current_page || 1),
    info:         Array.isArray(d.info) ? d.info : [],
    raw:          res,
  };
}

// 自動翻頁版本：把所有特約單位拉完
async function getAllUnits() {
  const all = [];
  let page = 1;
  // first page
  const first = await getUnitList({ page, paginate: 200 });
  all.push(...first.info);
  for (page = 2; page <= first.lastPage; page++) {
    const next = await getUnitList({ page, paginate: 200 });
    all.push(...next.info);
  }
  return all;
}

// ───────────────────────────────────────────────────────────────
// API 25: 特約廠商查詢（用代碼或類別）
// ───────────────────────────────────────────────────────────────
async function getAppointedUnitByCode({ appointed_unit_code, category_id } = {}) {
  if (!appointed_unit_code && !category_id) {
    throw new Error('appointed_unit_code 與 category_id 至少擇一');
  }
  const params = {};
  if (appointed_unit_code) params.appointed_unit_code = String(appointed_unit_code);
  if (category_id)         params.category_id         = String(category_id);
  const res = await callApi('/officialWed/getAppointedUnitByCode', params);
  // 文件寫物件，實測為陣列。為相容兩種格式：
  if (Array.isArray(res.data)) return res.data;
  if (res.data && typeof res.data === 'object') return [res.data];
  return [];
}

// ───────────────────────────────────────────────────────────────
// API 26: 特約廠商代碼查詢會員
// ───────────────────────────────────────────────────────────────
async function getAppointedUnitMembers(appointed_unit_code) {
  if (!appointed_unit_code) throw new Error('appointed_unit_code 必填');
  const res = await callApi('/officialWed/getAppointedUnitMembers', {
    appointed_unit_code: String(appointed_unit_code),
  });
  return Array.isArray(res.data) ? res.data : [];
}

// ───────────────────────────────────────────────────────────────
// API 27: 特約單位類別查詢會員
// ───────────────────────────────────────────────────────────────
async function getAppointedUnitCategoryMembers(category_id) {
  if (!category_id) throw new Error('category_id 必填');
  const res = await callApi('/officialWed/getAppointedUnitCategoryMembers', {
    category_id: String(category_id),
  });
  return Array.isArray(res.data) ? res.data : [];
}

// ───────────────────────────────────────────────────────────────
// API 12: 多筆顧客推播（樂活 APP 通道）
//   client_data: [{ client_id, url? }, ...]
// ───────────────────────────────────────────────────────────────
async function multipleLeftMessagePush({ client_data, title, message, staffId, img_url }) {
  if (!Array.isArray(client_data) || client_data.length === 0) {
    throw new Error('client_data 必填且不可為空');
  }
  if (!title || !message) throw new Error('title 與 message 必填');
  // 注意：此 API 文件範例的 body 結構直接是 { client_data, title, message, ... }，不含 apikey/apiver/data 包
  const res = await post('/message/multipleLeftMessagePush', {
    apikey: API_KEY,
    apiver: API_VER,
    client_data,
    title,
    message,
    staffId,
    img_url,
  });
  if (String(res.code) !== '200') {
    const err = new Error(`multipleLeftMessagePush 失敗 code=${res.code}`);
    err.payload = res;
    throw err;
  }
  return res;
}

// ───────────────────────────────────────────────────────────────
// API 13: 左手客服聊天推播（單筆）
// ───────────────────────────────────────────────────────────────
async function CSLeftMessagePush({ client_id, title, message, view_status = 1, link, category }) {
  if (!client_id || !title || !message) throw new Error('client_id/title/message 必填');
  const res = await post('/message/CSLeftMessagePush', {
    apikey: API_KEY,
    apiver: API_VER,
    client_id,
    title,
    message,
    view_status,
    link,
    category,
  });
  if (String(res.code) !== '200') {
    const err = new Error(`CSLeftMessagePush 失敗 code=${res.code}`);
    err.payload = res;
    throw err;
  }
  return res;
}

module.exports = {
  // 設定
  USE_TEST,
  BASE_URL,
  // 特約模組相關
  getUnitList,
  getAllUnits,
  getAppointedUnitByCode,
  getAppointedUnitMembers,
  getAppointedUnitCategoryMembers,
  // 推播
  multipleLeftMessagePush,
  CSLeftMessagePush,
};
