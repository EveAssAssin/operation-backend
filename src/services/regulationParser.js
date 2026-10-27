// services/regulationParser.js
// 把左手 MAP 規範（已去 HTML 的純文字）解析成「大項 → 中項 → 小項 → 細項」條文樹
// 每條給穩定條文代碼：<規範編號>-<大項序>.<中項>[.<小項>[.<細項>]]
//
// 輸出 doc：{ keywords, sections:[{ no, title, items:[clause] }], flags:[] }
// clause：{ code, no, t, text, notes:[{kind,text}], subs:[clause], stamps:[], flags:[] }
//   t（類型）匯入時一律 null（未分類），之後由 AI / 人工標「規定／流程／說明」

const CN_NUM = '一二三四五六七八九十';
const RE_SEC     = new RegExp(`^([${CN_NUM}]{1,3})[、.．]\\s*(.+)$`);
const RE_DETAIL  = /^(\d{1,2})-(\d{1,2})[.．](\d{1,2})[.．]?\s*(.*)$/;
const RE_SMALL   = /^(\d{1,2})-(\d{1,2})(?![\d])[.．、]?\s*(.*)$/;
const RE_MID     = /^(\d{1,2})[.．、](?!\d)\s*(.*)$/;
const RE_NOTE    = /^(註|例|備註|舉例|補充)\s*(\d*)\s*[:：]\s*(.*)$/;
const RE_STAMP   = /[<＜]\s*(\d{2,4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2})\s*([^>＞]{0,20})[>＞]/g;
const RE_TOP     = /【\s*至頂\s*】/g;
const RE_INDEX_H = /^MAP\s*(分類)?\s*(索引|引索|搜尋索引|搜尋引索)/;

function cleanLine(s) {
  return s.replace(/ /g, ' ').replace(/​/g, '').replace(/[ \t]+/g, ' ').trim();
}

function stripStamps(text, stamps) {
  return text.replace(RE_STAMP, (m, d, what) => {
    stamps.push({ date: d.replace(/\s/g, ''), what: (what || '').trim() });
    return '';
  }).trim();
}

function endsSentence(s) {
  return /[。！？!?：:；;）)」』\]】]$/.test(s);
}

