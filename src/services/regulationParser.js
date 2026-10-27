// services/regulationParser.js
// 把左手 MAP 規範（已去 HTML 的純文字）解析成「大項 → 中項 → 小項 → 細項」條文樹
// 每條給穩定條文代碼：<規範編號>-<大項序>.<中項>[.<小項>[.<細項>]]
//
// 輸出 doc：{ keywords, sections:[{ no, title, items:[clause] }], flags:[] }
// clause：{ code, no, t, text, notes:[{kind,text}], subs:[clause], stamps:[], flags:[] }
//   t（類型）匯入時一律 null（未分類），之後由 AI / 人工標「規定／流程／說明」

const CN_NUM = '一二三四五六七八九十';
const RE_SEC     = new RegExp(`^([${CN_NUM}]{1,3})[、.．]\\s*(.+)$`);
// 多層編號：1-1、1-1.1、1-1-2、1-1-2-1、1--1-2-2（打錯兩個減號）、1-1-6.1 …（至少一個「-」）
//   路徑＝所有數字，條文代碼 <規範>-<大項>.<路徑用 . 串>；1-1／1-1.1 跟舊版代碼一樣
const RE_PATH    = /^(\d{1,2}(?:\s*-{1,2}\s*\d{1,2}(?!\d))+(?:[.．]\d{1,2}(?!\d))*)[.．、]?\s*(.*)$/;
const RE_MID     = /^(\d{1,2})[.．、](?!\d)\s*(.*)$/;
const RE_MID_SP  = /^(\d{1,2})[ \u3000]+(?![\d個月天年日次元分人位%％])(\S.{0,40})$/;   // 「5   新人扣分事項」只在接續目前中項號碼時才算
const RE_NOTE    = /^(註|例|備註|舉例|補充)\s*(\d*)\s*[:：]\s*(.*)$/;
const RE_STAMP   = /[<＜]\s*(\d{2,4}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{1,2})\s*([^>＞]{0,20})[>＞]/g;
const RE_TOP     = /【\s*至頂\s*】/g;
const RE_INDEX_H = /^MAP\s*(分類)?\s*(索引|引索|搜尋索引|搜尋引索)/;

function cleanLine(s) {
  return s.replace(/ /g, ' ').replace(/​/g, '').replace(/[ \t]+/g, ' ').trim();
}

function stripStamps(text, stamps) {
  return text.replace(RE_STAMP, (m, d, what) => {
    stamps.push({ date: d.replace(/\s/g, '').replace(/[.\-]/g, '/'), what: (what || '').trim() });
    return '';
  }).trim();
}

function endsSentence(s) {
  return /[。！？!?：:；;）)」』\]】]$/.test(s);
}


// ── 表格：MAP 的 HTML 表格去標籤後變成「一格一行、用整行 tab 分隔」的文字 ──
//   一個區塊＝連續以 tab 開頭（或空白）的行；內容行最常見的 tab 數＝L
//   只有 tab 的行：L-1 個＝換列、L 個＝換格
//   轉成 markdown 表格（一整個表格＝一條條文），跨列合併（rowspan）的格子從上一列補
const TAB_MARK = '\u0000TABLE';
const isPureTab = (l) => /^\t+$/.test(l);
const tabCount = (l) => (l.match(/^\t*/) || [''])[0].length;
const cellClean = (s) => s.replace(/ /g, ' ').replace(/​/g, '').replace(/[ \t]+/g, ' ').trim();

