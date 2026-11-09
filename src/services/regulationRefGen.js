// services/regulationRefGen.js — 參考既有規範＋新需求 → AI 產生一份新規範（2026-11）
//   常用在行銷企劃：拿舊企劃（例：去年生日活動、母親節活動）的架構與邏輯，套上這次的新需求延伸出新企劃
//   輸出格式與 regulationDocx 一樣（title/summary/scenario/sections/ai_notes/stats）→ 前端「套用到編輯器」共用
//   生成要 30 秒～數分鐘，走背景工作：start() 回 job id，前端輪詢 get()
const crypto   = require('crypto');
const axios    = require('axios');
const supabase = require('../config/supabase');
const D        = require('./regulationDoc');

const MODEL = process.env.REGULATION_REFGEN_MODEL || process.env.REGULATION_AI_MODEL || 'claude-sonnet-4-5';
const MAX_REFS = 3;
const jobs = new Map();   // id → { owner, status, result, error, at }

const SYSTEM = `你是眼鏡連鎖公司（樂活眼鏡）的企劃／規範撰寫助理。
使用者會給你 1～3 份「參考規範」（通常是以前的行銷企劃或作業規範）和「這次的新需求」。
請「沿用參考規範的架構與邏輯」（大項怎麼分、每一段寫哪些面向：目的、期間、對象、內容、流程、分工、門市執行細節、注意事項、成效追蹤…），
依新需求寫出一份全新的規範。
規則：
- 架構跟著參考走；內容換成新需求的。參考裡跟新需求無關的段落就拿掉，新需求需要但參考沒有的就補上。
- 參考裡寫死的日期、金額、商品、門市、人名、數量不能直接沿用到新規範——新需求有給就用新需求的；沒給就寫「（請填）」。
- 參考裡值得保留的執行細節、常見錯誤提醒、分工方式可以沿用（改寫成符合新需求）。
- 繁體中文、公司內部規範語氣、一條只講一件事、句子完整；每一條都可能被引用扣分，所以要明確、可判斷有沒有做到。
- 原本有扣分（pen）的規定，只有在新規範仍然適用時才保留扣分。
- 新需求裡如果有「確認過的方向／大綱」與「補充回答」，一定要照那個大綱與回答寫，不要自行改方向。
只輸出 JSON：
{"title":"新規範名稱","summary":"一句話說明（30 字內）","scenario":"什麼時候會用到",
 "sections":[{"title":"大項標題","items":[條文]}],
 "ai_notes":["沿用了參考的哪些架構、哪些地方需要人工確認或補資料（最多 8 點）"]}
條文＝{"text":"條文內容","pen":扣分數字或 null,"notes":[{"kind":"註"或"例","text":"…"}],"subs":[子條文（同格式，最多 4 層）]}
條文文字不要帶「1.」「(1)」這類編號，系統會自己編號。`;

async function loadDoc(id) {
  const { data: reg } = await supabase.from('regulations').select('id, title, current_version').eq('id', id).maybeSingle();
  if (!reg) throw new Error(`找不到規範 #${id}`);
  const { data: v } = await supabase.from('regulation_versions').select('doc').eq('regulation_id', id).eq('version', reg.current_version).maybeSingle();
  if (!v?.doc) throw new Error(`規範《${reg.title}》還沒有上線的內容，不能當參考`);
  return { id: reg.id, title: reg.title, doc: v.doc };
}

