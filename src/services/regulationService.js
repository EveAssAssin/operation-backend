// services/regulationService.js
// 規範系統（Phase 1）：匯入 MAP、版本／草稿、送審審核、推播、引用條文扣分
const axios    = require('axios');
const supabase = require('../config/supabase');
const mapScore = require('./mapScoreApi');
const linePush = require('./linePushService');
const { parseRegulation } = require('./regulationParser');
const D = require('./regulationDoc');
const AI = require('./regulationAi');

const FRONTEND = (process.env.OPERATION_FRONTEND_URL || 'https://operation-frontend.onrender.com').replace(/\/$/, '');
const MAP_ROLES = ['LOHAS店長', '副店長', 'LOHAS店員', '穩定新人', '新進人員', '區長', '辦公室', '直通車店長', '直通車店員'];
const OPEN_STATUSES = ['draft', 'pending', 'returned'];

const must = (r, msg) => { if (r.error) throw new Error(`${msg}：${r.error.message}`); return r.data; };
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const nowIso = () => new Date().toISOString();

// ════════════════════════════════════════════════════════════
// 設定：審核人
// ════════════════════════════════════════════════════════════
async function getReviewer() {
  const { data } = await supabase.from('report_settings').select('value').eq('key', 'regulation_reviewer').maybeSingle();
  return data?.value || { erpid: null, app_number: null, name: null };
}
async function setReviewer(erpid, by) {
  const { data: emp } = await supabase.from('employees').select('erpid, app_number, name').eq('erpid', String(erpid)).maybeSingle();
  if (!emp) throw new Error('找不到這位員工');
  const value = { erpid: emp.erpid, app_number: emp.app_number || null, name: emp.name };
  must(await supabase.from('report_settings').upsert({ key: 'regulation_reviewer', value, updated_by: by || null, updated_at: nowIso() }), '儲存審核人失敗');
  return value;
}
function isReviewer(user, reviewer) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  return !!(reviewer?.erpid && String(user.erpid || '') === String(reviewer.erpid));
}

// ════════════════════════════════════════════════════════════
// 匯入左手 MAP 規範
// ════════════════════════════════════════════════════════════
let importJob = { running: false, startedAt: null, finishedAt: null, result: null, error: null, progress: '' };
function getImportStatus() { return importJob; }

function toDoc(reason, parsed, scoreInfo) {
  const strip = (arr) => arr.forEach(c => {
    if (c.stamps && c.stamps.length) c.hist = c.stamps; // 原文日期戳記保留在 hist（不顯示在正文）
    delete c.stamps; delete c.no; delete c.loose;
    if (!c.flags || !c.flags.length) delete c.flags;
    c.t = c.t || null; c.notes = c.notes || []; c.subs = c.subs || [];
    strip(c.subs);
  });
  const sections = parsed.sections.map(s => { strip(s.items); return { title: s.title, items: s.items }; });
  return {
    title: String(reason.title || '').trim(),
    category: reason.categoryName || '',
    doc_type: null, summary: '', scenario: '', owner_dept: '',
    roles: Array.isArray(reason.enableRoles) ? reason.enableRoles : [],
    keywords: parsed.keywords || '',
    legacy_meta: parsed.legacyMeta || '',
    parse_flags: parsed.flags || [],
    sections,
  };
}

async function fetchAllReasons() {
  const all = [];
  let page = 1, totalPage = 1;
  do {
    const d = await mapScore.getReasonList(page, 50);
    all.push(...(d.reasons || []));
    totalPage = Number(d.totalPage || 1);
    importJob.progress = `讀取 MAP 規範第 ${page}/${totalPage} 頁`;
    page += 1;
  } while (page <= totalPage);
  // 分數／獎金：#26 依身分別讀，各身分相同，聯集即可
  const scores = new Map();
  for (const role of MAP_ROLES) {
    try {
      const cats = await mapScore.getReasons(role);
      cats.forEach(c => (c.reasons || []).forEach(r => { if (!scores.has(r.reasonId)) scores.set(r.reasonId, { score: Number(r.score), bonus: Number(r.bonus) }); }));
    } catch (e) { console.warn(`[Regulation] 讀取 ${role} 分數失敗：${e.message}`); }
  }
  return { reasons: all, scores };
}

async function rebuildClauses(regId, version, doc) {
  const flat = D.flatten(doc).filter(c => c.code);
  must(await supabase.from('regulation_clauses').update({ active: false }).eq('regulation_id', regId), '更新條文索引失敗');
  for (const part of chunk(flat, 500)) {
    must(await supabase.from('regulation_clauses').upsert(part.map(c => ({
      code: c.code, regulation_id: regId, version, parent_code: c.parent_code, section_title: c.section_title,
      display_no: c.display_no, ctype: c.ctype, text: c.text || '（空白）', notes: c.notes || [], penalty: c.penalty, sort: c.sort, active: true,
    })), { onConflict: 'code' }), '寫入條文索引失敗');
  }
}

/**
 * 從 MAP 匯入／更新
 *   - 系統裡沒有的規範 → 新增（第 1 版，直接生效）
 *   - 已有、且從未在本系統修改過、MAP 版本較新 → 新增一版（來源 MAP）
 *   - 已在本系統修改過 → 不覆蓋，列入 conflicts
 */
