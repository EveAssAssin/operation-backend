// services/recurringExpenseService.js
// 常態費用模組業務邏輯
//   - CRUD（expenses）
//   - 計算當月應付日期（含假日順延規則）
//   - 補產生缺漏的 payment 紀錄
//   - 取今日應付清單（給排程推播用）

const supabase = require('../config/supabase');
const XLSX     = require('xlsx');
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
  const needsBilling = !!input.needs_billing;
  const cycleDayNum  = parseCycleDay(input.cycle_day, input.cycle_day_text);

  const row = {
    name:             input.name?.trim(),
    description:      input.description?.trim() || null,
    amount:           Number(input.amount),
    cycle_type:       input.cycle_type || 'monthly_fixed_day',
    cycle_day:        cycleDayNum,
    cycle_day_text:   (input.cycle_day_text || '').trim() || null,
    holiday_rule:     input.holiday_rule || 'previous_workday',

    payment_method:   (input.payment_method || '').trim() || null,
    payee_name:       (input.payee_name     || '').trim() || null,
    needs_billing:    needsBilling,
    period_text:      (input.period_text    || '').trim() || null,
    bank_code:        (input.bank_code      || '').trim() || null,
    bank_branch:      (input.bank_branch    || '').trim() || null,
    bank_account:     (input.bank_account   || '').trim() || null,

    bill_target_type: needsBilling ? input.bill_target_type : null,
    bill_target_id:   needsBilling ? String(input.bill_target_id || '') : null,
    bill_target_name: needsBilling ? input.bill_target_name : null,
    start_year_month: input.start_year_month || null,
    end_year_month:   input.end_year_month   || null,
    is_active:        input.is_active !== false,
    note:             input.note?.trim() || null,
    created_by:       createdBy || null,
  };

  if (!row.name)             throw new Error('name 必填');
  if (!Number.isFinite(row.amount)) throw new Error('amount 必須是數字');
  if (!row.cycle_day)        throw new Error('cycle_day 必填（或請填寫 cycle_day_text 例如「5號」）');
  if (needsBilling) {
    if (!row.bill_target_type) throw new Error('bill_target_type 必填（needs_billing=true 時）');
    if (!row.bill_target_id)   throw new Error('bill_target_id 必填（needs_billing=true 時）');
    if (!row.bill_target_name) throw new Error('bill_target_name 必填（needs_billing=true 時）');
  }

  const { data, error } = await supabase
    .from('recurring_expenses')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** 解析「每月幾號支付」: 數字優先；否則從文字抽數字（「5號」→5、「18號前」→18） */
function parseCycleDay(numeric, text) {
  const n = Number(numeric);
  if (Number.isFinite(n) && n >= 1 && n <= 31) return n;
  if (text) {
    const m = String(text).match(/(\d+)/);
    if (m) {
      const d = Number(m[1]);
      if (d >= 1 && d <= 31) return d;
    }
  }
  // 預設 5
  return 5;
}

