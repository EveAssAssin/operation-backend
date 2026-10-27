// services/regulationDoc.js
// 規範文件（doc JSON）的純函式工具：攤平、自動編號、配發條文代碼、新舊版差異、風險分級、規則檢查
//
// doc = { title, category, doc_type, summary, scenario, owner_dept, roles[], keywords, sections:[{ title, items:[clause] }] }
// clause = { code, t, text, notes:[{kind,text}], subs:[clause], pen }
//   code：穩定條文代碼，一經使用永不重用；顯示編號（一、1.、1-1.、1-1.1）由位置自動產生

const CN = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
const cnNo = (i) => CN[i] || String(i + 1);

/** 依位置產生顯示編號 */
function displayNo(level, idxPath) {
  if (level === 1) return `${idxPath[0] + 1}.`;
  if (level === 2) return `${idxPath[0] + 1}-${idxPath[1] + 1}.`;
  return `${idxPath[0] + 1}-${idxPath[1] + 1}.${idxPath.slice(2).map(n => n + 1).join('.')}`;
}

/** 攤平成條文清單（含位置、顯示編號、上層代碼） */
function flatten(doc) {
  const out = [];
  let sort = 0;
  (doc.sections || []).forEach((sec, si) => {
    const walk = (items, level, path, parent) => items.forEach((c, i) => {
      const p = [...path, i];
      out.push({
        code: c.code, parent_code: parent, section_index: si, section_no: cnNo(si), section_title: sec.title || '',
        display_no: `${cnNo(si)}、${displayNo(level, p)}`, level, ctype: c.t || null,
        text: c.text || '', notes: c.notes || [], penalty: (c.pen === undefined || c.pen === null || c.pen === '') ? null : Number(c.pen),
        sort: sort++,
      });
      walk(c.subs || [], level + 1, p, c.code);
    });
    walk(sec.items || [], 1, [], null);
  });
  return out;
}

/** 收集文件中所有條文代碼 */
function allCodes(doc) { return flatten(doc).map(c => c.code).filter(Boolean); }

/**
 * 給沒有代碼的新條文配發代碼（不重用 usedCodes 內任何代碼）
 *   上層新條文：<規範>-<大項代號>.<n>；大項代號沿用該大項既有條文的代號，新大項則取用過的最大值 +1
 *   子條文：<上層代碼>.<n>
 */
function assignCodes(regId, doc, usedCodes = []) {
  const used = new Set([...usedCodes, ...allCodes(doc)]);
  const id = String(regId);
  const tail = (code, prefix) => {
    if (!code || !code.startsWith(prefix)) return null;
    const rest = code.slice(prefix.length);
    return /^\d+$/.test(rest) ? Number(rest) : null;
  };
  const nextUnder = (prefix) => {
    let max = 0;
    used.forEach(c => { const n = tail(c, prefix); if (n !== null && n > max) max = n; });
    let n = max + 1;
    while (used.has(`${prefix}${n}`)) n += 1;
    const code = `${prefix}${n}`;
    used.add(code);
    return code;
  };
  // 已用過的最大大項代號
  let maxSec = 0;
  used.forEach(c => { const m = String(c).match(new RegExp(`^${id}-(\\d+)\\.`)); if (m) maxSec = Math.max(maxSec, Number(m[1])); });

  (doc.sections || []).forEach(sec => {
    // 大項代號：沿用該大項既有條文的代號；全新的大項等到真的要配發時才取新號
    const getSecKey = () => {
      if (sec.key) return sec.key;
      const withCode = (sec.items || []).find(c => c.code && new RegExp(`^${id}-\\d+\\.`).test(c.code));
      if (withCode) sec.key = withCode.code.match(new RegExp(`^${id}-(\\d+)\\.`))[1];
      else { maxSec += 1; sec.key = String(maxSec); }
      return sec.key;
    };
    const walk = (items, parentCode) => items.forEach(c => {
      if (!c.code) c.code = parentCode ? nextUnder(`${parentCode}.`) : nextUnder(`${id}-${getSecKey()}.`);
      c.subs = c.subs || [];
      c.notes = c.notes || [];
      walk(c.subs, c.code);
    });
    walk(sec.items || [], null);
  });
  return doc;
}