async function importFromMap(by) {
  if (importJob.running) throw new Error('匯入進行中，請稍候');
  importJob = { running: true, startedAt: nowIso(), finishedAt: null, result: null, error: null, progress: '開始' };
  try {
    const { reasons, scores } = await fetchAllReasons();
    importJob.progress = `解析 ${reasons.length} 份規範`;
    const existing = must(await supabase.from('regulations').select('id, map_version, current_version, source, used_codes'), '讀取現有規範失敗');
    const exMap = new Map(existing.map(r => [Number(r.id), r]));
    const edited = new Set();
    if (existing.length) {
      const vs = must(await supabase.from('regulation_versions').select('regulation_id').neq('source', 'map_import'), '讀取版本失敗');
      vs.forEach(v => edited.add(Number(v.regulation_id)));
    }

    const result = { total: reasons.length, created: 0, updated: 0, unchanged: 0, conflicts: [], parseFlags: 0, clauses: 0 };
    const newRegs = [], newVers = [], clauseJobs = [];
    for (const r of reasons) {
      const id = Number(r.reasonId);
      const parsed = parseRegulation(id, r.description);
      const doc = toDoc(r, parsed, scores.get(id));
      if (doc.parse_flags.length) result.parseFlags += 1;
      const sc = scores.get(id) || { score: -1, bonus: 0 };
      const ex = exMap.get(id);
      const codes = D.allCodes(doc);
      if (!ex) {
        newRegs.push({ id, status: 'active', title: doc.title, category: doc.category, roles: doc.roles, keywords: doc.keywords, legacy_meta: doc.legacy_meta,
          current_version: 1, used_codes: codes, score: sc.score, bonus: sc.bonus, source: 'map_import', map_reason_id: id,
          map_version: r.version, map_update_time: r.updateTime || null, map_sync_status: 'synced' });
        newVers.push({ regulation_id: id, version: 1, status: 'approved', doc, source: 'map_import', change_note: `自 MAP 匯入（MAP 第 ${r.version} 版）`,
          created_by_name: by || '系統匯入', published_at: nowIso(), reviewed_by_name: '系統匯入', reviewed_at: nowIso() });
        clauseJobs.push([id, 1, doc]);
        result.created += 1;
      } else if (edited.has(id)) {
        if (Number(ex.map_version) !== Number(r.version)) result.conflicts.push({ id, title: doc.title, map_version: r.version });
        else result.unchanged += 1;
      } else if (Number(ex.map_version) !== Number(r.version)) {
        const v = Number(ex.current_version) + 1;
        must(await supabase.from('regulation_versions').insert({ regulation_id: id, version: v, status: 'approved', doc, source: 'map_import',
          change_note: `自 MAP 更新（MAP 第 ${r.version} 版）`, created_by_name: by || '系統匯入', published_at: nowIso(), reviewed_by_name: '系統匯入', reviewed_at: nowIso() }), '新增版本失敗');
        must(await supabase.from('regulations').update({ title: doc.title, category: doc.category, roles: doc.roles, current_version: v,
          used_codes: [...new Set([...(ex.used_codes || []), ...codes])], score: sc.score, bonus: sc.bonus,
          map_version: r.version, map_update_time: r.updateTime || null, updated_at: nowIso() }).eq('id', id), '更新規範失敗');
        clauseJobs.push([id, v, doc]);
        result.updated += 1;
      } else result.unchanged += 1;
    }
    importJob.progress = `寫入 ${newRegs.length} 份新規範`;
    for (const part of chunk(newRegs, 100)) must(await supabase.from('regulations').insert(part), '寫入規範失敗');
    for (const part of chunk(newVers, 50)) must(await supabase.from('regulation_versions').insert(part), '寫入版本失敗');
    // 新匯入的規範：條文一次批次寫入；更新的規範：逐份重建（要先把舊條文標成非現行）
    const newIds = new Set(newRegs.map(r => r.id));
    const bulk = [];
    let k = 0;
    for (const [id, v, doc] of clauseJobs) {
      const flat = D.flatten(doc).filter(c => c.code);
      result.clauses += flat.length;
      if (newIds.has(id)) {
        flat.forEach(c => bulk.push({ code: c.code, regulation_id: id, version: v, parent_code: c.parent_code, section_title: c.section_title,
          display_no: c.display_no, ctype: c.ctype, text: c.text || '（空白）', notes: c.notes || [], penalty: c.penalty, sort: c.sort, active: true }));
      } else {
        k += 1; importJob.progress = `更新條文索引 ${k}`;
        await rebuildClauses(id, v, doc);
      }
    }
    const parts = chunk(bulk, 1000);
    for (let i = 0; i < parts.length; i++) {
      importJob.progress = `寫入條文 ${Math.min((i + 1) * 1000, bulk.length)}/${bulk.length}`;
      must(await supabase.from('regulation_clauses').upsert(parts[i], { onConflict: 'code' }), '寫入條文索引失敗');
    }
    importJob = { ...importJob, running: false, finishedAt: nowIso(), result, progress: '完成' };
    return result;
  } catch (e) {
    console.error('[Regulation] 匯入失敗：', e.message);
    importJob = { ...importJob, running: false, finishedAt: nowIso(), error: e.message, progress: '失敗' };
    throw e;
  }
}