async function updateExpense(id, patch) {
  const allowed = [
    'name','description','amount','cycle_type','cycle_day','cycle_day_text','holiday_rule',
    'payment_method','payee_name','needs_billing','period_text',
    'bank_code','bank_branch','bank_account',
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
/** 補建指定月份所有 active expense 的 payment row（沒給月份 = 本月） */
async function ensurePaymentsForMonth(yearMonth) {
  if (!yearMonth) yearMonth = todayStr().slice(0, 7);
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

// 舊名相容
async function ensureCurrentMonthPayments() {
  return ensurePaymentsForMonth();
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


// ════════════════════════════════════════════════════════════
//                  產生本月元大匯款 Excel
// ════════════════════════════════════════════════════════════

/**
 * 產生指定月份的元大網銀批次匯款檔
 *   - 撈 recurring_expense_payments 該月 status='pending'
 *   - JOIN recurring_expenses 拿銀行資料 + 費用名稱
 *   - 從 company_profile 讀 payer 資料
 *   - 格式照使用者提供的「115.06元大常態+支票 出款.xlsx」
 *     R3 付款資料 header / R4 付款資料 / R6 收款 header / R7 範本 / R8+ 明細
 */
async function exportEltonBatchForMonth(yearMonth, paymentIds = null) {
  // ── 1. 撈 payments + 對應的 expense bank info
  //    有給 paymentIds → 依 IN 篩；沒給 → 全部 pending
  let q = supabase
    .from('recurring_expense_payments')
    .select(`
      id, year_month, due_date, amount, status,
      recurring_expenses (
        name, payee_name, bank_code, bank_branch, bank_account
      )
    `)
    .eq('year_month', yearMonth)
    .order('due_date', { ascending: true });
  if (Array.isArray(paymentIds) && paymentIds.length > 0) {
    q = q.in('id', paymentIds);
  } else {
    q = q.eq('status', 'pending');
  }
  const { data: payments, error } = await q;
  if (error) throw new Error(error.message);

  // ── 2. 撈 company_profile
  const { data: payer, error: pErr } = await supabase
    .from('company_profile')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!payer) throw new Error('請先到「公司資料」頁設定付款方資料');

  // ── 3. 組明細列
  const items = (payments || []).map(p => {
    const e = p.recurring_expenses || {};
    return {
      due_date:     p.due_date,
      amount:       Number(p.amount),
      account_no:   e.bank_account || '',
      account_name: e.payee_name   || '',
      bank_code:    e.bank_code    || '',
      branch_code:  e.bank_branch  || '',
      memo:         e.name         || '',
    };
  });

  // ── 4. 付款日：用最早一筆的 due_date（西元 yyyymmdd）
  const firstDue = items[0]?.due_date || `${yearMonth}-15`;
  const paymentDateYmd = String(firstDue).replace(/-/g, '');

  // ── 5. 組裝 sheet
  const data = [];
  data.push([]);   // R1
  data.push([]);   // R2

  // R3: 付款資料 header
  data.push(['', '', '', '付款日期', '付款帳號', '付款戶名', '付款總行', '付款分行', '逾時處理指示',
             '', '', '', '', '', '', 'V20130123版']);

  // R4: 付款資料 values
  data.push(['', '', '',
    paymentDateYmd,
    payer.payer_account_no   || '',
    payer.payer_account_name || '',
    payer.payer_bank_code    || '',
    payer.payer_branch_code  || '',
    payer.default_overdue_code || '1',
  ]);

  // R5 空
  data.push([]);

  // R6: 收款資料 header
  data.push([
    '', '', '日期', '收款金額', '收款帳號', '收款戶名', '收款總行', '收款分行',
    '識別碼類別', '識別碼', '手續費負擔別', '通知方式',
    'FAX傳真號碼', 'E-mail Address', 'FXML URL', '銷帳參考資料', '附言',
  ]);

  // R7: 範本（勿刪除）
  data.push([
    '', '', '', 38, '00000000000001', '王大明', '806', '0998', '53', 'A123456789',
    '15', '0', '', '', '', '', '範本資料，勿刪除！',
  ]);

  // R8 起：明細
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const [y, m, d] = String(it.due_date).split('-').map(Number);
    const rocDate = `${y - 1911}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
    data.push([
      '',
      i === 0 ? '開始=＞' : '',
      rocDate,
      it.amount,
      it.account_no,
      it.account_name,
      it.bank_code,
      it.branch_code,
      '', '',
      payer.default_fee_burden  || '15',
      payer.default_notify_method || '0',
      '', '', '', '',
      it.memo,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [
    { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 22 },
    { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 },
    { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 20 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工作表1');

  return {
    buffer:   XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    filename: `${yearMonth}_元大常態+支票_出款.xlsx`,
    count:    items.length,
  };
}


// ── 開帳對象選項 ───────────────────────────────────────────

// 「門市」「部門」現在都從 departments 表撈
//   - 門市：store_erpid 以「1」「2」開頭（120xxx、2456300...）
//   - 部門：store_erpid 以「0」開頭（00002 企劃部...）
//   - 跟基本資料「依門市」視角一致

async function listStores() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name')
    .order('store_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || [])
    .filter(r => r.store_erpid && /^[12]/.test(r.store_erpid))
    .map(r => ({ id: r.store_erpid, name: r.store_name }));
}

async function listDepartments() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name')
    .order('store_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || [])
    .filter(r => r.store_erpid && /^0/.test(r.store_erpid))
    .map(r => ({ id: r.store_erpid, name: r.store_name }));
}

module.exports = {
  // CRUD
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  // Payment 補建 / 查詢 / 狀態
  ensurePaymentForMonth, ensureCurrentMonthPayments, ensurePaymentsForMonth,
  listPaymentsByMonth, getTodayDuePayments,
  markPaid, unmarkPaid, markNotified,
  // 對象清單
  listStores, listDepartments,
  // 元大匯款
  exportEltonBatchForMonth,
  // 工具（給 cron / route 共用）
  todayStr, ymOf, computeDueDates,
};
