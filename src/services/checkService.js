// services/checkService.js
// 支票紀錄系統服務層（v2 schema）

const supabase = require('../config/supabase');
const { prevWorkingDay } = require('./taiwanHolidayService');

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
// 包含：① 今日到期（prevWorkingDay(due_date) === today）
//       ② 逾期未消除（due_date < today，status=pending）
// ══════════════════════════════════════════════════════════
const CHECK_SELECT = `
  id, batch_id, seq_no, check_no, amount, due_date, status, notes,
  batch:check_batches(id, batch_no, drawer_name, bank_name,
    subject:check_subjects(name))
`;

async function getTodayDueChecks() {
  const today = todayTaipei();

  // ── ① 今日到期：due_date 在 today-3 ~ today+60 之間的 pending ──
  const from = new Date(today);
  from.setDate(from.getDate() - 3);
  const to = new Date(today);
  to.setDate(to.getDate() + 60);

  const { data: candidates, error: e1 } = await supabase
    .from('checks')
    .select(CHECK_SELECT)
    .eq('status', 'pending')
    .gte('due_date', from.toISOString().slice(0, 10))
    .lte('due_date', to.toISOString().slice(0, 10));
  if (e1) throw e1;

  const todayChecks = [];
  for (const c of candidates) {
    const disp = await prevWorkingDay(c.due_date);
    if (disp === today) todayChecks.push({ ...c, display_date: disp, is_overdue: false });
  }

  // ── ② 逾期＋今日到期：due_date <= today 且不在 todayChecks 裡（避免重複）──
  const todayCheckIds = new Set(todayChecks.map(c => c.id));
  const { data: overdueRaw, error: e2 } = await supabase
    .from('checks')
    .select(CHECK_SELECT)
    .eq('status', 'pending')
    .lte('due_date', today);   // <= 包含今天到期的票
  if (e2) throw e2;

  const overdueChecks = (overdueRaw || [])
    .filter(c => !todayCheckIds.has(c.id))  // 已出現在 todayChecks 的不重複
    .map(c => ({
      ...c,
      display_date: c.due_date,
      is_overdue: c.due_date < today,  // 嚴格過期才貼「逾期」標籤，今日到期不貼
    }));

  // ── 合併並依出款人分群 ────────────────────────────────
  const all = [...todayChecks, ...overdueChecks];
  const grouped = {};
  for (const c of all) {
    const key = c.batch?.drawer_name || '未知';
    if (!grouped[key]) grouped[key] = { today: [], overdue: [] };
    if (c.is_overdue) grouped[key].overdue.push(c);
    else              grouped[key].today.push(c);
  }

  // ── 各出款人小計 ─────────────────────────────────────
  const summary = Object.entries(grouped).map(([drawer, g]) => {
    const todayAmt   = g.today.reduce((s, c)   => s + (parseFloat(c.amount) || 0), 0);
    const overdueAmt = g.overdue.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
    return {
      drawer_name:   drawer,
      today_count:   g.today.length,
      today_amount:  todayAmt,
      overdue_count: g.overdue.length,
      overdue_amount: overdueAmt,
      total_amount:  todayAmt + overdueAmt,
      checks:        [...g.today, ...g.overdue],
    };
  });

  return {
    date:          today,
    total:         all.length,
    today_count:   todayChecks.length,
    overdue_count: overdueChecks.length,
    grouped,
    summary,
  };
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

// ══════════════════════════════════════════════════════════
// 刪除 / 清除 / 批次補付款
// ══════════════════════════════════════════════════════════

// ── 合併科目 ──────────────────────────────────────────────
async function mergeSubjects(keepId, mergeIds) {
  // 防呆：確保 keepId 不在被刪清單內
  const safeIds = mergeIds.filter(id => id !== keepId);
  if (safeIds.length === 0) throw new Error('沒有可合併的科目（不能將科目合併到自己）');

  // 把 safeIds 的批次全部改掛到 keepId
  const { error: updateErr } = await supabase
    .from('check_batches')
    .update({ subject_id: keepId })
    .in('subject_id', safeIds);
  if (updateErr) throw updateErr;

  // 刪除被合併的科目（已確保不包含 keepId）
  const { error: delErr } = await supabase
    .from('check_subjects')
    .delete()
    .in('id', safeIds);
  if (delErr) throw delErr;

  // 回傳保留的科目
  const { data: kept } = await supabase
    .from('check_subjects').select('*').eq('id', keepId).single();
  return { kept, merged_count: safeIds.length };
}

async function deleteBatch(id) {
  // 先刪子票（保險起見，DB 若有 cascade 也無妨）
  await supabase.from('checks').delete().eq('batch_id', id);
  const { error } = await supabase.from('check_batches').delete().eq('id', id);
  if (error) throw error;
  return { message: '批次已刪除' };
}

async function clearAll() {
  // 刪全部支票，再刪全部批次
  await supabase.from('checks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { error } = await supabase.from('check_batches').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) throw error;
  return { message: '所有支票資料已清除' };
}

async function bulkPayPast() {
  const today = todayTaipei();

  // 先查出要更新的支票
  const { data: targets, error: qErr } = await supabase
    .from('checks')
    .select('id, batch_id')
    .eq('status', 'pending')
    .lt('due_date', today);
  if (qErr) throw qErr;
  if (!targets || targets.length === 0) return { count: 0, message: '沒有需要補標的過期票' };

  // 批次更新
  const ids = targets.map(c => c.id);
  const { error: updErr } = await supabase
    .from('checks')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .in('id', ids);
  if (updErr) throw updErr;

  // 同步各批次狀態
  const uniqueBatchIds = [...new Set(targets.map(c => c.batch_id).filter(Boolean))];
  for (const bid of uniqueBatchIds) {
    await syncBatchStatus(bid);
  }

  return { count: ids.length, message: `已將 ${ids.length} 張過期票標記為已付款` };
}

module.exports = {
  getSubjects, createSubject, updateSubject,
  getBatches, getBatchById, createBatch, updateBatch, syncBatchStatus,
  payCheck, bounceCheck, voidCheck, updateCheck,
  getTodayDueChecks, getUpcomingChecks,
  getNotifyTargets, createNotifyTarget, updateNotifyTarget, deleteNotifyTarget,
  deleteBatch, clearAll, bulkPayPast, mergeSubjects,
};
