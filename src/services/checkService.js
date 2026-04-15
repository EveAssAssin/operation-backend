// services/checkService.js
// 支票紀錄系統：批次 / 個別支票 / 通知名單

const supabase = require('../config/supabase');

// ============================================================
// 支票批次（check_batches）
// ============================================================

/**
 * 查詢批次列表
 * @param {object} opts - { payee_type, status, q（關鍵字）, page, limit }
 */
async function getBatches(opts = {}) {
  const { payee_type, status, q, page = 1, limit = 20 } = opts;
  const from = (Math.max(1, page) - 1) * Math.min(100, limit);

  let query = supabase
    .from('check_batches')
    .select('*, checks(id, status)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + Math.min(100, limit) - 1);

  if (payee_type) query = query.eq('payee_type', payee_type);
  if (status)     query = query.eq('status', status);
  if (q)          query = query.ilike('payee_name', `%${q}%`);

  const { data, error, count } = await query;
  if (error) throw new Error(`查詢批次失敗：${error.message}`);

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
 * 取得單一批次（含所有支票）
 */
async function getBatchById(id) {
  const { data, error } = await supabase
    .from('check_batches')
    .select(`
      *,
      checks (
        id, seq_no, check_no, bank_name, bank_account,
        amount, due_date, status, paid_at, void_reason, notes
      )
    `)
    .eq('id', id)
    .single();

  if (error) throw new Error(`找不到批次：${error.message}`);

  // 支票依 seq_no 排序
  if (data.checks) {
    data.checks.sort((a, b) => a.seq_no - b.seq_no);
  }
  return data;
}

/**
 * 建立支票批次（含個別支票）
 * @param {object} batchData  - 批次欄位
 * @param {Array}  checkItems - [{ seq_no, check_no, bank_name, bank_account, amount, due_date, notes }]
 * @param {string} createdBy  - system_users.id
 */
async function createBatch(batchData, checkItems, createdBy) {
  const now = new Date().toISOString();

  // 計算總金額（若前端沒帶就自動加總）
  const totalAmount = batchData.total_amount
    || checkItems.reduce((s, c) => s + parseFloat(c.amount || 0), 0);

  // 建立批次
  const { data: batch, error: bErr } = await supabase
    .from('check_batches')
    .insert({
      ...batchData,
      total_amount: totalAmount,
      check_count:  checkItems.length,
      status:       'active',
      created_by:   createdBy,
      created_at:   now,
      updated_at:   now,
    })
    .select()
    .single();

  if (bErr) throw new Error(`建立批次失敗：${bErr.message}`);

  // 建立個別支票
  if (checkItems.length > 0) {
    const rows = checkItems.map((c, i) => ({
      batch_id:     batch.id,
      seq_no:       c.seq_no || (i + 1),
      check_no:     c.check_no || null,
      bank_name:    c.bank_name || null,
      bank_account: c.bank_account || null,
      amount:       parseFloat(c.amount),
      due_date:     c.due_date,
      status:       'pending',
      notes:        c.notes || null,
      created_at:   now,
      updated_at:   now,
    }));

    const { error: cErr } = await supabase.from('checks').insert(rows);
    if (cErr) throw new Error(`建立支票明細失敗：${cErr.message}`);
  }

  return getBatchById(batch.id);
}

/**
 * 更新批次基本資訊
 */
async function updateBatch(id, payload) {
  const allowed = ['payee_name','payee_type','purpose','notes'];
  const update  = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (payload[k] !== undefined) update[k] = payload[k]; });

  const { data, error } = await supabase
    .from('check_batches')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`更新批次失敗：${error.message}`);
  return data;
}

/**
 * 自動同步批次狀態（依子支票狀態推算）
 * - 全部 paid → completed
 * - 含有 pending → active
 */
async function syncBatchStatus(batchId) {
  const { data: items } = await supabase
    .from('checks')
    .select('status')
    .eq('batch_id', batchId);

  if (!items || items.length === 0) return;

  const nonVoided = items.filter(c => c.status !== 'voided');
  const allPaid   = nonVoided.length > 0 && nonVoided.every(c => c.status === 'paid');
  const newStatus = allPaid ? 'completed' : 'active';

  await supabase
    .from('check_batches')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', batchId);
}

// ============================================================
// 個別支票（checks）
// ============================================================

/**
 * 標記支票為已付款
 * @param {string} checkId - 支票 id
 * @param {string} userId  - 操作者 id
 */
