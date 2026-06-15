// services/contractService.js
// 合約管理模組業務邏輯
//   - CRUD（房租 / 廠商 / 員工）
//   - 到期/即將到期清單

const supabase = require('../config/supabase');

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ── CRUD ────────────────────────────────────────────────────

async function listContracts({ type = null, status = 'active' } = {}) {
  let q = supabase.from('contracts').select('*').order('end_date', { ascending: true });
  if (type)   q = q.eq('type', type);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getContract(id) {
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function createContract(input, createdBy) {
  if (!input.type)  throw new Error('type 必填（rent/vendor/employee）');
  if (!input.name)  throw new Error('name 必填');
  const row = sanitize(input, createdBy);
  const { data, error } = await supabase
    .from('contracts')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateContract(id, patch) {
  const allowed = [
    'type', 'name', 'party_type', 'party_id', 'party_name',
    'our_side_type', 'our_side_id', 'our_side_name',
    'start_date', 'end_date', 'signed_date',
    'total_amount', 'monthly_amount', 'currency',
    'type_data', 'file_url', 'status', 'note',
  ];
  const update = {};
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];
  if (Object.keys(update).length === 0) return getContract(id);
  const { data, error } = await supabase
    .from('contracts')
    .update(update)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteContract(id) {
  // 軟刪除：status='archived'
  const { error } = await supabase
    .from('contracts')
    .update({ status: 'archived' })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

function sanitize(input, createdBy) {
  const row = {
    type:           input.type,
    name:           String(input.name || '').trim(),
    party_type:     input.party_type   || null,
    party_id:       input.party_id     || null,
    party_name:     input.party_name   || null,
    our_side_type:  input.our_side_type || null,
    our_side_id:    input.our_side_id   || null,
    our_side_name:  input.our_side_name || null,
    start_date:     input.start_date  || null,
    end_date:       input.end_date    || null,
    signed_date:    input.signed_date || null,
    total_amount:   numOrNull(input.total_amount),
    monthly_amount: numOrNull(input.monthly_amount),
    currency:       input.currency  || 'TWD',
    type_data:      input.type_data || {},
    file_url:       input.file_url  || null,
    status:         input.status    || 'active',
    note:           input.note      || null,
    created_by:     createdBy || null,
  };
  return row;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


// ── 即將到期 ────────────────────────────────────────────────

/**
 * 列出 N 天內到期的合約（給 dashboard / 排程用）
 *   includeOverdue=true 會包含已過期但 status='active' 的
 */
async function listExpiring({ days = 60, includeOverdue = true } = {}) {
  const today = todayStr();
  const upperDate = new Date(Date.now() + days * 86400 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  let q = supabase
    .from('contracts')
    .select('*')
    .eq('status', 'active')
    .not('end_date', 'is', null)
    .lte('end_date', upperDate)
    .order('end_date', { ascending: true });
  if (!includeOverdue) q = q.gte('end_date', today);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(c => ({
    ...c,
    days_to_expire: Math.ceil((new Date(c.end_date) - new Date(today)) / 86400000),
  }));
}


// ── Reminder ────────────────────────────────────────────────

async function listReminders(contractId) {
  const { data, error } = await supabase
    .from('contract_reminders')
    .select('*')
    .eq('contract_id', contractId)
    .order('fire_date', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function upsertReminders(contractId, reminders) {
  // 簡化：先刪後插
  await supabase.from('contract_reminders').delete().eq('contract_id', contractId);
  if (!Array.isArray(reminders) || reminders.length === 0) return [];
  const rows = reminders.map(r => ({
    contract_id: contractId,
    label:       r.label || null,
    fire_date:   r.fire_date,
    target_date: r.target_date || null,
    days_before: Number(r.days_before || 0),
  }));
  const { data, error } = await supabase
    .from('contract_reminders')
    .insert(rows)
    .select();
  if (error) throw new Error(error.message);
  return data || [];
}


// ── 歷史記錄 ────────────────────────────────────────────────

async function listHistory(contractId, limit = 200) {
  const { data, error } = await supabase
    .from('contract_history')
    .select('id, changed_at, changed_by, field, old_value, new_value')
    .eq('contract_id', contractId)
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}


module.exports = {
  listContracts, getContract, createContract, updateContract, deleteContract,
  listExpiring,
  listReminders, upsertReminders,
  listHistory,
  todayStr,
};
