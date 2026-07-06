// services/opexReportService.js
// 營運報表：以「門市 (store_erpid) 聚合」為主的統計
//   - 期間內每月合計 + 依品項/門市拆分
//   - 同期比較（YoY，用篩選期間結束月對比去年同月）
//   - KPI 統計
//   - 匯出用的明細清單

const supabase = require('../config/supabase');

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthDiff(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function rangeMonths(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { y++; m = 1; }
  }
  return out;
}

/**
 * 主查詢：撈範圍內所有分帳 + join 需要的欄位
 * store_scope: 'all' | 'store_only' | 'misc_only'
 */
async function fetchAllocations({ from, to, categoryId, storeErpid, storeScope = 'all' }) {
  let q = supabase
    .from('operational_expense_allocations')
    .select(`
      store_erpid, year_month, amount,
      opex:operational_expense_id (
        category_id,
        category:entity_fact_categories!category_id ( id, name, icon ),
        fact:entity_facts!fact_id ( id, store_name )
      )
    `)
    .gte('year_month', from)
    .lte('year_month', to);
  if (storeErpid) q = q.eq('store_erpid', storeErpid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (categoryId) rows = rows.filter(r => r.opex?.category_id === Number(categoryId));
  if (storeScope === 'store_only') rows = rows.filter(r => r.store_erpid && !r.store_erpid.startsWith('MISC-'));
  if (storeScope === 'misc_only')  rows = rows.filter(r => r.store_erpid && r.store_erpid.startsWith('MISC-'));
  return rows;
}

/** 撈 departments 建 store_erpid → store_name 對照表 */
async function buildStoreNameMap() {
  const { data } = await supabase.from('departments').select('store_erpid, store_name');
  const m = {};
  for (const d of (data || [])) if (d.store_erpid) m[d.store_erpid] = d.store_name;
  return m;
}

async function getReport({ from, to, categoryId, storeErpid, storeScope = 'all' }) {
  if (!from || !to) throw new Error('from / to 必填 (YYYY-MM)');
  if (monthDiff(from, to) < 0) throw new Error('from 必須 <= to');

  const rows = await fetchAllocations({ from, to, categoryId, storeErpid, storeScope });
  const nameMap = await buildStoreNameMap();
  const months = rangeMonths(from, to);

  // 分品項聚合每月
  const byMonth = {};    // ym → { total, byCategory: { catName: amt } }
  const byMonthByStore = {}; // ym → storeErpid → { store_name, total, byCategory: {} }
  const catNameSet = new Set();
  const storeSet   = new Set();

  for (const ym of months) {
    byMonth[ym] = { year_month: ym, total: 0, byCategory: {} };
    byMonthByStore[ym] = {};
  }

  for (const r of rows) {
    const ym = r.year_month;
    if (!byMonth[ym]) continue;
    const amt = Number(r.amount || 0);
    const catName = r.opex?.category?.name || '—';
    catNameSet.add(catName);
    byMonth[ym].total += amt;
    byMonth[ym].byCategory[catName] = (byMonth[ym].byCategory[catName] || 0) + amt;

    const erpid = r.store_erpid || '未知';
    storeSet.add(erpid);
    if (!byMonthByStore[ym][erpid]) {
      byMonthByStore[ym][erpid] = {
        store_erpid: erpid,
        store_name:  nameMap[erpid] || (erpid.startsWith('MISC-') ? erpid.replace('MISC-', '') : erpid),
        total: 0, byCategory: {},
      };
    }
    byMonthByStore[ym][erpid].total += amt;
    byMonthByStore[ym][erpid].byCategory[catName] = (byMonthByStore[ym][erpid].byCategory[catName] || 0) + amt;
  }

  // ── KPI ─────────────────────────────
  const total = Object.values(byMonth).reduce((s, m) => s + m.total, 0);
  const nonZeroMonths = months.filter(m => byMonth[m].total > 0).length;
  const avgMonthly = nonZeroMonths > 0 ? total / nonZeroMonths : 0;

  // YoY：對比 to 月與去年同月
  const yoyBaseMonth = to;
  const [yy, mm] = to.split('-').map(Number);
  const yoyPrevMonth = `${yy - 1}-${String(mm).padStart(2, '0')}`;
  const thisMonthTotal = byMonth[yoyBaseMonth]?.total || 0;
  let lastYearTotal = 0;
  {
    const q = await supabase
      .from('operational_expense_allocations')
      .select('amount, opex:operational_expense_id(category_id)')
      .eq('year_month', yoyPrevMonth);
    if (!q.error) {
      let lyRows = q.data || [];
      if (categoryId) lyRows = lyRows.filter(r => r.opex?.category_id === Number(categoryId));
      lastYearTotal = lyRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    }
  }
  const yoyDiff = thisMonthTotal - lastYearTotal;
  const yoyRatio = lastYearTotal > 0 ? yoyDiff / lastYearTotal : null;

  // ── 主圖資料（依品項）──────────────
  // 每月一列： { year_month, cat1: X, cat2: Y, ... }
  const categoryNames = Array.from(catNameSet).sort();
  const chartByCategory = months.map(ym => {
    const row = { year_month: ym, total: byMonth[ym].total };
    for (const c of categoryNames) row[c] = byMonth[ym].byCategory[c] || 0;
    return row;
  });

  // ── 主圖資料（依門市，取 top 10）─
  const storeTotals = {};
  for (const erpid of storeSet) {
    storeTotals[erpid] = 0;
    for (const ym of months) {
      storeTotals[erpid] += (byMonthByStore[ym][erpid]?.total || 0);
    }
  }
  const topStores = Object.entries(storeTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([erpid]) => erpid);
  const chartByStore = months.map(ym => {
    const row = { year_month: ym };
    for (const erpid of topStores) {
      row[nameMap[erpid] || erpid] = byMonthByStore[ym][erpid]?.total || 0;
    }
    return row;
  });

  // ── 明細（給 Excel 匯出）───────────
  const detail = [];
  for (const r of rows) {
    detail.push({
      year_month:  r.year_month,
      store_erpid: r.store_erpid,
      store_name:  nameMap[r.store_erpid] || (r.store_erpid?.startsWith('MISC-') ? r.store_erpid.replace('MISC-', '') : r.store_erpid),
      category:    r.opex?.category?.name || '—',
      fact_name:   r.opex?.fact?.store_name || '',
      amount:      Number(r.amount || 0),
    });
  }
  detail.sort((a, b) => a.year_month.localeCompare(b.year_month) || (a.store_name || '').localeCompare(b.store_name || '') || (a.category || '').localeCompare(b.category || ''));

  // 月度彙總（給 Excel 第二個 sheet）
  const summary = months.map(ym => {
    const row = { year_month: ym, total: byMonth[ym].total };
    for (const c of categoryNames) row[c] = byMonth[ym].byCategory[c] || 0;
    return row;
  });

  return {
    from, to,
    kpi: {
      total, avg_monthly: avgMonthly, non_zero_months: nonZeroMonths,
      this_month_total: thisMonthTotal, last_year_total: lastYearTotal,
      yoy_diff: yoyDiff, yoy_ratio: yoyRatio, yoy_base_month: yoyBaseMonth, yoy_prev_month: yoyPrevMonth,
    },
    category_names: categoryNames,
    top_stores: topStores.map(erpid => ({ store_erpid: erpid, store_name: nameMap[erpid] || erpid, total: storeTotals[erpid] })),
    chart_by_category: chartByCategory,
    chart_by_store:    chartByStore,
    detail,
    summary,
  };
}

module.exports = { getReport };
