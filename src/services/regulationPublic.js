// services/regulationPublic.js
// 人員「查規範」（手機頁 /rules，用 APP 編號確認身分，不需登入營運系統）
//   搜尋條文、看規範全文、最近更新、我的扣分紀錄、問 AI（只根據規範回答並附條文出處）
const axios    = require('axios');
const supabase = require('../config/supabase');
const D = require('./regulationDoc');

const MAP_ROLES = ['LOHAS店長', '副店長', 'LOHAS店員', '穩定新人', '新進人員', '區長', '辦公室', '直通車店長', '直通車店員'];
const STORE_ROLES = ['LOHAS店長', '副店長', 'LOHAS店員', '穩定新人', '新進人員'];
const MODEL_ASK  = process.env.REGULATION_ASK_MODEL || process.env.REGULATION_AI_MODEL || 'claude-sonnet-4-5';
const MODEL_FAST = process.env.REGULATION_AI_FAST_MODEL || 'claude-haiku-4-5';
const must = (r, msg) => { if (r.error) throw new Error(`${msg}：${r.error.message}`); return r.data; };
const clean = (s) => String(s || '').replace(/[%,()]/g, ' ').trim();

/** 用 APP 編號確認身分，推估 MAP 身分別（用來過濾適用的規範） */
async function verify(appNumber) {
  const app = String(appNumber || '').trim();
  if (!app) throw new Error('缺少 APP 編號');
  const emp = must(await supabase.from('employees').select('erpid, name, store_name, jobtitle, app_number')
    .eq('app_number', app).eq('is_active', true).maybeSingle(), '查詢員工失敗');
  if (!emp) throw new Error('找不到這個 APP 編號的在職員工');
  const isStore = String(emp.store_name || '').includes('店');
  let roles;
  if (!isStore) roles = ['辦公室'];
  else {
    const job = String(emp.jobtitle || '');
    const hit = MAP_ROLES.filter(r => r !== '辦公室' && job.includes(r.replace('LOHAS', '')));
    roles = hit.length ? [...new Set([...hit, '新進人員', '穩定新人'])] : STORE_ROLES;   // 新人／穩定新人從職稱看不出來，一律帶上
    if (/區長/.test(job)) roles = [...new Set([...roles, '區長'])];
  }
  return { erpid: emp.erpid, name: emp.name, store_name: emp.store_name, jobtitle: emp.jobtitle, roles, app_number: emp.app_number };
}

/** 這個人適用的規範編號（規範沒設適用身分的，視為全部適用） */
async function applicableIds(roles) {
  const regs = must(await supabase.from('regulations').select('id, roles').eq('status', 'active'), '讀取規範失敗');
  return new Set(regs.filter(r => !r.roles?.length || !roles?.length || r.roles.some(x => roles.includes(x))).map(r => r.id));
}

async function search(emp, q, { all = false } = {}) {
  const s = clean(q).replace(/[㄀-ㄯˇˊˋ˙]/g, '');
  if (s.length < 1) return { regulations: [], clauses: [] };
  const ids = all ? null : await applicableIds(emp.roles);
  const regs = must(await supabase.from('regulations').select('id, title, category, current_version, roles').eq('status', 'active').ilike('title', `%${s}%`).limit(30), '搜尋規範失敗');
  let q2 = supabase.from('regulation_clauses').select('code, regulation_id, display_no, section_title, text, penalty, regulations(title, category)')
    .eq('active', true).ilike('text', `%${s}%`).order('regulation_id').order('sort').limit(200);
  if (/^\d+-[\dp.]+$/i.test(s)) q2 = supabase.from('regulation_clauses').select('code, regulation_id, display_no, section_title, text, penalty, regulations(title, category)').eq('active', true).ilike('code', `${s}%`).limit(50);
  const clauses = must(await q2, '搜尋條文失敗');
  const keep = (id) => !ids || ids.has(Number(id));
  return {
    regulations: regs.filter(r => keep(r.id)).map(({ roles, ...r }) => r),
    clauses: clauses.filter(c => keep(c.regulation_id)).slice(0, 80),
  };
}

async function getRegulation(id) {
  const reg = must(await supabase.from('regulations').select('id, title, category, summary, scenario, owner_dept, roles, current_version, status, score, updated_at').eq('id', id).maybeSingle(), '讀取規範失敗');
  if (!reg || reg.status !== 'active') throw new Error('找不到這份規範');
  const v = must(await supabase.from('regulation_versions').select('doc, published_at, change_note').eq('regulation_id', id).eq('version', reg.current_version).maybeSingle(), '讀取內容失敗');
  const doc = v?.doc || { sections: [] };
  let recent_change = null;
  try { recent_change = await require('./regulationService').recentChange(reg.id); } catch (e) { console.warn('[RegPublic] recentChange', e.message); }
  return { regulation: reg, doc: { ...doc, parse_flags: undefined }, published_at: v?.published_at, change_note: v?.change_note, recent_change };
}

