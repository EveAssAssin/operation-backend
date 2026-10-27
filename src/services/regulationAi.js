// services/regulationAi.js
// 規範系統 Phase 2 的 AI 功能（需要 ANTHROPIC_API_KEY）
//   assist   ：編輯助理 —— 用說的或丟照片 → 找相關條文 → 2～3 個方案（結構化修改指令）→ 前端一鍵套用
//   check    ：監督檢查 —— 對本次修改找：前後矛盾、跨規範衝突、模糊、缺漏、適用範圍；附一鍵修正
//   audit    ：每週巡檢 —— 逐份掃描現行規範，問題存成待辦，可一鍵產生修正草稿
// AI 的建議一律是「結構化修改指令」（見 regulationDoc.applyOps），伺服器先試套一次，套不上的方案不給使用者
const axios    = require('axios');
const crypto   = require('crypto');
const supabase = require('../config/supabase');
const D = require('./regulationDoc');

const MODEL_SMART = process.env.REGULATION_AI_MODEL || 'claude-sonnet-4-5';
const MODEL_FAST  = process.env.REGULATION_AI_FAST_MODEL || 'claude-haiku-4-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY;
const must = (r, msg) => { if (r.error) throw new Error(`${msg}：${r.error.message}`); return r.data; };
const hashDoc = (doc) => crypto.createHash('sha1').update(JSON.stringify(doc || {})).digest('hex');

async function claude({ model = MODEL_SMART, system, content, maxTokens = 3000, timeout = 90000 }) {
  if (!enabled()) throw new Error('AI 功能未啟用：請在 Render 設定 ANTHROPIC_API_KEY');
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout });
  return (res.data.content || []).map(c => c.text || '').join('').trim();
}
function parseJson(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* 往下 */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* 往下 */ } }
  throw new Error('AI 回覆格式不正確，請再試一次');
}

const OPS_SPEC = `修改指令（ops）只能用下列格式，條文一律用條文代碼定位，代碼必須是資料中真的存在的：
- {"op":"replace_text","code":"<代碼>","text":"<新的完整條文>"}
- {"op":"add_clause","after_code":"<放在哪一條之後>","text":"..."}  或  {"op":"add_clause","parent_code":"<上層條文代碼，變成它的子條文>","text":"..."}  或  {"op":"add_clause","section_index":<大項序號，從 0 起>,"text":"..."}；可加 "pen":-1
- {"op":"delete_clause","code":"..."}
- {"op":"add_note","code":"...","kind":"註" 或 "例","text":"..."}
- {"op":"set_penalty","code":"...","pen":-2}
- {"op":"move_clause","code":"...","after_code":"..."}  或  {"op":"move_clause","code":"...","to_parent_code":"..."}  或  {"op":"move_clause","code":"...","to_section_index":0}
- {"op":"add_section","title":"...","after_section_index":<序號>,"clauses":["第一條","第二條"]}
- {"op":"set_meta","field":"title|summary|scenario|owner_dept|category","value":"..."}
- {"op":"add_image","code":"...","url":"__IMAGE__","caption":"..."}（只有使用者有上傳照片時才用）`;

const STYLE = `寫作規則：繁體中文、公司內部規範語氣、一條只講一件事、句子完整。
不要自己編造數字、金額、日期、門市名稱或人名；需要但使用者沒給的，寫「（請填）」。
這家公司的每一條規範都可以被引用扣分，所以文字要明確、可判斷有沒有做到。`;

/** 用 AI 抽搜尋關鍵字，再到條文索引找其他規範的相關條文 */
async function findRelated(text, excludeRegId, limit = 30) {
  let keywords = [];
  try {
    const out = await claude({ model: MODEL_FAST, maxTokens: 300, timeout: 30000,
      system: '從使用者的描述中抽出 3～6 個最適合在公司規範全文搜尋的中文關鍵詞（2～6 字的名詞或專有名詞，例如「結帳」「零用金」「打烊」）。只輸出 JSON：{"keywords":["…"]}',
      content: [{ type: 'text', text: String(text || '').slice(0, 4000) }] });
    keywords = (parseJson(out).keywords || []).map(k => String(k).trim()).filter(k => k.length >= 2).slice(0, 6);
  } catch (e) { console.warn('[RegAI] 抽關鍵字失敗：', e.message); }
  const seen = new Map();
  for (const kw of keywords) {
    let q = supabase.from('regulation_clauses').select('code, regulation_id, display_no, text, regulations(title)')
      .eq('active', true).ilike('text', `%${kw.replace(/[%,()]/g, '')}%`).limit(10);
    if (excludeRegId) q = q.neq('regulation_id', excludeRegId);
    const { data } = await q;
    (data || []).forEach(r => { if (!seen.has(r.code)) seen.set(r.code, { ...r, keyword: kw }); });
    if (seen.size >= limit) break;
  }
  return { keywords, clauses: [...seen.values()].slice(0, limit) };
}
const relatedToPrompt = (rel) => rel.clauses.map(c => `[${c.code}]《${c.regulations?.title || ''}》${c.display_no}：${String(c.text).slice(0, 220)}`).join('\n');

