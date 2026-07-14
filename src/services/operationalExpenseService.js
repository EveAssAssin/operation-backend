// services/operationalExpenseService.js
// 營運費用（電費 / 水費 / 電話與網路 ...）
//   - 建檔日、費用期間、分類、電號 fact、總金額
//   - 分帳：一筆營運費用可拆給多個門市 + 掛帳年月，總和不強制=總金額（允許四捨五入誤差）

const supabase = require('../config/supabase');

async function listExpenses({ from, to, category_id, fact_id, store_erpid } = {}) {
  let q = supabase
    .from('operational_expenses')
    .select(`
      *,
      category:entity_fact_categories!category_id ( id, code, name, icon ),
      fact:entity_facts!fact_id ( id, store_erpid, store_name, data ),
      allocations:operational_expense_allocations ( * )
    `)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (from)        q = q.gte('entry_date', from);
  if (to)          q = q.lte('entry_date', to);
  if (category_id) q = q.eq('category_id', category_id);
  if (fact_id)     q = q.eq('fact_id', fact_id);
  if (store_erpid) q = q.eq('store_erpid', store_erpid);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getExpense(id) {
  const { data, error } = await supabase
    .from('operational_expenses')
    .select(`
      *,
      category:entity_fact_categories!category_id ( id, code, name, icon ),
      fact:entity_facts!fact_id ( id, store_erpid, store_name, data ),
      allocations:operational_expense_allocations ( * )
    `)
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function createExpense(input, actor) {
  const row = {
    entry_date:   input.entry_date,
    period_from:  input.period_from,
    period_to:    input.period_to,
    category_id:  input.category_id  || null,
    fact_id:      input.fact_id      || null,
    store_erpid:  input.store_erpid  || null,
    total_amount: Number(input.total_amount) || 0,
    notes:        (input.notes || '').trim() || null,
    created_by:   actor || null,
  };
  if (!row.entry_date)                    throw new Error('建檔日必填');
  if (!row.period_from || !row.period_to) throw new Error('費用期間起訖必填');

  const { data, error } = await supabase
    .from('operational_expenses')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);

  // 若傳入 allocations，一次寫入
  const allocs = Array.isArray(input.allocations) ? input.allocations : [];
  if (allocs.length > 0) {
    const rows = allocs.map(a => ({
      operational_expense_id: data.id,
      store_erpid:            a.store_erpid,
      year_month:             a.year_month,
      amount:                 Number(a.amount) || 0,
      notes:                  a.notes || null,
    }));
    const { error: aErr } = await supabase
      .from('operational_expense_allocations')
      .insert(rows);
    if (aErr) throw new Error('分帳寫入失敗：' + aErr.message);
  }

  return getExpense(data.id);
}

async function updateExpense(id, patch) {
  const allowed = ['entry_date','period_from','period_to','category_id','fact_id','store_erpid','total_amount','notes'];
  const update = {};
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];
  update.updated_at = new Date().toISOString();

  if (Object.keys(update).length > 1) {
    const { error } = await supabase
      .from('operational_expenses')
      .update(update)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }
  return getExpense(id);
}

async function deleteExpense(id) {
  // allocations 因 CASCADE 會一起被砍
  const { error } = await supabase
    .from('operational_expenses')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
  return { id, deleted: true };
}

// 覆寫某筆營運費用的分帳：先刪舊、再全部寫入新的
async function replaceAllocations(expenseId, allocations) {
  const { error: dErr } = await supabase
    .from('operational_expense_allocations')
    .delete()
    .eq('operational_expense_id', expenseId);
  if (dErr) throw new Error('清舊分帳失敗：' + dErr.message);

  if (Array.isArray(allocations) && allocations.length > 0) {
    const rows = allocations.map(a => ({
      operational_expense_id: expenseId,
      store_erpid:            a.store_erpid,
      year_month:             a.year_month,
      amount:                 Number(a.amount) || 0,
      notes:                  a.notes || null,
    }));
    const { error: iErr } = await supabase
      .from('operational_expense_allocations')
      .insert(rows);
    if (iErr) throw new Error('分帳寫入失敗：' + iErr.message);
  }
  return getExpense(expenseId);
}

// 供前端下拉用：撈某分類底下所有 facts（電號 / 水號 ...）+ 對應門市
async function listFactsByCategory(categoryId) {
  const { data, error } = await supabase
    .from('entity_facts')
    .select('id, store_erpid, store_name, data')
    .eq('category_id', categoryId)
    .order('store_name');
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * 查詢某個 fact 的已分帳月份
 * @param {string} factId  fact_id (UUID)
 * @param {string|null} excludeExpenseId  編輯時要排除自己（避免自己的分帳被當成「已存在」）
 * @returns {{ allocated: string[], last: string|null, next_suggested: string|null }}
 */
async function getFactAllocatedMonths(factId, excludeExpenseId = null) {
  // 先撈這個 fact 底下所有 expenses（含 allocations）
  let q = supabase
    .from('operational_expenses')
    .select('id, allocations:operational_expense_allocations(year_month)')
    .eq('fact_id', factId);
  if (excludeExpenseId) q = q.neq('id', excludeExpenseId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  // 收集去重
  const set = new Set();
  for (const e of (data || [])) {
    for (const a of (e.allocations || [])) {
      if (a.year_month) set.add(a.year_month);
    }
  }
  const allocated = Array.from(set).sort();
  const last = allocated.length > 0 ? allocated[allocated.length - 1] : null;
  // 建議：last 的下一個月，沒有則不建議
  let nextSuggested = null;
  if (last) {
    const [y, m] = last.split('-').map(Number);
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    nextSuggested = `${ny}-${String(nm).padStart(2, '0')}`;
  }
  return { allocated, last, next_suggested: nextSuggested };
}

module.exports = {
  listExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  replaceAllocations, listFactsByCategory, getFactAllocatedMonths,
};