// ════════════════════════════════════════════════════════════
// 查詢
// ════════════════════════════════════════════════════════════
async function listRegulations({ q, category, status = 'active', limit = 600 } = {}) {
  let query = supabase.from('regulations')
    .select('id, title, category, doc_type, roles, status, current_version, source, map_sync_status, updated_at')
    .order('category').order('title').limit(limit);
  if (status) query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  if (q) {
    const s = String(q).trim();
    if (/^\d+$/.test(s)) query = query.or(`id.eq.${s},title.ilike.%${s}%`);
    else query = query.ilike('title', `%${s}%`);
  }
  const regs = must(await query, '讀取規範失敗');
  // 有開著的草稿／送審
  const ids = regs.map(r => r.id);
  const open = ids.length ? must(await supabase.from('regulation_versions').select('regulation_id, status').in('status', OPEN_STATUSES), '讀取草稿失敗') : [];
  const om = new Map(open.map(o => [Number(o.regulation_id), o.status]));
  return regs.map(r => ({ ...r, open_status: om.get(Number(r.id)) || null }));
}

/** 全文搜尋條文（扣分、查規範用） */
async function searchClauses({ q, regulationId, limit = 40 } = {}) {
  let query = supabase.from('regulation_clauses')
    .select('code, regulation_id, version, display_no, section_title, ctype, text, penalty, regulations(title, score)')
    .eq('active', true).order('regulation_id').order('sort').limit(limit);
  if (regulationId) query = query.eq('regulation_id', regulationId);
  if (q) {
    const s = String(q).trim().replace(/[%,()]/g, ' ');
    query = /^\d+-[\d.p]+$/i.test(s) ? query.ilike('code', `${s}%`) : query.ilike('text', `%${s}%`);
  }
  return must(await query, '搜尋條文失敗');
}

async function getRegulation(id) {
  const reg = must(await supabase.from('regulations').select('*').eq('id', id).maybeSingle(), '讀取規範失敗');
  if (!reg) throw new Error('找不到這份規範');
  const versions = must(await supabase.from('regulation_versions')
    .select('id, version, status, source, change_note, created_by_name, created_at, submitted_at, reviewed_by_name, reviewed_at, review_note, reviewer_edited, published_at')
    .eq('regulation_id', id).order('version', { ascending: false }), '讀取版本失敗');
  const cur = must(await supabase.from('regulation_versions').select('doc').eq('regulation_id', id).eq('version', reg.current_version).maybeSingle(), '讀取內容失敗');
  const open = versions.find(v => OPEN_STATUSES.includes(v.status)) || null;
  return { regulation: reg, doc: cur?.doc || null, versions, open_draft: open };
}

