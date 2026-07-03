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
 *   - code 是 UNIQUE，空字串會撞鍵；統一把 ''/whitespace 規範化為 null
 *   - 其他可能空字串的選填欄位也一起 normalize 成 null 避免日後 query 雜訊
 */
async function createSource(payload) {
  const cleaned = { ...payload };
  for (const k of ['code', 'dept_erpid', 'contact_name', 'contact_phone', 'contact_email', 'api_start_period']) {
    if (typeof cleaned[k] === 'string' && cleaned[k].trim() === '') cleaned[k] = null;
  }
  const { data, error } = await supabase
    .from('billing_sources')
    .insert({ ...cleaned, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) {
    // 友善訊息
    if (/billing_sources_code_key/.test(error.message)) {
      throw new Error('識別碼已被其他來源單位使用，請改用其他識別碼（可留空）');
    }
    throw new Error(`建立來源單位失敗：${error.message}`);
  }
  return data;
}

/**
 * 更新來源單位
 */
async function updateSource(id, payload) {
  // 若切換為 api 且沒設 api_start_period，自動設為當月
  if (payload.sync_method === 'api' && !payload.api_start_period) {
    const d = new Date();
    payload.api_start_period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
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
  const pageInt  = Math.max(1, Number(page));
  const limitInt = Math.min(100, Number(limit) || 20);

  // 1. bills（撈全部符合條件，不分頁，後面合併時再切）
  let query = supabase
    .from('bills')
    .select(`
      id, bill_no, period, title, total_amount, status,
      source_id, accounting_category_id,
      invoice_no, invoice_date, submitted_at, confirmed_at,
      created_by_type, created_at,
      billing_sources!source_id ( id, name, source_type, sync_method ),
      accounting_categories!accounting_category_id ( id, name, code )
    `)
    .order('created_at', { ascending: false });

  if (period)    query = query.eq('period', period);
  if (source_id) query = query.eq('source_id', source_id);
  if (status)    query = query.eq('status', status);

  const { data: bills, error } = await query;
  if (error) throw new Error(`查詢帳單失敗：${error.message}`);

  // 2. operational_expenses 也算「帳單」，轉成同格式
  //    篩了 source_id 時不含（opex 沒有 source_id）
  //    篩了 status 且非 'confirmed' 時不含（opex 視為已確認）
  let opex = [];
  if (!source_id && (!status || status === 'confirmed')) {
    let oq = supabase
      .from('operational_expenses')
      .select(`
        id, entry_date, period_from, period_to, category_id, fact_id, store_erpid,
        total_amount, notes, created_at,
        category:entity_fact_categories!category_id ( id, code, name, icon ),
        fact:entity_facts!fact_id ( id, store_name, store_erpid, data )
      `)
      .order('created_at', { ascending: false });
    if (period) {
      oq = oq.gte('period_from', `${period}-01`).lt('period_from', _nextMonthFirstDay(period));
    }
    const { data: opRows, error: oErr } = await oq;
    if (oErr) console.warn('[getBills] 撈 operational_expenses 失敗：', oErr.message);
    else opex = (opRows || []).map(_mapOpexAsBill);
  }

  const merged = [...(bills || []), ...opex]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const total = merged.length;
  const offset = (pageInt - 1) * limitInt;
  const paged = merged.slice(offset, offset + limitInt);

  return {
    data: paged,
    pagination: {
      total,
      page:  pageInt,
      limit: limitInt,
      pages: Math.max(1, Math.ceil(total / limitInt)),
    },
  };
}

// 把 operational_expense 轉成 bill 格式
function _mapOpexAsBill(x) {
  const factLabel = x.fact ? _factSummary(x.fact) : '';
  return {
    id:                     'opex-' + x.id,
    bill_no:                'OPEX-' + (x.entry_date || '').replace(/-/g, '').slice(0, 6) + '-' + String(x.id).slice(0, 6),
    period:                 (x.period_from || '').slice(0, 7),
    title:                  `${x.category ? (x.category.name + ' ') : ''}${factLabel || ''}`.trim() || '營運費用',
    total_amount:           x.total_amount,
    status:                 'confirmed',
    source_id:              null,
    accounting_category_id: null,
    invoice_no:             null,
    invoice_date:           null,
    submitted_at:           null,
    confirmed_at:           x.created_at,
    created_by_type:        'system',
    created_at:             x.created_at,
    billing_sources:        { id: null, name: '營運費用', source_type: 'operational', sync_method: 'manual' },
    accounting_categories:  x.category ? { id: x.category.id, name: x.category.name, code: x.category.code } : null,
    __is_operational:       true,
  };
}
function _factSummary(fact) {
  const d = fact.data || {};
  const vals = Object.values(d).filter(v => v != null && String(v).trim() !== '').map(v => String(v).trim());
  return [...vals.slice(0, 2), fact.store_name || ''].filter(Boolean).join(' · ');
}
function _nextMonthFirstDay(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const nm = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${nm.y}-${String(nm.m).padStart(2, '0')}-01`;
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

async function getMonthSummaryV2(period) {
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
  // ── 加入 operational_expense_allocations（year_month = period）─────
  try {
    const { data: opAllocs, error: opErr } = await supabase
      .from('operational_expense_allocations')
      .select(`
        store_erpid, year_month, amount,
        opex:operational_expense_id (
          id, entry_date,
          category:entity_fact_categories!category_id ( name, icon ),
          fact:entity_facts!fact_id ( store_name, data )
        )
      `)
      .eq('year_month', period);
    if (opErr) console.warn('[getMonthSummaryV2] opex allocations 失敗：', opErr.message);

    // 撈 departments 對照表，補 store_name（先前的 storeMap 只有從 bill_allocations 帶來的名字）
    const missingErpids = Array.from(new Set(
      (opAllocs || [])
        .map(a => a.store_erpid)
        .filter(id => id && !storeMap[id])
    ));
    let deptMap = {};
    if (missingErpids.length > 0) {
      const { data: depts } = await supabase
        .from('departments')
        .select('store_erpid, store_name')
        .in('store_erpid', missingErpids);
      for (const d of (depts || [])) if (d.store_erpid) deptMap[d.store_erpid] = d.store_name;
    }

    for (const a of (opAllocs || [])) {
      const { store_erpid, amount } = a;
      if (!store_erpid) continue;
      const amt = parseFloat(amount) || 0;
      if (!storeMap[store_erpid]) {
        storeMap[store_erpid] = {
          store_erpid,
          store_name: deptMap[store_erpid] || '',
          total:       0,
          admin_dept:  0,
          vendor:      0,
          operational: 0,
          bills:       [],
        };
      }
      const s = storeMap[store_erpid];
      s.total       += amt;
      s.operational += amt;
      const opex = a.opex || {};
      const catName = opex.category?.name || '';
      const catIcon = opex.category?.icon || '';
      const factHint = opex.fact?.store_name || '';
      s.bills.push({
        bill_id:     'opex-' + opex.id,
        bill_no:     'OPEX-' + String(opex.id || '').slice(0, 8),
        title:       `${catIcon ? catIcon + ' ' : ''}${catName || '營運費用'}${factHint ? ' · ' + factHint : ''}`.trim(),
        amount:      amt,
        source_name: '營運費用',
        source_type: 'operational',
      });
    }
  } catch (e) {
    console.warn('[getMonthSummaryV2] 合併 opex 失敗：', e.message);
  }

  return Object.values(storeMap).sort((a, b) => (a.store_name || '').localeCompare(b.store_name || '', 'zh-Hant'));
}

module.exports = {
  getSources,
  getSourceById,
  createSource,
  updateSource,
  getCategories,
  createCategory,
  updateCategory,
  getBills,
  getBillById,
  createBill,
  updateBill,
  updateBillAllocations,
  changeBillStatus,
  getMonthSummaryV2,
};