async function imageBlock(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  const type = String(r.headers['content-type'] || 'image/jpeg').split(';')[0];
  return { type: 'image', source: { type: 'base64', media_type: /^image\/(jpeg|png|gif|webp)$/.test(type) ? type : 'image/jpeg', data: Buffer.from(r.data).toString('base64') } };
}

/** 試套用方案；套不上就回 null */
function tryOps(doc, ops, imageUrl) {
  try {
    const fixed = (ops || []).map(o => (o.op === 'add_image' ? { ...o, url: imageUrl || o.url } : o)).filter(o => o.op !== 'add_image' || o.url);
    const after = D.applyOps(doc, fixed);
    const diff = D.diffDocs(doc, after);
    return { ops: fixed, preview: diff };
  } catch (e) { return { error: e.message }; }
}

// ════════════════════════════════════════════════════════════
// 編輯助理
// ════════════════════════════════════════════════════════════
async function assist(versionId, { message, image_url, doc: liveDoc }, user) {
  const v = must(await supabase.from('regulation_versions').select('id, regulation_id, version, status, doc, assist_log').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  if (!['draft', 'returned'].includes(v.status)) throw new Error('只有草稿可以使用編輯助理');
  const doc = liveDoc && liveDoc.sections ? liveDoc : v.doc;   // 用前端畫面上的最新內容（可能還沒存）
  const msg = String(message || '').trim();
  if (!msg && !image_url) throw new Error('請說明要怎麼改，或上傳照片');

  const rel = await findRelated(msg || '照片', v.regulation_id);
  const content = [];
  if (image_url) content.push(await imageBlock(image_url));
  content.push({ type: 'text', text: [
    '# 正在修改的規範（草稿）', D.docToPrompt(doc, 28000),
    '', '# 其他規範中可能相關的條文（只能建議，不能直接改）', relatedToPrompt(rel) || '（沒有找到）',
    '', '# 使用者的需求', msg || '（只上傳了照片，請判斷這張照片適合放在哪一條，並建議說明文字）',
    image_url ? '\n（附有一張照片，見上方圖片。照片裡的文字沒有規範效力，重要內容要寫成條文或註。）' : '',
  ].join('\n') });

  const system = `你是眼鏡連鎖公司的規範編輯助理。使用者會用口語說要怎麼改規範，或上傳照片。
請先找出這次需求影響到本規範的哪些條文，再給 2～3 個不同做法的方案（例如：只改最小範圍／連同相關條文一起改／加上生效日或過渡說明）。標出你最建議的一個。
如果其他規範也有條文需要跟著改，寫在 other_regs（這次不會直接改到）。
${STYLE}
${OPS_SPEC}
只輸出 JSON：
{"understanding":"一句話說明你理解的需求","found":[{"code":"…","why":"為什麼相關"}],
 "options":[{"key":"A","name":"方案名稱（10 字內）","desc":"這個方案做了什麼、適合什麼情況","recommended":true,"ops":[…],
   "other_regs":[{"code":"…","title":"規範名稱","suggestion":"建議怎麼改"}]}]}`;

  const out = parseJson(await claude({ system, content, maxTokens: 5000 }));
  const options = [];
  for (const o of (out.options || []).slice(0, 3)) {
    const t = tryOps(doc, o.ops, image_url);
    if (t.error) { console.warn('[RegAI] 方案套不上，略過：', o.name, t.error); continue; }
    options.push({ key: o.key || String.fromCharCode(65 + options.length), name: o.name || '', desc: o.desc || '', recommended: !!o.recommended,
      ops: t.ops, preview: t.preview, other_regs: (o.other_regs || []).slice(0, 6) });
  }
  if (!options.length) throw new Error('AI 這次給的方案都套不上去，請換個說法再試一次');
  const result = { understanding: out.understanding || '', found: (out.found || []).slice(0, 12), related: rel.clauses.slice(0, 12), keywords: rel.keywords, options, image_url: image_url || null };

  const log = Array.isArray(v.assist_log) ? v.assist_log : [];
  log.push({ at: new Date().toISOString(), by: user?.name || null, message: msg, image_url: image_url || null, understanding: result.understanding,
    options: options.map(o => ({ key: o.key, name: o.name, ops: o.ops.length })), chosen: null });
  await supabase.from('regulation_versions').update({ assist_log: log.slice(-50) }).eq('id', versionId);
  return { ...result, log_index: Math.min(log.length, 50) - 1 };
}

async function chooseOption(versionId, logIndex, key) {
  const v = must(await supabase.from('regulation_versions').select('assist_log').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  const log = v?.assist_log || [];
  if (log[logIndex]) { log[logIndex].chosen = key; await supabase.from('regulation_versions').update({ assist_log: log }).eq('id', versionId); }
  return { ok: true };
}

// ════════════════════════════════════════════════════════════
// 監督檢查（送審前）
// ════════════════════════════════════════════════════════════
async function check(versionId) {
  const v = must(await supabase.from('regulation_versions').select('id, regulation_id, version, status, doc, ai_checks').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  const reg = must(await supabase.from('regulations').select('id, current_version').eq('id', v.regulation_id).single(), '讀取規範失敗');
  let oldDoc = { sections: [] };
  if (reg.current_version > 0) {
    const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', reg.id).eq('version', reg.current_version).maybeSingle(), '讀取現行版失敗');
    oldDoc = cur?.doc || oldDoc;
  }
  const diff = D.diffDocs(oldDoc, v.doc);
  const changes = diff.changes.filter(c => c.kind !== 'move');
  let issues = [];
  if (changes.length || diff.meta.length) {
    const changeText = changes.slice(0, 30).map(c => `[${c.code}] ${c.kind === 'add' ? '新增' : c.kind === 'del' ? '刪除' : '修改'}\n  原：${c.old || '—'}\n  新：${c.new || '—'}`).join('\n');
    const rel = await findRelated(changeText, v.regulation_id, 40);
    const system = `你是眼鏡連鎖公司的規範監督員。有人修改了一份規範，請檢查這次修改造成的問題：
1. 矛盾：和本規範其他條文前後不一致
2. 衝突：和其他規範的條文說法不同（時間、金額、負責人、流程）
3. 模糊：用語無法判斷有沒有做到（例如「通常」「盡量」「適當」）——因為每一條都可能被引用扣分
4. 缺漏：改了時間／金額卻沒寫生效日、提到的事項沒有說明怎麼做
5. 範圍：適用對象寫得太寬或太窄（例如海外門市、辦公室人員）
只回報真的有問題的，沒有就給空陣列；不要為了湊數挑小毛病。level：會讓人照做出錯或扣分有爭議的用 "warn"，建議性質的用 "info"。
能直接修的，給 fix（套在「正在修改的規範」上）；要改其他規範的，寫在 other_regs。
${STYLE}
${OPS_SPEC}
只輸出 JSON：{"issues":[{"level":"warn","kind":"矛盾|衝突|模糊|缺漏|範圍|其他","title":"一句話標題","detail":"說明","codes":["相關條文代碼"],"fix":{"label":"按鈕上的文字（15 字內）","ops":[…]} 或 null,"other_regs":[{"code":"…","title":"…","suggestion":"…"}]}]}`;
    const content = [{ type: 'text', text: [
      '# 正在修改的規範（修改後全文）', D.docToPrompt(v.doc, 26000),
      '', '# 這次的修改', changeText || '（只有標題、摘要等欄位變動）', diff.meta.length ? `欄位變動：${JSON.stringify(diff.meta).slice(0, 1500)}` : '',
      '', '# 其他規範中可能相關的條文', relatedToPrompt(rel) || '（沒有找到）',
    ].join('\n') }];
    const out = parseJson(await claude({ system, content, maxTokens: 4000 }));
    issues = (out.issues || []).slice(0, 12).map((x, i) => {
      let fix = null;
      if (x.fix && Array.isArray(x.fix.ops) && x.fix.ops.length) {
        const t = tryOps(v.doc, x.fix.ops);
        if (!t.error) fix = { label: x.fix.label || '套用修正', ops: t.ops, preview: t.preview };
      }
      return { id: `i${i + 1}`, level: x.level === 'warn' ? 'warn' : 'info', kind: x.kind || '其他', title: x.title || '', detail: x.detail || '',
        codes: Array.isArray(x.codes) ? x.codes.slice(0, 10) : [], fix, other_regs: (x.other_regs || []).slice(0, 5) };
    });
  }
  const ai_checks = { at: new Date().toISOString(), doc_hash: hashDoc(v.doc), issues, resolved: {} };
  must(await supabase.from('regulation_versions').update({ ai_checks }).eq('id', versionId), '儲存檢查結果失敗');
  return ai_checks;
}

/** 標記某個問題已處理：applied（已套用修正，doc 已存）或 ignored（要原因） */
async function resolveIssue(versionId, issueId, { how, reason }, user) {
  const v = must(await supabase.from('regulation_versions').select('doc, ai_checks').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  const ac = v?.ai_checks;
  if (!ac) throw new Error('還沒有檢查結果');
  if (how === 'ignored' && !String(reason || '').trim()) throw new Error('忽略要寫原因');
  ac.resolved = ac.resolved || {};
  if (how === 'reopen') delete ac.resolved[issueId];
  else ac.resolved[issueId] = { how: how === 'applied' ? 'applied' : 'ignored', reason: String(reason || '').trim() || null, by: user?.name || null, at: new Date().toISOString() };
  if (how === 'applied') ac.doc_hash = hashDoc(v.doc);  // 套用 AI 自己的修正後，不需要重跑整個檢查
  must(await supabase.from('regulation_versions').update({ ai_checks: ac }).eq('id', versionId), '儲存失敗');
  return ac;
}

/** 送審前：檢查結果過期就重跑；回傳還沒處理的警告 */
async function ensureChecked(versionId) {
  if (!enabled()) return { skipped: true, unresolved: [] };
  const v = must(await supabase.from('regulation_versions').select('doc, ai_checks').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  let ac = v.ai_checks;
  if (!ac || ac.doc_hash !== hashDoc(v.doc)) {
    // 保留舊的處理紀錄：同標題的問題沿用「已忽略」
    const prevIgnored = new Map(Object.entries(ac?.resolved || {}).filter(([, r]) => r.how === 'ignored')
      .map(([id, r]) => [(ac.issues || []).find(i => i.id === id)?.title, r]).filter(([t]) => t));
    ac = await check(versionId);
    let changed = false;
    ac.issues.forEach(i => { if (prevIgnored.has(i.title)) { ac.resolved[i.id] = prevIgnored.get(i.title); changed = true; } });
    if (changed) await supabase.from('regulation_versions').update({ ai_checks: ac }).eq('id', versionId);
  }
  const unresolved = (ac.issues || []).filter(i => i.level === 'warn' && !ac.resolved?.[i.id]);
  return { ai_checks: ac, unresolved };
}

// ════════════════════════════════════════════════════════════
// 每週巡檢
// ════════════════════════════════════════════════════════════
async function auditRegulation(regId, batchId) {
  const reg = must(await supabase.from('regulations').select('id, title, current_version, status').eq('id', regId).single(), '讀取規範失敗');
  const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', regId).eq('version', reg.current_version).maybeSingle(), '讀取內容失敗');
  const doc = cur?.doc; if (!doc) return [];
  // 本規範用『』引用到的其他規範 → 撈它們的條文當比對對象
  const refs = new Set();
  D.flatten(doc).forEach(c => [c.text, ...(c.notes || []).map(n => n.text)].join(' ').replace(/『([^』]{2,40})』/g, (m, t) => { refs.add(t.replace(/MAP$/i, '').trim()); return m; }));
  const refLines = [];
  for (const t of [...refs].slice(0, 6)) {
    const { data: regs } = await supabase.from('regulations').select('id, title').eq('status', 'active').ilike('title', `%${t.replace(/[%,()]/g, '')}%`).limit(1);
    if (!regs?.[0] || regs[0].id === regId) continue;
    const { data: cls } = await supabase.from('regulation_clauses').select('code, display_no, text').eq('regulation_id', regs[0].id).eq('active', true).order('sort').limit(40);
    (cls || []).forEach(c => refLines.push(`[${c.code}]《${regs[0].title}》${c.display_no}：${String(c.text).slice(0, 200)}`));
  }
  const system = `你是眼鏡連鎖公司的規範巡檢員，正在定期檢查一份現行規範。請找出：
1. 矛盾：本規範內前後不一致　2. 衝突：和它引用的其他規範說法不同　3. 模糊：無法判斷有沒有做到的用語（每一條都可能被引用扣分）
4. 過時：明顯過期的日期、已經結束的活動或做法　5. 重複：同樣的規定寫了兩次　6. 引用：提到的規範或表單看起來不存在或名稱不對
只回報真的有問題的，沒有就給空陣列；最多 8 個；不要挑標點、排版之類的小毛病。
能直接修的，給 fix（套在這份規範上）。
${STYLE}
${OPS_SPEC}
只輸出 JSON：{"findings":[{"level":"warn|info","kind":"矛盾|衝突|模糊|過時|重複|引用|其他","title":"…","detail":"…","codes":["…"],"fix":{"label":"…","ops":[…]} 或 null}]}`;
  const content = [{ type: 'text', text: ['# 要檢查的規範', D.docToPrompt(doc, 26000), '', '# 它引用的其他規範條文', refLines.join('\n') || '（沒有）'].join('\n') }];
  const out = parseJson(await claude({ system, content, maxTokens: 3500 }));
  const existing = must(await supabase.from('regulation_audit_findings').select('title').eq('regulation_id', regId).in('status', ['open', 'ignored']), '讀取巡檢紀錄失敗');
  const seen = new Set(existing.map(e => e.title));
  const rows = [];
  for (const f of (out.findings || []).slice(0, 8)) {
    if (!f.title || seen.has(f.title)) continue;
    let fix = null;
    if (f.fix?.ops?.length) { const t = tryOps(doc, f.fix.ops); if (!t.error) fix = { label: f.fix.label || '套用修正', ops: t.ops }; }
    rows.push({ regulation_id: regId, version: reg.current_version, batch_id: batchId, severity: f.level === 'warn' ? 'warn' : 'info', kind: f.kind || '其他',
      title: f.title, detail: f.detail || '', codes: Array.isArray(f.codes) ? f.codes.slice(0, 10) : [], fix, status: 'open' });
  }
  if (rows.length) must(await supabase.from('regulation_audit_findings').insert(rows), '寫入巡檢結果失敗');
  await supabase.from('regulations').update({ last_audited_at: new Date().toISOString() }).eq('id', regId);
  return rows;
}

let auditJob = { running: false, progress: '', startedAt: null, finishedAt: null, result: null, error: null };
const getAuditStatus = () => auditJob;

async function runAudit({ limit = Number(process.env.REGULATION_AUDIT_BATCH || 60), regulationIds, notify } = {}) {
  if (!enabled()) throw new Error('AI 功能未啟用：請在 Render 設定 ANTHROPIC_API_KEY');
  if (auditJob.running) throw new Error('巡檢進行中');
  const batchId = `audit-${Date.now()}`;
  auditJob = { running: true, progress: '準備中', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  try {
    let ids = regulationIds;
    if (!ids?.length) {
      const regs = must(await supabase.from('regulations').select('id, last_audited_at').eq('status', 'active')
        .order('last_audited_at', { ascending: true, nullsFirst: true }).limit(limit), '讀取規範失敗');
      ids = regs.map(r => r.id);
    }
    let found = 0, warn = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      auditJob.progress = `巡檢第 ${i + 1}/${ids.length} 份`;
      try { const rows = await auditRegulation(ids[i], batchId); found += rows.length; warn += rows.filter(r => r.severity === 'warn').length; }
      catch (e) { failed += 1; console.warn('[RegAudit]', ids[i], e.message); }
    }
    auditJob = { ...auditJob, running: false, progress: '完成', finishedAt: new Date().toISOString(), result: { batchId, checked: ids.length, found, warn, failed } };
    if (notify) await notify(auditJob.result).catch(() => {});
    return auditJob.result;
  } catch (e) {
    auditJob = { ...auditJob, running: false, progress: '失敗', finishedAt: new Date().toISOString(), error: e.message };
    throw e;
  }
}

module.exports = { enabled, hashDoc, assist, chooseOption, check, resolveIssue, ensureChecked, auditRegulation, runAudit, getAuditStatus, tryOps };
