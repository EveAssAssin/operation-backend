// services/bankParsers.js —— 網銀交易明細檔解析（2026-11 銀存彙整）
// 支援（照 2026-11-10 營運給的樣本）：
//   中國信託 個人戶 CSV（Big5，前幾行是標題）／公司戶 CSV（="..." 格式）
//   元大銀行 CSV（每列有帳號、時間）
//   郵局 CSV（第一行存簿帳號、民國年＋時間、「續上一行」接備註）
//   合作金庫 XLS 兩種（Sheet0：每列帳號＋民國年；Jasper 報表：標題區有遮罩帳號）
//   高雄銀行 XLS
// 其他銀行：只要有「日期／支出(提款)／存入(存款)／餘額」欄位，一般也讀得到（照表頭找欄位）
// 輸出：{ bank, format, account_no, account_hint, holder, rows:[{ txn_date, txn_time, summary, out_amt, in_amt, balance, memo, memo2, counter_account, branch, cheque_no, raw }] , warnings }

const XLSX = require('xlsx');

let iconv = null;
try { iconv = require('iconv-lite'); } catch { /* 沒裝就用 TextDecoder */ }

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 不是 UTF-8 */ }
  if (iconv) return iconv.decode(buf, 'big5');
  try { return new TextDecoder('big5').decode(buf); } catch { return buf.toString('latin1'); }
}

// 簡單 CSV（含引號、逗號、換行；去掉 ="..." 與開頭的 '）
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const clean = (v) => {
  if (v == null) return '';
  let s = String(v);
  s = s.replace(/^=\s*"?/, '').replace(/"$/, '');      // ="xxx"
  s = s.replace(/^'+/, '').replace(/'+$/, '');          // 'xxx'
  return s.replace(/[　\s]+/g, ' ').trim();
};
const num = (v) => {
  const s = clean(v).replace(/[,\s]/g, '').replace(/^\+/, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const hdr = (v) => clean(v).replace(/\s+/g, '');

const COLS = {
  date: ['日期', '交易日期', '交易日', '交易日期交易時間'],
  time: ['交易時間'],
  value_date: ['帳務日期'],
  out: ['支出', '支出金額', '提款金額', '提出金額'],
  in: ['存入', '存入金額', '存款金額', '存入金額(元)'],
  balance: ['結餘', '餘額', '結存金額', '帳戶餘額'],
  summary: ['摘要', '交易說明', '交易摘要'],
  memo: ['備註', '備註1'],
  memo2: ['註記', '附言', '票號/備註2', '備註2'],
  counter: ['轉出入帳號', '對方帳號'],
  account: ['帳號'],
  branch: ['交易行庫', '交易分行'],
  cheque: ['支票號碼', '票據號碼'],
  reversal: ['沖銷記號'],
};

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = rows[i].map(hdr);
    const has = (k) => h.some((x) => COLS[k].includes(x));
    if (has('date') && has('balance') && (has('in') || has('out'))) {
      const idx = {};
      for (const k of Object.keys(COLS)) { const j = h.findIndex((x) => COLS[k].includes(x)); if (j >= 0) idx[k] = j; }
      return { at: i, idx, cells: h };
    }
  }
  return null;
}