async function payCheck(checkId, userId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('checks')
    .update({ status: 'paid', paid_at: now, paid_by: userId, updated_at: now })
    .eq('id', checkId)
    .select()
    .single();

  if (error) throw new Error(`標記付款失敗：${error.message}`);
  await syncBatchStatus(data.batch_id);
  return data;
}

/**
 * 作廢支票
 */
async function voidCheck(checkId, reason, userId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('checks')
    .update({ status: 'voided', void_reason: reason || null, paid_by: userId, updated_at: now })
    .eq('id', checkId)
    .select()
    .single();

  if (error) throw new Error(`作廢支票失敗：${error.message}`);
  await syncBatchStatus(data.batch_id);
  return data;
}

/**
 * 更新支票基本資訊（僅 pending 狀態可改）
 */
async function updateCheck(id, payload) {
  const allowed = ['check_no','bank_name','bank_account','amount','due_date','notes'];
  const update  = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (payload[k] !== undefined) update[k] = payload[k]; });

  // 確認狀態
  const { data: existing } = await supabase
    .from('checks').select('status').eq('id', id).single();
  if (existing?.status !== 'pending') throw new Error('只有待兌現的支票可以修改');

  const { data, error } = await supabase
    .from('checks').update(update).eq('id', id).select().single();

  if (error) throw new Error(`更新支票失敗：${error.message}`);
  return data;
}

// ============================================================
// 今日到期 & 通知相關
// ============================================================

/**
 * 取得指定日期的到期支票（status=pending）
 * @param {string} date - YYYY-MM-DD，預設今天
 */
async function getDueChecks(date) {
  const targetDate = date || new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

  const { data, error } = await supabase
    .from('checks')
    .select(`
      id, seq_no, check_no, bank_name, bank_account,
      amount, due_date, status, notes,
      check_batches!batch_id (
        id, batch_no, payee_name, payee_type, purpose
      )
    `)
    .eq('due_date', targetDate)
    .eq('status', 'pending')
    .order('amount', { ascending: false });

  if (error) throw new Error(`查詢到期支票失敗：${error.message}`);
  return data || [];
}

/**
 * 取得近 N 天內到期的支票清單（用於儀表板預覽）
 * @param {number} days - 幾天內
 */
async function getUpcomingChecks(days = 7) {
  const today   = new Date();
  const from    = today.toLocaleDateString('sv-SE');
  const toDate  = new Date(today);
  toDate.setDate(toDate.getDate() + days - 1);
  const to      = toDate.toLocaleDateString('sv-SE');

  const { data, error } = await supabase
    .from('checks')
    .select(`
      id, seq_no, check_no, bank_name, amount, due_date, status, notes,
      check_batches!batch_id (
        id, batch_no, payee_name, payee_type
      )
    `)
    .eq('status', 'pending')
    .gte('due_date', from)
    .lte('due_date', to)
    .order('due_date')
    .order('amount', { ascending: false });

  if (error) throw new Error(`查詢即將到期支票失敗：${error.message}`);
  return data || [];
}

// ============================================================
// LINE 通知目標
// ============================================================

async function getNotifyTargets(onlyActive = false) {
  let query = supabase
    .from('check_notify_targets')
    .select('*')
    .order('created_at');

  if (onlyActive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(`取得通知名單失敗：${error.message}`);
  return data || [];
}

async function createNotifyTarget(payload) {
  const { name, app_number, notes } = payload;
  if (!name || !app_number) throw new Error('缺少必填欄位：name, app_number');

  const { data, error } = await supabase
    .from('check_notify_targets')
    .insert({ name, app_number, notes, is_active: true, created_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(`新增通知目標失敗：${error.message}`);
  return data;
}

async function updateNotifyTarget(id, payload) {
  const allowed = ['name','app_number','is_active','notes'];
  const update  = {};
  allowed.forEach(k => { if (payload[k] !== undefined) update[k] = payload[k]; });

  const { data, error } = await supabase
    .from('check_notify_targets')
    .update(update).eq('id', id).select().single();

  if (error) throw new Error(`更新通知目標失敗：${error.message}`);
  return data;
}

async function deleteNotifyTarget(id) {
  const { error } = await supabase
    .from('check_notify_targets').delete().eq('id', id);
  if (error) throw new Error(`刪除通知目標失敗：${error.message}`);
}

module.exports = {
  // 批次
  getBatches,
  getBatchById,
  createBatch,
  updateBatch,
  syncBatchStatus,
  // 個別支票
  payCheck,
  voidCheck,
  updateCheck,
  // 到期查詢
  getDueChecks,
  getUpcomingChecks,
  // 通知名單
  getNotifyTargets,
  createNotifyTarget,
  updateNotifyTarget,
  deleteNotifyTarget,
};
