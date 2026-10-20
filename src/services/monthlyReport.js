// services/monthlyReport.js —— 門市月報 v1（2026-10-20，P1）
// 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
// 版型照「後甲月報」試算表：上方業績／實收、左＝營運支出、右＝費用支出（依廠商分列）、下＝盈餘與分紅。
// 數字一律從帳本 ledger_lines(ym) 來（開帳帳單、部門開帳、營運費用拆月、固定支出、固定金額、手填／調帳），
// 再加市場部內部 API 的 ERP 帳上業績（參考）與 ERP 門市費用單（分店支出雜項）。
const axios = require('axios');
const supabase = require('../config/supabase');

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

// 版面：左欄（營運支出）與右欄（費用支出，依廠商分列）用哪些大類
const LEFT_GROUPS = ['opex', 'planning', 'ads'];
const RIGHT_GROUPS = ['misc', 'frame', 'lens', 'contact'];
const GROUP_NAME = { opex: '營運支出', planning: '企劃品', ads: '廣告費', misc: '雜費', frame: '鏡框', lens: '鏡片', contact: '藥拋' };
// 不算進總支出、放在分紅區塊扣的
// 成本率目標（後甲月報下方那張表）
const RATIO_TARGET = { 人事: 23, 包裝: 10, 鏡片: 15, 鏡框: 12, 營運費用: 30, 藥拋: 90, 淨利: 30 };
const DIVIDEND_CODES = ['marketing_fund', 'depreciation'];
const SOURCE_NAME = {
  bill: '開帳單', billing_order: '部門開帳', opex: '營運費用', recurring: '固定支出', fixed: '固定金額',
  manual_value: '手填', manual_adjust: '調帳', erp_cost: 'ERP 費用單', aimin_expense: '愛民支出', planning_bill: '企劃部開帳',
};

const MARKET_BASE = process.env.MARKET_BACKEND_URL || 'https://market-backend-0544.onrender.com';

async function marketMonth(ym, stores) {
  const key = process.env.MARKET_INTERNAL_KEY;
  if (!key) return { error: '營運部沒設 MARKET_INTERNAL_KEY', stores: {} };
  try {
    const { data } = await axios.get(`${MARKET_BASE}/api/internal/report/store-month`, {
      params: { ym, stores: stores && stores.length ? stores.join(',') : undefined },
      headers: { 'x-internal-key': key }, timeout: 90000,
    });
    return { stores: data.stores || {}, cats: data.cost_cats || {}, errors: data.errors || [], end: data.end };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `市場部月資料：${msg}`, stores: {} };
  }
}

// ── 愛民（IMING 系統，Supabase suvsaycdiyvofzaudpkg）：眼鏡業績、收款、結帳、門市支出 ──
// 愛民門市（後甲、北屯、十甲、高應大…）的眼鏡不走 ERP；IMING 開了只讀函式 report_store_month(p_key, p_ym)
// 金鑰存在營運部 report_settings.aimin_report_key（IMING 只存 sha256）；門市對照 report_settings.aimin_store_map（IMING 門市 id → ERP 門市編號）
const AIMIN_URL = process.env.AIMIN_SUPABASE_URL || 'https://suvsaycdiyvofzaudpkg.supabase.co';
const AIMIN_PUB = process.env.AIMIN_PUBLISHABLE_KEY || 'sb_publishable_s9iUEJn9i5c0TB_ViJBtcg_izwVlnPH'; // 公開金鑰（前端也用），權限靠 p_key
const aiminCache = new Map();
async function aiminMonth(ym) {
  const hit = aiminCache.get(ym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const { data: rows } = await supabase.from('report_settings').select('key, value').in('key', ['aimin_report_key', 'aimin_store_map']);
  const o = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  if (!o.aimin_report_key) return { error: '營運部沒設愛民金鑰（report_settings.aimin_report_key）', byStore: {} };
  let v;
  try {
    const { data } = await axios.post(`${AIMIN_URL}/rest/v1/rpc/report_store_month`, { p_key: o.aimin_report_key, p_ym: ym },
      { headers: { apikey: AIMIN_PUB, 'Content-Type': 'application/json' }, timeout: 30000 });
    const map = o.aimin_store_map || {};
    const byStore = {};
    for (const st of (data && data.stores) || []) { const erp = map[st.id]; if (erp) byStore[String(erp)] = st; }
    v = { byStore };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `愛民系統月資料：${msg}`, byStore: {} };
  }
  aiminCache.set(ym, { at: Date.now(), v });
  return v;
}