async function getVersion(versionId) {
  const v = must(await supabase.from('regulation_versions').select('*').eq('id', versionId).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  return v;
}

async function getVersionByNo(regId, versionNo) {
  const v = must(await supabase.from('regulation_versions').select('*').eq('regulation_id', regId).eq('version', versionNo).maybeSingle(), '讀取版本失敗');
  if (!v) throw new Error('找不到這個版本');
  return v;
}

// ════════════════════════════════════════════════════════════
// 草稿
// ════════════════════════════════════════════════════════════
async function createDraft(regId, user) {
  const { regulation, doc, open_draft } = await getRegulation(regId);
  if (open_draft) {
    if (open_draft.status === 'pending') throw new Error('這份規範已有修改在送審中，審核完成前不能再開新的修改');
    return getVersion(open_draft.id);
  }
  const maxV = must(await supabase.from('regulation_versions').select('version').eq('regulation_id', regId).order('version', { ascending: false }).limit(1), '讀取版本失敗');
  const version = (maxV[0]?.version || regulation.current_version) + 1;
  return must(await supabase.from('regulation_versions').insert({
    regulation_id: regId, version, status: 'draft', doc: JSON.parse(JSON.stringify(doc)), source: 'editor',
    created_by_name: user?.name || null, created_by_id: user?.id ? String(user.id) : null,
  }).select().single(), '建立草稿失敗');
}

/** 新增一份全新規範（自建，編號從 900001 起），建立草稿 */
async function createNewRegulation({ title, category, doc_type }, user) {
  if (!String(title || '').trim()) throw new Error('請填規範標題');
  // 自建規範編號從 900001 起（MAP 規範編號目前在 5000 以內，不會撞號）
  const r = must(await supabase.from('regulations').select('id').gte('id', 900001).order('id', { ascending: false }).limit(1), '取號失敗');
  const id = Number(r[0]?.id || 900000) + 1;
  const doc = { title: title.trim(), category: category || '', doc_type: doc_type || null, summary: '', scenario: '', owner_dept: '', roles: [], sections: [{ title: '', items: [] }] };
  must(await supabase.from('regulations').insert({ id, title: doc.title, category: doc.category, doc_type: doc.doc_type, current_version: 0, status: 'draft', source: 'native', score: -1 }), '建立規範失敗');
  const v = must(await supabase.from('regulation_versions').insert({
    regulation_id: id, version: 1, status: 'draft', doc, source: 'editor', change_note: '新增規範',
    created_by_name: user?.name || null, created_by_id: user?.id ? String(user.id) : null,
  }).select().single(), '建立草稿失敗');
  return v;
}

function normalizeDoc(doc) {
  const d = JSON.parse(JSON.stringify(doc || {}));
  d.roles = Array.isArray(d.roles) ? d.roles : [];
  d.sections = (Array.isArray(d.sections) ? d.sections : []).map(s => ({ ...s, title: String(s.title || '').trim(), items: Array.isArray(s.items) ? s.items : [] }));
  const clean = (arr) => arr.forEach(c => {
    c.text = String(c.text || '').trim();
    c.t = c.t || null;
    c.pen = (c.pen === '' || c.pen === undefined || c.pen === null) ? null : Math.trunc(Number(c.pen));
    c.notes = (c.notes || []).filter(n => String(n.text || '').trim()).map(n => ({ kind: n.kind === '例' ? '例' : '註', text: String(n.text).trim() }));
    c.images = (Array.isArray(c.images) ? c.images : []).filter(im => im && im.url).map(im => ({ url: String(im.url), caption: String(im.caption || '').trim() }));
    if (!c.images.length) delete c.images;
    c.subs = Array.isArray(c.subs) ? c.subs : [];
    clean(c.subs);
  });
  d.sections.forEach(s => clean(s.items));
  return d;
}

async function saveDraft(versionId, { doc, change_note }, user) {
  const v = await getVersion(versionId);
  if (!['draft', 'returned'].includes(v.status)) throw new Error(v.status === 'pending' ? '送審中的版本不能修改' : '這個版本已結束，不能修改');
  const reg = must(await supabase.from('regulations').select('id, used_codes').eq('id', v.regulation_id).single(), '讀取規範失敗');
  const nd = D.assignCodes(reg.id, normalizeDoc(doc), reg.used_codes || []);
  return must(await supabase.from('regulation_versions').update({
    doc: nd, change_note: change_note ?? v.change_note, status: 'draft', updated_at: nowIso(),
  }).eq('id', versionId).select().single(), '儲存草稿失敗');
}

async function discardDraft(versionId) {
  const v = await getVersion(versionId);
  if (!['draft', 'returned'].includes(v.status)) throw new Error('只能捨棄草稿或被退回的版本');
  must(await supabase.from('regulation_versions').update({ status: 'discarded', updated_at: nowIso() }).eq('id', versionId), '捨棄失敗');
  // 全新規範的第一版被捨棄 → 規範一起停用
  const reg = must(await supabase.from('regulations').select('current_version').eq('id', v.regulation_id).single(), '讀取規範失敗');
  if (Number(reg.current_version) === 0) must(await supabase.from('regulations').update({ status: 'disabled' }).eq('id', v.regulation_id), '更新規範失敗');
  return { ok: true };
}

// ════════════════════════════════════════════════════════════
// 影響範圍、AI 摘要
// ════════════════════════════════════════════════════════════
// 依適用身分找出受影響員工
//   門市：部門名稱含「店」。適用身分含 4 種以上門市身分 → 視為全體門市人員；否則用職稱比對
//   辦公室：部門名稱不含「店」
function matchByRoles(emps, roles) {
  const storeRoles = (roles || []).filter(r => r !== '辦公室');
  const allStore = storeRoles.length >= 4;
  return (emps || []).filter(e => {
    if (String(e.store_name || '').includes('店')) {
      if (!storeRoles.length) return false;
      if (allStore) return true;
      return storeRoles.some(r => String(e.jobtitle || '').includes(r.replace('LOHAS', '')));
    }
    return (roles || []).includes('辦公室');
  });
}
async function countPeople(roles) {
  const { data: emps } = await supabase.from('employees').select('erpid, store_name, jobtitle').eq('is_active', true);
  const hit = matchByRoles(emps, roles);
  const stores = new Set(); let storePpl = 0, officePpl = 0;
  hit.forEach(e => { if (String(e.store_name || '').includes('店')) { storePpl += 1; stores.add(e.store_name); } else officePpl += 1; });
  return { stores: stores.size, store_people: storePpl, office_people: officePpl };
}

async function aiReview(regTitle, diff, risk) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const compact = {
    規範: regTitle, 風險: risk.level,
    變更: diff.changes.slice(0, 40).map(c => ({ 類型: c.kind, 條文: c.code, 編號: c.display_no, 條文類型: c.ctype, 原文: (c.old || '').slice(0, 300), 新文: (c.new || '').slice(0, 300), 扣分: [c.old_penalty, c.penalty] })),
    其他欄位: diff.meta,
  };
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.REGULATION_AI_MODEL || process.env.AUDIT_AI_MODEL || 'claude-haiku-4-5', max_tokens: 800,
      system: '你是眼鏡連鎖公司的規範審核助理。根據規範的新舊差異，用繁體中文輸出 JSON：{"summary":["…"],"notes":["…"]}。summary 2～3 句，白話說明改了什麼；notes 0～3 點，提醒審核人可能沒想到的影響（例如跨月、獎金、其他部門、適用對象、員工容易誤解）。只根據提供的資料，不要編造；沒有值得提醒的就給空陣列。只輸出 JSON。',
      messages: [{ role: 'user', content: JSON.stringify(compact) }],
    }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
    const text = (res.data.content || []).map(c => c.text || '').join('').trim().replace(/^```json\s*|\s*```$/g, '');
    const j = JSON.parse(text);
    return { summary: Array.isArray(j.summary) ? j.summary.slice(0, 4) : [], notes: Array.isArray(j.notes) ? j.notes.slice(0, 4) : [] };
  } catch (e) {
    console.warn('[Regulation] AI 摘要失敗：', e.message);
    return null;
  }
}

