// services/pointRedemptionService.js
// 分數兌換模組 — 商業邏輯（送審制）
//
// 流程：
//   1. 員工申請兌換 → 建立 status=pending 紀錄（不扣分、不扣庫存）→ 通知營運主管
//   2. 營運主管審核通過 → 寫負分回 MAP（setemployeescore）+ 扣庫存 → status=completed → 通知員工
//   3. 駁回 → status=rejected（不扣分）→ 通知員工
//   4. 實體獎品發放 → status=fulfilled
//
// 餘額來源：MAP getemployeescorerecord 全部歷史 score 加總（mapScoreApi.getEmployeeBalance）

const supabase   = require('../config/supabase');
const mapScore   = require('./mapScoreApi');
const linePush   = require('./linePushService');

const ITEM_TYPES = ['physical', 'cash', 'title', 'other'];
const REDEEM_COOLDOWN_MS = 20 * 1000;   // 同一員工兩次申請最短間隔（防連點）
const CASH_RATIO = 100;                 // cash 型品項：1 分 = NT$100 現金（固定）

// 算這筆兌換要寫多少獎金到 MAP（cash 才 > 0）
function calcBonus(item, cost) {
  return item.item_type === 'cash' ? Number(cost) * CASH_RATIO : 0;
}

// ───────────────────────────────────────────────────────────
// 兌換品項目錄
// ───────────────────────────────────────────────────────────
async function listItems({ activeOnly = false } = {}) {
  let q = supabase
    .from('point_redeem_items')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(`讀取兌換品項失敗：${error.message}`);
  return data || [];
}

async function getItem(id) {
  const { data, error } = await supabase
    .from('point_redeem_items')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error('找不到此兌換品項');
  return data;
}

function normalizeItemPayload(p = {}) {
  const out = {};
  if (p.name !== undefined)        out.name        = String(p.name || '').trim();
  if (p.description !== undefined) out.description = p.description ? String(p.description) : null;
  if (p.item_type !== undefined) {
    const t = String(p.item_type || 'physical');
    out.item_type = ITEM_TYPES.includes(t) ? t : 'physical';
  }
  if (p.points_cost !== undefined) out.points_cost = Math.trunc(Number(p.points_cost) || 0);
  if (p.image_url !== undefined)   out.image_url   = p.image_url ? String(p.image_url) : null;
  if (p.stock !== undefined)       out.stock       = (p.stock === null || p.stock === '') ? null : Math.trunc(Number(p.stock) || 0);
  if (p.is_active !== undefined)   out.is_active   = !!p.is_active;
  if (p.sort_order !== undefined)  out.sort_order  = Math.trunc(Number(p.sort_order) || 0);
  if (p.min_balance_after !== undefined) out.min_balance_after = Math.max(0, Math.trunc(Number(p.min_balance_after) || 0));
  return out;
}

async function createItem(payload) {
  const data = normalizeItemPayload(payload);
  if (!data.name)                        throw new Error('品項名稱必填');
  if (!data.points_cost || data.points_cost <= 0) throw new Error('所需分數必須大於 0');
  const { data: row, error } = await supabase
    .from('point_redeem_items')
    .insert(data)
    .select()
    .single();
  if (error) throw new Error(`新增兌換品項失敗：${error.message}`);
  return row;
}

async function updateItem(id, payload) {
  const data = normalizeItemPayload(payload);
  if (data.name !== undefined && !data.name) throw new Error('品項名稱不可為空');
  if (data.points_cost !== undefined && data.points_cost <= 0) throw new Error('所需分數必須大於 0');
  if (Object.keys(data).length === 0) throw new Error('沒有要更新的欄位');
  const { data: row, error } = await supabase
    .from('point_redeem_items')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`更新兌換品項失敗：${error.message}`);
  return row;
}

async function deleteItem(id) {
  const { error } = await supabase
    .from('point_redeem_items')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`刪除兌換品項失敗：${error.message}`);
  return { ok: true };
}

// ───────────────────────────────────────────────────────────
// 員工身份驗證（公開入口用 app_number）
// ───────────────────────────────────────────────────────────
async function verifyEmployee(appNumber) {
  const app = String(appNumber || '').trim();
  if (!app) throw new Error('缺少員工編號 app_number');
  const { data: emp, error } = await supabase
    .from('employees')
    .select('erpid, app_number, name, store_name, is_active')
    .eq('app_number', app)
    .eq('is_active', true)
    .single();
  if (error || !emp)   throw new Error('找不到此員工，或帳號未啟用');
  if (!emp.erpid)      throw new Error('此員工沒有 ERP 編號，無法使用分數兌換');
  return {
    erpid:      String(emp.erpid),
    app_number: emp.app_number,
    name:       emp.name,
    store_name: emp.store_name || null,
  };
}

