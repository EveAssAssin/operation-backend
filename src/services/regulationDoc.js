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
        text: c.text || '', notes: c.notes || [], images: c.images || [], penalty: (c.pen === undefined || c.pen === null || c.pen === '') ? null : Number(c.pen),
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
    if (JSON.stringify(p.images || []) !== JSON.stringify(c.images || [])) fields.push('images');
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

/**
 * 風險分級（每一條都可以引用扣分，所以看「改動會不會改變員工該怎麼做」）
 *   高：刪條文、改扣分、改適用身分、數字（時間／金額／數量）有變、內容大改（> 20 字）
 *   中：新增條文、內容中幅修改（5～20 字）、註／例／照片變動
 *   低：只有移動位置、錯字等小修（≤ 4 字）、摘要／情境等說明欄位
 */
const nums = (t) => (String(t || '').match(/\d+(?:[.:：／/]\d+)*/g) || []).join(',');
function riskOf(diff) {
  const { changes, meta } = diff;
  const reasons = [];
  changes.forEach(c => {
    if (c.kind === 'del') reasons.push(['高', `刪除條文 ${c.code}`]);
    if (c.kind === 'add') reasons.push(['中', `新增條文 ${c.code}`]);
    if (c.kind !== 'mod') return;
    if (c.fields.includes('penalty')) reasons.push(['高', `${c.code} 扣分改變`]);
    if (c.fields.includes('text')) {
      if (nums(c.old) !== nums(c.new)) reasons.push(['高', `${c.code} 數字（時間／金額／數量）改變`]);
      else if (c.char_diff > 20) reasons.push(['高', `${c.code} 內容大幅修改`]);
      else if (c.char_diff > 4) reasons.push(['中', `${c.code} 內容修改`]);
    }
    if (c.fields.includes('notes') || c.fields.includes('images')) reasons.push(['中', `${c.code} 註／例／照片變動`]);
  });
  meta.forEach(m => {
    if (m.field === 'roles') reasons.push(['高', '適用身分改變']);
    if (m.field === 'title') reasons.push(['中', '規範標題改變']);
  });
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

// ── 套用 AI 建議（結構化修改指令）─────────────────────────────
//   每個 op 都以條文代碼定位，找不到就丟錯，不會改到別的地方
//   replace_text {code,text} · add_clause {parent_code?|section_index?, after_code?, text, pen?}
//   delete_clause {code} · add_note {code,kind,text} · set_penalty {code,pen}
//   set_meta {field,value} · add_section {title, after_section_index?, clauses:[text]}
//   add_image {code,url,caption} · set_image_caption {code,url,caption}
//   move_clause {code, to_parent_code?|to_section_index?, after_code?}
function locate(doc, code) {
  for (const sec of doc.sections || []) {
    const walk = (arr, parent) => {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].code === code) return { arr, i, node: arr[i], parent, sec };
        const r = walk(arr[i].subs || [], arr[i]); if (r) return r;
      }
      return null;
    };
    const r = walk(sec.items || [], null); if (r) return r;
  }
  return null;
}
const META_FIELDS = ['title', 'category', 'doc_type', 'summary', 'scenario', 'owner_dept', 'roles'];
function applyOps(docIn, ops = []) {
  const doc = JSON.parse(JSON.stringify(docIn));
  doc.sections = doc.sections || [];
  const need = (code) => { const r = locate(doc, code); if (!r) throw new Error(`找不到條文 ${code}`); return r; };
  const newClause = (o) => ({ text: String(o.text || '').trim(), t: null, notes: [], subs: [], pen: (o.pen === undefined || o.pen === null || o.pen === '') ? null : Number(o.pen) });
  for (const op of ops) {
    switch (op.op) {
      case 'replace_text': need(op.code).node.text = String(op.text || '').trim(); break;
      case 'delete_clause': { const r = need(op.code); r.arr.splice(r.i, 1); break; }
      case 'add_note': { const r = need(op.code); r.node.notes = r.node.notes || []; r.node.notes.push({ kind: op.kind === '例' ? '例' : '註', text: String(op.text || '').trim() }); break; }
      case 'set_penalty': need(op.code).node.pen = (op.pen === null || op.pen === '') ? null : Number(op.pen); break;
      case 'set_meta': if (META_FIELDS.includes(op.field)) doc[op.field] = op.value; break;
      case 'add_image': { const r = need(op.code); r.node.images = r.node.images || []; r.node.images.push({ url: op.url, caption: op.caption || '' }); break; }
      case 'set_image_caption': { const r = need(op.code); (r.node.images || []).forEach(im => { if (!op.url || im.url === op.url) im.caption = op.caption || ''; }); break; }
      case 'add_section': {
        const sec = { title: String(op.title || '').trim(), items: (op.clauses || []).map(t => newClause({ text: t })) };
        const at = Number.isInteger(op.after_section_index) ? op.after_section_index + 1 : doc.sections.length;
        doc.sections.splice(Math.max(0, Math.min(at, doc.sections.length)), 0, sec); break;
      }
      case 'add_clause': case 'move_clause': {
        let node;
        if (op.op === 'move_clause') { const r = need(op.code); node = r.node; r.arr.splice(r.i, 1); } else node = newClause(op);
        const parentCode = op.op === 'move_clause' ? op.to_parent_code : op.parent_code;
        const secIdx = op.op === 'move_clause' ? op.to_section_index : op.section_index;
        let arr;
        if (parentCode) { const p = need(parentCode); p.node.subs = p.node.subs || []; arr = p.node.subs; }
        else if (op.after_code) { arr = need(op.after_code).arr; }
        else if (Number.isInteger(secIdx) && doc.sections[secIdx]) arr = doc.sections[secIdx].items;
        else throw new Error('新增條文要指定放在哪裡');
        let pos = arr.length;
        if (op.after_code) { const k = arr.findIndex(x => x.code === op.after_code); if (k >= 0) pos = k + 1; }
        arr.splice(pos, 0, node); break;
      }
      default: throw new Error(`不認得的修改指令：${op.op}`);
    }
  }
  return doc;
}

/** 給 AI 看的精簡文字版（代碼＋編號＋內容） */
function docToPrompt(doc, maxChars = 30000) {
  const lines = [`標題：${doc.title || ''}`, `分類：${doc.category || ''}`, `適用身分：${(doc.roles || []).join('、')}`];
  if (doc.summary) lines.push(`摘要：${doc.summary}`);
  (doc.sections || []).forEach((sec, si) => {
    lines.push(`【大項 ${si}】${cnNo(si)}、${sec.title || ''}`);
    const walk = (arr, level, path) => arr.forEach((c, i) => {
      const p = [...path, i];
      lines.push(`${'  '.repeat(level)}[${c.code || '新'}] ${displayNo(level, p)} ${c.text || ''}${c.pen != null ? `（扣分 ${c.pen}）` : ''}`);
      (c.notes || []).forEach(n => lines.push(`${'  '.repeat(level + 1)}${n.kind}：${n.text}`));
      (c.images || []).forEach(im => lines.push(`${'  '.repeat(level + 1)}〔照片〕${im.caption || '（無說明）'}`));
      walk(c.subs || [], level + 1, p);
    });
    walk(sec.items || [], 1, []);
  });
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（後面省略）`;
  return out;
}

module.exports = { applyOps, locate, docToPrompt, flatten, allCodes, assignCodes, diffDocs, riskOf, ruleChecks, plainSummary, cnNo, charDiffCount };
