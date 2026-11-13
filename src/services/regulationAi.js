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
const Core = require('./regulationCheckCore');

const MODEL_SMART = process.env.REGULATION_AI_MODEL || 'claude-sonnet-4-5';
const MODEL_FAST  = process.env.REGULATION_AI_FAST_MODEL || 'claude-haiku-4-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY;
const must = (r, msg) => { if (r.error) throw new Error(`${msg}：${r.error.message}`); return r.data; };
const hashDoc = (doc) => crypto.createHash('sha1').update(JSON.stringify(doc || {})).digest('hex');

async function claude({ model = MODEL_SMART, system, content, maxTokens = 3000, timeout = 90000, temperature }) {
  if (!enabled()) throw new Error('AI 功能未啟用：請在 Render 設定 ANTHROPIC_API_KEY');
  let res;
  try {
    res = await axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
      ...(temperature === undefined ? {} : { temperature }),   // 監督檢查用 0：同樣內容給同樣結果（2026-11-12）
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout });
  } catch (e) {   // AI 問題紀錄（2026-11-10）：規範 AI（協助修改／檢查／巡檢）呼叫失敗
    const m = e.response?.data?.error?.message || e.message;
    require('./aiIssue').track({ ai: 'regulation_ai', tool: 'claude', error: m, timed_out: e.code === 'ECONNABORTED' || /timeout/i.test(m), question: String(system || '').slice(0, 60) });
    throw e;
  }
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
/** 其他規範「正在修改中」（草稿／送審中／退回）的條文變動（2026-11-13 Louis：跨規範一起修改時，
 *  A 規範的草稿改了聚餐費用、B 規範也跟著改；檢查 B 時只看得到 A 的現行版 → 一直報「衝突」卡住送不出去）。
 *  回 [{ regulation_id, title, status, changes:[{code, kind, old, new}] }]；只取近 14 天有動的，最多 8 份、每份 12 條。 */