function parseRegulation(reasonId, rawText, opts = {}) {
  const id = String(reasonId);
  const lines = String(rawText || '').replace(/\r/g, '').split('\n').map(cleanLine);
  const doc = { keywords: '', sections: [], flags: [] };

  let sec = null, mid = null, small = null, detail = null, last = null;
  let skipIndexLine = false;
  const used = new Set();

  const uniqueCode = (base) => {
    let c = base, k = 1;
    while (used.has(c)) { k += 1; c = `${base}${String.fromCharCode(96 + k)}`; }
    used.add(c);
    if (c !== base) doc.flags.push(`編號重複：${base}`);
    return c;
  };
  const newSection = (no, title) => {
    sec = { no: no || '', title: title || '', items: [] };
    doc.sections.push(sec);
    mid = small = detail = null; last = null;
  };
  const ensureSection = () => { if (!sec) newSection('', '（前言）'); };
  const mkClause = (code, no, text) => {
    const stamps = [];
    const t = stripStamps(text.replace(RE_TOP, ''), stamps);
    return { code, no, t: null, text: t, notes: [], subs: [], stamps, flags: [] };
  };
  const appendText = (target, line) => {
    const stamps = [];
    const t = stripStamps(line.replace(RE_TOP, ''), stamps);
    if (!t && !stamps.length) return;
    if (target.notes && target._lastNote) {
      const n = target._lastNote;
      n.text = n.text ? (endsSentence(n.text) ? `${n.text}\n${t}` : `${n.text}${t}`) : t;
    } else {
      target.text = target.text ? (endsSentence(target.text) ? `${target.text}\n${t}` : `${target.text}${t}`) : t;
    }
    if (target.stamps) target.stamps.push(...stamps);
    if (t.length <= 12 && !/[，。、]/.test(t)) target._short = (target._short || 0) + 1;
  };
  const secIdx = () => doc.sections.indexOf(sec) + 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // 關鍵字
    if (/^關鍵字\s*[:：]/.test(line) && doc.sections.length === 0) {
      doc.keywords = stripStamps(line.replace(/^關鍵字\s*[:：]\s*/, ''), []);
      continue;
    }
    // 索引標題 + 下一行【…】【…】
    if (RE_INDEX_H.test(line)) { skipIndexLine = true; continue; }
    if (skipIndexLine && /^【.*】/.test(line) && !RE_SEC.test(line)) { skipIndexLine = false; continue; }
    skipIndexLine = false;
    if (/^【\s*至頂\s*】$/.test(line)) continue;

    // 大項：國字編號，或整行以【至頂】結尾的標題
    let m = line.match(RE_SEC);
    if (m && line.length <= 60) { newSection(m[1], m[2].replace(RE_TOP, '').trim()); continue; }
    if (RE_TOP.test(line) && line.replace(RE_TOP, '').trim().length <= 40) {
      RE_TOP.lastIndex = 0;
      newSection('', line.replace(RE_TOP, '').trim());
      continue;
    }
    RE_TOP.lastIndex = 0;

    // 細項
    if ((m = line.match(RE_DETAIL))) {
      ensureSection();
      const parent = small || mid;
      if (!parent) { doc.flags.push(`細項無上層：${line.slice(0, 20)}`); }
      const code = uniqueCode(`${id}-${secIdx()}.${m[1]}.${m[2]}.${m[3]}`);
      detail = mkClause(code, `${m[1]}-${m[2]}.${m[3]}`, m[4]);
      (parent ? parent.subs : sec.items).push(detail);
      last = detail; continue;
    }
    // 小項
    if ((m = line.match(RE_SMALL))) {
      ensureSection();
      const code = uniqueCode(`${id}-${secIdx()}.${m[1]}.${m[2]}`);
      small = mkClause(code, `${m[1]}-${m[2]}`, m[3]); detail = null;
      if (mid) mid.subs.push(small); else { sec.items.push(small); doc.flags.push(`小項無中項：${m[1]}-${m[2]}`); }
      last = small; continue;
    }
    // 中項
    if ((m = line.match(RE_MID))) {
      ensureSection();
      const code = uniqueCode(`${id}-${secIdx()}.${m[1]}`);
      mid = mkClause(code, m[1], m[2]); small = detail = null;
      sec.items.push(mid);
      last = mid; continue;
    }
    // 註／例
    if ((m = line.match(RE_NOTE))) {
      ensureSection();
      const kind = /例/.test(m[1]) ? '例' : '註';
      const stamps = [];
      const note = { kind, text: stripStamps(m[3], stamps) };
      const host = last || (sec.items[sec.items.length - 1]);
      if (host) { host.notes.push(note); host._lastNote = note; if (host.stamps) host.stamps.push(...stamps); }
      else { const c = mkClause(null, kind, m[3]); sec.items.push(c); last = c; }
      continue;
    }
    // 舊版樣板的表頭（編寫人／內容／目的／執行時間…）放在第一個大項之前 → 收進 legacyMeta
    if (!opts.noLegacy && doc.sections.length === 0 && line.length <= 40) {
      doc.legacyMeta = doc.legacyMeta ? `${doc.legacyMeta}\n${line}` : line;
      continue;
    }
    // 其他：沒編號的段落
    //   上一條是有編號的條文且句子沒結束 → Word 斷行，接回去
    //   否則 → 自成一個「段落條文」，給代碼 <規範>-<大項>.p<序>
    ensureSection();
    const continueLast = last && !(last.loose && endsSentence(last.text)) && !(last.loose === undefined && endsSentence(last.text) && !mid);
    if (continueLast) { appendText(last, line); }
    else {
      sec._p = (sec._p || 0) + 1;
      const c = mkClause(uniqueCode(`${id}-${secIdx()}.p${sec._p}`), '', line); c.loose = true;
      (mid && !last?.loose ? mid.subs : sec.items).push(c); last = c;
    }
    // 新的一般行出現後，不再接到註釋上
    if (last && last._lastNote && endsSentence(last._lastNote.text)) delete last._lastNote;
  }

  // 收尾：清掉暫存欄位、標記疑似表格
  const walk = (arr) => arr.forEach(c => {
    if ((c._short || 0) >= 4) c.flags.push('疑似表格被攤平，需人工確認');
    delete c._short; delete c._lastNote;
    walk(c.subs);
  });
  doc.sections.forEach(s => { walk(s.items); delete s._p; });
  // 整份都沒有大項（舊樣板或純文字）→ 不收表頭，整份當一個大項重解析
  if (!doc.sections.length && !opts.noLegacy) return parseRegulation(reasonId, rawText, { noLegacy: true });
  if (!doc.sections.length) doc.flags.push('無法解析出任何大項');
  return doc;
}

function countClauses(doc) {
  let n = 0;
  const walk = (a) => a.forEach(c => { if (c.code) n += 1; walk(c.subs || []); });
  (doc.sections || []).forEach(s => walk(s.items));
  return n;
}

module.exports = { parseRegulation, countClauses };