// ── 差異 ─────────────────────────────────────────────────────
function charDiffCount(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return Math.max(a.length - s - e, b.length - s - e);
}
const notesKey = (n) => JSON.stringify((n || []).map(x => [x.kind, x.text]));

function diffDocs(oldDoc, newDoc) {
  const o = new Map(flatten(oldDoc || { sections: [] }).map(c => [c.code, c]));
  const n = new Map(flatten(newDoc).map(c => [c.code, c]));
  const changes = [];
  n.forEach((c, code) => {
    const p = o.get(code);
    if (!p) { changes.push({ kind: 'add', code, ctype: c.ctype, display_no: c.display_no, section_title: c.section_title, new: c.text, penalty: c.penalty }); return; }
    const fields = [];
    if (p.text !== c.text) fields.push('text');
    if ((p.ctype || null) !== (c.ctype || null)) fields.push('ctype');
    if (p.penalty !== c.penalty) fields.push('penalty');
    if (notesKey(p.notes) !== notesKey(c.notes)) fields.push('notes');
    const moved = p.parent_code !== c.parent_code || p.section_title !== c.section_title;
    if (fields.length || moved) {
      changes.push({
        kind: fields.length ? 'mod' : 'move', code, fields, moved,
        ctype: c.ctype, old_ctype: p.ctype, display_no: c.display_no, old_display_no: p.display_no,
        section_title: c.section_title, old: p.text, new: c.text,
        old_penalty: p.penalty, penalty: c.penalty,
        old_notes: p.notes, notes: c.notes, char_diff: charDiffCount(p.text, c.text),
      });
    }
  });
  o.forEach((p, code) => { if (!n.has(code)) changes.push({ kind: 'del', code, ctype: p.ctype, display_no: p.display_no, section_title: p.section_title, old: p.text, penalty: p.penalty }); });

  const meta = [];
  ['title', 'category', 'doc_type', 'summary', 'scenario', 'owner_dept'].forEach(k => {
    if ((oldDoc?.[k] || '') !== (newDoc?.[k] || '')) meta.push({ field: k, old: oldDoc?.[k] || '', new: newDoc?.[k] || '' });
  });
  const oldRoles = [...(oldDoc?.roles || [])].sort().join(','), newRoles = [...(newDoc?.roles || [])].sort().join(',');
  if (oldRoles !== newRoles) meta.push({ field: 'roles', old: oldDoc?.roles || [], new: newDoc?.roles || [] });
  const oSec = (oldDoc?.sections || []).map(s => s.title).join('|'), nSec = (newDoc?.sections || []).map(s => s.title).join('|');
  if (oSec !== nSec) meta.push({ field: 'sections', old: (oldDoc?.sections || []).map(s => s.title), new: (newDoc?.sections || []).map(s => s.title) });
  return { changes, meta };
}

/** 風險分級：高＝動到規定／扣分／適用身分或刪條文；低＝只有移動、少量錯字、說明欄位；其餘中 */
function riskOf(diff) {
  const { changes, meta } = diff;
  const reasons = [];
  const isRule = (c) => c.ctype === '規定' || c.old_ctype === '規定';
  changes.forEach(c => {
    if (c.kind === 'del') reasons.push(['高', `刪除條文 ${c.code}`]);
    if (c.kind === 'mod' && c.fields.includes('penalty')) reasons.push(['高', `${c.code} 扣分改變`]);
    if (c.kind === 'mod' && c.fields.includes('ctype') && (c.ctype === '規定' || c.old_ctype === '規定')) reasons.push(['高', `${c.code} 規定類型改變`]);
    if (c.kind === 'mod' && isRule(c) && c.fields.includes('text') && c.char_diff > 4) reasons.push(['高', `規定 ${c.code} 內容修改`]);
    if (c.kind === 'add' && c.ctype === '規定') reasons.push(['高', `新增規定 ${c.code}`]);
    if (c.kind === 'add' && c.ctype !== '規定') reasons.push(['中', `新增條文 ${c.code}`]);
    if (c.kind === 'mod' && !isRule(c) && (c.char_diff > 4 || c.fields.includes('notes'))) reasons.push(['中', `${c.code} 內容修改`]);
  });
  meta.forEach(m => { if (m.field === 'roles') reasons.push(['高', '適用身分改變']); });
  const level = reasons.some(r => r[0] === '高') ? '高' : reasons.some(r => r[0] === '中') ? '中' : '低';
  return { level, reasons: reasons.map(r => r[1]) };
}

