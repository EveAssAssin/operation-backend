// services/taiwanHolidayService.js
// 台灣國定假日服務：從社群維護的 CDN 取得假日資料並快取到 DB
// 資料來源：https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/{year}.json
// 格式：[{ date:"2024-01-01", isHoliday:true, description:"..." }]

const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data';

// ── 快取（記憶體層，避免重複查 DB）────────────────────────
const _cache = new Map(); // year → Set<'YYYY-MM-DD'>

// ── 抓取並快取指定年份假日 ────────────────────────────────
async function fetchAndCacheYear(year) {
  try {
    const url = `${CDN_BASE}/${year}.json`;
    const { data } = await axios.get(url, { timeout: 10000 });

    const holidays = data
      .filter(r => r.isHoliday === true)
      .map(r => ({ date: r.date, name: r.description || '假日', year }));

    if (holidays.length > 0) {
      await supabase
        .from('taiwan_holidays')
        .upsert(holidays, { onConflict: 'date' });
    }

    const set = new Set(holidays.map(h => h.date));
    _cache.set(year, set);
    console.log(`[假日] ${year} 年：快取 ${holidays.length} 筆`);
    return set;
  } catch (err) {
    console.warn(`[假日] 無法取得 ${year} 年資料：${err.message}，改用週末判斷`);
    return null;
  }
}

// ── 取得指定年份假日 Set（先查記憶體 → DB → API）─────────
async function getHolidaysForYear(year) {
  if (_cache.has(year)) return _cache.get(year);

  // 從 DB 讀取
  const { data } = await supabase
    .from('taiwan_holidays')
    .select('date')
    .eq('year', year);

  if (data && data.length > 0) {
    const set = new Set(data.map(r => r.date));
    _cache.set(year, set);
    return set;
  }

  // DB 沒有，從 CDN 拉
  return await fetchAndCacheYear(year);
}

// ── 判斷某日是否為假日（週六/日 或 國定假日）────────────
async function isHoliday(date) {
  const d   = new Date(date);
  const dow = d.getDay(); // 0=週日, 6=週六
  if (dow === 0 || dow === 6) return true;

  const year    = d.getFullYear();
  const dateStr = d.toISOString().slice(0, 10);
  const set     = await getHolidaysForYear(year);
  return set ? set.has(dateStr) : false;
}

// ── 計算前一個工作天 ──────────────────────────────────────
// due_date 的前一個工作天（前一天、跳過週末與假日）
async function prevWorkingDay(dueDateStr) {
  const d = new Date(dueDateStr);
  d.setDate(d.getDate() - 1);

  let maxIter = 30;
  while (maxIter-- > 0) {
    if (!(await isHoliday(d))) break;
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// ── 計算下一個工作天（假日時往後推）─────────────────────
async function nextWorkingDay(dateStr) {
  const d = new Date(dateStr);
  let maxIter = 30;
  while (maxIter-- > 0) {
    if (!(await isHoliday(d))) break;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// ── 今日需要顯示的出款日期範圍 ───────────────────────────
// 今天是工作天：回傳 [today]
// 今天是假日：回傳從「最近一次未通知工作天的前一天」到「今天前一工作天」
// 簡化版：取今天 + 連續假日往前所有有 due_date = 那些前一工作天的日期
async function getDisplayDatesForToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  // 往前找所有連續假日（包含今天如果也是假日）
  // 今天的出款清單 = 所有 due_date，其前一工作天 = 今天
  // 所以反過來問：哪些 due_date 的 prevWorkingDay = today？
  // 就是 due_date = nextWorkingDay(today) 以及 due_date = tomorrow（若明天是假日前一工作天還是今天）
  // 簡化：直接回傳 today，讓 query 在應用層算每張票的 prevWorkingDay
  return todayStr;
}

// ── 初始化：確保本年 + 明年假日都有快取 ─────────────────
async function init() {
  const year = new Date().getFullYear();
  await getHolidaysForYear(year);
  await getHolidaysForYear(year + 1);
  console.log(`[假日] 初始化完成：${year} & ${year + 1}`);
}

module.exports = {
  init,
  isHoliday,
  prevWorkingDay,
  nextWorkingDay,
  fetchAndCacheYear,
  getDisplayDatesForToday,
};
