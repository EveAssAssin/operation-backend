// anthropicSafe.js — 送給 Claude 的字串一律洗成 well-formed（2026-11-10，企劃 AI 400「unexpected end of hex escape」同類防護）
//   String#slice 會把 emoji（UTF-16 代理對）切成一半，留下孤立代理；JSON 化後 Anthropic 不收 → HTTP 400。
//   營運部各支 Claude 呼叫都用 axios.post('https://api.anthropic.com/...')：開機時掛一個 axios 請求攔截器統一洗。
const axios = require('axios');
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s) => (typeof s === 'string' ? s.replace(LONE, '�') : s);
function deep(v) {
  if (typeof v === 'string') return wellFormed(v);
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { const o = {}; for (const k of Object.keys(v)) o[k] = deep(v[k]); return o; }
  return v;
}
if (!axios.__anthropicSafe) {
  axios.interceptors.request.use((cfg) => {
    if (cfg && /api\.anthropic\.com/.test(String(cfg.url || '')) && cfg.data && typeof cfg.data === 'object') cfg.data = deep(cfg.data);
    return cfg;
  });
  axios.__anthropicSafe = true;
}
module.exports = { wellFormed, deep };