function blockToTable(block) {
  const counts = {};
  block.forEach(l => { if (!isPureTab(l) && cellClean(l)) { const k = tabCount(l); counts[k] = (counts[k] || 0) + 1; } });
  const L = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 0);
  if (L < 2) return null;
  // 連續的「只有 tab」行看成一組：
  //   組裡有少於 L 個 tab 的行 → 換列；全部是 L 個且 ≥2 行 → 換格（</td><td>）；只有 1 行 → 同一格裡換段落
  const rows = []; let row = null, cell = null;
  const closeCell = () => { cell = null; };
  const closeRow = () => { cell = null; if (row && row.length) rows.push(row); row = null; };
  // 另一種格式：格子之間沒有分隔行（一行就是一格）
  let seps = 0, r0 = 0;
  block.forEach(l => { if (isPureTab(l) && l.length === L) r0 += 1; else { if (r0 >= 2) seps += 1; r0 = 0; } });
  const linePerCell = seps === 0;
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.some(k => k < L)) closeRow();
    else if (run.length >= 2) closeCell();
    else if (cell) cell.push('');
    run = [];
  };
  for (const l of block) {
    if (isPureTab(l)) { run.push(l.length); continue; }
    if (!/\t/.test(l) && !cellClean(l)) { if (!run.length && cell) cell.push(''); continue; }
    flushRun();
    const t = cellClean(l);
    if (linePerCell && cell && !/^[<＜]\s*\d{2,4}\s*[\/.\-]/.test(t)) cell = null;   // 一行一格（只有日期戳記的行接在上一格）
    if (!row) row = [];
    if (!cell) { cell = []; row.push(cell); }
    cell.push(t);
  }
  flushRun();
  closeRow();
  if (!rows.length) return null;
  // 同一格裡的段落用 <br> 接（畫面換行、AI 也看得懂）
  const txt = rows.map(r => r.map(c => c.join('\n').replace(/\n{2,}/g, '\n').trim().split('\n').map(x => x.trim()).filter(Boolean).join('<br>')));
  return txt;
}

function tableToMarkdown(rows, stamps) {
  const st = (s) => stripStamps(s.replace(RE_TOP, ''), stamps).replace(/\|/g, '／');
  rows = rows.map(r => r.map(st));
  const width = rows[0].length >= 2 ? rows[0].length : Math.max(...rows.map(r => r.length));
  if (width <= 1 || rows.length <= 1) {
    // 只有一欄或一列的「排版用表格」→ 當一般段落
    return { text: rows.map(r => r.filter(Boolean).join(' ｜ ')).filter(Boolean).join('\n'), irregular: false, plain: true };
  }
  let irregular = false;
  const full = [];
  rows.forEach((r, i) => {
    // 比表頭多的格子＝同一格裡的段落被拆開（MAP 沒留分隔行），接回最後一欄
    if (r.length > width) r = [...r.slice(0, width - 1), r.slice(width - 1).filter(Boolean).join('<br>')];
    if (r.length < width && i > 0) {
      const prev = full[i - 1];
      full.push([...prev.slice(0, width - r.length), ...r]);
      if (width - r.length > 2) irregular = true;
    } else if (r.length < width) { full.push([...r, ...Array(width - r.length).fill('')]); irregular = true; }
    else full.push(r);
  });
  const line = (r) => `| ${r.map(c => c || ' ').join(' | ')} |`;
  const md = [line(full[0]), `| ${full[0].map(() => '---').join(' | ')} |`, ...full.slice(1).map(line)].join('\n');
  return { text: md, irregular, plain: false };
}

/** 把原文裡的表格區塊換成一行記號，表格另外存 */
function extractTables(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const out = [], tables = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\t/.test(lines[i]) || (isPureTab(lines[i]))) {
      let j = i; const block = [];
      while (j < lines.length && (/^\t/.test(lines[j]) || !cellClean(lines[j]))) { block.push(lines[j]); j++; }
      // 區塊尾端的空行還回去
      while (block.length && !/\t/.test(block[block.length - 1])) { block.pop(); j--; }
      const pureTabs = block.filter(isPureTab).length;
      const rows = pureTabs >= 3 ? blockToTable(block) : null;
      if (rows && rows.length) { tables.push(rows); out.push(`${TAB_MARK}${tables.length - 1}`); i = j; continue; }
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j; if (j === i) i++;
      continue;
    }
    out.push(lines[i]); i++;
  }
  return { text: out.join('\n'), tables };
}

