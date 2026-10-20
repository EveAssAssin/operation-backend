// services/sheetImport.js —— 舊月報試算表匯入成「已關帳」月報（2026-10-21）
// 營運定案：串聯上線前的月份（2025-09～2026-08）不回溯串聯，直接用各店 Google 月報試算表當正本，匯入後關帳。
// 快照長得跟 MR.build() 一樣（月報、帳本明細、店長外部月報、投資管理都直接讀），多一個 imported 標記。
// 明細每一列＝試算表的一列（source 'sheet'）；合計、盈餘、分紅一律用試算表上的數字，不重算。
// 同時寫 ledger_history（查帳提醒的舊試算表基準）。
const supabase = require('../config/supabase');
const MR = require('./monthlyReport');

const LEFT_GROUPS = ['opex', 'planning', 'ads'];
const RIGHT_GROUPS = ['misc', 'frame', 'lens', 'contact'];
const RATIO_TARGET = { 人事: 23, 包裝: 10, 鏡片: 15, 鏡框: 12, 營運費用: 30, 藥拋: 90, 淨利: 30 };
const r0 = (n) => Math.round(Number(n || 0) * 100) / 100;
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// 費用支出列的「月份」欄 → 費用月（本月＝這個月；數字＝那個月，大於這個月就是去年）
function feeYm(ym, mon) {
  const s = String(mon || '').trim();
  if (!s || s === '本月') return ym;
  const m = s.match(/^(\d{1,2})(?:\.0)?$/);
  if (!m) return ym;
  const mm = Number(m[1]); const [y, cur] = ym.split('-').map(Number);
  if (mm < 1 || mm > 12) return ym;
  return `${mm > cur ? y - 1 : y}-${String(mm).padStart(2, '0')}`;
}

/**
 * sheet＝parse 出來的一個月 { tab, revenue, totals, left[], right[], holders[] }
 * meta＝{ title, file_id }
 */
