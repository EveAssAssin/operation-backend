// services/checkService.js
// 支票紀錄系統服務層（v2 schema）

const supabase = require('../config/supabase');
const XLSX     = require('xlsx');
const { prevWorkingDay } = require('./taiwanHolidayService');

// ── 出款人 → 甲存帳號 對照 ────────────────────────────────
// 高銀 016 / 分行 2184；三信暫無資料（先留空）
const DRAWER_ACCOUNTS = {
  '高銀|黃信儒': { account: '218101114762', bankCode: '016', branch: '2184' },
  '高銀|黃志雄': { account: '218101110643', bankCode: '016', branch: '2184' },
};
function lookupDrawerAccount(bankName, drawerName) {
  return DRAWER_ACCOUNTS[`${bankName}|${drawerName}`] || { account: '', bankCode: '', branch: '' };
}

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

// 回傳樹狀結構：[{ ...category, children: [...subjects] }]
async function getSubjectsTree() {
  const { data, error } = await supabase
    .from('check_subjects')
    .select('*')
    .order('name');
  if (error) throw error;

  const categories = (data || []).filter(s => !s.parent_id);
  const children   = (data || []).filter(s => !!s.parent_id);

  return categories.map(cat => ({
    ...cat,
    children: children.filter(c => c.parent_id === cat.id),
  }));
}

async function createSubject(name, parentId = null) {
  const { data, error } = await supabase
    .from('check_subjects')
    .insert({ name: name.trim(), parent_id: parentId || null })
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
  // upsert：同一 app_number 重複新增時改為更新，不報錯
  const { data, error } = await supabase
    .from('check_notify_targets')
    .upsert(payload, { onConflict: 'app_number' })
    .select().single();
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

// ══════════════════════════════════════════════════════════
// 續票提醒
// 條件：renewal_needed=true + 進行中 + 剩最後 1 張待出款
// ══════════════════════════════════════════════════════════
async function getRenewalReminders() {
  const { data, error } = await supabase
    .from('check_batches')
    .select(`
      *,
      subject:check_subjects(id, name),
      checks(id, seq_no, amount, due_date, status)
    `)
    .eq('renewal_needed', true)
    .eq('status', 'active')   // 只看進行中的批次
    .order('created_at', { ascending: false });
  if (error) throw error;
  // 只回傳「剩最後 1 張待出款」的批次
  return (data || []).filter(b => {
    const pendingCount = (b.checks || []).filter(c => c.status === 'pending').length;
    return pendingCount === 1;
  });
}

// ── 產出本月元大匯款 Excel ────────────────────────────────
async function exportEltonBatchForMonth(yearMonth, checkIds = null) {
  let q = supabase
    .from('checks')
    .select(`
      id, seq_no, amount, due_date, status, notes,
      check_batches (
        id, batch_no, drawer_name, bank_name, check_count, notes,
        check_subjects ( id, name )
      )
    `)
    .order('due_date', { ascending: true });

  if (Array.isArray(checkIds) && checkIds.length > 0) {
    q = q.in('id', checkIds);
  } else {
    const [y, m] = yearMonth.split('-').map(Number);
    const firstDay = `${yearMonth}-01`;
    const lastDay  = `${yearMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    q = q.gte('due_date', firstDay).lte('due_date', lastDay).eq('status', 'pending');
  }
  const { data: checks, error } = await q;
  if (error) throw new Error(error.message);

  const { data: payer, error: pErr } = await supabase
    .from('company_profile')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!payer) throw new Error('請先到「公司資料」頁設定付款方資料');

  const items = (checks || []).map(ch => {
    const b = ch.check_batches || {};
    const subject = b.check_subjects?.name || '';
    const acc = lookupDrawerAccount(b.bank_name || '', b.drawer_name || '');
    const memo = (b.notes && b.notes.trim()) ||
                 `${subject}${b.check_count ? b.check_count : ''}${b.check_count ? '-' : ''}${ch.seq_no}`;
    return {
      due_date:     ch.due_date,
      amount:       Number(ch.amount),
      account_no:   acc.account,
      account_name: b.drawer_name || '',
      bank_code:    acc.bankCode,
      branch_code:  acc.branch,
      memo,
    };
  });

  const firstDue = items[0]?.due_date || `${yearMonth}-15`;
  const paymentDateYmd = String(firstDue).replace(/-/g, '');

  const data = [];
  data.push([]);
  data.push([]);
  data.push(['', '', '', '付款日期', '付款帳號', '付款戶名', '付款總行', '付款分行', '逾時處理指示',
             '', '', '', '', '', '', 'V20130123版']);
  data.push(['', '', '',
    paymentDateYmd,
    payer.payer_account_no   || '',
    payer.payer_account_name || '',
    payer.payer_bank_code    || '',
    payer.payer_branch_code  || '',
    payer.default_overdue_code || '1',
  ]);
  data.push([]);
  data.push([
    '', '', '日期', '收款金額', '收款帳號', '收款戶名', '收款總行', '收款分行',
    '識別碼類別', '識別碼', '手續費負擔別', '通知方式',
    'FAX傳真號碼', 'E-mail Address', 'FXML URL', '銷帳參考資料', '附言',
  ]);
  data.push([
    '', '', '', 38, '00000000000001', '王大明', '806', '0998', '53', 'A123456789',
    '15', '0', '', '', '', '', '範本資料，勿刪除！',
  ]);

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
      payer.default_fee_burden    || '15',
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
    filename: `${yearMonth}_元大支票_出款.xlsx`,
    count:    items.length,
  };
}


module.exports = {
  getSubjects, createSubject, updateSubject,
  getBatches, getBatchById, createBatch, updateBatch, syncBatchStatus,
  payCheck, bounceCheck, voidCheck, updateCheck,
  getTodayDueChecks, getUpcomingChecks,
  getNotifyTargets, createNotifyTarget, updateNotifyTarget, deleteNotifyTarget,
  deleteBatch, clearAll, bulkPayPast, mergeSubjects,
  getSubjectsTree, getRenewalReminders,
  exportEltonBatchForMonth,
};
