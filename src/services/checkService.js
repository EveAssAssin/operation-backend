// services/checkService.js
// 支票紀錄系統服務層（v2 schema）

const { createClient } = require('@supabase/supabase-js');
const { prevWorkingDay } = require('./taiwanHolidayService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// ── 工具：今天台北日期 ────────────────────────────────────
function todayTaipei() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ── 工具：計算每張票的 display_date ──────────────────────
async function enrichCheckWithDisplayDate(check) {
  check.display_date = await prevWorkingDay(check.due_date);
  return check;
}

// ══════════════════════════════════════════════════════════
// 支票科目
// ══════════════════════════════════════════════════════════
async function getSubjects() {
  const { data, error } = await supabase
    .from('check_subjects')
    .select('*')
    .order('name');
  if (error) throw error;
  return data;
}

async function createSubject(name) {
  const { data, error } = await supabase
    .from('check_subjects')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateSubject(id, updates) {
  const { data, error } = await supabase
    .from('check_subjects')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ══════════════════════════════════════════════════════════
// 支票批次
// ══════════════════════════════════════════════════════════
async function getBatches(params = {}) {
  let q = supabase
    .from('check_batches')
    .select(`
      *,
      subject:check_subjects(id, name),
      checks(id, seq_no, amount, due_date, status, paid_at)
    `)
    .order('created_at', { ascending: false });

  if (params.status)      q = q.eq('status', params.status);
  if (params.drawer_name) q = q.eq('drawer_name', params.drawer_name);
  if (params.subject_id)  q = q.eq('subject_id', params.subject_id);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function getBatchById(id) {
  const { data, error } = await supabase
    .from('check_batches')
    .select(`
      *,
      subject:check_subjects(id, name),
      checks(id, seq_no, check_no, amount, due_date, status, paid_at, void_reason, notes)
    `)
    .eq('id', id)
    .single();
  if (error) throw error;

  if (data.checks) {
    data.checks = await Promise.all(
      data.checks
        .sort((a, b) => a.seq_no - b.seq_no)
        .map(c => enrichCheckWithDisplayDate(c))
    );
  }
  return data;
}

async function createBatch(payload) {
  const {
    subject_id, drawer_name, bank_name = '高銀',
    total_amount, renewal_needed = false, prev_batch_id = null,
    notes, checks: checkList,
  } = payload;

  if (!drawer_name) throw new Error('請填寫出款人');
  if (!checkList || checkList.length === 0) throw new Error('請至少填寫一張支票');

  const { data: batch, error: batchErr } = await supabase
    .from('check_batches')
    .insert({
      subject_id: subject_id || null,
      drawer_name,
      bank_name,
      total_amount: total_amount || null,
      check_count: checkList.length,
      renewal_needed,
      prev_batch_id: prev_batch_id || null,
      notes: notes || null,
    })
    .select()
    .single();
  if (batchErr) throw batchErr;

  const checksToInsert = checkList.map((c, i) => ({
    batch_id: batch.id,
    seq_no:   c.seq_no ?? i + 1,
    check_no: c.check_no || null,
    amount:   c.amount || null,
    due_date: c.due_date,
    notes:    c.notes || null,
  }));

  const { error: chkErr } = await supabase
    .from('checks')
    .insert(checksToInsert);
  if (chkErr) throw chkErr;

  return getBatchById(batch.id);
}

async function updateBatch(id, updates) {
  const allowed = ['subject_id','drawer_name','bank_name','total_amount',
                   'renewal_needed','status','notes','prev_batch_id'];
  const clean = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );

  const { data, error } = await supabase
    .from('check_batches')
    .update(clean)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 自動同步批次狀態，並回傳是否需要續票提醒
async function syncBatchStatus(batchId) {
  const { data: checks } = await supabase
    .from('checks')
    .select('status')
    .eq('batch_id', batchId);

  if (!checks || checks.length === 0) return null;

  const allDone = checks.every(c => c.status === 'paid' || c.status === 'voided');
  const allVoid = checks.every(c => c.status === 'voided');
  const newStatus = allVoid ? 'voided' : allDone ? 'completed' : 'active';

  await supabase.from('check_batches').update({ status: newStatus }).eq('id', batchId);

  if (newStatus === 'active') {
    const pendingCount = checks.filter(c => c.status === 'pending').length;
    if (pendingCount === 1) {
      const { data: batch } = await supabase
        .from('check_batches')
        .select('renewal_needed, batch_no, drawer_name')
        .eq('id', batchId)
        .single();
      if (batch?.renewal_needed) {
        return { renewalAlert: true, batchNo: batch.batch_no, drawerName: batch.drawer_name };
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// 個別支票操作
// ══════════════════════════════════════════════════════════
async function payCheck(id) {
  const { data: check, error: fetchErr } = await supabase
    .from('checks').select('id, batch_id, status').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  if (check.status !== 'pending') throw new Error('只有 pending 狀態的支票可以標記付款');

  const { data, error } = await supabase
    .from('checks')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw error;

  const renewal = await syncBatchStatus(check.batch_id);
  return { check: data, renewal };
}

async function bounceCheck(id) {
  const { data: check, error: fetchErr } = await supabase
    .from('checks').select('id, batch_id, status').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  if (check.status !== 'paid') throw new Error('只有 paid 狀態的支票可以標記退票');

  const { data, error } = await supabase
    .from('checks')
    .update({ status: 'bounced' })
    .eq('id', id).select().single();
  if (error) throw error;

  await syncBatchStatus(check.batch_id);
  return data;
}

async function voidCheck(id, reason) {
  const { data: check, error: fetchErr } = await supabase
    .from('checks').select('id, batch_id, status').eq('id', id).single();
  if (fetchErr) throw fetchErr;
  if (check.status === 'paid') throw new Error('已付款的支票無法作廢，請用退票');

  const { data, error } = await supabase
    .from('checks')
    .update({ status: 'voided', void_reason: reason || null })
    .eq('id', id).select().single();
  if (error) throw error;

  await syncBatchStatus(check.batch_id);
  return data;
}

async function updateCheck(id, updates) {
  const allowed = ['check_no','amount','due_date','notes'];
  const clean = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );
  const { data, error } = await supabase
    .from('checks').update(clean).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ══════════════════════════════════════════════════════════
// 今日出款清單
// 找出 pending 支票中，prevWorkingDay(due_date) === today 的票
// ══════════════════════════════════════════════════════════
async function getTodayDueChecks() {
  const today = todayTaipei();

  // 抓候選範圍（due_date 在 today ~ today+60天）
  const from = new Date(today);
  from.setDate(from.getDate() - 3);
  const to = new Date(today);
  to.setDate(to.getDate() + 60);

  const { data: checks, error } = await supabase
    .from('checks')
    .select(`
      id, batch_id, seq_no, check_no, amount, due_date, status, notes,
      batch:check_batches(id, batch_no, drawer_name, bank_name,
        subject:check_subjects(name))
    `)
    .eq('status', 'pending')
    .gte('due_date', from.toISOString().slice(0, 10))
    .lte('due_date', to.toISOString().slice(0, 10));

  if (error) throw error;

  const result = [];
  for (const c of checks) {
    const disp = await prevWorkingDay(c.due_date);
    if (disp === today) {
      result.push({ ...c, display_date: disp });
    }
  }

  // 依出款人分群
  const grouped = {};
  for (const c of result) {
    const key = c.batch?.drawer_name || '未知';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }

  return { date: today, total: result.length, grouped };
}

async function getUpcomingChecks(days = 7) {
  const today = todayTaipei();
  const to = new Date(today);
  to.setDate(to.getDate() + days + 5);

  const { data: checks, error } = await supabase
    .from('checks')
    .select(`
      id, batch_id, seq_no, amount, due_date, status,
      batch:check_batches(batch_no, drawer_name, bank_name,
        subject:check_subjects(name))
    `)
    .eq('status', 'pending')
    .gte('due_date', today)
    .lte('due_date', to.toISOString().slice(0, 10))
    .order('due_date');

  if (error) throw error;

  const result = [];
  for (const c of checks) {
    const disp = await prevWorkingDay(c.due_date);
    const diffMs = new Date(disp) - new Date(today);
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays >= 0 && diffDays <= days) {
      result.push({ ...c, display_date: disp, days_until: diffDays });
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════
// 通知名單
// ══════════════════════════════════════════════════════════
async function getNotifyTargets() {
  const { data, error } = await supabase
    .from('check_notify_targets').select('*').order('created_at');
  if (error) throw error;
  return data;
}

async function createNotifyTarget(payload) {
  const { data, error } = await supabase
    .from('check_notify_targets').insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function updateNotifyTarget(id, updates) {
  const { data, error } = await supabase
    .from('check_notify_targets').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function deleteNotifyTarget(id) {
  const { error } = await supabase
    .from('check_notify_targets').delete().eq('id', id);
  if (error) throw error;
}

module.exports = {
  getSubjects, createSubject, updateSubject,
  getBatches, getBatchById, createBatch, updateBatch, syncBatchStatus,
  payCheck, bounceCheck, voidCheck, updateCheck,
  getTodayDueChecks, getUpcomingChecks,
  getNotifyTargets, createNotifyTarget, updateNotifyTarget, deleteNotifyTarget,
};