// ───────────────────────────────────────────────────────────
// 查餘額（直接讀 MAP 歷史加總）
// ───────────────────────────────────────────────────────────
async function getBalance(erpid) {
  return mapScore.getEmployeeBalance(erpid);
}

// ───────────────────────────────────────────────────────────
// 取 MAP 評分紀錄明細（用來比對 MAP 系統累計差異）
//   回傳：{ totalScore, totalBonus, recordCount, records: [...] }
// ───────────────────────────────────────────────────────────
async function getScoreDetail(erpid) {
  const erp = String(erpid || '').trim();
  if (!erp) throw new Error('erpid 必填');
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${mm}-${dd}`;

  const rows = await mapScore.getScoreRecords(erp, '2000-01-01', todayStr);
  const row  = rows.find(r => String(r.employeeErpid) === erp) || rows[0];
  const records = Array.isArray(row?.records) ? row.records : [];
  let totalScore = 0;
  let totalBonus = 0;
  for (const r of records) {
    totalScore += Number(r.score || 0);
    totalBonus += Number(r.bonus || 0);
  }
  return {
    employeeName: row?.employeeName || null,
    totalScore,
    totalBonus,
    recordCount: records.length,
    records,
  };
}

// ───────────────────────────────────────────────────────────
// 兌換紀錄查詢
// ───────────────────────────────────────────────────────────
async function listRedemptions({ erpid, status, limit = 200 } = {}) {
  let q = supabase
    .from('point_redemptions')
    .select('*')
    .order('redeemed_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 1000));
  if (erpid)  q = q.eq('employee_erpid', String(erpid));
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(`讀取兌換紀錄失敗：${error.message}`);
  return data || [];
}

async function getRedemption(id) {
  const { data, error } = await supabase
    .from('point_redemptions')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error('找不到此兌換紀錄');
  return data;
}

// ───────────────────────────────────────────────────────────
// 通知
// ───────────────────────────────────────────────────────────

// 取得營運部主管的 app_number（用於送審通知）
async function getOpsManagerAppNumbers() {
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, role, is_active')
    .in('role', ['operation_lead', 'dept_head', 'super_admin'])
    .eq('is_active', true);
  if (error) {
    console.error('[PointRedemption] 取營運主管清單失敗：', error.message);
    return [];
  }
  return (data || []).map(u => u.member_id).filter(Boolean);
}

// 送審 → 通知營運主管
async function notifyOpsNewRequest(record) {
  try {
    const managers = await getOpsManagerAppNumbers();
    if (managers.length === 0) return;
    const cashLine = record.item_type === 'cash' && record.bonus_amount > 0
      ? `\n現金：NT$${record.bonus_amount}`
      : '';
    const msg =
      `🪙 分數兌換待審核\n` +
      `員工：${record.employee_name}（${record.store_name || '—'}）\n` +
      `品項：${record.item_name}\n` +
      `扣分：${record.points_cost} 分${cashLine}\n\n` +
      `請至營運部系統「分數兌換管理 → 兌換紀錄」審核。`;
    await linePush.pushToUsers(managers, msg);
  } catch (e) {
    console.error('[PointRedemption] 送審通知失敗：', e.message);
  }
}

// 審核通過 → 通知員工
async function notifyEmployeeApproved(record, balanceAfter) {
  try {
    const cashLine = record.item_type === 'cash' && record.bonus_amount > 0
      ? `\n💰 獎金 NT$${record.bonus_amount} 已寫入 MAP`
      : '';
    const physLine = record.item_type === 'physical'
      ? `\n\n實體獎品將另行通知發放。`
      : '';
    const msg =
      `✅ 分數兌換已通過\n` +
      `品項：${record.item_name}\n` +
      `已扣 ${record.points_cost} 分` +
      (balanceAfter != null ? `，剩餘 ${balanceAfter} 分` : '') +
      cashLine + physLine;
    await linePush.pushToUser(record.employee_app_number, msg);
  } catch (e) {
    console.error('[PointRedemption] 通過通知失敗：', e.message);
  }
}

// 駁回 → 通知員工
async function notifyEmployeeRejected(record, reason) {
  try {
    const msg =
      `❌ 分數兌換未通過\n` +
      `品項：${record.item_name}\n` +
      `原因：${reason || '未說明'}\n\n` +
      `分數未扣除，如有疑問請洽營運部。`;
    await linePush.pushToUser(record.employee_app_number, msg);
  } catch (e) {
    console.error('[PointRedemption] 駁回通知失敗：', e.message);
  }
}

// ───────────────────────────────────────────────────────────
// 申請兌換（送審制）
//   1. 驗證員工身份
//   2. 取品項、檢查上架與庫存
//   3. 防連點：同員工 20 秒內不可重複申請
//   4. 查 MAP 餘額（預檢，避免送出註定不足的申請）
//   5. 建立 status=pending 紀錄（不扣分、不扣庫存）
//   6. 通知營運主管
//
//   quantity（選填，預設 1）：兌換倍數。
//     cash 型：總扣分 = item.points_cost × quantity；獎金 = 總扣分 × 100
//     其他型：當作件數（要扣庫存幾件）
// ───────────────────────────────────────────────────────────
async function redeem({ app_number, item_id, quantity = 1 }) {
  const employee = await verifyEmployee(app_number);
  const item     = await getItem(item_id);

  if (!item.is_active) throw new Error('此品項已下架，無法兌換');

  // 數量清洗：必須為正整數
  const qty = Math.max(1, Math.trunc(Number(quantity) || 1));

  if (item.stock !== null && item.stock !== undefined) {
    if (Number(item.stock) <= 0) throw new Error('此品項已無庫存');
    if (Number(item.stock) < qty) throw new Error(`此品項庫存只剩 ${item.stock}，無法一次兌換 ${qty}`);
  }

  // 防連點
  const since = new Date(Date.now() - REDEEM_COOLDOWN_MS).toISOString();
  const { data: recent } = await supabase
    .from('point_redemptions')
    .select('id')
    .eq('employee_erpid', employee.erpid)
    .gte('redeemed_at', since)
    .limit(1);
  if (recent && recent.length > 0) {
    throw new Error('操作太頻繁，請稍候幾秒再試');
  }

  // 預檢餘額（審核時會再檢查一次）
  const balance   = await getBalance(employee.erpid);
  const unitCost  = Number(item.points_cost);
  const cost      = unitCost * qty;                      // 總扣分
  const minAfter  = Math.max(0, Number(item.min_balance_after || 0));
  const remaining = balance.totalScore - cost;

  if (balance.totalScore < cost) {
    throw new Error(`分數不足：目前 ${balance.totalScore} 分，需要 ${cost} 分`);
  }
  if (remaining < minAfter) {
    throw new Error(`此品項兌換後剩餘分數不得低於 ${minAfter} 分（目前 ${balance.totalScore}，兌換後將剩 ${remaining}）`);
  }

  const bonus = calcBonus(item, cost);                   // cash：cost × 100

  // 建立待審紀錄（不扣分、不扣庫存）
  const record = {
    employee_erpid:      employee.erpid,
    employee_app_number: employee.app_number,
    employee_name:       employee.name,
    store_name:          employee.store_name,
    item_id:             item.id,
    item_name:           item.name,
    item_type:           item.item_type,
    quantity:            qty,
    points_cost:         cost,
    bonus_amount:        bonus,
    status:              'pending',
    map_write_status:    null,
    map_write_message:   null,
  };
  const { data: saved, error: insErr } = await supabase
    .from('point_redemptions')
    .insert(record)
    .select()
    .single();
  if (insErr) {
    console.error('[PointRedemption] 申請紀錄寫入失敗：', insErr.message);
    throw new Error('申請寫入失敗，請稍後再試');
  }

  // 通知營運主管（背景進行，不擋使用者）
  notifyOpsNewRequest(saved);

  return {
    redemption:    saved,
    balance_before: balance.totalScore,
  };
}

// ───────────────────────────────────────────────────────────
// 審核通過
//   1. 取紀錄，必須 status=pending
//   2. 重新檢查品項庫存
//   3. 重新查 MAP 餘額是否仍足夠
//   4. 寫負分回 MAP
//   5. 更新紀錄 status=completed，扣庫存
//   6. 通知員工
// ───────────────────────────────────────────────────────────
async function approveRedemption(id, approver) {
  const record = await getRedemption(id);
  if (record.status !== 'pending') {
    throw new Error(`此申請目前狀態為「${record.status}」，無法審核`);
  }

  const item = await getItem(record.item_id).catch(() => null);
  const qty  = Math.max(1, Math.trunc(Number(record.quantity) || 1));
  // 庫存重檢（品項可能已被刪 → item 為 null 則略過庫存檢查）
  if (item && item.stock !== null && item.stock !== undefined) {
    if (Number(item.stock) <= 0)    throw new Error('此品項已無庫存，無法通過');
    if (Number(item.stock) < qty)   throw new Error(`此品項庫存只剩 ${item.stock}，無法通過 ${qty} 件`);
  }

  // 餘額重檢 + 門檻重檢
  const balance = await getBalance(record.employee_erpid);
  const cost    = Number(record.points_cost);
  const minAfter = Math.max(0, Number(item?.min_balance_after || 0));
  const remaining = balance.totalScore - cost;
  if (balance.totalScore < cost) {
    throw new Error(`員工分數不足（目前 ${balance.totalScore} 分，需要 ${cost} 分），無法通過`);
  }
  if (remaining < minAfter) {
    throw new Error(`通過後剩餘分數會低於 ${minAfter} 分（目前 ${balance.totalScore}，剩 ${remaining}），無法通過`);
  }

  // 寫入 MAP：cash 型同時寫負分 + 正獎金
  const bonus = Number(record.bonus_amount || 0);
  const reasontitle = record.item_type === 'cash'
    ? `【獎金兌換】${record.item_name}`
    : `【分數兌換】${record.item_name}`;
  let mapOk = false, mapMsg = '';
  try {
    const r = await mapScore.addScore({
      employeeerpid: record.employee_erpid,
      score:         -Math.abs(cost),
      bonus:         bonus,
      reasonid:      '-1',
      reasontitle,
      editor:        approver || '分數兌換審核',
    });
    mapOk  = true;
    mapMsg = r.message || '寫入成功';
  } catch (e) {
    mapOk  = false;
    mapMsg = e.message || 'MAP 寫入失敗';
  }

  if (!mapOk) {
    // MAP 失敗 → 不改狀態，留 pending 讓主管重試
    throw new Error(`MAP 扣分失敗，未通過：${mapMsg}`);
  }

  // 更新紀錄
  const { data: updated, error: updErr } = await supabase
    .from('point_redemptions')
    .update({
      status:            'completed',
      map_write_status:  'success',
      map_write_message: mapMsg,
      approved_at:       new Date().toISOString(),
      approved_by:       approver || null,
    })
    .eq('id', id)
    .select()
    .single();
  if (updErr) throw new Error(`紀錄更新失敗：${updErr.message}`);

  // 扣庫存（按 quantity 扣）
  if (item && item.stock !== null && item.stock !== undefined) {
    const nextStock = Math.max(0, Number(item.stock) - qty);
    await supabase.from('point_redeem_items').update({ stock: nextStock }).eq('id', item.id);
  }

  // 通知員工
  notifyEmployeeApproved(updated, balance.totalScore - cost);

  return { redemption: updated, balance_after: balance.totalScore - cost };
}

// ───────────────────────────────────────────────────────────
// 駁回
// ───────────────────────────────────────────────────────────
async function rejectRedemption(id, approver, reason) {
  const record = await getRedemption(id);
  if (record.status !== 'pending') {
    throw new Error(`此申請目前狀態為「${record.status}」，無法駁回`);
  }
  const r = String(reason || '').trim();
  if (!r) throw new Error('請填寫駁回原因');

  const { data: updated, error } = await supabase
    .from('point_redemptions')
    .update({
      status:        'rejected',
      reject_reason: r,
      approved_at:   new Date().toISOString(),
      approved_by:   approver || null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`駁回失敗：${error.message}`);

  notifyEmployeeRejected(updated, r);
  return updated;
}

// ───────────────────────────────────────────────────────────
// 實體獎品標記已發放
// ───────────────────────────────────────────────────────────
async function fulfill(id, fulfilledBy) {
  const record = await getRedemption(id);
  if (record.status !== 'completed') {
    throw new Error('只有「已通過」的兌換才能標記發放');
  }
  const { data, error } = await supabase
    .from('point_redemptions')
    .update({
      status:       'fulfilled',
      fulfilled_at: new Date().toISOString(),
      fulfilled_by: fulfilledBy || null,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`標記發放失敗：${error.message}`);
  return data;
}

module.exports = {
  ITEM_TYPES,
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  verifyEmployee,
  getBalance,
  getScoreDetail,
  listRedemptions,
  getRedemption,
  redeem,
  approveRedemption,
  rejectRedemption,
  fulfill,
};