/** 最近更新：本系統審核通過的版本（不含從 MAP 匯入的），附修改對照與開始扣分日 */
async function recent(emp, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = must(await supabase.from('regulation_versions')
    .select('regulation_id, version, change_note, published_at, review, regulations(title, category, status, current_version)')
    .eq('status', 'approved').neq('source', 'map_import').gte('published_at', since)
    .order('published_at', { ascending: false }).limit(60), '讀取最近更新失敗');
  const ids = await applicableIds(emp.roles);
  return rows.filter(r => r.regulations?.status === 'active' && ids.has(Number(r.regulation_id))).map(r => ({
    regulation_id: r.regulation_id, title: r.regulations?.title, category: r.regulations?.category, version: r.version,
    is_current: r.regulations?.current_version === r.version, change_note: r.change_note, published_at: r.published_at,
    penalty_from: new Date(new Date(r.published_at).getTime() + 7 * 864e5).toISOString(),   // 發佈 7 天後開始扣分
    summary: r.review?.summary || [],
    changes: (r.review?.diff?.changes || []).filter(c => c.kind !== 'move').slice(0, 30)
      .map(c => ({ kind: c.kind, code: c.code, display_no: c.display_no, old: c.old || null, new: c.new || null })),
  }));
}

async function myDeductions(emp) {
  return must(await supabase.from('regulation_deductions')
    .select('id, regulation_id, regulation_title, version, clause_code, clause_text, score, incident_date, note, status, created_at, reviewed_at')
    .eq('employee_erpid', emp.erpid).in('status', ['approved', 'pending']).order('created_at', { ascending: false }).limit(100), '讀取扣分紀錄失敗');
}

// ── 問 AI ────────────────────────────────────────────────────
async function claude({ model, system, text, maxTokens }) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 90000 });
  return (res.data.content || []).map(c => c.text || '').join('').trim();
}
function parseJson(t) {
  t = String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.slice(a, b + 1)); }
}

