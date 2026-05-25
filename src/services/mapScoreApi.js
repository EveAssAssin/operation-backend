// services/mapScoreApi.js
// 樂活 MAP 分數 API 整合（map.lohasglasses.com/_api/v1.ashx）
// 用於「分數兌換」模組：讀取員工分數紀錄、寫入分數、查詢評分事由。
//
// 與 leftHandApi.js 同一個進入點、同一組 AES 設定，但專責「分數」相關方法：
//   #19 getemployeescorerecord — 查詢員工評分記錄（讀）
//   #25 setemployeescore       — 新增員工分數（寫，score 可為負＝扣分）
//   #26 getreason              — 取得評分事由
//
// ⚠️ 回傳 statecode 為字串，'0' 才算成功。

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

const AES_KEY  = process.env.LEFTHAND_AES_KEY || 'GmAOoS003d5OJ2G2';
const AES_IV   = process.env.LEFTHAND_AES_IV  || 'bgfDcfWdWG6NSUr5';
const BASE_URL = process.env.LEFTHAND_API_URL || 'https://map.lohasglasses.com/_api/v1.ashx';

const DEFAULT_TIMEOUT_MS = 20000;

// ── AES-128-CBC 加密（結果 Base64）────────────────────────────
function aesEncrypt(text) {
  const key    = Buffer.from(AES_KEY, 'utf8');
  const iv     = Buffer.from(AES_IV,  'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let enc = cipher.update(String(text), 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

// ── 安全解析 data（API 有時把 data 包成 JSON 字串，需二次解析）──
function parseData(data) {
  if (data == null) return [];
  if (typeof data === 'string') {
    const s = data.trim();
    if (s === '') return [];
    try { return JSON.parse(s); } catch { return []; }
  }
  return data;
}

// ── HTTP POST（支援 http / https）─────────────────────────────
function post(body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(BASE_URL);
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
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`MAP API 回應非 JSON：${raw.slice(0, 150)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('MAP API 請求超時'));
    });
    req.write(payload);
    req.end();
  });
}

// ── 統一呼叫：檢查 statecode ───────────────────────────────────
async function callApi(body) {
  const res  = await post(body);
  const code = String(res.statecode ?? res.stateCode ?? '');
  if (code !== '0') {
    const err = new Error(`MAP API 錯誤（${body.method}）：${res.message || '未知錯誤'}`);
    err.statecode = code;
    err.payload   = res;
    throw err;
  }
  return res;
}

// ───────────────────────────────────────────────────────────────
// #19 查詢員工評分記錄
//   erpids：一個或多個 ERP 編號（陣列或逗號字串）
//   starttime / endtime：'YYYY-MM-DD'
//   回傳：[{ employeeId, employeeErpid, employeeName, records:[...] }]
// ───────────────────────────────────────────────────────────────
async function getScoreRecords(erpids, starttime, endtime) {
  const list = Array.isArray(erpids)
    ? erpids
    : String(erpids || '').split(',');
  const cleaned = list.map(e => String(e).trim()).filter(Boolean);
  if (cleaned.length === 0) throw new Error('erpids 必填');

  const res = await callApi({
    method:    'getemployeescorerecord',
    erpids:    aesEncrypt(cleaned.join(',')),
    starttime: starttime,
    endtime:   endtime,
  });
  const data = parseData(res.data);
  return Array.isArray(data) ? data : [];
}

// ───────────────────────────────────────────────────────────────
// 查單一員工目前分數餘額（加總全部歷史 score）
//   回傳：{ erpid, employeeName, totalScore, totalBonus, recordCount }
// ───────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function getEmployeeBalance(erpid) {
  const erp = String(erpid || '').trim();
  if (!erp) throw new Error('erpid 必填');

  // 從很早的日期撈到今天，等於撈完整歷史
  const rows = await getScoreRecords(erp, '2000-01-01', todayStr());
  const row  = rows.find(r => String(r.employeeErpid) === erp) || rows[0];

  const records = Array.isArray(row?.records) ? row.records : [];
  let totalScore = 0;
  let totalBonus = 0;
  for (const rec of records) {
    totalScore += Number(rec.score || 0);
    totalBonus += Number(rec.bonus || 0);
  }
  return {
    erpid:        erp,
    employeeName: row?.employeeName || null,
    totalScore,
    totalBonus,
    recordCount:  records.length,
  };
}

// ───────────────────────────────────────────────────────────────
// #25 新增員工分數（score 可為負＝扣分）
//   { employeeerpid, score, bonus?, reasonid?, reasontitle, editor }
// ───────────────────────────────────────────────────────────────
async function addScore({ employeeerpid, score, bonus = 0, reasonid = '-1', reasontitle, editor }) {
  const erp = String(employeeerpid || '').trim();
  if (!erp)         throw new Error('employeeerpid 必填');
  if (score == null || score === '') throw new Error('score 必填');
  if (!reasontitle) throw new Error('reasontitle 必填');

  const res = await callApi({
    method:        'setemployeescore',
    employeeerpid: aesEncrypt(erp),
    reasonid:      String(reasonid),
    reasontitle:   String(reasontitle),
    score:         String(score),
    bonus:         String(bonus),
    editor:        String(editor || '分數兌換系統'),
  });
  return { ok: true, message: res.message || '' };
}

// ───────────────────────────────────────────────────────────────
// #26 取得評分事由（依身分別）
// ───────────────────────────────────────────────────────────────
async function getReasons(roletype) {
  if (!roletype) throw new Error('roletype 必填');
  const res = await callApi({ method: 'getreason', roletype: String(roletype) });
  const data = parseData(res.data);
  return Array.isArray(data) ? data : [];
}

module.exports = {
  aesEncrypt,
  getScoreRecords,
  getEmployeeBalance,
  addScore,
  getReasons,
};
