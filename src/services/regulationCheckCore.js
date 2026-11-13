// services/regulationCheckCore.js
// 送審前 AI 檢查「會收斂」的核心邏輯（2026-11-12 Louis：改年年換新規範，AI 檢查每改一次就整份重審、換說法又冒新問題，永遠沒完沒了）
//
//   1. 增量：ai_checks 記每條條文的 hash（clause_hash）；再檢查時只把「上次檢查後有變動的條文」當本次修改給 AI，
//      沒再動的條文上一輪的問題原樣保留（含已處理狀態），不重審。第一次（或舊格式）＝對現行版的完整 diff。
//   2. 穩定身分：issue 用「kind＋排序後的本規範條文代碼」當 key，id 由 key 算出（k＋8 碼），resolved 跟著 id 走；
//      被忽略／已套用的問題只有它涉及的條文又被改過，才會被丟掉、可能重新出現。
//   3. 同 key 合併：同一組條文只留一個問題、一個修法（其他說明併進 detail）。
//   4. 每個問題帶 first_seen_at／is_new（🆕 這次新發現／之前就有）。
//   5. 第 3 輪起只有「矛盾／衝突／缺漏」的 warn 擋送審；其他（模糊、範圍、用詞…）降為 info 提示。
//
// 純函式（不碰資料庫、不叫 AI），regulationAi.check() 把 AI 呼叫包成 ask() 傳進來；test/regulationCheckCore.test.js 用假 AI 驗。
const crypto = require('crypto');
const D = require('./regulationDoc');

const BLOCK_KINDS = ['矛盾', '衝突', '缺漏'];
const STRICT_FROM_ROUND = 3;
const sha = (x) => crypto.createHash('sha1').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

/** 每條條文一個 hash（文字、類型、扣分、註、照片、所在位置） */
function clauseHashes(doc) {
  const out = {};
  for (const c of D.flatten(doc || { sections: [] })) {
    if (!c.code) continue;
    out[c.code] = sha([c.text, c.ctype, c.penalty, (c.notes || []).map(n => [n.kind, n.text]), c.images || [], c.parent_code || null, c.section_title]).slice(0, 16);
  }
  return out;
}
const META_KEYS = ['title', 'category', 'doc_type', 'summary', 'scenario', 'owner_dept', 'keywords', 'roles'];
function metaHash(doc) { return sha(META_KEYS.map(k => (doc || {})[k] ?? null)).slice(0, 16); }

/** 本規範的條文代碼（其他規範的代碼不算進 key 與「有沒有被改」判斷） */
function ownCodes(codes, regId) {
  const p = `${regId}-`;
  return [...new Set((codes || []).map(String).filter(c => c.startsWith(p)))].sort();
}
function issueKey(kind, codes, regId, title) {
  const own = ownCodes(codes, regId);
  // 沒有本規範條文代碼的（例只動到標題欄位）用標題前 20 字當 key，至少同一輪內可以合併
  return `${kind || '其他'}|${own.length ? own.join(',') : `t:${String(title || '').slice(0, 20)}`}`;
}
const idOf = (key) => `k${sha(key).slice(0, 8)}`;

/** 同 key 合併：保留第一個（含它的 fix），其餘的標題／說明併進 detail；level 取最嚴重 */
function mergeSameKey(list) {
  const by = new Map();
  for (const it of list) {
    const cur = by.get(it.key);
    if (!cur) { by.set(it.key, { ...it }); continue; }
    if (it.level === 'warn') cur.level = 'warn';
    const extra = [it.title, it.detail].filter(Boolean).join('：');
    if (extra && !String(cur.detail || '').includes(String(it.title || '').slice(0, 12))) cur.detail = `${cur.detail || ''}\n另外：${extra}`.trim();
    if (!cur.fix && it.fix) cur.fix = it.fix;
    cur.other_regs = [...(cur.other_regs || []), ...(it.other_regs || [])].slice(0, 5);
  }
  return [...by.values()];
}

/** 舊格式（沒有 key／clause_hash）→ 補上 key／stable id，resolved 換成新 id；回傳正規化後的 prev（或 null） */
function normalizePrev(prev, regId) {
  if (!prev || !Array.isArray(prev.issues)) return null;
  const resolved = {};
  const issues = prev.issues.map((i) => {
    const key = i.key || issueKey(i.kind, i.codes, regId, i.title);
    const id = i.key ? i.id : idOf(key);
    const r = prev.resolved?.[i.id];
    if (r) resolved[id] = r;
    return { ...i, key, id, first_seen_at: i.first_seen_at || prev.at || null };
  });
  return { ...prev, issues, resolved, round: Number(prev.round) || 1, legacy: !prev.clause_hash };
}

/** 這一輪要給 AI 看哪些條文：null＝完整 diff（第一輪／舊格式）；Set＝上次檢查後變動的代碼 */
function changedSince(prev, doc) {
  if (!prev || !prev.clause_hash) return null;
  const now = clauseHashes(doc), was = prev.clause_hash, set = new Set();
  for (const [c, h] of Object.entries(now)) if (was[c] !== h) set.add(c);
  for (const c of Object.keys(was)) if (!(c in now)) set.add(c);
  return set;
}