async function analyze(regId, oldDoc, newDoc, { withAi = true } = {}) {
  const diff = D.diffDocs(oldDoc, newDoc);
  const risk = D.riskOf(diff);
  const titles = must(await supabase.from('regulations').select('title').eq('status', 'active'), '讀取規範標題失敗').map(r => r.title);
  const checks = D.ruleChecks(newDoc, { knownTitles: titles });
  const people = await countPeople(newDoc.roles);
  // 連帶：其他規範用『標題』引用到這份
  const bare = String(newDoc.title || '').replace(/[「」『』]/g, '').replace(/MAP$/i, '').trim();
  let linked = [];
  if (bare.length >= 2) {
    const refs = must(await supabase.from('regulation_clauses').select('regulation_id, code, regulations(title)')
      .eq('active', true).neq('regulation_id', regId).ilike('text', `%${bare}%`).limit(50), '查連帶規範失敗');
    const m = new Map(); refs.forEach(r => { if (!m.has(r.regulation_id)) m.set(r.regulation_id, { id: r.regulation_id, title: r.regulations?.title, codes: [] }); m.get(r.regulation_id).codes.push(r.code); });
    linked = [...m.values()];
  }
  // 扣分影響：改到的條文近 90 天被引用次數
  const touched = diff.changes.filter(c => c.kind !== 'add').map(c => c.code);
  let recentDeductions = 0;
  if (touched.length) {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const { count } = await supabase.from('regulation_deductions').select('id', { count: 'exact', head: true }).in('clause_code', touched).gte('created_at', since).neq('status', 'rejected');
    recentDeductions = count || 0;
  }
  // 每一條都可以引用扣分 → 除了單純移動位置，其他變動都算扣分相關
  const penaltyChanges = diff.changes.filter(c => c.kind !== 'move').length;
  const ai = withAi ? await aiReview(newDoc.title, diff, risk) : null;
  return {
    diff, risk: risk.level, risk_reasons: risk.reasons, checks,
    summary: ai?.summary?.length ? ai.summary : D.plainSummary(diff),
    notes: ai?.notes || [], ai: !!ai,
    impact: { roles: newDoc.roles || [], ...people, linked, recent_deductions: recentDeductions, penalty_changes: penaltyChanges },
  };
}

// ════════════════════════════════════════════════════════════
// 送審 / 審核
// ════════════════════════════════════════════════════════════
async function submitDraft(versionId, user) {
  const v = await getVersion(versionId);
  if (!['draft', 'returned'].includes(v.status)) throw new Error('這個版本不是草稿');
  const reg = must(await supabase.from('regulations').select('*').eq('id', v.regulation_id).single(), '讀取規範失敗');
  let oldDoc = { sections: [] };
  if (reg.current_version > 0) oldDoc = (await getVersionByNo(reg.id, reg.current_version)).doc;
  const review = await analyze(reg.id, oldDoc, v.doc);
  if (!review.diff.changes.length && !review.diff.meta.length) throw new Error('沒有任何修改，不需要送審');
  if (review.checks.some(c => c.lv === 'warn')) throw new Error(`還有問題要先處理：${review.checks.filter(c => c.lv === 'warn').map(c => c.text).join('；')}`);
  // AI 監督檢查：結果過期就重跑；還有沒處理的警告 → 不能送審
  if (AI.enabled()) {
    const chk = await AI.ensureChecked(versionId);
    if (chk.unresolved.length) {
      const e = new Error(`AI 檢查還有 ${chk.unresolved.length} 個問題沒處理（修正，或忽略並寫原因）：${chk.unresolved.map(i => i.title).join('；')}`);
      e.code = 'AI_UNRESOLVED'; throw e;
    }
    const ac = chk.ai_checks;
    review.ai_checks = { at: ac.at, issues: (ac.issues || []).map(i => ({ id: i.id, level: i.level, kind: i.kind, title: i.title, detail: i.detail, codes: i.codes, other_regs: i.other_regs, resolved: ac.resolved?.[i.id] || null })) };
  }
  const saved = must(await supabase.from('regulation_versions').update({
    status: 'pending', submitted_at: nowIso(), review, review_note: null, updated_at: nowIso(),
    created_by_name: v.created_by_name || user?.name || null,
  }).eq('id', versionId).select().single(), '送審失敗');
  notifyReviewer(saved, reg).catch(e => console.warn('[Regulation] 推播審核人失敗：', e.message));
  return saved;
}

