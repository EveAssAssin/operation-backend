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
  manual_value: '手填', manual_adjust: '調帳', erp_cost: 'ERP 費用單',
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

const splitTitle = (t) => { const s = String(t || ''); const i = s.indexOf('｜'); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const r0 = (n) => Math.round(Number(n) || 0);
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1) + 1; };

async function settings() {
  const { data } = await supabase.from('report_settings').select('key, value');
  const o = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { cutoff_day: Number(o.cutoff_day) || 26, retained_rate: o.retained_rate == null ? 0.1 : Number(o.retained_rate) };
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
  const [accs, st, linesR, mkt, rep, fixed, holders, dept] = await Promise.all([
    accounts(),
    settings(),
    supabase.rpc('ledger_lines', { p_ym: ym }).eq('store_erpid', store),
    opts.market || marketMonth(ym, [store]),
    supabase.from('store_month_reports').select('*').eq('store_erpid', store).eq('ym', ym).maybeSingle(),
    supabase.from('store_fixed_items').select('*').eq('store_erpid', store),
    supabase.from('store_shareholders').select('*').eq('store_erpid', store),
    supabase.from('departments').select('store_erpid, store_name').eq('store_erpid', store).maybeSingle(),
  ]);
  if (linesR.error) throw linesR.error;
  const lines = linesR.data || [];
  const byCode = {};
  for (const l of lines) (byCode[l.ledger_code] = byCode[l.ledger_code] || []).push(l);
  const warnings = [];
  if (mkt.error) warnings.push(mkt.error);
  (mkt.errors || []).forEach((e) => warnings.push(e));
  const m = (mkt.stores || {})[store] || {};

  // ERP 門市費用單 → 分店支出雜項（有手填值就以手填為準）
  if (!(byCode.store_misc || []).some((l) => l.source === 'manual_value') && m.costs) {
    byCode.store_misc = (byCode.store_misc || []).concat(m.costs.items.map((x) => ({
      store_erpid: store, ledger_code: 'store_misc', amount: x.amount, fee_ym: ym, source: 'erp_cost',
      ref_id: String(x.pay_id), ref_title: `ERP 費用單｜${x.date ? String(x.date).slice(0, 10) : ''} ${x.remark || ''}`.trim(),
    })));
  } else if (!m.costs) warnings.push('分店支出雜項：這次拿不到 ERP 門市費用單');

  const rowOf = (a) => {
    const ls = byCode[a.code] || [];
    const amount = ls.reduce((s, l) => s + Number(l.amount || 0), 0);
    const sources = [...new Set(ls.map((l) => l.source))];
    const vendors = {};
    for (const l of ls) {
      let [v] = splitTitle(l.ref_title);
      if (l.source === 'opex' || l.source === 'recurring' || l.source === 'erp_cost' || l.source === 'billing_order') v = '';
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
  const revenue = {
    glasses_sales: { name: '眼鏡業績', amount: filled('glasses_sales') ? r0(val('glasses_sales')) : null, erp: erp ? r0(erp.glasses) : null },
    glasses_receipt: { name: '眼鏡實收', amount: filled('glasses_receipt') ? r0(val('glasses_receipt')) : null, erp: erp ? r0(erp.glasses) : null },
    contact_receipt: { name: '藥拋實收', amount: filled('contact_receipt') ? r0(val('contact_receipt')) : null, erp: erp ? r0(erp.contact) : null },
    api_pay: { name: 'API 支付', amount: filled('api_pay') ? r0(val('api_pay')) : null, erp: null },
    stored_value: { name: '儲值收款（不列業績）', amount: filled('stored_value') ? r0(val('stored_value')) : null, erp: null },
  };
  ['glasses_receipt', 'contact_receipt'].forEach((k) => { if (revenue[k].amount == null) warnings.push(`${revenue[k].name}還沒填（ERP 帳上 ${revenue[k].erp == null ? '—' : revenue[k].erp.toLocaleString()}）`); });
  const glassesIn = revenue.glasses_receipt.amount || 0;
  const contactIn = revenue.contact_receipt.amount || 0;
  const apiIn = revenue.api_pay.amount || 0;
  const totalIn = glassesIn + contactIn + apiIn;

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
    warnings, settings: st, market_end: mkt.end || null, year: y,
  };
}

/** 全部門市一覽（每店一列：實收、總支出、盈餘） */
async function overview(ym) {
  if (!YM.test(ym)) throw new Error('ym 要是 YYYY-MM');
  const { data: stores } = await supabase.from('departments').select('store_erpid, store_name, is_active').eq('is_active', true).order('store_name');
  const list = (stores || []).filter((s) => s.store_erpid);
  const mkt = await marketMonth(ym, list.map((s) => s.store_erpid));
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const s = list[i++];
      try {
        const r = await build(ym, s.store_erpid, { market: mkt });
        out.push({ store: s.store_erpid, store_name: s.store_name, status: r.status, total_in: r.totals.total_in, total_out: r.totals.total_out, profit: r.totals.profit,
          erp_total: r.revenue.glasses_receipt.erp == null ? null : r.revenue.glasses_receipt.erp + (r.revenue.contact_receipt.erp || 0),
          filled: r.revenue.glasses_receipt.amount != null && r.revenue.contact_receipt.amount != null, warnings: r.warnings.length });
      } catch (e) { out.push({ store: s.store_erpid, store_name: s.store_name, error: e.message }); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((a, b) => String(a.store_name).localeCompare(String(b.store_name), 'zh-Hant'));
  return { ym, stores: out, market_error: mkt.error || null };
}

module.exports = { build, overview, accounts, settings, marketMonth, YM, GROUP_NAME, SOURCE_NAME };