/**
 * 跑一輪檢查。
 *   prev      ：上一輪的 ai_checks（可為 null／舊格式）
 *   oldDoc    ：現行版；doc：草稿
 *   ask(input)：叫 AI，input＝{ changes（要檢查的 diff 項目）, meta, kept（保留的舊問題）, full }，回傳 AI 原始 issues 陣列
 *   validateFix(ops)：回 { ops, preview } 或 { error }
 *   isStale(issue)：（選填）舊問題的前提變了（例：衝突的那份其他規範後來改了／正在改）→ 不保留、那幾條重新問 AI（2026-11-13）
 */
async function runRound({ prev: prevIn, oldDoc, doc, regId, ask, validateFix, isStale, now = new Date().toISOString() }) {
  const prev = normalizePrev(prevIn, regId);
  const diff = D.diffDocs(oldDoc || { sections: [] }, doc);
  const allChanges = diff.changes.filter(c => c.kind !== 'move');
  const changed = changedSince(prev, doc);           // null＝完整
  const metaChanged = !prev || !prev.meta_hash || prev.meta_hash !== metaHash(doc);
  // 前提變了的舊問題（isStale）：它涉及的本規範條文也一起重新檢查
  const staleCodes = new Set();
  if (prev && changed !== null && isStale) for (const i of prev.issues) if (isStale(i)) for (const c of ownCodes(i.codes, regId)) staleCodes.add(c);
  const focus = changed === null ? allChanges : allChanges.filter(c => changed.has(c.code) || staleCodes.has(c.code));
  const focusCodes = new Set(changed === null ? allChanges.map(c => c.code) : [...changed, ...staleCodes]);

  // 保留：上一輪的問題，涉及的本規範條文這次都沒再動（沒有本規範代碼的：欄位沒變才保留）
  const kept = [];
  if (prev && changed !== null) {
    for (const i of prev.issues) {
      const own = ownCodes(i.codes, regId);
      const touched = own.length ? own.some(c => focusCodes.has(c)) : metaChanged;
      if (!touched && !(isStale && isStale(i))) kept.push(i);
    }
  }
  const keptKeys = new Set(kept.map(i => i.key));

  let fresh = [];
  const needAi = (changed === null ? (allChanges.length || diff.meta.length) : (focus.length || (metaChanged && diff.meta.length) || staleCodes.size));
  if (needAi) {
    const raw = await ask({ changes: focus, meta: metaChanged ? diff.meta : [], kept, full: changed === null });
    fresh = (raw || []).slice(0, 12).map((x) => {
      let fix = null;
      if (x.fix && Array.isArray(x.fix.ops) && x.fix.ops.length && validateFix) {
        const t = validateFix(x.fix.ops);
        if (!t.error) fix = { label: x.fix.label || '套用修正', ops: t.ops, preview: t.preview };
      }
      const kind = x.kind || '其他';
      const codes = Array.isArray(x.codes) ? x.codes.map(String).slice(0, 10) : [];
      return { key: issueKey(kind, codes, regId, x.title), level: x.level === 'warn' ? 'warn' : 'info', kind, title: x.title || '', detail: x.detail || '',
        codes, fix, other_regs: (x.other_regs || []).slice(0, 5) };
    });
    // 增量輪：只收「涉及這次變動條文」的問題（AI 看得到全文，常順手挑沒動的條文——那正是沒完沒了的來源）
    if (changed !== null) fresh = fresh.filter(i => { const own = ownCodes(i.codes, regId); return own.length ? own.some(c => focusCodes.has(c)) : true; });
    fresh = mergeSameKey(fresh).filter(i => !keptKeys.has(i.key));
  }

  const round = prev ? prev.round + (needAi ? 1 : 0) : 1;   // 沒有新變動的「重新檢查」不算一輪
  const prevByKey = new Map((prev?.issues || []).map(i => [i.key, i]));
  const resolved = {};
  for (const i of kept) if (prev.resolved?.[i.id]) resolved[i.id] = prev.resolved[i.id];
  // 舊格式（沒有條文快照，無法判斷條文改過沒）→ 同身分的已處理照舊沿用（跟以前「同標題沿用忽略」一樣寬）
  if (prev && prev.legacy) for (const i of fresh) { const id = idOf(i.key); if (prev.resolved?.[id]) resolved[id] = prev.resolved[id]; }
  const issues = [
    ...kept.map(i => ({ ...i, is_new: false })),
    ...fresh.map(i => { const old = prevByKey.get(i.key); return { ...i, id: idOf(i.key), first_seen_at: old?.first_seen_at || now, is_new: !old }; }),
  ];
  // 第 3 輪起：不是矛盾／衝突／缺漏的警告降為提示（不擋送審）
  if (round >= STRICT_FROM_ROUND) for (const i of issues) if (i.level === 'warn' && !BLOCK_KINDS.includes(i.kind)) { i.level = 'info'; i.downgraded = 'warn'; }

  return { at: now, v: 2, round, doc_hash: null, clause_hash: clauseHashes(doc), meta_hash: metaHash(doc), checked: { full: changed === null, codes: focus.map(c => c.code), kept: kept.length, fresh: fresh.length }, issues, resolved };
}

/** 擋送審的問題（submitDraft／前端計數用同一個判斷） */
function blocking(ac) {
  if (!ac) return [];
  return (ac.issues || []).filter(i => i.level === 'warn' && !ac.resolved?.[i.id]);
}

module.exports = { runRound, blocking, clauseHashes, metaHash, issueKey, idOf, mergeSameKey, normalizePrev, changedSince, ownCodes, BLOCK_KINDS, STRICT_FROM_ROUND };
