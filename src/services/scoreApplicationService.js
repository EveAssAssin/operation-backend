// services/scoreApplicationService.js
// 分數加分申請 — 業務邏輯
//
// 流程：
//   1. 員工選類型 → 填 reason + 上傳附件 → submitApplication → status=pending
//   2. 主管在後台看到 pending，按通過時可調整 final_score
//      → approveApplication(id, approver, finalScore)
//      → MAP setemployeescore 寫 score=+finalScore + bonus=0 → status=approved
//   3. 駁回時填原因 → rejectApplication(id, approver, reason) → status=rejected
//   4. 通知：申請時通知營運主管；通過/駁回通知員工

const supabase = require('../config/supabase');
const mapScore = require('./mapScoreApi');
const linePush = require('./linePushService');
const { verifyEmployee } = require('./pointRedemptionService');

// ───────────────────────────────────────────────────────────
// 申請類型 CRUD
// ───────────────────────────────────────────────────────────
async function listTypes({ activeOnly = false } = {}) {
  let q = supabase
    .from('score_application_types')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(`讀取申請類型失敗：${error.message}`);
  return data || [];
}

async function getType(id) {
  const { data, error } = await supabase
    .from('score_application_types').select('*').eq('id', id).single();
  if (error || !data) throw new Error('找不到此申請類型');
  return data;
}

function normalizeTypePayload(p = {}) {
  const out = {};
  if (p.name !== undefined)          out.name          = String(p.name || '').trim();
  if (p.description !== undefined)   out.description   = p.description ? String(p.description) : null;
  if (p.default_score !== undefined) out.default_score = Math.max(0, Math.trunc(Number(p.default_score) || 0));
  if (p.is_active !== undefined)     out.is_active     = !!p.is_active;
  if (p.sort_order !== undefined)    out.sort_order    = Math.trunc(Number(p.sort_order) || 0);
  return out;
}

async function createType(payload, user) {
  const data = normalizeTypePayload(payload);
  if (!data.name) throw new Error('類型名稱必填');
  if (data.default_score == null || data.default_score < 0) throw new Error('預設分數需 ≥ 0');
  const row = {
    ...data,
    created_by_id:   user?.id || null,
    created_by_name: user?.name || '營運部',
  };
  const { data: saved, error } = await supabase
    .from('score_application_types').insert(row).select().single();
  if (error) throw new Error(`新增類型失敗：${error.message}`);
  return saved;
}

async function updateType(id, payload) {
  const data = normalizeTypePayload(payload);
  if (data.name !== undefined && !data.name) throw new Error('類型名稱不可為空');
  if (Object.keys(data).length === 0) throw new Error('沒有要更新的欄位');
  data.updated_at = new Date().toISOString();
  const { data: row, error } = await supabase
    .from('score_application_types').update(data).eq('id', id).select().single();
  if (error) throw new Error(`更新類型失敗：${error.message}`);
  return row;
}

async function deleteType(id) {
  const { error } = await supabase.from('score_application_types').delete().eq('id', id);
  if (error) throw new Error(`刪除類型失敗：${error.message}`);
  return { ok: true };
}