async function notifyReviewer(v, reg) {
  const reviewer = await getReviewer();
  if (!reviewer?.app_number) { console.warn('[Regulation] 尚未設定審核人，略過推播'); return; }
  const pending = must(await supabase.from('regulation_versions').select('id', { count: 'exact' }).eq('status', 'pending'), '計算待審失敗');
  const msg = [
    `📋 規範送審：${reg.title}（第 ${v.version} 版）`,
    `送審人：${v.created_by_name || '—'}　風險：${v.review?.risk || '—'}`,
    ...(v.review?.summary || []).slice(0, 2).map(s => `• ${s}`),
    `目前共 ${pending.length} 件待審`,
    `${FRONTEND}/regulations?tab=review&v=${v.id}`,
  ].join('\n');
  await linePush.pushToUser(reviewer.app_number, msg);
}

/** 草稿與被退回的版本（編輯中） */
async function listDrafts() {
  const rows = must(await supabase.from('regulation_versions')
    .select('id, regulation_id, version, status, change_note, created_by_name, updated_at, review_note, doc->title, regulations(title)')
    .in('status', ['draft', 'returned']).order('updated_at', { ascending: false }).limit(200), '讀取草稿失敗');
  return rows.map(r => ({ ...r, title: r.title || r.regulations?.title }));
}

async function listReviews(status = 'pending') {
  let q = supabase.from('regulation_versions')
    .select('id, regulation_id, version, status, change_note, created_by_name, submitted_at, reviewed_by_name, reviewed_at, review_note, reviewer_edited, review, regulations(title, category)')
    .order('submitted_at', { ascending: false }).limit(200);
  q = status === 'pending' ? q.eq('status', 'pending') : q.in('status', ['approved', 'returned']).not('submitted_at', 'is', null);
  const rows = must(await q, '讀取送審清單失敗');
  return rows.map(r => ({ ...r, title: r.regulations?.title, risk: r.review?.risk, summary: r.review?.summary || [], review: undefined }));
}

async function getReview(versionId) {
  const v = await getVersion(versionId);
  const reg = must(await supabase.from('regulations').select('*').eq('id', v.regulation_id).single(), '讀取規範失敗');
  const oldDoc = reg.current_version > 0 && reg.current_version !== v.version ? (await getVersionByNo(reg.id, reg.current_version)).doc : null;
  return { version: v, regulation: reg, old_doc: oldDoc };
}

async function lookupSubmitterAppNumber(v) {
  let erp = null;
  if (v.created_by_id) {
    const { data } = await supabase.from('system_users').select('erpid').eq('id', v.created_by_id).maybeSingle();
    erp = data?.erpid || null;
  }
  if (!erp && v.created_by_name) {
    const { data } = await supabase.from('system_users').select('erpid').eq('name', v.created_by_name).limit(1);
    erp = data?.[0]?.erpid || null;
  }
  if (!erp) return null;
  const { data: e } = await supabase.from('employees').select('app_number').eq('erpid', erp).maybeSingle();
  return e?.app_number || null;
}

async function approve(versionId, user, { doc, notifyStaff = false, notice } = {}) {
  const reviewer = await getReviewer();
  if (!isReviewer(user, reviewer)) throw new Error('只有指定的審核人可以審核');
  const v = await getVersion(versionId);
  if (v.status !== 'pending') throw new Error('這個版本不是待審狀態');
  const reg = must(await supabase.from('regulations').select('*').eq('id', v.regulation_id).single(), '讀取規範失敗');
  let finalDoc = v.doc, edited = false, review = v.review;
  if (doc) {
    finalDoc = D.assignCodes(reg.id, normalizeDoc(doc), reg.used_codes || []);
    edited = JSON.stringify(finalDoc) !== JSON.stringify(v.doc);
    if (edited) {
      const oldDoc = reg.current_version > 0 ? (await getVersionByNo(reg.id, reg.current_version)).doc : { sections: [] };
      review = await analyze(reg.id, oldDoc, finalDoc, { withAi: false });
      review.summary = v.review?.summary || review.summary;
      review.notes = v.review?.notes || [];
      if (review.checks.some(c => c.lv === 'warn')) throw new Error(`修改後有問題：${review.checks.filter(c => c.lv === 'warn').map(c => c.text).join('；')}`);
    }
  }
  const now = nowIso();
  must(await supabase.from('regulation_versions').update({
    status: 'approved', doc: finalDoc, review, reviewer_edited: edited, reviewed_by_name: user?.name || null, reviewed_at: now, published_at: now, updated_at: now,
  }).eq('id', versionId), '更新版本失敗');
  const codes = D.allCodes(finalDoc);
  must(await supabase.from('regulations').update({
    title: finalDoc.title, category: finalDoc.category || null, doc_type: finalDoc.doc_type || null, summary: finalDoc.summary || null,
    scenario: finalDoc.scenario || null, owner_dept: finalDoc.owner_dept || null, roles: finalDoc.roles || [],
    current_version: v.version, status: 'active', used_codes: [...new Set([...(reg.used_codes || []), ...codes])],
    map_sync_status: 'pending', updated_at: now,
  }).eq('id', reg.id), '更新規範失敗');
  await rebuildClauses(reg.id, v.version, finalDoc);
  await supabase.from('regulation_audit_findings').update({ status: 'resolved', handled_at: now }).eq('draft_version_id', versionId);

  // 通知送審人
  const app = await lookupSubmitterAppNumber(v);
  if (app) linePush.pushToUser(app, `✅ 規範審核通過：${finalDoc.title}（第 ${v.version} 版）${edited ? '\n審核人有修改部分內容，請到系統查看。' : ''}`).catch(() => {});
  // 推播規範更新給受影響人員
  let notified = 0;
  if (notifyStaff && String(notice || '').trim()) notified = await pushNoticeToRoles(finalDoc.roles, `${String(notice).trim()}\n\n查看規範：${FRONTEND}/rules?reg=${reg.id}`);
  return { ok: true, edited, notified };
}