async function ask(emp, question, history = []) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI 問答還沒啟用，請先用「搜尋」查規範');
  const qtext = String(question || '').trim().slice(0, 500);
  if (qtext.length < 2) throw new Error('請輸入問題');
  const ids = await applicableIds(emp.roles);

  // 1. 抽關鍵字（含同義詞），搜條文
  let keywords = [];
  try {
    const out = await claude({ model: MODEL_FAST, maxTokens: 300,
      system: '你在幫眼鏡門市員工查公司規範。從問題中抽出 4～8 個適合在規範全文搜尋的中文關鍵詞（2～6 字），包含可能的同義說法（例如「取件」「交件」、「退貨」「退件」）。只輸出 JSON：{"keywords":["…"]}',
      text: `${history.slice(-2).map(h => h.q).join('\n')}\n${qtext}` });
    keywords = (parseJson(out).keywords || []).map(k => clean(k)).filter(k => k.length >= 2).slice(0, 8);
  } catch (e) { console.warn('[RegAsk] 關鍵字失敗：', e.message); }
  if (!keywords.length) keywords = [qtext.slice(0, 6)];

  // 2. 撈候選條文：每個關鍵字最多 400 條（常見詞如「結帳」會命中上百條，只取前幾十條會漏掉關鍵條文）
  const score = new Map();
  const add = (c, w) => { if (!ids.has(Number(c.regulation_id))) return; const cur = score.get(c.code) || { c, n: 0 }; cur.n += w; score.set(c.code, cur); };
  const SEL = 'code, regulation_id, parent_code, display_no, section_title, text, notes, sort, regulations(title)';
  for (const kw of keywords) {
    const w = qtext.includes(kw) ? 2 : 1;   // 問題裡原本就有的詞比 AI 補的同義詞重要
    const { data } = await supabase.from('regulation_clauses').select(SEL).eq('active', true).ilike('text', `%${kw}%`).limit(400);
    (data || []).forEach(c => add(c, w));
    // 規範標題命中關鍵字（例如「交件」→「眼鏡交件流程MAP」）→ 把那份規範前面的條文也拉進來
    const { data: regs } = await supabase.from('regulations').select('id').eq('status', 'active').ilike('title', `%${kw}%`).limit(3);
    for (const r of regs || []) {
      const { data: cl } = await supabase.from('regulation_clauses').select(SEL).eq('active', true).eq('regulation_id', r.id).order('sort').limit(30);
      (cl || []).forEach(c => add(c, 1.5));
    }
  }
  // 3. 排序：命中幾個關鍵字＋和問題字面的相似度（中文兩字詞重疊）；太長的條文稍微降權
  const bigrams = (t) => { const z = String(t || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ''); const out = new Set(); for (let i = 0; i < z.length - 1; i++) out.add(z.slice(i, i + 2)); return out; };
  const qb = bigrams(qtext);
  score.forEach(v => {
    const t = v.c.text || '';
    const tb = bigrams(t); let ov = 0; qb.forEach(b => { if (tb.has(b)) ov += 1; });
    v.n += ov;
    if (t.length > 400) v.n -= 0.5;
  });
  // 命中越多關鍵字越前面；同一份規範最多 8 條，總共 45 條
  const perReg = new Map();
  const picked = [...score.values()].sort((a, b) => b.n - a.n).filter(({ c }) => {
    const k = perReg.get(c.regulation_id) || 0; if (k >= 10) return false; perReg.set(c.regulation_id, k + 1); return true;
  }).slice(0, 80).map(x => x.c);
  // 子條文要連同上層條文一起給 AI，才看得懂前後文
  const have = new Set(picked.map(c => c.code));
  const parents = [...new Set(picked.map(c => c.parent_code).filter(p => p && !have.has(p)))].slice(0, 15);
  if (parents.length) {
    const { data } = await supabase.from('regulation_clauses').select(SEL).in('code', parents);
    (data || []).forEach(c => picked.push(c));
  }

  const cut = (t, n) => (String(t || '').length > n ? `${String(t).slice(0, n)}…` : String(t || ''));
  const ctx = picked.map(c => `【${c.code}】《${c.regulations?.title}》${c.section_title ? `${c.section_title} ` : ''}${c.display_no}：${cut(c.text, 300)}${(c.notes || []).map(n => `（${n.kind}：${cut(n.text, 120)}）`).join('')}`).join('\n');
  const system = `你是樂活眼鏡的規範小幫手，回答門市與總部同仁「公司規範怎麼規定」。
規則：
1. 只能根據下面提供的規範條文回答，不可以用常識或猜測補充公司規定。
2. 每個重點後面標出處，格式【條文代碼】，例如【903-4.1】，只能用條文清單裡真的有的代碼。
3. 先給一句直接的答案，再分點說明怎麼做；用口語、簡短，適合手機閱讀。
4. 條文裡找不到答案，就老實說「規範裡沒有寫到」，建議詢問主管，不要編造。found 設 false。
5. 如果不同條文說法不一致，要指出來，建議以主管說明為準。
只輸出 JSON：{"answer":"回答內容（可用換行與「・」分點）","citations":["903-4.1"],"found":true}`;
  const text = `# 提問的同仁\n${emp.name}（${emp.store_name || ''}，${emp.jobtitle || ''}）\n\n# 之前的對話\n${history.slice(-3).map(h => `問：${h.q}\n答：${String(h.a || '').slice(0, 400)}`).join('\n') || '（無）'}\n\n# 相關規範條文\n${ctx || '（沒有找到相關條文）'}\n\n# 問題\n${qtext}`;

  const out = parseJson(await claude({ model: MODEL_ASK, system, text, maxTokens: 1500 }));
  const known = new Map(picked.map(c => [c.code, c]));
  const cited = [...new Set([...(out.citations || []), ...String(out.answer || '').matchAll(/【([^】]+)】/g)].map(x => (Array.isArray(x) ? x[1] : x)))].filter(c => known.has(c));
  const citations = cited.map(code => { const c = known.get(code); return { code, regulation_id: c.regulation_id, title: c.regulations?.title, display_no: c.display_no, text: c.text }; });
  const found = !!out.found && citations.length > 0;
  // 拿掉 AI 自己編、不在條文清單裡的出處
  const answer = String(out.answer || '').replace(/【([^】]+)】/g, (m, code) => (known.has(code) ? m : ''));
  const { data: logged } = await supabase.from('regulation_questions').insert({
    employee_erpid: emp.erpid, employee_name: emp.name, store_name: emp.store_name, question: qtext,
    answer, citations: cited, found,
  }).select('id').maybeSingle();
  return { id: logged?.id || null, answer, citations, found, keywords };
}

async function feedback(emp, id, helpful) {
  must(await supabase.from('regulation_questions').update({ helpful: !!helpful }).eq('id', id).eq('employee_erpid', emp.erpid), '儲存回饋失敗');
  return { ok: true };
}

/** 後台：人員問了什麼、哪些找不到答案 */
async function listQuestions({ found, limit = 200 } = {}) {
  let q = supabase.from('regulation_questions').select('*').order('created_at', { ascending: false }).limit(limit);
  if (found === 'false') q = q.eq('found', false);
  if (found === 'unhelpful') q = q.eq('helpful', false);
  return must(await q, '讀取提問紀錄失敗');
}

async function categories() {
  const data = must(await supabase.from('regulations').select('id, title, category, roles').eq('status', 'active').order('title'), '讀取規範失敗');
  return data;
}

module.exports = { verify, search, getRegulation, recent, myDeductions, ask, feedback, listQuestions, categories, applicableIds };