async function pendingOthers(excludeRegId) {
  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  const { data: vs } = await supabase.from('regulation_versions').select('id, regulation_id, status, doc, updated_at, regulations(title, current_version)')
    .in('status', ['draft', 'pending', 'returned']).neq('regulation_id', excludeRegId).gte('updated_at', since).order('updated_at', { ascending: false }).limit(20);
  const out = []; const seen = new Set();
  for (const v of vs || []) {
    if (seen.has(v.regulation_id) || out.length >= 8) continue;
    seen.add(v.regulation_id);
    let oldDoc = { sections: [] };
    const cv = v.regulations?.current_version || 0;
    if (cv > 0) { const { data: cur } = await supabase.from('regulation_versions').select('doc').eq('regulation_id', v.regulation_id).eq('version', cv).maybeSingle(); oldDoc = cur?.doc || oldDoc; }
    let changes = [];
    try { changes = D.diffDocs(oldDoc, v.doc || { sections: [] }).changes.filter((c) => c.kind !== 'move'); } catch (e) { continue; }
    if (!changes.length) continue;
    out.push({ regulation_id: v.regulation_id, title: v.regulations?.title || v.doc?.title || '', status: v.status, changes: changes.slice(0, 12).map((c) => ({ code: c.code, kind: c.kind, old: c.old || '', new: c.new || '' })) });
  }
  return out;
}
const pendingToPrompt = (list) => list.map((r) => `《${r.title}》（${r.status === 'pending' ? '送審中' : '草稿'}）\n` + r.changes.map((c) => `  [${c.code}] ${c.kind === 'add' ? '新增' : c.kind === 'del' ? '刪除' : '修改'}：${String(c.kind === 'del' ? c.old : c.new).slice(0, 220)}`).join('\n')).join('\n');

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
  // 會收斂的檢查（2026-11-12，regulationCheckCore）：只審上次檢查後變動的條文、問題用 kind＋條文代碼當身分、同條文合併、第 3 輪起只擋矛盾／衝突／缺漏
  const ask = async ({ changes, meta, kept, full }) => {
    const changeText = changes.slice(0, 30).map(c => `[${c.code}] ${c.kind === 'add' ? '新增' : c.kind === 'del' ? '刪除' : '修改'}\n  原：${c.old || '—'}\n  新：${c.new || '—'}`).join('\n');
    const rel = await findRelated(changeText || JSON.stringify(meta).slice(0, 1500), v.regulation_id, 40);
    let pend = []; try { pend = await pendingOthers(v.regulation_id); } catch (e) { console.warn('[RegAI] 讀修改中的其他規範失敗：', e.message); }
    // 條文裡直接寫了其他規範的代碼（例「依 1254-5.9」）→ 一定把那幾條帶給 AI，避免它誤判「條文不存在」（2026-11-10）
    const cited = [...new Set((changeText.match(/\d{2,8}-\d+(?:\.\d+)*[a-z]?/g) || []))].filter((c) => !c.startsWith(`${v.regulation_id}-`) && !rel.clauses.some((x) => x.code === c));
    if (cited.length) { try { const extra = await lookupClauses(cited); for (const x of extra) rel.clauses.push(x.exists ? { code: x.code, regulation_id: x.regulation_id, display_no: x.display_no, text: x.text, regulations: { title: x.title } } : { code: x.code, regulation_id: x.regulation_id, display_no: '（現行版找不到這條）', text: '', regulations: { title: x.title } }); } catch (e) { console.warn('[RegAI] 引用條文查詢失敗', e.message); } }
    const system = `你是眼鏡連鎖公司的規範監督員。有人修改了一份規範，請檢查「這次修改」造成的問題：
1. 矛盾：和本規範其他條文前後不一致
2. 衝突：和其他規範的條文說法不同（時間、金額、負責人、流程）
3. 模糊：用語無法判斷有沒有做到（例如「通常」「盡量」「適當」）——因為每一條都可能被引用扣分
4. 缺漏：改了時間／金額卻沒寫生效日、提到的事項沒有說明怎麼做、引用的條文不存在或引錯
5. 範圍：適用對象寫得太寬或太窄（例如海外門市、辦公室人員）
只回報真的有問題的，沒有就給空陣列；不要為了湊數挑小毛病，用詞偏好、換句話說、補修改日期這類不要報。
${full ? '' : '只檢查「這次的修改」列出的條文；全文只是參考，沒有列在這次修改裡的條文不要回報問題。'}
「已經提出過的問題」不要重複回報，也不要換個說法再報一次。
同一條文只回報一個問題；有好幾種改法時，合併成一個 issue、只給一個最好的 fix。
寫 title、detail 時用人看得懂的編號：本規範寫「三、2.」（必要時加幾個字點出內容，例「三、2.（簡單生活方案）」）；其他規範寫「《規範名稱》五、9.」。不要在 title、detail 裡寫方括號代碼；代碼只放在 codes 陣列（本規範相關條文代碼一定要放）。
注意：方括號裡的條文代碼（例 [1254-6.1.1]）是永久代碼，條文移到別的章節後代碼「本來就不會變」（扣分紀錄、引用都靠它）；畫面上的編號（六、1.）由系統依位置自動重排。不要回報「代碼跟章節不符／編號錯誤」這類問題。level：會讓人照做出錯或扣分有爭議的用 "warn"，建議性質的用 "info"。
其他規範如果列在「正在修改中的其他規範」，那幾條以「修改中」的新內容為準：跟新內容一致就不是衝突（它們是同一批一起改、會一起送審），不要回報；只有跟新內容也不一致才報。
能直接修的，給 fix（套在「正在修改的規範」上）；要改其他規範的，寫在 other_regs。
${STYLE}
${OPS_SPEC}
只輸出 JSON：{"issues":[{"level":"warn","kind":"矛盾|衝突|模糊|缺漏|範圍|其他","title":"一句話標題","detail":"說明","codes":["相關條文代碼"],"fix":{"label":"按鈕上的文字（15 字內）","ops":[…]} 或 null,"other_regs":[{"code":"…","title":"…","suggestion":"…"}]}]}`;
    const content = [{ type: 'text', text: [
      '# 正在修改的規範（修改後全文）', D.docToPrompt(v.doc, 26000),
      '', `# 這次的修改${full ? '' : '（上次檢查之後又改的條文）'}`, changeText || '（只有標題、摘要等欄位變動）', meta.length ? `欄位變動：${JSON.stringify(meta).slice(0, 1500)}` : '',
      '', '# 已經提出過的問題（不要重複）', kept.length ? kept.map(i => `- [${i.kind}] ${i.title}（${(i.codes || []).join('、')}）`).join('\n') : '（無）',
      '', '# 其他規範中可能相關的條文（現行版）', relatedToPrompt(rel) || '（沒有找到）',
      '', '# 正在修改中的其他規範（草稿／送審中，會一起生效；衝突以這裡的新內容為準）', pendingToPrompt(pend) || '（沒有）',
    ].join('\n') }];
    // 大份規範（全文 26k 字＋相關條文）Sonnet 寫 4000 tokens 常要 60～100 秒：預設 90 秒會逾時（2026-11-11 980／981 送審全卡在這）
    const out = parseJson(await claude({ system, content, maxTokens: 4000, timeout: 170000, temperature: 0 }));
    return out.issues || [];
  };
  // 「衝突」的舊問題：對方規範後來有改（正在修改中，或問題提出後才發布新版）→ 不沿用，重新問（2026-11-13：跨規範一起改會互卡）
  let staleRegs = new Set();
  try {
    const pend = await pendingOthers(v.regulation_id);
    for (const r of pend) staleRegs.add(Number(r.regulation_id));
    const prevIssues = (v.ai_checks && v.ai_checks.issues) || [];
    const otherIds = [...new Set(prevIssues.filter((i) => i.kind === '衝突').flatMap((i) => (i.codes || []).map((c) => Number(String(c).split('-')[0]))).filter((n) => n && n !== Number(v.regulation_id)))];
    if (otherIds.length) {
      const { data: regs } = await supabase.from('regulations').select('id, updated_at').in('id', otherIds);
      const firstSeen = Math.min(...prevIssues.map((i) => Date.parse(i.first_seen_at || '') || Date.now()));
      for (const r of regs || []) if (Date.parse(r.updated_at || '') > firstSeen) staleRegs.add(Number(r.id));
    }
  } catch (e) { console.warn('[RegAI] 判斷衝突前提失敗：', e.message); }
  const isStale = (i) => i.kind === '衝突' && (i.codes || []).some((c) => staleRegs.has(Number(String(c).split('-')[0])));
  const ac = await Core.runRound({ prev: v.ai_checks, oldDoc, doc: v.doc, regId: v.regulation_id, ask, validateFix: (ops) => tryOps(v.doc, ops), isStale });
  ac.doc_hash = hashDoc(v.doc);
  ac.code_labels = await otherCodeLabels(ac.issues, v.regulation_id);
  must(await supabase.from('regulation_versions').update({ ai_checks: ac }).eq('id', versionId), '儲存檢查結果失敗');
  console.log(`[RegAI] 檢查 v${versionId} 第 ${ac.round} 輪：${ac.checked.full ? '完整' : `增量 ${ac.checked.codes.length} 條`}、保留 ${ac.checked.kept}、新 ${ac.checked.fresh}`);
  return ac;
}