function parseRegulation(reasonId, rawText, opts = {}) {
  const id = String(reasonId);
  const ex = extractTables(rawText);
  const lines = ex.text.split('\n').map(l => (l.startsWith(TAB_MARK) ? l : cleanLine(l)));
  const doc = { keywords: '', sections: [], flags: [] };

  let sec = null, mid = null, last = null;
  let byPath = new Map();   // 本大項裡「編號路徑 → 條文」，找上層用
  let midNo = 0;            // 本大項目前的中項號碼
  let sub = null;           // 條文底下又從 1. 開始的清單：{ host, next }
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
    mid = null; last = null; byPath = new Map(); midNo = 0; sub = null;
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

    // 表格（整個表格＝一條條文，掛在上一條有編號的條文底下）
    if (line.startsWith(TAB_MARK)) {
      ensureSection();
      const stamps = [];
      const tb = tableToMarkdown(ex.tables[Number(line.slice(TAB_MARK.length))], stamps);
      if (!tb.text) continue;
      sec._p = (sec._p || 0) + 1;
      const c = mkClause(uniqueCode(`${id}-${secIdx()}.p${sec._p}`), '', '');
      c.text = tb.text; c.stamps.push(...stamps); c.loose = true;
      if (!tb.plain) { c.table = true; if (tb.irregular) c.flags.push('表格欄位對不齊，需人工確認'); }
      const host = last && !last.loose ? last : (mid || null);
      (host ? host.subs : sec.items).push(c);
      last = c; continue;
    }
    // 多層編號（1-1、1-1-2、1-1.1 …）
    if ((m = line.match(RE_PATH))) {
      ensureSection();
      sub = null;
      const path = m[1].split(/\s*-{1,2}\s*|[.．]/).filter(Boolean).map(Number);
      if (/--/.test(m[1])) doc.flags.push(`編號打錯（兩個減號）：${m[1]}`);
      let parent = null;
      for (let k = path.length - 1; k >= 1 && !parent; k--) parent = byPath.get(path.slice(0, k).join('.')) || null;
      if (!parent) { parent = mid; doc.flags.push(`編號找不到上層：${path.join('-')}`); }
      const code = uniqueCode(`${id}-${secIdx()}.${path.join('.')}`);
      const c = mkClause(code, path.join('-'), m[2]);
      (parent ? parent.subs : sec.items).push(c);
      byPath.set(path.join('.'), c);
      last = c; continue;
    }
    // 中項
    if (!(m = line.match(RE_MID)) && (m = line.match(RE_MID_SP)) && !(sec && midNo >= 1 && Number(m[1]) === midNo + 1)) m = null;
    if (m) {
      ensureSection();
      const n = Number(m[1]);
      // 清單接續：上一條底下的 1. 2. 3. …
      if (sub && n === sub.next) {
        const c = mkClause(uniqueCode(`${sub.host.code}.${n}`), String(n), m[2]);
        sub.host.subs.push(c); sub.next += 1; last = c; continue;
      }
      // 號碼回到 1（而且比目前中項小）＝上一條底下的清單，不是新的中項
      if (n === 1 && midNo >= 1 && last && last.code) {
        const host = last.loose && mid ? mid : last;
        sub = { host, next: 2 };
        const c = mkClause(uniqueCode(`${host.code}.${n}`), String(n), m[2]);
        host.subs.push(c); last = c; continue;
      }
      sub = null;
      if (midNo && n <= midNo) doc.flags.push(`中項編號重複或倒退：${n}`);
      const code = uniqueCode(`${id}-${secIdx()}.${n}`);
      mid = mkClause(code, String(n), m[2]);
      sec.items.push(mid);
      byPath.set(String(n), mid);
      midNo = n;
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

// 解析器版本：改了解析規則就 +1，伺服器開機時會把「從沒在本系統改過」的規範用新規則重新解析一次（regulationService.reparseIfNeeded）
const PARSER_VERSION = 2;   // 2026-10-27：多層編號 1-1-2-1、清單重新從 1 開始、表格轉 markdown、日期戳記 2026.07.21

module.exports = { parseRegulation, countClauses, PARSER_VERSION, _extractTables: extractTables };
