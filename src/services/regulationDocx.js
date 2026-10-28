// services/regulationDocx.js — 上傳 Word（.docx）→ AI 轉成系統規範格式（2026-10-28）
//   mammoth 讀出 HTML（含圖片）→ 圖片壓縮後上傳 → 轉成精簡文字（標題／清單／表格／[圖N]）
//   → Claude 依原文轉成 doc（sections → 條文 → 子條文、註／例、圖片放回該條）→ 回給編輯器（不直接存檔）
//   轉檔要 30 秒～數分鐘，所以走背景工作：start() 回 job id，前端輪詢 get()
const crypto  = require('crypto');
const axios   = require('axios');
const mammoth = require('mammoth');
const sharp   = require('sharp');
const storage = require('./storageService');

const MODEL = process.env.REGULATION_DOCX_MODEL || process.env.REGULATION_AI_MODEL || 'claude-sonnet-4-5';
const MAX_TEXT = 60000;     // 轉成文字後的上限（字）；超過請分兩份
const MAX_IMAGES = 40;
const jobs = new Map();     // id → { owner, status: running|done|error, step, result, error, at }

const ent = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => ent(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();

/** mammoth 的 HTML → 給 AI 看的精簡文字 */
function htmlToText(html) {
  let h = String(html);
  // 表格 → markdown
  h = h.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]).replace(/\n+/g, ' ').replace(/\|/g, '／')));
    if (!rows.length) return '';
    const w = Math.max(...rows.map(r => r.length));
    const line = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
    return `\n${line(rows[0])}\n| ${Array(w).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n`;
  });
  h = h.replace(/<img[^>]*src="__IMG_(\d+)"[^>]*>/gi, ' [圖$1] ');
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${'#'.repeat(Number(n))} ${stripTags(t)}\n`);
  // 清單：依巢狀深度縮排
  let depth = 0, out = '';
  const re = /<(\/?)(ul|ol|li|p)\b[^>]*>/gi;
  let last = 0, m;
  while ((m = re.exec(h))) {
    out += h.slice(last, m.index); last = re.lastIndex;
    const close = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'ul' || tag === 'ol') depth += close ? -1 : 1;
    else if (tag === 'li' && !close) out += `\n${'  '.repeat(Math.max(0, depth - 1))}- `;
    else if (tag === 'p' && !close) out += '\n';
  }
  out += h.slice(last);
  return stripTags(out.replace(/\n/g, '\u0001')).split('\u0001').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readDocx(buffer) {
  const images = [];
  const { value: html, messages } = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async (img) => {
      if (images.length >= MAX_IMAGES) return { src: '' };
      try {
        const raw = await img.read();
        const buf = await sharp(raw).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        const url = await storage.uploadPhoto(buf, 'photo.jpg', 'regulations');
        images.push(url);
        return { src: `__IMG_${images.length}` };
      } catch (e) { console.warn('[RegDocx] 圖片略過：', e.message); return { src: '' }; }
    }),
  });
  return { text: htmlToText(html), images, warnings: (messages || []).filter(x => x.type === 'warning').length };
}

const SYSTEM = `你把公司內部規範的 Word 原稿轉成系統格式。原稿是一般 Word 排版（大標題、編號清單、表格、圖片、註解）。
只輸出 JSON，格式：
{"title":"規範名稱","summary":"一句話說明這份規範在講什麼（原稿沒有就自己寫一句，30 字內）","scenario":"什麼時候會用到（原稿沒有可留空字串）",
 "sections":[{"title":"大標題","items":[條文]}],
 "ai_notes":["你做了哪些整理、哪些地方要人工確認（最多 8 點）"]}