/** 條文代碼查原文（AI 檢查卡片點代碼跳出原文用，2026-11-10）：找不到的也回規範名稱（代碼前綴＝規範 id） */
async function lookupClauses(codesIn) {
  const codes = [...new Set((Array.isArray(codesIn) ? codesIn : String(codesIn || '').split(',')).map((c) => String(c).trim()).filter((c) => /^\d{1,8}-[\w.]+$/.test(c)))].slice(0, 40);
  if (!codes.length) return [];
  const { data } = await supabase.from('regulation_clauses').select('code, regulation_id, display_no, section_title, text, notes, penalty, regulations(title)').in('code', codes).eq('active', true);
  const by = new Map((data || []).map((c) => [c.code, c]));
  const missingRegIds = [...new Set(codes.filter((c) => !by.has(c)).map((c) => Number(c.split('-')[0])).filter(Boolean))];
  const { data: regs } = missingRegIds.length ? await supabase.from('regulations').select('id, title').in('id', missingRegIds) : { data: [] };
  const regTitle = new Map((regs || []).map((r) => [r.id, r.title]));
  return codes.map((code) => {
    const c = by.get(code);
    if (c) return { code, exists: true, regulation_id: c.regulation_id, title: c.regulations?.title || '', display_no: c.display_no, section_title: c.section_title, text: c.text, notes: c.notes || [], penalty: c.penalty };
    const rid = Number(code.split('-')[0]);
    return { code, exists: false, regulation_id: rid || null, title: regTitle.get(rid) || '' };
  });
}

