// services/recurringExpenseService.js
// 常態費用模組業務邏輯
//   - CRUD（expenses）
//   - 計算當月應付日期（含假日順延規則）
//   - 補產生缺漏的 payment 紀錄
//   - 取今日應付清單（給排程推播用）

const supabase = require('../config/supabase');
const { prevWorkingDay } = require('./taiwanHolidayService');

// ── 工具 ────────────────────────────────────────────────────

/** 把 Date 物件轉成 YYYY-MM-DD（依 Asia/Taipei） */
function toDateStr(d) {
  return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

/** 取台北時區的「今天」字串 YYYY-MM-DD */
function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

/** 從 YYYY-MM-DD 取 YYYY-MM */
function ymOf(dateStr) {
  return dateStr.slice(0, 7);
}

/** 把 YYYY-MM 跟 day 組合成「該月實際存在的日期」(若 day 大於該月最大天，回傳該月最後一天) */
function clampDayToMonth(yearMonth, day) {
  const [y, m] = yearMonth.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // m 是 1-based，這裡用 0 day 取上個月最後 = 該月最後天
  const useDay  = Math.min(day, lastDay);
  const dd      = String(useDay).padStart(2, '0');
  return `${yearMonth}-${dd}`;
}

/**
 * 計算某筆 expense 在某個 year_month 應付的實際日期（含假日順延）
 * @returns {{ original: 'YYYY-MM-DD', adjusted: 'YYYY-MM-DD' }}
 */
async function computeDueDates(expense, yearMonth) {
  const original = clampDayToMonth(yearMonth, expense.cycle_day);

  let adjusted;
  if (expense.holiday_rule === 'previous_workday') {
    // 用既有 taiwanHolidayService 的工具
    const { isHoliday } = require('./taiwanHolidayService');
    if (await isHoliday(original)) {
      adjusted = await prevWorkingDay(original);
    } else {
      adjusted = original;
    }
  } else {
    adjusted = original;
  }
  return { original, adjusted };
}


// ── Expense CRUD ────────────────────────────────────────────

async function listExpenses({ active = null } = {}) {
  let q = supabase.from('recurring_expenses').select('*').order('created_at', { ascending: false });
  if (active === true)  q = q.eq('is_active', true);
  if (active === false) q = q.eq('is_active', false);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getExpense(id) {
  const { data, error } = await supabase
    .from('recurring_expenses')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function createExpense(input, createdBy) {
  const row = {
    name:             input.name?.trim(),
    description:      input.description?.trim() || null,
    amount:           Number(input.amount),
    cycle_type:       input.cycle_type || 'monthly_fixed_day',
    cycle_day:        Number(input.cycle_day),
    holiday_rule:     input.holiday_rule || 'previous_workday',
    bill_target_type: input.bill_target_type,
    bill_target_id:   String(input.bill_target_id),
    bill_target_name: input.bill_target_name,
    start_year_month: input.start_year_month || null,
    end_year_month:   input.end_year_month   || null,
    is_active:        input.is_active !== false,
    note:             input.note?.trim() || null,
    created_by:       createdBy || null,
  };

  if (!row.name)             throw new Error('name 必填');
  if (!Number.isFinite(row.amount)) throw new Error('amount 必須是數字');
  if (!row.cycle_day)        throw new Error('cycle_day 必填');
  if (!row.bill_target_type) throw new Error('bill_target_type 必填');
  if (!row.bill_target_id)   throw new Error('bill_target_id 必填');
  if (!row.bill_target_name) throw new Error('bill_target_name 必填');

  const { data, error } = await supabase
    .from('recurring_expenses')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateExpense(id, patch) {
  const allowed = [
    'name','description','amount','cycle_type','cycle_day','holiday_rule',
    'bill_target_type','bill_target_id','bill_target_name',
    'start_year_month','end_year_month','is_active','note',
  ];
  const update = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) update[k] = patch[k];
  }
  if (Object.keys(update).length === 0) {
    return getExpense(id);
  }
  const { data, error } = await supabase
    .from('recurring_expenses')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteExpense(id) {
  // 軟刪除：is_active=false（保留歷史 payment 不被 cascade 砍掉）
  const { error } = await supabase
    .from('recurring_expenses')
    .update({ is_active: false })
    .eq('id', id);
  if (error) throw error;
}


// ── 確保某個月的 payment row 存在 ──────────────────────────

/**
 * 對單一 expense 確保其 yearMonth 那期 payment 存在（不存在就建立）
 * 如果 yearMonth 不在 expense 的 [start, end] 期間內，跳過
 * @returns 該 payment row（存在或新建的）
 */
async function ensurePaymentForMonth(expense, yearMonth) {
  if (!expense.is_active) return null;
  if (expense.start_year_month && yearMonth < expense.start_year_month) return null;
  if (expense.end_year_month   && yearMonth > expense.end_year_month)   return null;

  // 已存在？
  const { data: existing, error: e1 } = await supabase
    .from('recurring_expense_payments')
    .select('*')
    .eq('expense_id', expense.id)
    .eq('year_month', yearMonth)
    .maybeSingle();
  if (e1) throw e1;
  if (existing) return existing;

  // 計算日期
  const { original, adjusted } = await computeDueDates(expense, yearMonth);

  const row = {
    expense_id:        expense.id,
    year_month:        yearMonth,
    original_due_date: original,
    due_date:          adjusted,
    amount:            expense.amount,
    bill_target_type:  expense.bill_target_type,
    bill_target_id:    expense.bill_target_id,
    bill_target_name:  expense.bill_target_name,
    status:            'pending',
  };

  const { data, error } = await supabase
    .from('recurring_expense_payments')
    .insert(row)
    .select()
    .single();
  if (error) {
    // 競爭情況下可能 unique 撞了，重新查一次
    if (error.code === '23505') {
      const { data: r2 } = await supabase
        .from('recurring_expense_payments')
        .select('*')
        .eq('expense_id', expense.id)
        .eq('year_month', yearMonth)
        .single();
      return r2;
    }
    throw error;
  }
  return data;
}

/** 確保所有 active expense 都已有「本月」payment row。回傳建立的數量。 */
async function ensureCurrentMonthPayments() {
  const yearMonth = todayStr().slice(0, 7);
  const actives = await listExpenses({ active: true });
  let created = 0;
  for (const exp of actives) {
    const before = await supabase
      .from('recurring_expense_payments')
      .select('id', { count: 'exact', head: true })
      .eq('expense_id', exp.id)
      .eq('year_month', yearMonth);
    const exists = (before.count || 0) > 0;
    await ensurePaymentForMonth(exp, yearMonth);
    if (!exists) created++;
  }
  return { yearMonth, total_active: actives.length, created };
}


// ── 查詢 payment ───────────────────────────────────────────

/** 列出某月 payments（含 expense 名稱） */
async function listPaymentsByMonth(yearMonth) {
  const { data, error } = await supabase
    .from('recurring_expense_payments')
    .select(`
      *,
      recurring_expenses (
        id, name, description, cycle_day, holiday_rule
      )
    `)
    .eq('year_month', yearMonth)
    .order('due_date', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** 取今天應付且未付的 payments（用於排程推播） */
async function getTodayDuePayments() {
  const today = todayStr();
  const { data, error } = await supabase
    .from('recurring_expense_payments')
    .select(`
      *,
      recurring_expenses (
        id, name
      )
    `)
    .eq('due_date', today)
    .eq('status', 'pending')
    .order('bill_target_name', { ascending: true });
  if (error) throw error;
  return { date: today, payments: data || [] };
}

/** 標記為已付 */
async function markPaid(paymentId, paidBy, paidNote) {
  const { data, error } = await supabase
    .from('recurring_expense_payments')
    .update({
      status:    'paid',
      paid_at:   new Date().toISOString(),
      paid_by:   paidBy || null,
      paid_note: paidNote || null,
    })
    .eq('id', paymentId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** 取消已付（改回 pending） */
async function unmarkPaid(paymentId) {
  const { data, error } = await supabase
    .from('recurring_expense_payments')
    .update({
      status: 'pending',
      paid_at: null,
      paid_by: null,
      paid_note: null,
    })
    .eq('id', paymentId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** 標記已通知 */
async function markNotified(paymentIds) {
  if (!paymentIds || paymentIds.length === 0) return;
  const { error } = await supabase
    .from('recurring_expense_payments')
    .update({ notified_at: new Date().toISOString() })
    .in('id', paymentIds);
  if (error) throw error;
}


// ── 開帳對象選項 ───────────────────────────────────────────

/** 取得門市清單（用於下拉選單） */
async function listStores() {
  const { data, error } = await supabase
    .from('employees')
    .select('store_erpid, store_name')
    .not('store_erpid', 'is', null)
    .not('store_name',  'is', null)
    .eq('is_active', true);
  if (error) throw error;
  // 去重
  const map = new Map();
  (data || []).forEach(r => {
    if (r.store_erpid && r.store_name && !map.has(r.store_erpid)) {
      map.set(r.store_erpid, { id: r.store_erpid, name: r.store_name });
    }
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
}

/** 取得部門清單 */
async function listDepartments() {
  const { data, error } = await supabase
    .from('departments')
    .select('id, name')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []).map(d => ({ id: String(d.id), name: d.name }));
}


module.exports = {
  // CRUD
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  // Payment 補建 / 查詢 / 狀態
  ensurePaymentForMonth, ensureCurrentMonthPayments,
  listPaymentsByMonth, getTodayDuePayments,
  markPaid, unmarkPaid, markNotified,
  // 對象清單
  listStores, listDepartments,
  // 工具（給 cron / route 共用）
  todayStr, ymOf, computeDueDates,
};