// 日期：2026/10/12、20261012、1151012（民國）、115/10/12、115/10/12 13:08:16
function parseDate(v) {
  const s = clean(v);
  let m;
  if ((m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/))) return { d: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, t: m[4] || null };
  if ((m = s.match(/^(\d{2,3})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/))) return { d: `${1911 + Number(m[1])}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, t: m[4] || null };
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return { d: `${m[1]}-${m[2]}-${m[3]}`, t: null };
  if ((m = s.match(/^(\d{3})(\d{2})(\d{2})$/))) return { d: `${1911 + Number(m[1])}-${m[2]}-${m[3]}`, t: null };
  if (typeof v === 'number' && v > 30000 && v < 80000) { const dt = XLSX.SSF.parse_date_code(v); return { d: `${dt.y}-${String(dt.m).padStart(2, '0')}-${String(dt.d).padStart(2, '0')}`, t: null }; }
  return null;
}
const parseTime = (v) => {
  const s = clean(v);
  let m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  if ((m = s.match(/^(\d{2})(\d{2})(\d{2})$/))) return `${m[1]}:${m[2]}:${m[3]}`;
  return null;
};
const validDate = (d) => { if (!d) return false; const t = Date.parse(d + 'T00:00:00Z'); return Number.isFinite(t) && d >= '2000-01-01' && d <= '2100-12-31'; };

function guessBank(fileName, cells, head) {
  const f = String(fileName || '');
  const all = head.join(' ');
  if (/郵局|郵政|中華郵政/.test(f) || /存簿帳號/.test(all)) return '中華郵政';
  if (/中國信託|中信|ctbc/i.test(f) || cells.includes('轉出入帳號')) return '中國信託';
  if (/元大|yuanta/i.test(f) || (cells.includes('帳務日期') && cells.includes('交易說明'))) return '元大銀行';
  if (/合作金庫|合庫/.test(f) || cells.includes('交易行庫')) return '合作金庫';
  if (/高雄銀行|高銀/.test(f) || cells.includes('備註1')) return '高雄銀行';
  return '其他銀行';
}

/** buffer + 檔名 → 解析結果 */
function parseBankFile(buffer, fileName) {
  const warnings = [];
  let rows;
  const isXls = /\.(xls|xlsx)$/i.test(fileName || '') || (buffer[0] === 0xd0 && buffer[1] === 0xcf) || (buffer[0] === 0x50 && buffer[1] === 0x4b);
  if (isXls) {
    const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
    const sh = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
  } else {
    rows = parseCsv(decodeText(buffer));
  }
  rows = rows.filter((r) => Array.isArray(r) && r.some((c) => clean(c) !== ''));
  const h = findHeader(rows);
  if (!h) throw new Error('看不懂這個檔案：找不到「日期／存入／支出／餘額」欄位');

  // 標題區：帳號、戶名
  const headTexts = rows.slice(0, h.at).map((r) => r.map(clean).filter(Boolean).join(' '));
  let accountNo = null; let holder = null;
  for (const r of rows.slice(0, h.at)) {
    const cs = r.map(clean).filter(Boolean);
    for (let k = 0; k < cs.length; k++) {
      if (/^(存簿帳號|查詢帳號|帳號)[:：]?$/.test(cs[k]) && cs[k + 1]) accountNo = cs[k + 1].replace(/[^\d*]/g, '');
      if (/^戶名[:：]?$/.test(cs[k]) && cs[k + 1]) holder = cs[k + 1];
    }
  }
  const bank = guessBank(fileName, h.cells, headTexts);

  const out = [];
  const I = h.idx;
  const get = (r, k) => (I[k] === undefined ? '' : r[I[k]]);
  for (const r of rows.slice(h.at + 1)) {
    const summary = clean(get(r, 'summary'));
    const dp = parseDate(get(r, 'date'));
    // 郵局：「續上一行」＝上一筆的備註接續
    if (/^續上一[行筆]/.test(summary) && out.length) {
      const p = out[out.length - 1];
      const extra = [clean(get(r, 'memo')), clean(get(r, 'memo2'))].filter(Boolean).join(' ');
      if (extra) p.memo = [p.memo, extra].filter(Boolean).join(/續上一行/.test(summary) ? '' : ' ');
      continue;
    }
    if (!dp || !validDate(dp.d)) continue;                 // 合計列、註解列
    const outAmt = num(get(r, 'out')) || 0;
    const inAmt = num(get(r, 'in')) || 0;
    const bal = num(get(r, 'balance'));
    if (bal === null && !outAmt && !inAmt) continue;
    const time = dp.t ? parseTime(dp.t) : (I.time !== undefined ? parseTime(get(r, 'time')) : null);
    const acc = I.account !== undefined ? clean(get(r, 'account')).replace(/[^\d*]/g, '') : '';
    if (acc && !accountNo) accountNo = acc;
    const vd = I.value_date !== undefined ? parseDate(get(r, 'value_date')) : null;
    out.push({
      txn_date: dp.d, txn_time: time, value_date: vd && validDate(vd.d) ? vd.d : null,
      summary, out_amt: outAmt, in_amt: inAmt, balance: bal,
      memo: clean(get(r, 'memo')) || null, memo2: clean(get(r, 'memo2')) || null,
      counter_account: clean(get(r, 'counter')).replace(/^-$/, '') || null,
      branch: clean(get(r, 'branch')) || null, cheque_no: clean(get(r, 'cheque')) || null,
      reversal: clean(get(r, 'reversal')) || null,
      raw: r.map(clean),
    });
  }
  if (!out.length) throw new Error('檔案裡沒有交易明細');
  const dates = out.map((x) => x.txn_date).sort();
  return {
    bank, format: Object.keys(I).sort().join(','), account_no: accountNo || null, holder,
    period_from: dates[0], period_to: dates[dates.length - 1], rows: out, warnings,
  };
}

// 同一個檔裡完全一樣的交易（同日同時同金額同餘額同摘要）→ 第幾筆
function fingerprints(rows) {
  const seen = {};
  return rows.map((x) => {
    const base = [x.txn_date, x.txn_time || '', x.out_amt, x.in_amt, x.balance == null ? '' : x.balance, (x.summary || '').replace(/\s/g, '')].join('|');
    seen[base] = (seen[base] || 0) + 1;
    return `${base}#${seen[base]}`;
  });
}

module.exports = { parseBankFile, fingerprints, parseDate, decodeText };