// ───────────────────────────────────────────────────────────
// 申請紀錄
// ───────────────────────────────────────────────────────────
async function listApplications({ erpid, status, limit = 200 } = {}) {
  let q = supabase
    .from('score_applications')
    .select('*')
    .order('applied_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 1000));
  if (erpid)  q = q.eq('employee_erpid', String(erpid));
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(`讀取申請紀錄失敗：${error.message}`);
  return data || [];
}

async function getApplication(id) {
  const { data, error } = await supabase
    .from('score_applications').select('*').eq('id', id).single();
  if (error || !data) throw new Error('找不到此申請紀錄');
  return data;
}

// ───────────────────────────────────────────────────────────
// 通知 helper
// ───────────────────────────────────────────────────────────
async function getOpsManagerAppNumbers() {
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, role, is_active')
    .in('role', ['operation_lead', 'dept_head', 'super_admin'])
    .eq('is_active', true);
  if (error) {
    console.error('[ScoreApp] 取營運主管清單失敗：', error.message);
    return [];
  }
  return (data || []).map(u => u.member_id).filter(Boolean);
}

async function notifyOpsNewApplication(record) {
  try {
    const managers = await getOpsManagerAppNumbers();
    if (managers.length === 0) return;
    const att = Array.isArray(record.attachments) ? record.attachments.length : 0;
    const msg =
      `📝 加分申請待審核\n` +
      `員工：${record.employee_name}（${record.store_name || '—'}）\n` +
      `類型：${record.type_name}（預設 ${record.default_score} 分）\n` +
      (record.apply_reason ? `說明：${record.apply_reason}\n` : '') +
      (att > 0 ? `附件：${att} 份\n` : '') +
      `\n請至營運部系統「分數兌換管理 → 加分審核」審核。`;
    await linePush.pushToUsers(managers, msg);
  } catch (e) {
    console.error('[ScoreApp] 送審通知失敗：', e.message);
  }
}

async function notifyEmployeeApproved(record, balanceAfter) {
  try {
    const msg =
      `✅ 加分申請已通過\n` +
      `類型：${record.type_name}\n` +
      `加 ${record.approved_score} 分` +
      (balanceAfter != null ? `，目前總分 ${balanceAfter} 分` : '');
    await linePush.pushToUser(record.employee_app_number, msg);
  } catch (e) {
    console.error('[ScoreApp] 通過通知失敗：', e.message);
  }
}

async function notifyEmployeeRejected(record, reason) {
  try {
    const msg =
      `❌ 加分申請未通過\n` +
      `類型：${record.type_name}\n` +
      `原因：${reason || '未說明'}`;
    await linePush.pushToUser(record.employee_app_number, msg);
  } catch (e) {
    console.error('[ScoreApp] 駁回通知失敗：', e.message);
  }
}

// ───────────────────────────────────────────────────────────
// 提交申請
// ───────────────────────────────────────────────────────────
async function submitApplication({ app_number, type_id, apply_reason, attachments }) {
  const employee = await verifyEmployee(app_number);
  const type     = await getType(type_id);
  if (!type.is_active) throw new Error('此申請類型已停用，無法申請');

  const atts = Array.isArray(attachments) ? attachments : [];
  // 過濾出 valid 的 attachment 物件
  const cleanAtts = atts
    .filter(a => a && typeof a.url === 'string' && a.url)
    .map(a => ({
      url:  String(a.url),
      name: String(a.name || ''),
      mime: String(a.mime || ''),
      size: Number(a.size || 0),
    }));

  const row = {
    type_id:             type.id,
    type_name:           type.name,
    default_score:       Number(type.default_score || 0),
    employee_erpid:      employee.erpid,
    employee_app_number: employee.app_number,
    employee_name:       employee.name,
    store_name:          employee.store_name,
    apply_reason:        apply_reason ? String(apply_reason).trim() : null,
    attachments:         cleanAtts,
    status:              'pending',
  };
  const { data: saved, error } = await supabase
    .from('score_applications').insert(row).select().single();
  if (error) throw new Error(`申請寫入失敗：${error.message}`);

  notifyOpsNewApplication(saved);
  return saved;
}

// ───────────────────────────────────────────────────────────
// 審核通過：可調整最終加分
// ───────────────────────────────────────────────────────────
async function approveApplication(id, approver, finalScore) {
  const record = await getApplication(id);
  if (record.status !== 'pending') {
    throw new Error(`此申請狀態為「${record.status}」，無法審核`);
  }
  const score = Math.trunc(Number(finalScore));
  if (!Number.isFinite(score) || score <= 0) {
    throw new Error('加分數值必須是大於 0 的整數');
  }

  // 寫正分到 MAP
  const reasontitle = `【加分申請】${record.type_name}`;
  let mapOk = false, mapMsg = '';
  try {
    const r = await mapScore.addScore({
      employeeerpid: record.employee_erpid,
      score:         score,
      bonus:         0,
      reasonid:      '-1',
      reasontitle,
      editor:        approver || '加分審核',
    });
    mapOk  = true;
    mapMsg = r.message || '寫入成功';
  } catch (e) {
    mapOk  = false;
    mapMsg = e.message || 'MAP 寫入失敗';
  }
  if (!mapOk) throw new Error(`MAP 寫入失敗，未通過：${mapMsg}`);

  const { data: updated, error } = await supabase
    .from('score_applications')
    .update({
      status:            'approved',
      approved_score:    score,
      approved_by:       approver || null,
      approved_at:       new Date().toISOString(),
      map_write_status:  'success',
      map_write_message: mapMsg,
      updated_at:        new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`紀錄更新失敗：${error.message}`);

  // 通知員工（順便撈一下最新餘額）
  try {
    const bal = await mapScore.getEmployeeBalance(record.employee_erpid);
    notifyEmployeeApproved(updated, bal?.totalScore);
  } catch {
    notifyEmployeeApproved(updated, null);
  }

  return updated;
}

// ───────────────────────────────────────────────────────────
// 駁回
// ───────────────────────────────────────────────────────────
async function rejectApplication(id, approver, reason) {
  const record = await getApplication(id);
  if (record.status !== 'pending') {
    throw new Error(`此申請狀態為「${record.status}」，無法駁回`);
  }
  const r = String(reason || '').trim();
  if (!r) throw new Error('請填寫駁回原因');

  const { data: updated, error } = await supabase
    .from('score_applications')
    .update({
      status:       'rejected',
      reject_reason: r,
      approved_by:  approver || null,
      approved_at:  new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`駁回失敗：${error.message}`);

  notifyEmployeeRejected(updated, r);
  return updated;
}

module.exports = {
  // types
  listTypes,
  getType,
  createType,
  updateType,
  deleteType,
  // applications
  listApplications,
  getApplication,
  submitApplication,
  approveApplication,
  rejectApplication,
};
