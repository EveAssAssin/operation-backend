// services/billingV2Service.js
// 開帳系統 v2：來源單位 / 會計科目 / 帳單 / 門市分配

const supabase = require('../config/supabase');

// ============================================================
// 來源單位（billing_sources）
// ============================================================

/**
 * 取得所有來源單位
 * @param {object} opts - { source_type, is_active }
 */
async function getSources(opts = {}) {
  let query = supabase
    .from('billing_sources')
    .select('*')
    .order('source_type')
    .order('name');

  if (opts.source_type) query = query.eq('source_type', opts.source_type);
  if (opts.is_active !== undefined) query = query.eq('is_active', opts.is_active);

  const { data, error } = await query;
  if (error) throw new Error(`取得來源單位失敗：${error.message}`);
  return data;
}

/**
 * 取得單一來源單位
 */
async function getSourceById(id) {
  const { data, error } = await supabase
    .from('billing_sources')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(`找不到來源單位：${error.message}`);
  return data;
}

/**
 * 建立來源單位
 */
async function createSource(payload) {
  const { data, error } = await supabase
    .from('billing_sources')
    .insert({ ...payload, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw new Error(`建立來源單位失敗：${error.message}`);
  return data;
}

/**
 * 更新來源單位
 */
async function updateSource(id, payload) {
  const { data, error } = await supabase
    .from('billing_sources')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`更新來源單位失敗：${error.message}`);
  return data;
}

// ============================================================
// 會計科目（accounting_categories）
// ============================================================

/**
 * 取得某來源單位的會計科目
 */
async function getCategories(sourceId, onlyActive = true) {
  let query = supabase
    .from('accounting_categories')
    .select('*')
    .eq('source_id', sourceId)
    .order('sort_order')
    .order('name');

  if (onlyActive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(`取得會計科目失敗：${error.message}`);
  return data;
}

/**
 * 建立會計科目
 */
async function createCategory(sourceId, payload) {
  const { data, error } = await supabase
    .from('accounting_categories')
    .insert({
      ...payload,
      source_id:  sourceId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`建立會計科目失敗：${error.message}`);
  return data;
}

/**
 * 更新會計科目
 */
async function updateCategory(id, payload) {
  const { data, error } = await supabase
    .from('accounting_categories')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`更新會計科目失敗：${error.message}`);
  return data;
}

// ============================================================
// 帳單（bills）
// ============================================================

/**
 * 查詢帳單列表
 * @param {object} opts - { period, source_id, status, page, limit }
 */
async function getBills(opts = {}) {
  const { period, source_id, status, page = 1, limit = 20 } = opts;
  const from = (Math.max(1, page) - 1) * Math.min(100, limit);

  let query = supabase
    .from('bills')
    .select(`
      id, bill_no, period, title, total_amount, status,
      source_id, accounting_category_id,
      invoice_no, invoice_date, submitted_at, confirmed_at,
      created_by_type, created_at,
      billing_sources!source_id ( id, name, source_type ),
      accounting_categories!accounting_category_id ( id, name, code )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + Math.min(100, limit) - 1);

  if (period)    query = query.eq('period', period);
  if (source_id) query = query.eq('source_id', source_id);
  if (status)    query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw new Error(`查詢帳單失敗：${error.message}`);

  return {
    data,
    pagination: {
      total: count,
      page:  Math.max(1, page),
      limit: Math.min(100, limit),
      pages: Math.ceil(count / Math.min(100, limit)),
    },
  };
}

/**
 * 取得單一帳單（含分配明細）
 */
async function getBillById(id) {
  const { data, error } = await supabase
    .from('bills')
    .select(`
      *,
      billing_sources!source_id ( id, name, source_type, code ),
      accounting_categories!accounting_category_id ( id, name, code ),
      bill_allocations (
        id, store_erpid, store_name, allocated_amount, allocation_note,
        confirm_status, confirmed_at, dispute_reason
      )
    `)
    .eq('id', id)
    .single();

  if (error) throw new Error(`找不到帳單：${error.message}`);
  return data;
}

/**
 * 建立帳單（含分配明細）
 * @param {object} billData - 帳單欄位
 * @param {Array}  allocations - [{ store_erpid, store_name, allocated_amount, allocation_note }]
 * @param {string} creatorType - 'system' | 'vendor'
 * @param {string} creatorId   - system_users.id 或 vendor_accounts.id
 */
async function createBill(billData, allocations = [], creatorType = 'system', creatorId = null) {
  // 建立帳單主記錄
  const insertData = {
    ...billData,
    created_by_type:   creatorType,
    created_by_system: creatorType === 'system' ? creatorId : null,
    created_by_vendor: creatorType === 'vendor' ? creatorId : null,
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  };

  const { data: bill, error: billErr } = await supabase
    .from('bills')
    .insert(insertData)
    .select()
    .single();

  if (billErr) throw new Error(`建立帳單失敗：${billErr.message}`);

  // 建立分配明細
  if (allocations.length > 0) {
    const allocationRows = allocations.map(a => ({
      ...a,
      bill_id:    bill.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    const { error: allocErr } = await supabase
      .from('bill_allocations')
      .insert(allocationRows);

    if (allocErr) throw new Error(`建立分配明細失敗：${allocErr.message}`);
  }

  return getBillById(bill.id);
}

/**
 * 更新帳單（僅 draft 狀態可修改基本欄位）
 */
async function updateBill(id, payload) {
  // 確認帳單存在且為 draft
  const { data: existing } = await supabase
    .from('bills')
    .select('id, status')
    .eq('id', id)
    .single();

  if (!existing) throw new Error('找不到帳單');
  if (existing.status !== 'draft') throw new Error('只有草稿狀態的帳單可以修改');

  const { data, error } = await supabase
    .from('bills')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`更新帳單失敗：${error.message}`);
  return data;
}

/**
 * 更新帳單分配（先刪後插）
 */
async function updateBillAllocations(billId, allocations) {
  // 先確認帳單為 draft
  const { data: bill } = await supabase
    .from('bills')
    .select('id, status')
    .eq('id', billId)
    .single();

  if (!bill) throw new Error('找不到帳單');
  if (bill.status !== 'draft') throw new Error('只有草稿狀態可以修改分配');

  // 刪除舊的分配
  await supabase.from('bill_allocations').delete().eq('bill_id', billId);

  // 插入新的分配
  if (allocations.length > 0) {
    const rows = allocations.map(a => ({
      ...a,
      bill_id:    billId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('bill_allocations').insert(rows);
    if (error) throw new Error(`更新分配失敗：${error.message}`);
  }
}

/**
 * 帳單狀態流轉
 * @param {string} id        - 帳單 ID
 * @param {string} newStatus - 'submitted' | 'confirmed' | 'distributed' | 'void'
 * @param {string} userId    - 操作者 ID
 * @param {object} extra     - 額外欄位（如 void_reason）
 */
async function changeBillStatus(id, newStatus, userId, extra = {}) {
  const now = new Date().toISOString();
  const update = { status: newStatus, updated_at: now };

  if (newStatus === 'submitted')   { update.submitted_at   = now; }
  if (newStatus === 'confirmed')   { update.confirmed_at   = now; update.confirmed_by   = userId; }
  if (newStatus === 'distributed') { update.distributed_at = now; update.distributed_by = userId; }
  if (newStatus === 'void')        { update.void_at        = now; update.void_by        = userId; update.void_reason = extra.void_reason || null; }

  const { data, error } = await supabase
    .from('bills')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`狀態更新失敗：${error.message}`);
  return data;
}

// ============================================================
// 月報：門市帳單彙總
// ============================================================

/**
 * 取得某月份所有門市的帳單彙總
 * 回傳：每個門市的分配總額，以及各來源類型的小計
 */
async function getMonthSummaryV2(period) {
  // 取得該月份所有已確認或已分配的帳單分配
  const { data, error } = await supabase
    .from('bill_allocations')
    .select(`
      store_erpid, store_name, allocated_amount,
      bills!bill_id (
        id, bill_no, period, title, status, source_id,
        billing_sources!source_id ( name, source_type )
      )
    `)
    .eq('bills.period', period)
    .in('bills.status', ['confirmed', 'distributed']);

  if (error) throw new Error(`取得月報失敗：${error.message}`);

  // 依門市彙總
  const storeMap = {};
  for (const row of (data || [])) {
    const { store_erpid, store_name, allocated_amount, bills: bill } = row;
    if (!bill) continue;

    const sourceType = bill.billing_sources?.source_type;

    if (!storeMap[store_erpid]) {
      storeMap[store_erpid] = {
        store_erpid,
        store_name,
        total:       0,
        admin_dept:  0,
        vendor:      0,
        operational: 0,
        bills:       [],
      };
    }

    const s = storeMap[store_erpid];
    s.total += parseFloat(allocated_amount);
    if (sourceType === 'admin_dept')  s.admin_dept  += parseFloat(allocated_amount);
    if (sourceType === 'vendor')      s.vendor      += parseFloat(allocated_amount);
    if (sourceType === 'operational') s.operational += parseFloat(allocated_amount);
    s.bills.push({
      bill_id:     bill.id,
      bill_no:     bill.bill_no,
      title:       bill.title,
      amount:      parseFloat(allocated_amount),
      source_name: bill.billing_sources?.name,
      source_type: sourceType,
    });
  }

  return Object.values(storeMap).sort((a, b) => a.store_name?.localeCompare(b.store_name, 'zh-Hant'));
}

module.exports = {
  // 來源單位
  getSources,
  getSourceById,
  createSource,
  updateSource,
  // 會計科目
  getCategories,
  createCategory,
  updateCategory,
  // 帳單
  getBills,
  getBillById,
  createBill,
  updateBill,
  updateBillAllocations,
  changeBillStatus,
  // 月報
  getMonthSummaryV2,
};