// ── 企劃部開帳（業績系統 Supabase gyhmfbclljkgmqeqbbxh，2026-10-20）──
// 企劃部開帳時就選好門市（planning_expense_billing，每筆 → 對象＋成本分攤＋加成後開帳金額）；業績系統開了只讀函式
// report_planning_month(p_key, p_year, p_month)。金鑰 report_settings.planning_report_key（對方只存 sha256），
// 對象 → 門市 report_settings.planning_target_map（planning_bill_target.id → ERP 門市編號；部門不在表裡＝不進門市月報）。
// 只收「開帳時有選門市」的；舊的文字開帳（bill_target_text）與「二次開帳」（倉庫出貨時才開）不在這裡。
const PLAN_URL = process.env.PLANNING_SUPABASE_URL || 'https://gyhmfbclljkgmqeqbbxh.supabase.co';
const PLAN_PUB = process.env.PLANNING_PUBLISHABLE_KEY || 'sb_publishable_8suC8kak9B60yiyhdiAu2A_gtWx-gpA'; // 公開金鑰，權限靠 p_key
const planCache = new Map();
async function planningMonth(ym) {
  const hit = planCache.get(ym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const { data: rows } = await supabase.from('report_settings').select('key, value').in('key', ['planning_report_key', 'planning_target_map']);
  const o = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  if (!o.planning_report_key) return { error: '營運部沒設企劃部開帳金鑰（report_settings.planning_report_key）', byStore: {}, issues: [] };
  const [y, m] = ym.split('-').map(Number);
  let v;
  try {
    const { data } = await axios.post(`${PLAN_URL}/rest/v1/rpc/report_planning_month`, { p_key: o.planning_report_key, p_year: y, p_month: m },
      { headers: { apikey: PLAN_PUB, 'Content-Type': 'application/json' }, timeout: 30000 });
    const map = o.planning_target_map || {};
    const byStore = {}, issues = [], perExp = {};
    for (const l of (data && data.lines) || []) {
      const erp = map[String(l.target_id)];
      const e = (perExp[l.expense_id] = perExp[l.expense_id] || { item: l.item, serial: l.serial, cost_total: Number(l.cost_total) || 0, qty_total: Number(l.qty_total) || 0, cost: 0, qty: 0, lines: [] });
      e.cost += Number(l.cost_share) || 0; e.qty += Number(l.qty) || 0; e.lines.push(l);
      if (l.status !== '已開帳') continue;
      if (!erp) { if (l.category !== 'dept' && l.category !== 'planning') issues.push({ kind: 'unmapped', line: l }); continue; }
      (byStore[erp] = byStore[erp] || []).push(l);
      if (Number(l.qty) > 0 && !Number(l.sell_amount)) issues.push({ kind: 'zero', store: erp, line: l });
    }
    for (const [id, e] of Object.entries(perExp)) {
      if (e.cost_total && Math.abs(e.cost - e.cost_total) > 1) issues.push({ kind: 'cost_sum', expense_id: id, e });
      if (e.qty_total && e.qty && Math.abs(e.qty - e.qty_total) > 0.001) issues.push({ kind: 'qty_sum', expense_id: id, e });
    }
    v = { byStore, issues, unbilled: data ? data.unbilled : null };
  } catch (e) {
    const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 120)}` : e.message;
    return { error: `企劃部開帳：${msg}`, byStore: {}, issues: [] };
  }
  planCache.set(ym, { at: Date.now(), v });
  return v;
}

const splitTitle = (t) => { const s = String(t || ''); const i = s.indexOf('｜'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const r0 = (n) => Math.round(Number(n) || 0);
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1) + 1; };

async function settings() {
  const { data } = await supabase.from('report_settings').select('key, value');
  const o = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { cutoff_day: Number(o.cutoff_day) || 26, retained_rate: o.retained_rate == null ? 0.1 : Number(o.retained_rate),
    gap_alert_pct: o.gap_alert_pct == null ? 10 : Number(o.gap_alert_pct) };
}

async function accounts() {
  const { data, error } = await supabase.from('ledger_accounts').select('*').eq('is_active', true).order('sort_order');
  if (error) throw error;
  return data || [];
}

/**
 * 算一家店一個月的月報
 * @returns {object} { ym, store, revenue, left, right, totals, dividend, shareholders, warnings, report }
 */
async function build(ym, store, opts = {}) {
  if (!YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  store = String(store || '');
  if (!store) throw new Error('缺門市');
  const [accs, st, linesR, mkt, aimin, rep, fixed, holders, dept, plan] = await Promise.all([
    accounts(),
    settings(),
    supabase.rpc('ledger_lines', { p_ym: ym }).eq('store_erpid', store),
    opts.market || marketMonth(ym, [store]),
    opts.aimin || aiminMonth(ym),
    supabase.from('store_month_reports').select('*').eq('store_erpid', store).eq('ym', ym).maybeSingle(),
    supabase.from('store_fixed_items').select('*').eq('store_erpid', store),
    supabase.from('store_shareholders').select('*').eq('store_erpid', store),
    supabase.from('departments').select('store_erpid, store_name').eq('store_erpid', store).maybeSingle(),
    opts.planning || planningMonth(ym),
  ]);
  if (linesR.error) throw linesR.error;
  const lines = linesR.data || [];
  const byCode = {};
  for (const l of lines) (byCode[l.ledger_code] = byCode[l.ledger_code] || []).push(l);
  const warnings = [];
  if (mkt.error) warnings.push(mkt.error);
  (mkt.errors || []).forEach((e) => warnings.push(e));
  const m = (mkt.stores || {})[store] || {};
  const am = (aimin.byStore || {})[store] || null;   // 愛民門市才有
  if (aimin.error && am === null && /愛民|後甲|北屯|十甲/.test((dept.data && dept.data.store_name) || '')) warnings.push(aimin.error);

  // ERP 門市費用單 → 分店支出雜項（有手填值就以手填為準）
  if (!(byCode.store_misc || []).some((l) => l.source === 'manual_value') && m.costs) {
    byCode.store_misc = (byCode.store_misc || []).concat(m.costs.items.map((x) => ({
      store_erpid: store, ledger_code: 'store_misc', amount: x.amount, fee_ym: ym, source: 'erp_cost',
      ref_id: String(x.pay_id), ref_title: `ERP 費用單｜${x.date ? String(x.date).slice(0, 10) : ''} ${x.remark || ''}`.trim(),
    })));
  } else if (!m.costs && !am) warnings.push('分店支出雜項：這次拿不到 ERP 門市費用單');
  // 愛民門市的門市支出記在 IMING expenses（後甲 8 月 1,797＝試算表）
  if (am && !(byCode.store_misc || []).some((l) => l.source === 'manual_value')) {
    byCode.store_misc = (byCode.store_misc || []).concat((am.expenses || []).map((x) => ({
      store_erpid: store, ledger_code: 'store_misc', amount: Number(x.amount) || 0, fee_ym: ym, source: 'aimin_expense',
      ref_id: String(x.id), ref_title: `愛民支出｜${x.date ? String(x.date).slice(0, 10) : ''} ${x.category || ''} ${x.note || ''}`.trim(),
    })));
  }

  // 企劃部開帳（開帳時選好門市的）→ 企劃品；有手填值就以手填為準
  if (plan.error) warnings.push(plan.error);
  const pl = (plan.byStore || {})[store] || [];
  if (pl.length && !(byCode.planning_goods || []).some((l) => l.source === 'manual_value')) {
    byCode.planning_goods = (byCode.planning_goods || []).concat(pl.map((l) => ({
      store_erpid: store, ledger_code: 'planning_goods', amount: Number(l.sell_amount) || 0, fee_ym: ym, source: 'planning_bill',
      ref_id: `pe-${l.expense_id}-${l.billing_id}`,
      ref_title: `${l.vendor || '企劃部'}｜${l.serial || ''} ${l.item || ''}（數量 ${l.qty ?? '—'}、成本 ${r0(l.cost_share)} × ${l.markup_rate}）${l.is_settled ? '' : '［企劃部還沒月結］'}`,
    })));
  }
  const planIssues = (plan.issues || []).filter((i) => i.store === store || (i.e && i.e.lines.some((l) => ((plan.byStore || {})[store] || []).some((x) => x.expense_id === l.expense_id))));

  const rowOf = (a) => {
    const ls = byCode[a.code] || [];
    const amount = ls.reduce((s, l) => s + Number(l.amount || 0), 0);
    const sources = [...new Set(ls.map((l) => l.source))];
    const vendors = {};
    for (const l of ls) {
      let [v] = splitTitle(l.ref_title);
      if (['opex', 'recurring', 'erp_cost', 'aimin_expense', 'billing_order'].includes(l.source)) v = '';
      if (l.source === 'planning_bill') v = '企劃部';
      vendors[v] = (vendors[v] || 0) + Number(l.amount || 0);
    }
    const crossMonth = ls.filter((l) => l.fee_ym && l.fee_ym !== ym).map((l) => l.fee_ym);
    return {
      code: a.code, name: a.name, group: a.group_code, ratio_group: a.ratio_group,
      amount: r0(amount), has_data: ls.length > 0, sources: sources.map((s) => SOURCE_NAME[s] || s),
      adjust_count: ls.filter((l) => l.source === 'manual_adjust').length,
      fee_months: [...new Set(crossMonth)].sort(),
      vendors: Object.entries(vendors).filter(([k]) => k).map(([k, v]) => ({ vendor: k, amount: r0(v) })),
      lines: opts.withLines ? ls.map((l) => ({ ...l, source_name: SOURCE_NAME[l.source] || l.source })) : undefined,
    };
  };

  const acc = Object.fromEntries(accs.map((a) => [a.code, a]));
  const val = (code) => (byCode[code] || []).reduce((s, l) => s + Number(l.amount || 0), 0);
  const filled = (code) => (byCode[code] || []).length > 0;

  // ── 業績／實收 ──
  const erp = m.sales || null;
  // 參考值：ERP 帳上（業績系統）＋愛民系統（IMING 訂單／收款）；愛民門市的眼鏡主要在 IMING
  const aSales = am ? Number(am.sales) || 0 : null;
  const aPaid = am ? Number(am.paid) || 0 : null;
  const plus = (a, b) => (a == null && b == null ? null : r0((a || 0) + (b || 0)));
  // 業績＝系統帶入（ERP＋愛民系統），有手填「改成」就用手填、有「調帳」就加上去；實收＝會計手填
  const sysOr = (code, sys) => {
    const ls = byCode[code] || [];
    if (ls.some((l) => l.source === 'manual_value')) return { amount: r0(val(code)), from: 'manual' };
    const adj = ls.filter((l) => l.source === 'manual_adjust').reduce((s, l) => s + Number(l.amount || 0), 0);
    if (sys == null) return { amount: ls.length ? r0(adj) : null, from: ls.length ? 'manual' : 'none' };
    return { amount: r0(sys + adj), from: adj ? 'system_adjusted' : 'system' };
  };
  const gSys = plus(erp ? erp.glasses : null, aSales);
  const cSys = erp ? r0(erp.contact) : null;
  const gS = sysOr('glasses_sales', gSys);
  const cS = sysOr('contact_sales', cSys);
  const revenue = {
    glasses_sales: { name: '眼鏡業績', kind: 'sales', amount: gS.amount, from: gS.from, erp: gSys,
      refs: [erp ? { label: 'ERP 帳上', amount: r0(erp.glasses) } : null, am ? { label: '愛民系統訂單', amount: r0(aSales) } : null].filter(Boolean) },
    contact_sales: { name: '藥拋業績', kind: 'sales', amount: cS.amount, from: cS.from, erp: cSys,
      refs: erp ? [{ label: 'ERP 帳上', amount: cSys }] : [] },
    glasses_receipt: { name: '眼鏡實收', kind: 'receipt', amount: filled('glasses_receipt') ? r0(val('glasses_receipt')) : null, from: 'manual', erp: plus(erp ? erp.glasses : null, aPaid),
      refs: [erp ? { label: 'ERP 帳上', amount: r0(erp.glasses) } : null, am ? { label: '愛民系統收款', amount: r0(aPaid) } : null].filter(Boolean) },
    contact_receipt: { name: '藥拋實收', kind: 'receipt', amount: filled('contact_receipt') ? r0(val('contact_receipt')) : null, from: 'manual', erp: cSys,
      refs: erp ? [{ label: 'ERP 帳上', amount: cSys }] : [] },
    api_pay: { name: 'API 支付', kind: 'other', amount: filled('api_pay') ? r0(val('api_pay')) : null, from: 'manual', erp: null, no_source: true },
    stored_value: { name: '儲值收款（不列業績）', kind: 'other', amount: filled('stored_value') ? r0(val('stored_value')) : null, from: 'manual', erp: null, no_source: true },
  };
  if (gS.amount == null) warnings.push('眼鏡業績系統拿不到（ERP／愛民系統都沒資料）');
  ['glasses_receipt', 'contact_receipt'].forEach((k) => { if (revenue[k].amount == null) warnings.push(`${revenue[k].name}還沒填（參考 ${revenue[k].erp == null ? '—' : revenue[k].erp.toLocaleString()}）`); });
  const glassesIn = revenue.glasses_receipt.amount || 0;
  const contactIn = revenue.contact_receipt.amount || 0;
  const apiIn = revenue.api_pay.amount || 0;
  const totalIn = glassesIn + contactIn + apiIn;   // 算獲利用（含 API 支付）

  // 總業績、總實收（眼鏡＋藥拋）與實收差：會計確認收到的錢 vs 帳上業績；差到 gap_alert_pct（預設 10%）要特別關注
  const salesTotal = gS.amount == null && cS.amount == null ? null : r0((gS.amount || 0) + (cS.amount || 0));
  const receiptFilled = revenue.glasses_receipt.amount != null && revenue.contact_receipt.amount != null;
  const receiptTotal = revenue.glasses_receipt.amount == null && revenue.contact_receipt.amount == null ? null : r0(glassesIn + contactIn);
  const gapOf = (label, sales, receipt) => {
    if (sales == null || receipt == null) return { label, sales, receipt, diff: null, pct: null, alert: false };
    const diff = r0(receipt - sales);
    const pct = sales ? Math.round((diff / sales) * 1000) / 10 : null;
    return { label, sales, receipt, diff, pct, alert: pct != null && Math.abs(pct) >= st.gap_alert_pct };
  };
  const gap = {
    alert_pct: st.gap_alert_pct,
    glasses: gapOf('眼鏡', gS.amount, revenue.glasses_receipt.amount),
    contact: gapOf('藥拋', cS.amount, revenue.contact_receipt.amount),
    total: gapOf('合計', salesTotal, receiptFilled ? receiptTotal : null),
  };
  ['glasses', 'contact', 'total'].forEach((k) => { const g = gap[k]; if (g.alert) warnings.push(`${g.label}實收差 ${g.pct > 0 ? '+' : ''}${g.pct}%（實收 ${g.receipt.toLocaleString()}／業績 ${g.sales.toLocaleString()}），超過 ${st.gap_alert_pct}%`); });

  // ── 支出 ──
  const section = (groups) => groups.map((g) => {
    const rows = accs.filter((a) => a.group_code === g && a.kind === 'expense' && !DIVIDEND_CODES.includes(a.code))
      .map(rowOf).filter((r) => r.has_data || acc[r.code].auto_source !== 'manual' || opts.allRows);
    return { group: g, name: GROUP_NAME[g], rows, total: rows.reduce((s, r) => s + r.amount, 0) };
  });
  const left = section(LEFT_GROUPS);
  const right = section(RIGHT_GROUPS);
  const leftTotal = left.reduce((s, g) => s + g.total, 0);
  const rightTotal = right.reduce((s, g) => s + g.total, 0);
  const totalOut = leftTotal + rightTotal;
  const contactOut = (right.find((g) => g.group === 'contact') || { total: 0 }).total;
  const glassesOut = totalOut - contactOut;
  const profit = totalIn - totalOut;

  // ── 分紅區塊 ──
  const fixedRows = (fixed.data || []);
  const fixedThis = (code) => fixedRows.filter((f) => f.ledger_code === code && f.from_ym <= ym && (!f.to_ym || f.to_ym >= ym)).reduce((s, f) => s + Number(f.amount), 0);
  const fixedCum = (code) => fixedRows.filter((f) => f.ledger_code === code && f.from_ym <= ym)
    .reduce((s, f) => s + Number(f.amount) * monthsBetween(f.from_ym, f.to_ym && f.to_ym < ym ? f.to_ym : ym), 0);
  const marketing = r0(val('marketing_fund'));
  const depr = r0(val('depreciation'));
  const report = rep.data || null;
  const retainedAuto = profit > 0 ? r0(profit * st.retained_rate) : 0;
  const retained = report && report.retained_amount != null ? r0(report.retained_amount) : retainedAuto;
  const distributable = profit - marketing - depr - retained;
  const hs = (holders.data || []).filter((h) => h.from_ym <= ym && (!h.to_ym || h.to_ym >= ym));
  const shares = hs.reduce((s, h) => s + h.shares, 0);
  if (shares > 100) warnings.push(`股東股數合計 ${shares}，超過 100`);
  const [y, mo] = ym.split('-').map(Number);

  return {
    ym, store, store_name: dept.data ? dept.data.store_name : null,
    status: report ? report.status : 'draft', report,
    revenue,
    totals: {
      glasses_in: glassesIn, contact_in: contactIn, api_in: apiIn, total_in: totalIn,
      sales_total: salesTotal, receipt_total: receiptTotal, receipt_filled: receiptFilled,
      left_total: leftTotal, right_total: rightTotal, total_out: totalOut,
      glasses_out: glassesOut, contact_out: contactOut,
      glasses_profit: glassesIn - glassesOut, contact_profit: contactIn + apiIn - contactOut, profit,
      // 成本率：藥拋 ÷ 藥拋實收（含 API 支付），其他 ÷ 總實收；淨利率＝盈餘 ÷ 總實收
      ratio: (() => {
        const sum = [...left, ...right].flatMap((g) => g.rows).reduce((o, r) => { if (r.ratio_group) o[r.ratio_group] = (o[r.ratio_group] || 0) + r.amount; return o; }, {});
        const pct = (v, base) => (base ? Math.round((v / base) * 1000) / 10 : null);
        const o = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, pct(v, k === '藥拋' ? contactIn + apiIn : totalIn)]));
        o['淨利'] = pct(profit, totalIn);
        return o;
      })(),
    },
    gap,
    ratio_target: RATIO_TARGET,
    left, right,
    dividend: {
      marketing_fund: marketing, marketing_fund_cum: r0(fixedCum('marketing_fund')),
      depreciation: depr, depreciation_cum: r0(fixedCum('depreciation')),
      retained, retained_auto: retainedAuto, retained_rate: st.retained_rate, retained_set: !!(report && report.retained_amount != null),
      distributable, total_shares: shares,
      cash_month: mo % 2 === 1, // 奇數月發現金（上月＋本月）
      cash_label: mo % 2 === 1 ? `現金分紅（${mo === 1 ? 12 : mo - 1}–${mo} 月）` : null,
      fixed_this: { marketing_fund: fixedThis('marketing_fund'), depreciation: fixedThis('depreciation') },
    },
    shareholders: hs.map((h) => ({ id: h.id, name: h.name, erpid: h.erpid, shares: h.shares, amount: r0(distributable * h.shares / 100) })),
    planning_issues: planIssues.map((i) => ({ kind: i.kind, expense_id: i.expense_id || (i.line && i.line.expense_id), item: (i.e && i.e.item) || (i.line && i.line.item), detail: i })),
    aimin: am ? { name: am.name, sales: r0(am.sales), orders: am.order_count, paid: r0(am.paid), paid_by_method: am.paid_by_method, closings: am.closings } : null,
    warnings, settings: st, market_end: mkt.end || null, year: y,
  };
}

/** 全部門市一覽（每店一列：實收、總支出、盈餘） */
async function overview(ym) {
  if (!YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  // 只出「門市」：departments.report_kind＝store（migration 020；NULL＝名稱「…店」當門市）
  const { data: units } = await supabase.from('departments').select('store_erpid, store_name, is_active, report_kind').eq('is_active', true).order('store_name');
  const isStore = (u) => u.report_kind === 'store' || (u.report_kind == null && /店$/.test(String(u.store_name || '')));
  const list = (units || []).filter((s) => s.store_erpid && isStore(s));
  const [mkt, aimin, planning] = await Promise.all([marketMonth(ym, list.map((s) => s.store_erpid)), aiminMonth(ym), planningMonth(ym)]);
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const s = list[i++];
      try {
        const r = await build(ym, s.store_erpid, { market: mkt, aimin, planning });
        out.push({ store: s.store_erpid, store_name: s.store_name, status: r.status, total_in: r.totals.total_in, total_out: r.totals.total_out, profit: r.totals.profit,
          sales_total: r.totals.sales_total, receipt_total: r.totals.receipt_filled ? r.totals.receipt_total : null, gap_pct: r.gap.total.pct, gap_alert: r.gap.total.alert,
          erp_total: r.revenue.glasses_receipt.erp == null ? null : r.revenue.glasses_receipt.erp + (r.revenue.contact_receipt.erp || 0),
          filled: r.revenue.glasses_receipt.amount != null && r.revenue.contact_receipt.amount != null, warnings: r.warnings.length });
      } catch (e) { out.push({ store: s.store_erpid, store_name: s.store_name, error: e.message }); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((a, b) => String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant'));

  // 不是門市、但這個月帳本上有費用的單位（董事長室、營運部、加工部…）：另列，免得錢「不見」
  const storeSet = new Set(list.map((s) => String(s.store_erpid)));
  const { data: lines } = await supabase.rpc('ledger_lines', { p_ym: ym });
  const other = {};
  for (const l of lines || []) {
    const id = String(l.store_erpid || '');
    if (!id || storeSet.has(id)) continue;
    const o = (other[id] = other[id] || { store: id, total: 0, lines: 0, codes: {} });
    o.total += Number(l.amount || 0); o.lines += 1; o.codes[l.ledger_code] = (o.codes[l.ledger_code] || 0) + Number(l.amount || 0);
  }
  const ids = Object.keys(other);
  if (ids.length) {
    const nameOf = Object.fromEntries((units || []).map((u) => [String(u.store_erpid), u.store_name]));
    // 名稱就是代碼的佔位單位（000000、00099…）→ 用營運部系統基本資料登記的單位名稱
    const { data: facts } = await supabase.from('entity_facts').select('store_erpid, store_name').in('store_erpid', ids);
    const factName = Object.fromEntries((facts || []).filter((f) => f.store_name).map((f) => [String(f.store_erpid), f.store_name]));
    for (const id of ids) {
      const n = nameOf[id];
      other[id].name = n && n !== id ? n : (factName[id] || n || id);
      other[id].total = r0(other[id].total);
      other[id].codes = Object.fromEntries(Object.entries(other[id].codes).map(([k, v]) => [k, r0(v)]));
    }
  }
  return { ym, stores: out, others: Object.values(other).sort((a, b) => b.total - a.total), market_error: mkt.error || null, aimin_error: aimin.error || null };
}

module.exports = { planningMonth, aiminMonth, build, overview, accounts, settings, marketMonth, YM, GROUP_NAME, SOURCE_NAME };