async function pushNoticeToRoles(roles, message) {
  const { data: emps } = await supabase.from('employees').select('app_number, store_name, jobtitle').eq('is_active', true);
  const targets = matchByRoles(emps, roles).filter(e => e.app_number).map(e => e.app_number);
  const uniq = [...new Set(targets)];
  for (const part of chunk(uniq, 200)) await linePush.pushToUsers(part, message);
  return uniq.length;
}

async function returnVersion(versionId, user, reason) {
  const reviewer = await getReviewer();
  if (!isReviewer(user, reviewer)) throw new Error('只有指定的審核人可以審核');
  if (!String(reason || '').trim()) throw new Error('請填退回原因');
  const v = await getVersion(versionId);
  if (v.status !== 'pending') throw new Error('這個版本不是待審狀態');
  must(await supabase.from('regulation_versions').update({
    status: 'returned', review_note: String(reason).trim(), reviewed_by_name: user?.name || null, reviewed_at: nowIso(), updated_at: nowIso(),
  }).eq('id', versionId), '退回失敗');
  const app = await lookupSubmitterAppNumber(v);
  if (app) linePush.pushToUser(app, `↩️ 規範被退回：${v.doc?.title}（第 ${v.version} 版）\n原因：${String(reason).trim()}\n${FRONTEND}/regulations?reg=${v.regulation_id}`).catch(() => {});
  return { ok: true };
}

async function approveAllLow(user) {
  const reviewer = await getReviewer();
  if (!isReviewer(user, reviewer)) throw new Error('只有指定的審核人可以審核');
  const rows = must(await supabase.from('regulation_versions').select('id, review').eq('status', 'pending'), '讀取待審失敗');
  const low = rows.filter(r => r.review?.risk === '低');
  const done = [];
  for (const r of low) { await approve(r.id, user, {}); done.push(r.id); }
  return { approved: done.length };
}

// ════════════════════════════════════════════════════════════
// 引用條文扣分
// ════════════════════════════════════════════════════════════
async function searchEmployees(q) {
  let query = supabase.from('employees').select('erpid, name, store_name, jobtitle, app_number').eq('is_active', true).order('store_name').limit(30);
  // 去掉注音等輸入法還沒組完的字
  const s = String(q || '').replace(/[\u3100-\u312F\u02C7\u02CA\u02CB\u02D9]/g, '').replace(/[%,()]/g, '').trim();
  if (!s) return [];
  query = /^\d+$/.test(s) ? query.or(`erpid.eq.${s},app_number.eq.${s}`) : query.or(`name.ilike.%${s}%,store_name.ilike.%${s}%`);
  return must(await query, '查員工失敗');
}

async function createDeduction({ employee_erpid, clause_code, score, note, incident_date }, user) {
  const emp = must(await supabase.from('employees').select('erpid, name, store_name, app_number').eq('erpid', String(employee_erpid)).maybeSingle(), '查員工失敗');
  if (!emp) throw new Error('找不到這位員工');
  const cl = must(await supabase.from('regulation_clauses').select('*, regulations(title, score, status)').eq('code', clause_code).maybeSingle(), '查條文失敗');
  if (!cl || !cl.active) throw new Error('找不到這條條文，或已不在現行版');
  const sc = (score === undefined || score === null || score === '') ? (cl.penalty ?? cl.regulations?.score ?? -1) : Math.trunc(Number(score));
  if (!Number.isFinite(sc) || sc === 0) throw new Error('扣分必須是非 0 的整數');
  return must(await supabase.from('regulation_deductions').insert({
    employee_erpid: emp.erpid, employee_name: emp.name, employee_app_number: emp.app_number, store_name: emp.store_name,
    regulation_id: cl.regulation_id, regulation_title: cl.regulations?.title, version: cl.version, clause_code: cl.code,
    clause_text: cl.text, score: sc, bonus: 0, status: 'pending', incident_date: incident_date || null, note: note || null, created_by_name: user?.name || null,
  }).select().single(), '建立扣分單失敗');
}