async function generate({ reference_ids, requirement, title }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI 功能未啟用：Render 要設 ANTHROPIC_API_KEY');
  const ids = [...new Set((Array.isArray(reference_ids) ? reference_ids : [reference_ids]).map(Number).filter(Boolean))].slice(0, MAX_REFS);
  if (!ids.length) throw new Error('請至少選一份參考規範');
  const need = String(requirement || '').trim();
  if (need.length < 5) throw new Error('請寫這次的新需求（至少一句話）');
  const refs = [];
  for (const id of ids) refs.push(await loadDoc(id));
  const per = Math.floor(45000 / refs.length);
  const content = [
    title ? `新規範名稱（暫定）：${title}` : '',
    ...refs.map((r, i) => `=== 參考規範 ${i + 1}：#${r.id}《${r.title}》 ===\n${D.docToPrompt(r.doc, per)}`),
    `=== 這次的新需求 ===\n${need}`,
  ].filter(Boolean).join('\n\n');

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: MODEL, max_tokens: 20000, system: SYSTEM, messages: [{ role: 'user', content }],
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 600000 });
  if (res.data.stop_reason === 'max_tokens') throw new Error('內容太長 AI 沒寫完，請把需求拆小一點或少選一份參考');
  const raw = (res.data.content || []).map(c => c.text || '').join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j;
  try { j = JSON.parse(raw); } catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); j = JSON.parse(raw.slice(a, b + 1)); }

  const fix = (arr, lvl) => (Array.isArray(arr) ? arr : []).map(c => ({
    text: String(c.text || '').trim(), t: null,
    pen: Number.isFinite(Number(c.pen)) && c.pen !== null && c.pen !== '' ? -Math.abs(Math.trunc(Number(c.pen))) : null,
    notes: (Array.isArray(c.notes) ? c.notes : []).filter(n => String(n?.text || '').trim()).map(n => ({ kind: n.kind === '例' ? '例' : '註', text: String(n.text).trim() })),
    subs: lvl < 4 ? fix(c.subs, lvl + 1) : [],
  })).filter(c => c.text || c.subs.length);
  const sections = (Array.isArray(j.sections) ? j.sections : []).map(s => ({ title: String(s.title || '').trim(), items: fix(s.items, 1) })).filter(s => s.items.length || s.title);
  if (!sections.length) throw new Error('AI 沒有產生任何條文，請把需求寫具體一點再試');
  const count = (arr) => arr.reduce((n, c) => n + 1 + count(c.subs), 0);
  const fills = JSON.stringify(sections).split('（請填）').length - 1;
  return {
    title: String(j.title || '').trim(), summary: String(j.summary || '').trim(), scenario: String(j.scenario || '').trim(),
    sections, ai_notes: (Array.isArray(j.ai_notes) ? j.ai_notes : []).map(String).slice(0, 8),
    references: refs.map(r => ({ id: r.id, title: r.title })),
    stats: { sections: sections.length, clauses: sections.reduce((n, s) => n + count(s.items), 0), images: 0, images_unplaced: 0, to_fill: fills },
  };
}

function start(owner, opts) {
  const id = crypto.randomBytes(9).toString('hex');
  jobs.set(id, { owner: String(owner), status: 'running', at: Date.now() });
  generate(opts || {})
    .then(result => jobs.set(id, { owner: String(owner), status: 'done', result, at: Date.now() }))
    .catch(e => { const m = e.response?.data?.error?.message || e.message; console.warn('[RegRefGen] 失敗：', m); require('./aiIssue').track({ ai: 'regulation_ai', tool: 'refgen', error: m, question: String((opts && (opts.title || opts.requirement)) || '').slice(0, 200), who: String(owner) }); jobs.set(id, { owner: String(owner), status: 'error', error: m, at: Date.now() }); });
  for (const [k, v] of jobs) if (Date.now() - v.at > 3 * 3600e3) jobs.delete(k);
  return { job: id };
}
function get(owner, id) {
  const j = jobs.get(String(id));
  if (!j || j.owner !== String(owner)) throw new Error('找不到這個產生工作（伺服器重新啟動過的話請再按一次）');
  return { status: j.status, result: j.result || null, error: j.error || null };
}


// ── 先確認方向：理解＋打算的大綱＋關鍵問題（產生要好幾分鐘，先讓人確認不會寫錯方向）──
async function clarify({ reference_ids, requirement, title }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI 功能未啟用：Render 要設 ANTHROPIC_API_KEY');
  const { normClarify, CLARIFY_RULES } = require('./regulationAi');
  const ids = [...new Set((Array.isArray(reference_ids) ? reference_ids : [reference_ids]).map(Number).filter(Boolean))].slice(0, MAX_REFS);
  if (!ids.length) throw new Error('請至少選一份參考規範');
  const need = String(requirement || '').trim();
  if (need.length < 5) throw new Error('請寫這次的新需求（至少一句話）');
  const refs = [];
  for (const id of ids) refs.push(await loadDoc(id));
  const per = Math.floor(30000 / refs.length);
  const system = `你是眼鏡連鎖公司（樂活眼鏡）的企劃／規範撰寫助理。使用者要你「沿用參考規範的架構與邏輯，依新需求寫一份新規範」。
plan 請寫成「新規範的大綱」：每一點＝一個大項＋這一項打算寫什麼（例：「二、活動內容：買框送鏡片升級的條件、可搭配的優惠」），並標出哪些大項是沿用參考、哪些是新加的。
${CLARIFY_RULES}`;
  const content = [
    title ? `新規範名稱（暫定）：${title}` : '',
    ...refs.map((r, i) => `=== 參考規範 ${i + 1}：#${r.id}《${r.title}》 ===\n${D.docToPrompt(r.doc, per)}`),
    `=== 這次的新需求 ===\n${need}`,
  ].filter(Boolean).join('\n\n');
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: MODEL, max_tokens: 2500, system, messages: [{ role: 'user', content }],
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
  const raw = (res.data.content || []).map(c => c.text || '').join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j;
  try { j = JSON.parse(raw); } catch { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); j = JSON.parse(raw.slice(a, b + 1)); }
  return { ...normClarify(j), references: refs.map(r => ({ id: r.id, title: r.title })) };
}

module.exports = { start, get, generate, clarify };