條文＝{"text":"條文內容","pen":扣分數字或 null,"notes":[{"kind":"註"或"例","text":"…"}],"images":[圖片編號數字],"subs":[子條文（同格式）]}
規則：
- 忠於原文：用字盡量照原稿，只修明顯錯字、標點、多餘空白；不要改規定內容、不要自己加規定、不要編造數字金額日期。
- 原稿的大標題（# 開頭或「一、二、三」）→ sections；沒有大標題就用一個 section，title 寫「規範內容」。
- 編號清單或一段段規定 → 一條一條的條文；下一層編號 → subs（最多 4 層）。條文文字不要再帶「1.」「(1)」這類編號，系統會自己編號。
- 「註：」「備註」「說明」→ notes kind 註；「例：」「範例」→ notes kind 例。
- 原稿有寫扣分（例如「扣 2 分」「-3」）才填 pen（負數，例 -2），沒寫就 null。
- 表格：整個表格原樣放進一條條文的 text（保留 | 分隔的 markdown 表格，前面可加一句說明）。
- [圖N] 出現在哪一段，就把 N 放進那一條的 images；文字裡不要留 [圖N]。
- 標題本身（文件最上面的規範名稱）放 title，不要變成條文。`;

async function convert(buffer, { title } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI 功能未啟用：Render 要設 ANTHROPIC_API_KEY');
  const { text, images } = await readDocx(buffer);
  if (!text.trim()) throw new Error('Word 裡讀不到文字（如果是掃描的圖片檔，請改用文字版 Word）');
  if (text.length > MAX_TEXT) throw new Error(`這份 Word 太長（${text.length} 字），請分成兩份再上傳（上限 ${MAX_TEXT} 字）`);
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: MODEL, max_tokens: 32000, system: SYSTEM,
    messages: [{ role: 'user', content: `${title ? `目前規範名稱：${title}\n` : ''}原稿共有 ${images.length} 張圖。\n=== Word 原稿 ===\n${text}` }],
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 600000, maxBodyLength: Infinity });
  if (res.data.stop_reason === 'max_tokens') throw new Error('這份 Word 內容太多，AI 沒轉完，請分成兩份再上傳');
  const raw = (res.data.content || []).map(c => c.text || '').join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j;
  try { j = JSON.parse(raw); } catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); j = JSON.parse(raw.slice(a, b + 1)); }
  const used = new Set();
  const fix = (arr, lvl) => (Array.isArray(arr) ? arr : []).map(c => {
    const imgs = (Array.isArray(c.images) ? c.images : []).map(n => Number(n)).filter(n => images[n - 1]).map(n => { used.add(n); return { url: images[n - 1], caption: '' }; });
    const o = { text: String(c.text || '').replace(/\[圖\d+\]/g, '').trim(), t: null,
      pen: Number.isFinite(Number(c.pen)) && c.pen !== null && c.pen !== '' ? -Math.abs(Math.trunc(Number(c.pen))) : null,
      notes: (Array.isArray(c.notes) ? c.notes : []).filter(n => String(n?.text || '').trim()).map(n => ({ kind: n.kind === '例' ? '例' : '註', text: String(n.text).trim() })),
      subs: lvl < 4 ? fix(c.subs, lvl + 1) : [] };
    if (imgs.length) o.images = imgs;
    return o;
  }).filter(c => c.text || c.images || c.subs.length);
  const sections = (Array.isArray(j.sections) ? j.sections : []).map(s => ({ title: String(s.title || '').trim(), items: fix(s.items, 1) })).filter(s => s.items.length || s.title);
  if (!sections.length) throw new Error('AI 沒有轉出任何條文，請確認 Word 內容');
  // 沒被放進條文的圖片 → 最後補一條，免得遺失
  const left = images.map((u, i) => (used.has(i + 1) ? null : u)).filter(Boolean);
  if (left.length) sections[sections.length - 1].items.push({ text: '（以下圖片 AI 沒放進條文，請拖到正確的位置或刪除）', t: null, pen: null, notes: [], subs: [], images: left.map(url => ({ url, caption: '' })) });
  const count = (arr) => arr.reduce((n, c) => n + 1 + count(c.subs), 0);
  return {
    title: String(j.title || '').trim(), summary: String(j.summary || '').trim(), scenario: String(j.scenario || '').trim(),
    sections, ai_notes: (Array.isArray(j.ai_notes) ? j.ai_notes : []).map(String).slice(0, 8),
    stats: { chars: text.length, images: images.length, images_unplaced: left.length, sections: sections.length, clauses: sections.reduce((n, s) => n + count(s.items), 0) },
  };
}

function start(owner, buffer, opts) {
  const id = crypto.randomBytes(9).toString('hex');
  jobs.set(id, { owner: String(owner), status: 'running', at: Date.now() });
  convert(buffer, opts)
    .then(result => jobs.set(id, { owner: String(owner), status: 'done', result, at: Date.now() }))
    .catch(e => { console.warn('[RegDocx] 轉換失敗：', e.response?.data?.error?.message || e.message); jobs.set(id, { owner: String(owner), status: 'error', error: e.response?.data?.error?.message || e.message, at: Date.now() }); });
  for (const [k, v] of jobs) if (Date.now() - v.at > 3 * 3600e3) jobs.delete(k);   // 3 小時前的丟掉
  return { job: id };
}
function get(owner, id) {
  const j = jobs.get(String(id));
  if (!j || j.owner !== String(owner)) throw new Error('找不到這個轉換工作（伺服器重新啟動過的話請再上傳一次）');
  return { status: j.status, result: j.result || null, error: j.error || null };
}
const isDocx = (f) => f && (/\.docx$/i.test(f.originalname || '') || /officedocument\.wordprocessingml/.test(f.mimetype || ''));

module.exports = { start, get, convert, htmlToText, isDocx };