async function listDeductions({ status, erpid, limit = 200 } = {}) {
  let q = supabase.from('regulation_deductions').select('*').order('created_at', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  if (erpid) q = q.eq('employee_erpid', String(erpid));
  return must(await q, '讀取扣分單失敗');
}

function mapReasonTitle(d) {
  const short = d.clause_text.length > 30 ? `${d.clause_text.slice(0, 30)}…` : d.clause_text;
  return `【${d.clause_code}】${short}｜${String(d.regulation_title || '').replace(/[「」]/g, '')} v${d.version}`;
}

async function approveDeduction(id, user) {
  const d = must(await supabase.from('regulation_deductions').select('*').eq('id', id).maybeSingle(), '讀取扣分單失敗');
  if (!d) throw new Error('找不到扣分單');
  if (d.status !== 'pending') throw new Error('這張扣分單已處理過');
  let ok = false, msg = '';
  try {
    const r = await mapScore.addScore({
      employeeerpid: d.employee_erpid, score: d.score, bonus: d.bonus || 0,
      reasonid: '-1', reasontitle: mapReasonTitle(d), editor: user?.name || '規範系統',
    });
    ok = true; msg = r.message || '寫入成功';
  } catch (e) { msg = e.message || 'MAP 寫入失敗'; }
  if (!ok) {
    must(await supabase.from('regulation_deductions').update({ map_status: 'failed', map_message: msg }).eq('id', id), '更新扣分單失敗');
    throw new Error(`MAP 寫入失敗，扣分單維持待審：${msg}`);
  }
  must(await supabase.from('regulation_deductions').update({
    status: 'approved', map_status: 'success', map_message: msg, reviewed_by_name: user?.name || null, reviewed_at: nowIso(),
  }).eq('id', id), '更新扣分單失敗');
  if (d.employee_app_number) {
    linePush.pushToUser(d.employee_app_number,
      `📌 扣分通知：${d.score} 分\n條文：【${d.clause_code}】${d.clause_text}\n規範：${d.regulation_title}（第 ${d.version} 版）${d.note ? `\n說明：${d.note}` : ''}`).catch(() => {});
  }
  return { ok: true, map_message: msg };
}

async function rejectDeduction(id, user, reason) {
  if (!String(reason || '').trim()) throw new Error('請填駁回原因');
  const d = must(await supabase.from('regulation_deductions').select('status').eq('id', id).maybeSingle(), '讀取扣分單失敗');
  if (!d || d.status !== 'pending') throw new Error('這張扣分單已處理過');
  must(await supabase.from('regulation_deductions').update({
    status: 'rejected', reject_reason: String(reason).trim(), reviewed_by_name: user?.name || null, reviewed_at: nowIso(),
  }).eq('id', id), '駁回失敗');
  return { ok: true };
}

// ════════════════════════════════════════════════════════════
// 巡檢結果
// ════════════════════════════════════════════════════════════
async function listFindings({ status = 'open', regulationId } = {}) {
  let q = supabase.from('regulation_audit_findings').select('*, regulations(title, category)').order('created_at', { ascending: false }).limit(500);
  if (status) q = q.eq('status', status);
  if (regulationId) q = q.eq('regulation_id', regulationId);
  return must(await q, '讀取巡檢結果失敗');
}
async function ignoreFinding(id, reason, user) {
  if (!String(reason || '').trim()) throw new Error('忽略要寫原因');
  must(await supabase.from('regulation_audit_findings').update({ status: 'ignored', ignore_reason: String(reason).trim(), handled_by: user?.name || null, handled_at: nowIso() }).eq('id', id), '更新失敗');
  return { ok: true };
}
/** 依巡檢問題產生（或併入）修正草稿 */
async function draftFromFinding(id, user) {
  const f = must(await supabase.from('regulation_audit_findings').select('*').eq('id', id).maybeSingle(), '讀取巡檢結果失敗');
  if (!f) throw new Error('找不到這個問題');
  const draft = await createDraft(f.regulation_id, user);   // 已有草稿就沿用
  let doc = draft.doc;
  let applied = false, note = '';
  if (f.fix?.ops?.length) {
    try { doc = D.applyOps(doc, f.fix.ops); applied = true; } catch (e) { note = `AI 修正套不上（${e.message}），請手動修改`; }
  }
  const change = `巡檢：${f.title}`;
  const saved = await saveDraft(draft.id, { doc, change_note: draft.change_note ? `${draft.change_note}；${change}` : change }, user);
  must(await supabase.from('regulation_audit_findings').update({ status: 'drafted', draft_version_id: draft.id, handled_by: user?.name || null, handled_at: nowIso() }).eq('id', id), '更新失敗');
  return { version_id: saved.id, applied, note };
}
async function notifyAuditSummary(result) {
  const reviewer = await getReviewer();
  if (!reviewer?.app_number) return;
  await linePush.pushToUser(reviewer.app_number,
    `🔎 規範巡檢完成：檢查 ${result.checked} 份，發現 ${result.found} 個問題（需要處理 ${result.warn} 個）${result.failed ? `，${result.failed} 份檢查失敗` : ''}
${FRONTEND}/regulations?tab=audit`);
}

module.exports = {
  listFindings, ignoreFinding, draftFromFinding, notifyAuditSummary,
  MAP_ROLES, getReviewer, setReviewer, isReviewer,
  importFromMap, getImportStatus,
  listRegulations, searchClauses, getRegulation, getVersion,
  createDraft, createNewRegulation, saveDraft, discardDraft,
  submitDraft, listDrafts, listReviews, getReview, approve, returnVersion, approveAllLow, analyze,
  searchEmployees, createDeduction, listDeductions, approveDeduction, rejectDeduction, mapReasonTitle,
};
