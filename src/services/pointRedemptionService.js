// services/pointRedemptionService.js
// 分數兌換模組 — 商業邏輯
//
// 餘額來源：MAP getemployeescorerecord 全部歷史 score 加總（mapScoreApi.getEmployeeBalance）
// 兌換扣分：MAP setemployeescore 寫一筆負分回 MAP（reasontitle 標「【分數兌換】品名」）
//          本地 point_redemptions 表同步留一筆紀錄供查詢與實體獎品發放追蹤。

const supabase   = require('../config/supabase');
const mapScore   = require('./mapScoreApi');

const ITEM_TYPES = ['physical', 'cash', 'title', 'other'];
const REDEEM_COOLDOWN_MS = 20 * 1000;   // 同一員工兩次兌換最短間隔（防連點重複扣分）

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

// ───────────────────────────────────────────────────────────
// 兌換主流程
//   1. 驗證員工身份（app_number → erpid）
//   2. 取品項、檢查上架與庫存
//   3. 防連點：同員工 20 秒內不可重複兌換
//   4. 查 MAP 餘額，檢查是否足夠
//   5. 寫負分回 MAP（setemployeescore）
//   6. 寫入本地兌換紀錄、扣庫存
// ───────────────────────────────────────────────────────────
async function redeem({ app_number, item_id }) {
  const employee = await verifyEmployee(app_number);
  const item     = await getItem(item_id);

  if (!item.is_active) throw new Error('此品項已下架，無法兌換');
  if (item.stock !== null && item.stock !== undefined && Number(item.stock) <= 0) {
    throw new Error('此品項已無庫存');
  }

  // 防連點：檢查最近一筆兌換時間
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

  // 查餘額
  const balance = await getBalance(employee.erpid);
  const cost    = Number(item.points_cost);
  if (balance.totalScore < cost) {
    throw new Error(`分數不足：目前 ${balance.totalScore} 分，需要 ${cost} 分`);
  }

  // 寫負分回 MAP
  const reasontitle = `【分數兌換】${item.name}`;
  let mapOk = false;
  let mapMsg = '';
  try {
    const r = await mapScore.addScore({
      employeeerpid: employee.erpid,
      score:         -Math.abs(cost),       // 負分＝扣分
      bonus:         0,
      reasonid:      '-1',
      reasontitle,
      editor:        '分數兌換系統',
    });
    mapOk  = true;
    mapMsg = r.message || '寫入成功';
  } catch (e) {
    mapOk  = false;
    mapMsg = e.message || 'MAP 寫入失敗';
  }

  // 寫入本地兌換紀錄
  const record = {
    employee_erpid:      employee.erpid,
    employee_app_number: employee.app_number,
    employee_name:       employee.name,
    store_name:          employee.store_name,
    item_id:             item.id,
    item_name:           item.name,
    item_type:           item.item_type,
    points_cost:         cost,
    status:              mapOk ? 'completed' : 'cancelled',
    map_write_status:    mapOk ? 'success'   : 'failed',
    map_write_message:   mapMsg,
  };
  const { data: saved, error: insErr } = await supabase
    .from('point_redemptions')
    .insert(record)
    .select()
    .single();
  if (insErr) {
    // 紀錄寫不進來但 MAP 已扣分 → 記 log，仍視為失敗讓使用者知道
    console.error('[PointRedemption] 兌換紀錄寫入失敗：', insErr.message, 'MAP 扣分=', mapOk);
    throw new Error('兌換紀錄寫入失敗，請聯繫管理員確認分數');
  }

  // MAP 扣分失敗 → 回報錯誤（紀錄已留存供稽核）
  if (!mapOk) {
    throw new Error(`兌換失敗，分數未扣除：${mapMsg}`);
  }

  // 扣庫存（有設定庫存才扣）
  if (item.stock !== null && item.stock !== undefined) {
    const nextStock = Math.max(0, Number(item.stock) - 1);
    await supabase
      .from('point_redeem_items')
      .update({ stock: nextStock })
      .eq('id', item.id);
  }

  return {
    redemption:    saved,
    balance_after: balance.totalScore - cost,
  };
}

// ───────────────────────────────────────────────────────────
// 實體獎品標記已發放
// ───────────────────────────────────────────────────────────
async function fulfill(id, fulfilledBy) {
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
  listRedemptions,
  redeem,
  fulfill,
};