async function buildSnapshot(store, ym, sheet, meta, accs) {
  const acc = Object.fromEntries(accs.map((a) => [a.code, a]));
  const { data: dept } = await supabase.from('departments').select('store_name').eq('store_erpid', store).maybeSingle();
  const src = `試算表「${meta.title || ''}」${sheet.tab || ''}`;
  const lines = [];
  const push = (x, side) => {
    const code = acc[x.code] ? x.code : 'other';
    const label = side === 'L' ? x.label : [x.label, x.vendor].filter(Boolean).join('｜');
    lines.push({ store_erpid: store, ledger_code: code, amount: r0(x.amount), fee_ym: side === 'R' ? feeYm(ym, x.month) : ym, source: 'sheet', source_name: '試算表',
      ref_id: `sheet-${store}-${ym}-${side}${x.row}`, ref_title: `${label}${code !== x.code ? `（試算表列名「${x.label}」）` : ''}`, vendor: side === 'R' ? (x.vendor || null) : null });
  };
  (sheet.left || []).forEach((x) => push(x, 'L'));
  (sheet.right || []).forEach((x) => push(x, 'R'));

  const byCode = {};
  for (const l of lines) (byCode[l.ledger_code] = byCode[l.ledger_code] || []).push(l);
  const rowOf = (a) => {
    const ls = byCode[a.code] || [];
    const vendors = {};
    for (const l of ls) if (l.vendor) vendors[l.vendor] = (vendors[l.vendor] || 0) + l.amount;
    return { code: a.code, name: a.name, group: a.group_code, ratio_group: a.ratio_group, amount: r0(ls.reduce((s, l) => s + l.amount, 0)), has_data: ls.length > 0,
      sources: ls.length ? ['試算表'] : [], adjust_count: 0, fee_months: [...new Set(ls.map((l) => l.fee_ym).filter((f) => f && f !== ym))].sort(),
      vendors: Object.entries(vendors).map(([vendor, amount]) => ({ vendor, amount: r0(amount) })), lines: ls };
  };
  const section = (groups) => groups.map((g) => {
    // 試算表有些店把折舊、行銷基金記在營運支出裡（算進總支出）→ 匯入時照試算表放在支出列，不放分紅區
    const rows = accs.filter((a) => a.group_code === g && a.kind === 'expense').map(rowOf).filter((r) => r.has_data);
    return { group: g, name: MR.GROUP_NAME[g], rows, total: r0(rows.reduce((s, r) => s + r.amount, 0)) };
  });
  const left = section(LEFT_GROUPS), right = section(RIGHT_GROUPS);
  const leftTotal = r0(left.reduce((s, g) => s + g.total, 0)), rightTotal = r0(right.reduce((s, g) => s + g.total, 0));

  const rv = sheet.revenue || {}, t = sheet.totals || {};
  const gS = n(rv.glasses_sales), salesTotal = n(rv.sales_total);
  const cS = salesTotal != null && gS != null ? r0(salesTotal - gS) : null;
  const gR = n(rv.glasses_receipt), cR = n(rv.contact_receipt), api = n(t.api_pay) || 0;
  const receiptTotal = n(rv.receipt_total) != null ? n(rv.receipt_total) : r0((gR || 0) + (cR || 0));
  const totalOut = n(t.total_out) != null ? n(t.total_out) : r0(leftTotal + rightTotal);
  const profit = n(t.profit) != null ? n(t.profit) : r0(receiptTotal - totalOut);
  const rvRow = (name, kind, amount) => ({ name, kind, amount, from: 'import', refs: [{ label: src, amount }] });
  const revenue = {
    glasses_sales: rvRow('眼鏡業績（試算表）', 'sales', gS), contact_sales: rvRow('隱眼業績（試算表）', 'sales', cS),
    glasses_receipt: rvRow('眼鏡實收（試算表）', 'receipt', gR), contact_receipt: rvRow('隱眼實收（試算表）', 'receipt', cR),
    api_pay: rvRow('API 支付（試算表）', 'other', api),
    stored_value: { name: '儲值收款（試算表沒有這欄）', kind: 'other', amount: 0, from: 'import', refs: [] },
  };
  const mo = Number(ym.slice(5));
  const sum = [...left, ...right].flatMap((g) => g.rows).reduce((o, r) => { if (r.ratio_group) o[r.ratio_group] = (o[r.ratio_group] || 0) + r.amount; return o; }, {});
  const pct = (v, base) => (base ? Math.round((v / base) * 1000) / 10 : null);
  const ratio = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, pct(v, k === '藥拋' ? (cR || 0) + api : receiptTotal)]));
  ratio['淨利'] = pct(profit, receiptTotal);
  const dividend = n(t.dividend);
  const holders = (sheet.holders || []).map((h, i) => ({ id: `sheet-${i}`, name: h.name, erpid: null, shares: r0(Number(h.ratio) * 100), amount: r0(h.amount), from_sheet: true }));
  const gapOf = (label, s, r) => {
    if (s == null || r == null || !s) return { label, sales: s, receipt: r, diff: null, pct: null, alert: false };
    const diff = r0(r - s); const p = Math.round((diff / s) * 1000) / 10; return { label, sales: s, receipt: r, diff, pct: p, alert: Math.abs(p) >= 10 };
  };
  return {
    ym, store, store_name: dept ? dept.store_name : null, status: 'closed',
    imported: { source: 'sheet', title: meta.title || null, file_id: meta.file_id || null, tab: sheet.tab || null, at: new Date().toISOString() },
    revenue,
    totals: {
      glasses_in: gR || 0, contact_in: cR || 0, api_in: api, extra_in: 0, total_in: receiptTotal,
      sales_total: salesTotal, receipt_total: receiptTotal, receipt_filled: true,
      left_total: leftTotal, right_total: rightTotal, total_out: totalOut,
      glasses_out: n(t.glasses_out), contact_out: n(t.contact_out),
      glasses_profit: n(t.glasses_profit), contact_profit: n(t.contact_profit), profit, ratio,
    },
    gap: { alert_pct: 10, glasses: gapOf('眼鏡', gS, gR), contact: gapOf('藥拋', cS, cR), total: gapOf('合計', salesTotal, receiptTotal) },
    ratio_target: RATIO_TARGET, left, right,
    dividend: {
      marketing_fund: 0, marketing_fund_cum: n(t.marketing_fund_cum) || 0, depreciation: 0, depreciation_cum: n(t.depreciation_cum) || 0,
      retained: n(t.retained) || 0, retained_auto: n(t.retained) || 0, retained_rate: null, retained_set: true, retained_cum: n(t.retained_cum),
      distributable: dividend != null ? dividend : profit, total_shares: r0(holders.reduce((s, h) => s + h.shares, 0)),
      cash_month: mo % 2 === 1, cash_label: mo % 2 === 1 ? `現金分紅（${mo === 1 ? 12 : mo - 1}–${mo} 月）` : null,
      fixed_this: { marketing_fund: 0, depreciation: 0 },
    },
    shareholders: holders,
    rent: null, card_fee: null, salary: null, storehouse_issues: [], planning_issues: [], aimin: null,
    warnings: [`這個月是從${src}匯入的（串聯上線前的月份），數字以試算表為準；系統串聯的資料不算進來。`],
    settings: null, market_end: null, year: Number(ym.slice(0, 4)),
    snapshot_at: new Date().toISOString(),
  };
}

