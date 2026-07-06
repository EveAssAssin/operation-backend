// services/opexAnomalyService.js
// 營運費用異常偵測
//   - 針對每個 fact_id，比對「當月合計」vs「近 N 個月平均」
//   - 超過閾值就標為異常
//   - 提供 detectAnomalies(yearMonth) 給 route / cron 用

const supabase = require('../config/supabase');

// 預設閾值（可從 company_profile 或 env 覆蓋）
const DEFAULT_WARN_RATIO   = 0.20;  // 提醒：超過平均 +20%
const DEFAULT_SEVERE_RATIO = 0.50;  // 嚴重：超過平均 +50%
const HISTORY_MONTHS       = 6;      // 用近 6 個月當基線

/**
 * 給 YYYY-MM 取上個月字串
 */
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nMonthsBefore(ym, n) {
  let r = ym;
  for (let i = 0; i < n; i++) r = prevMonth(r);
  return r;
}

/**
 * 讀取閾值設定（company_profile.opex_warn_ratio / opex_severe_ratio）
 * 沒設或讀取失敗就用預設
 */
async function loadThresholds() {
  try {
    const { data } = await supabase
      .from('company_profile')
      .select('opex_warn_ratio, opex_severe_ratio')
      .eq('id', 1)
      .maybeSingle();
    return {
      warn:   Number(data?.opex_warn_ratio  ?? DEFAULT_WARN_RATIO),
      severe: Number(data?.opex_severe_ratio ?? DEFAULT_SEVERE_RATIO),
    };
  } catch {
    return { warn: DEFAULT_WARN_RATIO, severe: DEFAULT_SEVERE_RATIO };
  }
}

/**
 * 對指定月份偵測異常
 * @param {string} yearMonth - 'YYYY-MM'
 * @returns {{month, thresholds, anomalies: Array}}
 */
async function detectAnomalies(yearMonth) {
  const thresholds = await loadThresholds();
  const historyStart = nMonthsBefore(yearMonth, HISTORY_MONTHS);

  // 1) 撈近 (HISTORY_MONTHS + 1) 個月的分帳，join fact + category
  const { data: allocs, error } = await supabase
    .from('operational_expense_allocations')
    .select(`
      year_month, amount,
      opex:operational_expense_id (
        fact_id, category_id,
        category:entity_fact_categories!category_id ( id, name, icon ),
        fact:entity_facts!fact_id ( id, store_name, store_erpid, data )
      )
    `)
    .gte('year_month', historyStart)
    .lte('year_month', yearMonth);
  if (error) throw new Error(error.message);

  // 2) 按 fact_id 分組彙總每月金額
  //    map: fact_id → { fact, category, byMonth: { 'YYYY-MM': sum } }
  const byFact = new Map();
  for (const a of (allocs || [])) {
    const opex = a.opex;
    if (!opex || !opex.fact_id) continue;
    const fid = opex.fact_id;
    if (!byFact.has(fid)) {
      byFact.set(fid, {
        fact_id:   fid,
        fact:      opex.fact,
        category:  opex.category,
        byMonth:   {},
      });
    }
    const entry = byFact.get(fid);
    const ym = a.year_month;
    entry.byMonth[ym] = (entry.byMonth[ym] || 0) + Number(a.amount || 0);
  }

  // 3) 對每個 fact 算平均 + 判斷是否異常
  const anomalies = [];
  for (const item of byFact.values()) {
    const currentAmt = item.byMonth[yearMonth] || 0;
    if (currentAmt === 0) continue; // 本月沒資料就跳過

    // 收集歷史（不含當月）
    const history = [];
    let ym = prevMonth(yearMonth);
    for (let i = 0; i < HISTORY_MONTHS; i++) {
      if (item.byMonth[ym] !== undefined) history.push(item.byMonth[ym]);
      ym = prevMonth(ym);
    }
    if (history.length < 2) continue; // 歷史太少不算（避免偽陽性）

    const avg = history.reduce((s, v) => s + v, 0) / history.length;
    if (avg <= 0) continue;
    const diffRatio = (currentAmt - avg) / avg;

    let severity = null;
    if (diffRatio >= thresholds.severe) severity = 'severe';
    else if (diffRatio >= thresholds.warn) severity = 'warn';
    if (!severity) continue;

    anomalies.push({
      fact_id:       item.fact_id,
      category_name: item.category?.name || '—',
      category_icon: item.category?.icon || '',
      store_name:    item.fact?.store_name || '',
      fact_data:     item.fact?.data || {},
      current:       Math.round(currentAmt),
      avg:           Math.round(avg),
      diff:          Math.round(currentAmt - avg),
      diff_ratio:    Number(diffRatio.toFixed(3)),
      severity,
      history_months: history.length,
    });
  }

  // 4) 依嚴重程度排序：severe 在前、然後 diff_ratio 大到小
  anomalies.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'severe' ? -1 : 1;
    return b.diff_ratio - a.diff_ratio;
  });

  return { month: yearMonth, thresholds, anomalies };
}

/**
 * 對一個 fact 撈近 N 個月的歷史序列（給趨勢圖用）
 */
async function getFactHistory(factId, months = 12) {
  const now = new Date();
  const startMonth = nMonthsBefore(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    months
  );

  const { data, error } = await supabase
    .from('operational_expense_allocations')
    .select(`
      year_month, amount,
      opex:operational_expense_id ( fact_id )
    `)
    .gte('year_month', startMonth);
  if (error) throw new Error(error.message);

  const byMonth = {};
  for (const a of (data || [])) {
    if (a.opex?.fact_id !== Number(factId)) continue;
    byMonth[a.year_month] = (byMonth[a.year_month] || 0) + Number(a.amount || 0);
  }
  return Object.entries(byMonth).map(([ym, amt]) => ({ year_month: ym, amount: Math.round(amt) }))
    .sort((a, b) => a.year_month.localeCompare(b.year_month));
}

module.exports = { detectAnomalies, getFactHistory, loadThresholds };