/** 規則檢查（不靠 AI，100% 準）*/
function ruleChecks(doc, { knownTitles = [] } = {}) {
  const out = [];
  const flat = flatten(doc);
  const seen = new Set(); const dup = [];
  flat.forEach(c => { if (c.code) { if (seen.has(c.code)) dup.push(c.code); seen.add(c.code); } });
  if (dup.length) out.push({ lv: 'warn', text: `條文代碼重複：${dup.join('、')}` });
  const empty = flat.filter(c => !String(c.text).trim());
  if (empty.length) out.push({ lv: 'warn', text: `有 ${empty.length} 條內容是空的：${empty.slice(0, 5).map(c => c.display_no).join('、')}` });
  if (!String(doc.title || '').trim()) out.push({ lv: 'warn', text: '規範標題是空的' });
  if (!(doc.sections || []).length) out.push({ lv: 'warn', text: '沒有任何大項' });
  const ruleNoPen = flat.filter(c => c.ctype === '規定' && c.penalty === null);
  if (ruleNoPen.length) out.push({ lv: 'info', text: `${ruleNoPen.length} 條規定沒有逐條設定扣分，扣分時會用整份預設分數` });
  // 『』引用的規範是否存在
  const norm = (s) => String(s || '').replace(/[「」『』\s]/g, '').replace(/MAP$/i, '').toLowerCase();
  const titleSet = new Set(knownTitles.map(norm));
  if (titleSet.size) {
    const broken = new Set();
    flat.forEach(c => {
      const txt = [c.text, ...(c.notes || []).map(n => n.text)].join(' ');
      for (const m of txt.matchAll(/『([^』]{2,40})』/g)) if (!titleSet.has(norm(m[1]))) broken.add(m[1]);
    });
    if (broken.size) out.push({ lv: 'info', text: `引用的規範找不到同名規範（可能改名或寫法不同）：${[...broken].slice(0, 8).map(b => `『${b}』`).join('、')}` });
  }
  if (!out.some(c => c.lv === 'warn')) out.unshift({ lv: 'ok', text: `格式檢查：${flat.length} 條條文，代碼無重複、沒有空白條文` });
  return out;
}

/** 規則式摘要（沒有 AI 時用） */
function plainSummary(diff) {
  const c = diff.changes;
  const cnt = (k) => c.filter(x => x.kind === k).length;
  const lines = [];
  const parts = [];
  if (cnt('mod')) parts.push(`修改 ${cnt('mod')} 條`);
  if (cnt('add')) parts.push(`新增 ${cnt('add')} 條`);
  if (cnt('del')) parts.push(`刪除 ${cnt('del')} 條`);
  if (cnt('move')) parts.push(`移動 ${cnt('move')} 條`);
  if (parts.length) lines.push(`條文：${parts.join('、')}。`);
  diff.meta.forEach(m => {
    const label = { title: '標題', category: '分類', doc_type: '類型', summary: '摘要', scenario: '適用情境', owner_dept: '負責部門', roles: '適用身分', sections: '大項' }[m.field] || m.field;
    lines.push(`${label}有變更。`);
  });
  c.filter(x => x.kind !== 'move').slice(0, 3).forEach(x => {
    const t = (x.new || x.old || '').slice(0, 40);
    lines.push(`${x.kind === 'add' ? '新增' : x.kind === 'del' ? '刪除' : '修改'} ${x.code}：${t}${(x.new || x.old || '').length > 40 ? '…' : ''}`);
  });
  if (!lines.length) lines.push('沒有內容變更。');
  return lines;
}

module.exports = { flatten, allCodes, assignCodes, diffDocs, riskOf, ruleChecks, plainSummary, cnNo, charDiffCount };