/** 匯入一店一月。force＝覆蓋已經「系統關帳」的月份（預設不蓋） */
async function importOne(item, by, { dry, force } = {}) {
  const { store, ym, sheet, meta } = item;
  if (!/^\d{4}-\d{2}$/.test(String(ym || '')) || !store || !sheet) throw new Error('缺 store／ym／sheet');
  const accs = await MR.accounts();
  const snap = await buildSnapshot(String(store), ym, sheet, meta || {}, accs);
  const { data: cur } = await supabase.from('store_month_reports').select('status, snapshot').eq('store_erpid', String(store)).eq('ym', ym).maybeSingle();
  if (cur && cur.status === 'closed' && !(cur.snapshot && cur.snapshot.imported) && !force) return { store, ym, skip: '已經用系統資料關帳，沒有蓋掉' };
  const sumLines = r0([...snap.left, ...snap.right].reduce((s, g) => s + g.total, 0));
  const res = { store, ym, total_out: snap.totals.total_out, lines_sum: sumLines, profit: snap.totals.profit, holders: snap.shareholders.length };
  if (dry) return { ...res, dry: true };
  const now = new Date().toISOString();
  const { error } = await supabase.from('store_month_reports').upsert({ store_erpid: String(store), ym, status: 'closed', snapshot: snap, closed_by: `${by}（試算表匯入）`, closed_at: now, updated_at: now }, { onConflict: 'store_erpid,ym' });
  if (error) throw new Error(error.message);
  // 查帳基準：同店同月 source=sheet 先刪再寫（跟 8 月那批同格式：非 0、廠商類帶廠商、_ 開頭＝合計）
  await supabase.from('ledger_history').delete().eq('store_erpid', String(store)).eq('ym', ym).eq('source', 'sheet');
  const agg = {};
  for (const g of [...snap.left, ...snap.right]) for (const r of g.rows) for (const l of r.lines) {
    const k = `${r.code}|${l.vendor && /_vendor$/.test(r.code) ? l.vendor : ''}`;
    agg[k] = (agg[k] || 0) + l.amount;
  }
  const t = snap.totals, rv = snap.revenue;
  const rows = Object.entries(agg).filter(([, v]) => Math.abs(v) > 0.004).map(([k, v]) => { const [c, ven] = k.split('|'); return { ledger_code: c, vendor: ven || null, amount: r0(v) }; });
  [['_glasses_sales', rv.glasses_sales.amount], ['_glasses_receipt', rv.glasses_receipt.amount], ['_contact_receipt', rv.contact_receipt.amount], ['_total_in', t.total_in], ['_total_out', t.total_out], ['_profit', t.profit]]
    .forEach(([c, v]) => { if (v != null) rows.push({ ledger_code: c, vendor: null, amount: r0(v) }); });
  const ref = `門市月報試算表 ${snap.imported.tab || ''}（${now.slice(0, 10)} 匯入）`;
  if (rows.length) {
    const { error: e2 } = await supabase.from('ledger_history').insert(rows.map((r) => ({ ...r, store_erpid: String(store), ym, source: 'sheet', source_ref: ref })));
    if (e2) throw new Error('ledger_history：' + e2.message);
  }
  return { ...res, ok: true };
}

module.exports = { buildSnapshot, importOne, feeYm };