/** 其他規範的條文代碼 → 人看得懂的「《規範名稱》五、9.」（本規範的由前端依目前內容即時換算） */
async function otherCodeLabels(issues, regId) {
  const txt = JSON.stringify((issues || []).map((i) => [i.title, i.detail, i.codes, i.other_regs]));
  const codes = [...new Set((txt.match(/\d{2,}-\d+(?:\.\d+)*[a-z]?/g) || []))].slice(0, 80);
  if (!codes.length) return {};
  const { data } = await supabase.from('regulation_clauses').select('code, regulation_id, display_no, regulations(title)').in('code', codes).eq('active', true);
  const out = {};
  for (const c of data || []) if (c.regulation_id !== regId) out[c.code] = `《${c.regulations?.title || ''}》${c.display_no}`;
  return out;
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
  if (how === 'applied') { ac.doc_hash = hashDoc(v.doc); if (ac.clause_hash) { ac.clause_hash = Core.clauseHashes(v.doc); ac.meta_hash = Core.metaHash(v.doc); } }  // 套用 AI 自己的修正後，不需要重跑；修過的條文當作已檢查（不會下一輪又被挑）
  must(await supabase.from('regulation_versions').update({ ai_checks: ac }).eq('id', versionId), '儲存失敗');
  return ac;
}

/** AI 檢查的問題沒有自動修正（例「不可抗因素定義不明」——AI 不知道公司怎麼定義）→ 人補充資料，AI 照資料寫出修正（2026-11-10）
 *  回傳更新後的 ai_checks：該 issue 的 fix 換成照補充資料寫的修正、記下 supplement；前端照原本「✓ 套用」流程套用＋存檔＋resolve */
async function fixIssue(versionId, issueId, { info, doc: liveDoc } = {}, user) {
  const v = must(await supabase.from('regulation_versions').select('id, regulation_id, status, doc, ai_checks').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  if (!['draft', 'returned'].includes(v.status)) throw new Error('只有草稿可以修改');
  const ac = v.ai_checks; const issue = ac && (ac.issues || []).find((x) => x.id === issueId);
  if (!issue) throw new Error('找不到這個問題，請重新執行 AI 檢查');
  const supp = String(info || '').trim();
  if (!supp) throw new Error('請寫要補充的內容（例：不可抗因素指天災、本人或直系親屬重大傷病住院…）');
  const doc = liveDoc && liveDoc.sections ? liveDoc : v.doc;
  const system = `你是眼鏡連鎖公司的規範編輯。AI 檢查發現一個問題，負責人補充了資料，請把補充的資料寫進規範，解決這個問題。
- 只改解決這個問題需要的條文；可以修改既有條文、在相關條文後新增一條或加「註」。
- 補充資料是口語，要改寫成規範條文語氣（完整句子、用詞精確、跟本規範其他條文一致），不是照抄。
- 只能寫補充資料裡有的內容：不要自己加例子（例：使用者沒說「住院」就不要寫住院）、不要加「或其他…之情形」這種概括說法——那正是 AI 檢查會判成「模糊」的寫法；使用者寫「等」時，照他列的項目寫成「包含以下情形：…」，並在 note 提醒他確認是否還有其他情形。
- 定義類用「註」或新增一條「定義」，寫成「本規範所稱『XX』，指…」。
- 如果同一個用語在多條出現，定義寫一次（放在最先出現的條文或新增一條定義），其他條文維持用詞一致。
${STYLE}
${OPS_SPEC}
只輸出 JSON：{"label":"按鈕文字（15 字內）","ops":[…],"note":"一句話說明怎麼改＋需要使用者再確認的地方"}`;
  const content = [{ type: 'text', text: [
    '# 正在修改的規範（目前內容）', D.docToPrompt(doc, 26000),
    '', '# AI 檢查發現的問題', `[${issue.kind}] ${issue.title}`, issue.detail, `相關條文：${(issue.codes || []).join('、') || '—'}`,
    '', '# 負責人補充的資料', supp,
  ].join('\n') }];
  const out = parseJson(await claude({ system, content, maxTokens: 3000 }));
  const t = tryOps(doc, out.ops || []);
  if (t.error) throw new Error(`AI 寫的修正套不上去（${t.error}），請換個說法再試一次，或直接在左邊編輯器修改`);
  if (!t.ops.length) throw new Error('AI 沒有產生修正，請把補充資料寫具體一點');
  issue.fix = { label: String(out.label || '套用補充後的修正').slice(0, 20), ops: t.ops, preview: t.preview, from_supplement: true, note: out.note || null };
  issue.supplement = { text: supp.slice(0, 1000), by: user?.name || null, at: new Date().toISOString() };
  must(await supabase.from('regulation_versions').update({ ai_checks: ac }).eq('id', versionId), '儲存失敗');
  return ac;
}

/** 送審前：檢查結果過期就重跑；回傳還沒處理的警告 */
/** 重跑 AI 檢查＋沿用舊的「已忽略」（同標題） */
async function freshCheck(versionId) {
  return check(versionId);   // 已處理（忽略／套用）的沿用改由 regulationCheckCore 依問題身分（kind＋條文代碼）帶過去（2026-11-12）
}

// 送審時的 AI 檢查改背景跑（2026-11-11 Louis「寫規範的 AI 一直網路超時」）：
//   以前送審請求裡同步等 AI 檢查（大份規範 60～100 秒），前端 60 秒就放棄 → 畫面「網路連線異常」、伺服器那邊 90 秒又逾時、什麼都沒存。
//   現在：檢查過期 → 背景開跑、立刻回 AI_CHECKING；前端每幾秒查一次，檢查好了自動再送審。失敗 → 下一次送審回 AI_CHECK_FAILED 講原因。
//   同一份草稿＋同一個內容只會有一個背景檢查（重新部署會中斷 → 下次送審自動重跑）。
const _bg = new Map();
function bgCheck(versionId, hash, prev) {
  const k = String(versionId); const cur = _bg.get(k);
  if (cur && cur.hash === hash && !cur.done) return cur;
  const job = { hash, started: Date.now(), done: false, error: null };
  _bg.set(k, job);
  freshCheck(versionId, prev).then(
    () => console.log(`[RegAI] 背景 AI 檢查完成 v${k}（${Math.round((Date.now() - job.started) / 1000)} 秒）`),
    (e) => { job.error = e.message; console.warn(`[RegAI] 背景 AI 檢查失敗 v${k}（${Math.round((Date.now() - job.started) / 1000)} 秒）：`, e.message); },
  ).finally(() => { job.done = true; });
  return job;
}
function checkStatus(versionId) {
  const j = _bg.get(String(versionId));
  return j ? { running: !j.done, error: j.error, seconds: Math.round((Date.now() - j.started) / 1000) } : null;
}

async function ensureChecked(versionId, { wait = true } = {}) {
  if (!enabled()) return { skipped: true, unresolved: [] };
  const v = must(await supabase.from('regulation_versions').select('doc, ai_checks').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  let ac = v.ai_checks;
  const h = hashDoc(v.doc);
  if (!ac || ac.doc_hash !== h) {
    if (wait) ac = await freshCheck(versionId, ac);
    else {
      const k = String(versionId); const j = _bg.get(k);
      if (j && j.done && j.hash === h && j.error) {
        _bg.delete(k);   // 講一次原因；下一次送審重新跑
        const e = new Error(`AI 檢查沒有完成（${/timeout|ECONNABORTED/i.test(j.error) ? 'AI 回覆太慢、逾時' : j.error}）。草稿已保留，請再按一次送審重試；一直失敗請回報。`);
        e.code = 'AI_CHECK_FAILED'; throw e;
      }
      const job = bgCheck(versionId, h, ac);
      const e = new Error(`AI 正在檢查這份草稿（已 ${Math.round((Date.now() - job.started) / 1000)} 秒，大份規範約 1～2 分鐘）。檢查好會自動送審，請先不要關閉畫面。`);
      e.code = 'AI_CHECKING'; throw e;
    }
  }
  const unresolved = Core.blocking(ac);
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


// ════════════════════════════════════════════════════════════
// AI 整理：替還沒填基本資料的規範產生「摘要／類型／適用情境／負責部門／關鍵字」建議
//   存成巡檢結果 kind=整理（fix＝set_meta 指令）→ 人按「產生草稿」或「全部送審」→ 審核人通過才生效
// ════════════════════════════════════════════════════════════
const DOC_TYPES = ['作業流程', '行政規定', '產品知識', '工作職掌', '人事規範', '其他'];
async function metaSuggest(regId, batchId) {
  const reg = must(await supabase.from('regulations').select('id, title, current_version').eq('id', regId).single(), '讀取規範失敗');
  const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', regId).eq('version', reg.current_version).maybeSingle(), '讀取內容失敗');
  const doc = cur?.doc; if (!doc) return null;
  const system = `你在幫眼鏡連鎖公司整理內部規範，讓人和 AI 都容易找到、看懂。讀完規範後填基本資料，只輸出 JSON：
{"doc_type":"${DOC_TYPES.join('|')}","summary":"一句話說這份規範在管什麼（40 字內，不要寫『本規範』）","scenario":"什麼時候會用到（30 字內，例如：客人要退貨時、每天打烊前）","owner_dept":"最可能負責的部門（營運部／市場部／企劃部／人資／財務／倉庫／加工中心／其他，看不出來就空字串）","keywords":"8～15 個門市人員會拿來搜尋的詞，用、分隔，包含同義詞與口語說法"}
用台灣繁體中文、口語。看不出來的欄位給空字串，不要亂猜。`;
  const out = parseJson(await claude({ model: MODEL_FAST, system, maxTokens: 700, timeout: 60000, content: [{ type: 'text', text: D.docToPrompt(doc, 12000) }] }));
  const ops = [];
  const set = (field, v, max) => { v = String(v || '').trim().slice(0, max); if (v && !String(doc[field] || '').trim()) ops.push({ op: 'set_meta', field, value: v }); };
  if (DOC_TYPES.includes(out.doc_type) && !doc.doc_type) ops.push({ op: 'set_meta', field: 'doc_type', value: out.doc_type });
  set('summary', out.summary, 80); set('scenario', out.scenario, 60); set('owner_dept', out.owner_dept, 20);
  const kw = [...new Set([...String(doc.keywords || '').split(/[、,，\s]+/), ...String(out.keywords || '').split(/[、,，\s]+/)].map(x => x.trim()).filter(x => x.length >= 2))].slice(0, 20).join('、');
  if (kw && kw !== String(doc.keywords || '').trim()) ops.push({ op: 'set_meta', field: 'keywords', value: kw });
  if (!ops.length) return null;
  const t = tryOps(doc, ops); if (t.error) return null;
  const detail = ops.map(o => `${({ doc_type: '類型', summary: '摘要', scenario: '適用情境', owner_dept: '負責部門', keywords: '關鍵字' })[o.field]}：${o.value}`).join('\n');
  const row = { regulation_id: regId, version: reg.current_version, batch_id: batchId, severity: 'info', kind: '整理', title: 'AI 整理：補上基本資料',
    detail, codes: [], fix: { label: '套用這些基本資料', ops: t.ops }, status: 'open' };
  await supabase.from('regulation_audit_findings').delete().eq('regulation_id', regId).eq('kind', '整理').eq('status', 'open');
  must(await supabase.from('regulation_audit_findings').insert(row), '寫入建議失敗');
  return row;
}
let metaJob = { running: false, progress: '', startedAt: null, finishedAt: null, result: null, error: null };
const getMetaStatus = () => metaJob;
async function runMetaSuggest({ limit = 600 } = {}) {
  if (!enabled()) throw new Error('AI 功能未啟用：請在 Render 設定 ANTHROPIC_API_KEY');
  if (metaJob.running) throw new Error('AI 整理進行中');
  metaJob = { running: true, progress: '準備中', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  const batchId = `meta-${Date.now()}`;
  try {
    // 只挑缺摘要或缺類型的；已經有一筆待處理建議的跳過
    const regs = must(await supabase.from('regulations').select('id, summary, doc_type').eq('status', 'active').limit(2000), '讀取規範失敗')
      .filter(r => !r.summary || !r.doc_type);
    const has = new Set(must(await supabase.from('regulation_audit_findings').select('regulation_id').eq('kind', '整理').in('status', ['open', 'drafted']), '讀取建議失敗').map(r => r.regulation_id));
    const ids = regs.filter(r => !has.has(r.id)).map(r => r.id).slice(0, limit);
    let made = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      metaJob.progress = `AI 整理第 ${i + 1}/${ids.length} 份`;
      try { if (await metaSuggest(ids[i], batchId)) made += 1; } catch (e) { failed += 1; console.warn('[RegMeta]', ids[i], e.message); }
    }
    metaJob = { ...metaJob, running: false, progress: '完成', finishedAt: new Date().toISOString(), result: { checked: ids.length, made, failed } };
    return metaJob.result;
  } catch (e) {
    metaJob = { ...metaJob, running: false, progress: '失敗', finishedAt: new Date().toISOString(), error: e.message };
    throw e;
  }
}


// ════════════════════════════════════════════════════════════
// 跨規範一起修改（2026-11）：把 other_regs 的「建議怎麼改」轉成每份規範可直接套用的修改指令
//   回傳每份規範的 ops（附原文 old），前端可逐條微調文字，再逐份或全部存草稿／送審
// ════════════════════════════════════════════════════════════
const OPEN_ST = ['draft', 'returned', 'pending'];
async function loadTargetReg(regId) {
  const reg = (await supabase.from('regulations').select('id, title, current_version, status').eq('id', regId).maybeSingle()).data;
  if (!reg) return { error: '找不到這份規範' };
  const vs = must(await supabase.from('regulation_versions').select('id, version, status, doc, created_by_id, created_by_name')
    .eq('regulation_id', regId).in('status', OPEN_ST).order('version', { ascending: false }).limit(1), '讀取版本失敗');
  const open = vs[0] || null;
  if (open?.status === 'pending') return { reg, error: '這份規範已有修改在送審中，審核完成前不能再改' };
  let doc = open?.doc;
  if (!doc) {
    const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', regId).eq('version', reg.current_version).maybeSingle(), '讀取現行版失敗');
    doc = cur?.doc || { sections: [] };
  }
  return { reg, doc, open_draft: open ? { id: open.id, by: open.created_by_name || null, by_id: open.created_by_id || null } : null };
}
const withOld = (doc, ops) => ops.map(o => {
  const r = o.code ? D.locate(doc, o.code) : null;
  return { ...o, old: r?.node?.text ?? null };
});

async function draftRelated(versionId, { items, doc: liveDoc } = {}) {
  const v = must(await supabase.from('regulation_versions').select('id, regulation_id, doc').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  const srcDoc = liveDoc && liveDoc.sections ? liveDoc : v.doc;

  // 依規範分組（代碼前綴＝規範編號）
  const groups = new Map();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 15)) {
    const code = String(it?.code || '').trim();
    const regId = Number(code.split('-')[0]);
    if (!regId || regId === Number(v.regulation_id)) continue;
    if (!groups.has(regId)) groups.set(regId, { regulation_id: regId, title: it.title || '', items: [] });
    groups.get(regId).items.push({ code, suggestion: String(it.suggestion || '') });
  }
  if (!groups.size) throw new Error('沒有其他規範需要一起修改');

  const regs = [];
  for (const g of groups.values()) {
    const t = await loadTargetReg(g.regulation_id);
    regs.push({ ...g, title: t.reg?.title || g.title, error: t.error || null, doc: t.doc || null, open_draft: t.open_draft || null });
  }
  const workable = regs.filter(r => !r.error);

  // 來源規範這次改了什麼（給 AI 當背景）
  const reg0 = must(await supabase.from('regulations').select('id, title, current_version').eq('id', v.regulation_id).single(), '讀取規範失敗');
  let oldDoc = { sections: [] };
  if (reg0.current_version > 0) {
    const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', reg0.id).eq('version', reg0.current_version).maybeSingle(), '讀取現行版失敗');
    oldDoc = cur?.doc || oldDoc;
  }
  const diff = D.diffDocs(oldDoc, srcDoc);
  const changeText = diff.changes.filter(c => c.kind !== 'move').slice(0, 25)
    .map(c => `[${c.code}] ${c.kind === 'add' ? '新增' : c.kind === 'del' ? '刪除' : '修改'}\n  原：${c.old || '—'}\n  新：${c.new || '—'}`).join('\n');

  let aiOut = { regs: [] };
  if (workable.length) {
    const per = Math.max(3000, Math.floor(24000 / workable.length));
    const system = `你是眼鏡連鎖公司的規範編輯。另一份規範剛被修改，下列幾份規範需要「跟著改」以保持一致。
請針對每一份規範，依「建議」產生可直接套用的修改指令，只改需要改的條文，其他不要動。
每份另外寫一句 change_note（給審核人看，說明是配合哪份規範修改、改了什麼，40 字內）。
${STYLE}
${OPS_SPEC}
只輸出 JSON：{"regs":[{"regulation_id":<編號>,"change_note":"…","ops":[…]}]}`;
    const content = [{ type: 'text', text: [
      `# 來源規範《${reg0.title}》這次的修改`, changeText || '（只有欄位變動）',
      ...workable.map(r => [
        '', `# 要跟著改的規範 #${r.regulation_id}《${r.title}》`,
        '## 建議', ...r.items.map(i => `- [${i.code}] ${i.suggestion}`),
        '## 目前全文', D.docToPrompt(r.doc, per),
      ].join('\n')),
    ].join('\n') }];
    try { aiOut = parseJson(await claude({ system, content, maxTokens: 6000, timeout: 110000 })); }
    catch (e) { console.warn('[RegAI] draftRelated AI 失敗：', e.message); }
  }

  const out = regs.map(r => {
    const base = { regulation_id: r.regulation_id, title: r.title, items: r.items, open_draft: r.open_draft ? { by: r.open_draft.by } : null, error: r.error };
    if (r.error) return { ...base, ops: [], change_note: '' };
    const a = (aiOut.regs || []).find(x => Number(x.regulation_id) === Number(r.regulation_id));
    const tried = a?.ops?.length ? tryOps(r.doc, a.ops) : { error: 'AI 沒有產生修改' };
    if (!tried.error) return { ...base, ops: withOld(r.doc, tried.ops), change_note: a.change_note || `配合《${reg0.title}》修改` };
    // 套不上：先放原文讓使用者直接改
    const fallback = r.items.map(i => ({ op: 'replace_text', code: i.code, text: D.locate(r.doc, i.code)?.node?.text || '' })).filter(o => D.locate(r.doc, o.code));
    return { ...base, ai_failed: true, ops: withOld(r.doc, fallback), change_note: `配合《${reg0.title}》修改` };
  });
  return { source_title: reg0.title, regs: out };
}


// ════════════════════════════════════════════════════════════
// 先確認方向（2026-11）：編輯助理在給方案前，需求不清楚就先問（清楚就直接 ready）
// ════════════════════════════════════════════════════════════
const CLARIFY_RULES = `在動手寫之前先確認方向，避免寫錯方向浪費時間。
只輸出 JSON：
{"understanding":"用 1～3 句白話說你理解要做什麼",
 "plan":["打算怎麼寫／會改哪些地方（大綱，最多 8 點）"],
 "questions":[{"q":"問題（一句話）","why":"不問清楚會影響什麼（一句話）","options":["常見答案A","常見答案B"]}],
 "ready":true 或 false}
規則：
- 只問「會影響方向或內容對錯」的關鍵問題，最多 4 題；能從規範內容或常識合理推斷的不要問。
- 日期、金額、數量這類之後可以留「（請填）」補的，不要問。
- options 給 2～4 個最可能的答案讓人直接點（沒有合適的可給空陣列）。
- 需求已經夠清楚：questions 給 []、ready 給 true。`;
async function assistClarify(versionId, { message, doc: liveDoc } = {}) {
  const v = must(await supabase.from('regulation_versions').select('id, doc, status').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  const doc = liveDoc && liveDoc.sections ? liveDoc : v.doc;
  const msg = String(message || '').trim();
  if (!msg) return { ready: true, understanding: '', plan: [], questions: [] };
  const system = `你是眼鏡連鎖公司的規範編輯助理，使用者要你修改下面這份規範。
小範圍、意思明確的修改（例如改時間、改字、加一條清楚的規定）直接 ready，不要為了問而問。
${CLARIFY_RULES}`;
  const out = parseJson(await claude({ model: MODEL_FAST, maxTokens: 1200, timeout: 45000, system,
    content: [{ type: 'text', text: ['# 規範（草稿）', D.docToPrompt(doc, 16000), '', '# 使用者的需求', msg].join('\n') }] }));
  return normClarify(out);
}
function normClarify(out) {
  const questions = (Array.isArray(out.questions) ? out.questions : []).slice(0, 4).map(q => ({
    q: String(q.q || '').trim(), why: String(q.why || '').trim(),
    options: (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 4),
  })).filter(q => q.q);
  return { ready: !questions.length && out.ready !== false, understanding: String(out.understanding || '').trim(),
    plan: (Array.isArray(out.plan) ? out.plan : []).map(String).filter(Boolean).slice(0, 8), questions };
}

module.exports = { lookupClauses, fixIssue, assistClarify, normClarify, CLARIFY_RULES, draftRelated, metaSuggest, runMetaSuggest, getMetaStatus, enabled, hashDoc, assist, chooseOption, check, resolveIssue, ensureChecked, checkStatus, auditRegulation, runAudit, getAuditStatus, tryOps };
