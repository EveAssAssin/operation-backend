// services/basicDataService.js
// 「基本資料」模組業務邏輯
//   - 分類 / 欄位 / 資料 CRUD
//   - 自動寫 audit log
//   - 變動時自動推播給訂閱者

const supabase = require('../config/supabase');
const { pushToUsers } = require('./linePushService');

// ── 工具 ──────────────────────────────────────────────────────

function tw(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

/**
 * 算兩個 jsonb 物件的差異（給 audit log changes 用）
 * 回傳 { field_key: [oldVal, newVal], ... }
 */
function diffData(oldObj = {}, newObj = {}) {
  const changes = {};
  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const k of keys) {
    const o = oldObj?.[k] ?? null;
    const n = newObj?.[k] ?? null;
    if (JSON.stringify(o) !== JSON.stringify(n)) changes[k] = [o, n];
  }
  return changes;
}

// ── 推播：依事件類型查訂閱者，組訊息，送 LINE ────────────────────
async function notifySubscribers(eventType, message) {
  try {
    const { data: subs, error } = await supabase
      .from('basic_data_notify_subscribers')
      .select('app_number, name, enabled, events')
      .eq('enabled', true);
    if (error) { console.error('[BasicData] 查訂閱者失敗', error.message); return; }

    const targets = (subs || [])
      .filter(s => Array.isArray(s.events) && s.events.includes(eventType))
      .map(s => s.app_number)
      .filter(Boolean);

    if (targets.length === 0) {
      console.log(`[BasicData] 事件 ${eventType} 無訂閱者，不推播`);
      return;
    }

    console.log(`[BasicData] 推播 ${eventType} → ${targets.length} 人`);
    await pushToUsers(targets, message);
  } catch (e) {
    console.error('[BasicData] 推播失敗：', e.message);
  }
}

// ── 寫一筆 audit log + 觸發推播 ──────────────────────────────
async function recordHistory({
  action,            // create / update / delete
  entityType,        // fact / category / field
  entityId,
  categoryId   = null,
  categoryName = null,
  storeErpid   = null,
  storeName    = null,
  changes      = null,
  fullData     = null,
  actor        = null,   // { app_number, name }
  note         = null,
  eventType,             // fact_create / fact_update / fact_delete / meta_change
  pushMessage,           // 推播文字
}) {
  // 1) 寫 history
  await supabase.from('entity_fact_history').insert([{
    action,
    entity_type:      entityType,
    entity_id:        entityId,
    category_id:      categoryId,
    category_name:    categoryName,
    store_erpid:      storeErpid,
    store_name:       storeName,
    changes,
    full_data:        fullData,
    actor_app_number: actor?.app_number || null,
    actor_name:       actor?.name || null,
    note,
  }]);

  // 2) 推播
  if (eventType && pushMessage) {
    await notifySubscribers(eventType, pushMessage);
  }
}

// ════════════════════════════════════════════════════════════
//                          分類
// ════════════════════════════════════════════════════════════

async function listCategories() {
  const { data, error } = await supabase
    .from('entity_fact_categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createCategory({ code, name, icon, sort_order = 0, extra = {} }, actor) {
  if (!code || !name) throw new Error('code / name 必填');
  const { data, error } = await supabase
    .from('entity_fact_categories')
    .insert([{ code, name, icon: icon || null, is_system: false, sort_order, extra }])
    .select()
    .single();
  if (error) throw new Error(error.message);

  await recordHistory({
    action: 'create', entityType: 'category', entityId: data.id,
    categoryId: data.id, categoryName: data.name,
    fullData: data, actor,
    eventType: 'meta_change',
    pushMessage: `📂 [基本資料] ${actor?.name || ''} 新增分類「${data.name}」`,
  });
  return data;
}

async function updateCategory(id, patch, actor) {
  // 拿原本
  const { data: before } = await supabase
    .from('entity_fact_categories').select('*').eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到分類');

  // is_system 的不能改 code，但可以改 name/icon/sort_order/extra
  const allowed = {};
  ['name', 'icon', 'sort_order', 'extra'].forEach(k => {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  });
  if (!before.is_system && patch.code !== undefined) allowed.code = patch.code;

  const { data, error } = await supabase
    .from('entity_fact_categories')
    .update(allowed).eq('id', id).select().single();
  if (error) throw new Error(error.message);

  const changes = diffData(before, data);
  if (Object.keys(changes).length > 0) {
    await recordHistory({
      action: 'update', entityType: 'category', entityId: id,
      categoryId: id, categoryName: data.name,
      changes, actor,
      eventType: 'meta_change',
      pushMessage: `✏️ [基本資料] ${actor?.name || ''} 修改分類「${data.name}」`,
    });
  }
  return data;
}

async function deleteCategory(id, actor) {
  const { data: before } = await supabase
    .from('entity_fact_categories').select('*').eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到分類');
  if (before.is_system) throw new Error('系統預設分類不能刪除');

  const { error } = await supabase.from('entity_fact_categories').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await recordHistory({
    action: 'delete', entityType: 'category', entityId: id,
    categoryId: id, categoryName: before.name,
    fullData: before, actor,
    eventType: 'meta_change',
    pushMessage: `🗑 [基本資料] ${actor?.name || ''} 刪除分類「${before.name}」`,
  });
  return { id };
}

// ════════════════════════════════════════════════════════════
//                          欄位
// ════════════════════════════════════════════════════════════

async function listFields(categoryId) {
  const { data, error } = await supabase
    .from('entity_fact_fields')
    .select('*')
    .eq('category_id', categoryId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createField(categoryId, payload, actor) {
  if (!payload.field_key || !payload.field_label) throw new Error('field_key / field_label 必填');
  const { data: cat } = await supabase.from('entity_fact_categories')
    .select('id, name').eq('id', categoryId).maybeSingle();
  if (!cat) throw new Error('分類不存在');

  const { data, error } = await supabase.from('entity_fact_fields').insert([{
    category_id:   categoryId,
    field_key:     payload.field_key,
    field_label:   payload.field_label,
    field_type:    payload.field_type   || 'text',
    is_required:   !!payload.is_required,
    sort_order:    payload.sort_order   || 0,
    placeholder:   payload.placeholder  || null,
    is_system:     false,
  }]).select().single();
  if (error) throw new Error(error.message);

  await recordHistory({
    action: 'create', entityType: 'field', entityId: data.id,
    categoryId: cat.id, categoryName: cat.name,
    fullData: data, actor,
    eventType: 'meta_change',
    pushMessage: `➕ [基本資料] ${actor?.name || ''} 在「${cat.name}」新增欄位「${data.field_label}」`,
  });
  return data;
}

async function updateField(fieldId, patch, actor) {
  const { data: before } = await supabase
    .from('entity_fact_fields').select('*, category:entity_fact_categories(id, name)')
    .eq('id', fieldId).maybeSingle();
  if (!before) throw new Error('找不到欄位');

  const allowed = {};
  ['field_label', 'field_type', 'is_required', 'sort_order', 'placeholder'].forEach(k => {
    if (patch[k] !== undefined) allowed[k] = patch[k];
  });
  if (!before.is_system && patch.field_key !== undefined) allowed.field_key = patch.field_key;

  const { data, error } = await supabase
    .from('entity_fact_fields').update(allowed).eq('id', fieldId).select().single();
  if (error) throw new Error(error.message);

  const cleanBefore = { ...before }; delete cleanBefore.category;
  const changes = diffData(cleanBefore, data);
  if (Object.keys(changes).length > 0) {
    await recordHistory({
      action: 'update', entityType: 'field', entityId: fieldId,
      categoryId: before.category?.id || before.category_id,
      categoryName: before.category?.name || null,
      changes, actor,
      eventType: 'meta_change',
      pushMessage: `✏️ [基本資料] ${actor?.name || ''} 修改「${before.category?.name || '分類'}」欄位「${data.field_label}」`,
    });
  }
  return data;
}

async function deleteField(fieldId, actor) {
  const { data: before } = await supabase
    .from('entity_fact_fields').select('*, category:entity_fact_categories(id, name)')
    .eq('id', fieldId).maybeSingle();
  if (!before) throw new Error('找不到欄位');
  if (before.is_system) throw new Error('系統預設欄位不能刪除');

  const { error } = await supabase.from('entity_fact_fields').delete().eq('id', fieldId);
  if (error) throw new Error(error.message);

  const cleanBefore = { ...before }; delete cleanBefore.category;
  await recordHistory({
    action: 'delete', entityType: 'field', entityId: fieldId,
    categoryId: before.category?.id || before.category_id,
    categoryName: before.category?.name || null,
    fullData: cleanBefore, actor,
    eventType: 'meta_change',
    pushMessage: `🗑 [基本資料] ${actor?.name || ''} 刪除「${before.category?.name || '分類'}」欄位「${before.field_label}」`,
  });
  return { id: fieldId };
}

// ════════════════════════════════════════════════════════════
//                          資料 facts
// ════════════════════════════════════════════════════════════

async function listFacts({ category_id, store_erpid, keyword }) {
  let q = supabase.from('entity_facts').select('*').order('store_erpid', { ascending: true });
  if (category_id) q = q.eq('category_id', category_id);
  if (store_erpid) q = q.eq('store_erpid', store_erpid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let rows = data || [];
  if (keyword) {
    const k = String(keyword).toLowerCase();
    rows = rows.filter(r => {
      const blob = (r.store_name || '') + ' ' + JSON.stringify(r.data || {}).toLowerCase();
      return blob.toLowerCase().includes(k);
    });
  }
  return rows;
}

async function createFact({ category_id, store_erpid, data, note }, actor) {
  if (!category_id || !store_erpid) throw new Error('category_id / store_erpid 必填');

  // 抓 category + store snapshot
  const [{ data: cat }, { data: store }] = await Promise.all([
    supabase.from('entity_fact_categories').select('id, name').eq('id', category_id).maybeSingle(),
    supabase.from('departments').select('store_erpid, store_name').eq('store_erpid', store_erpid).maybeSingle(),
  ]);
  if (!cat) throw new Error('分類不存在');

  const { data: row, error } = await supabase.from('entity_facts').insert([{
    category_id,
    store_erpid,
    store_name:            store?.store_name || null,
    data:                  data || {},
    note:                  note || null,
    created_by_app_number: actor?.app_number || null,
    updated_by_app_number: actor?.app_number || null,
  }]).select().single();
  if (error) throw new Error(error.message);

  await recordHistory({
    action: 'create', entityType: 'fact', entityId: row.id,
    categoryId: cat.id, categoryName: cat.name,
    storeErpid: row.store_erpid, storeName: row.store_name,
    fullData: row, actor,
    eventType: 'fact_create',
    pushMessage: `📝 [基本資料] ${actor?.name || ''} 新增 ${row.store_name || row.store_erpid}/${cat.name}`,
  });
  return row;
}

async function updateFact(id, patch, actor) {
  const { data: before } = await supabase
    .from('entity_facts').select('*, category:entity_fact_categories(id, name)')
    .eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到資料');

  const updated = { updated_by_app_number: actor?.app_number || null };
  if (patch.data !== undefined) updated.data = patch.data;
  if (patch.note !== undefined) updated.note = patch.note;
  if (patch.store_erpid !== undefined) {
    updated.store_erpid = patch.store_erpid;
    const { data: store } = await supabase.from('departments')
      .select('store_name').eq('store_erpid', patch.store_erpid).maybeSingle();
    updated.store_name = store?.store_name || null;
  }

  const { data: row, error } = await supabase.from('entity_facts')
    .update(updated).eq('id', id).select().single();
  if (error) throw new Error(error.message);

  // diff data + 比 note/store
  const dataChanges = diffData(before.data || {}, row.data || {});
  const meta = {};
  if (before.note !== row.note)               meta.note               = [before.note, row.note];
  if (before.store_erpid !== row.store_erpid) meta.store_erpid        = [before.store_erpid, row.store_erpid];

  const changes = { ...dataChanges, ...meta };
  if (Object.keys(changes).length > 0) {
    // 推播訊息：列出最多 3 個被改的欄位
    const catName  = before.category?.name || '';
    const fieldList = await listFields(before.category_id).catch(() => []);
    const labelMap = Object.fromEntries(fieldList.map(f => [f.field_key, f.field_label]));
    const summary = Object.keys(changes).slice(0, 3)
      .map(k => labelMap[k] || k).join(', ')
      + (Object.keys(changes).length > 3 ? '…' : '');

    await recordHistory({
      action: 'update', entityType: 'fact', entityId: id,
      categoryId: before.category_id, categoryName: catName,
      storeErpid: row.store_erpid, storeName: row.store_name,
      changes, actor,
      eventType: 'fact_update',
      pushMessage: `✏️ [基本資料] ${actor?.name || ''} 修改 ${row.store_name || row.store_erpid}/${catName}\n變動：${summary}`,
    });
  }
  return row;
}

async function deleteFact(id, actor) {
  const { data: before } = await supabase
    .from('entity_facts').select('*, category:entity_fact_categories(id, name)')
    .eq('id', id).maybeSingle();
  if (!before) throw new Error('找不到資料');

  const { error } = await supabase.from('entity_facts').delete().eq('id', id);
  if (error) throw new Error(error.message);

  const cleanBefore = { ...before }; delete cleanBefore.category;
  await recordHistory({
    action: 'delete', entityType: 'fact', entityId: id,
    categoryId: before.category_id, categoryName: before.category?.name || null,
    storeErpid: before.store_erpid, storeName: before.store_name,
    fullData: cleanBefore, actor,
    eventType: 'fact_delete',
    pushMessage: `🗑 [基本資料] ${actor?.name || ''} 刪除 ${before.store_name || before.store_erpid}/${before.category?.name || ''}`,
  });
  return { id };
}

// ════════════════════════════════════════════════════════════
//                          歷史紀錄
// ════════════════════════════════════════════════════════════

async function listHistory({ category_id, store_erpid, limit = 100 }) {
  let q = supabase.from('entity_fact_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(500, Number(limit) || 100));
  if (category_id) q = q.eq('category_id', category_id);
  if (store_erpid) q = q.eq('store_erpid', store_erpid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(h => ({ ...h, created_at_tw: tw(h.created_at) }));
}

// ════════════════════════════════════════════════════════════
//                       推播訂閱
// ════════════════════════════════════════════════════════════

async function listSubscribers() {
  const { data, error } = await supabase
    .from('basic_data_notify_subscribers')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function upsertSubscriber({ app_number, name, enabled = true, events }, actor) {
  if (!app_number) throw new Error('app_number 必填');
  const finalEvents = Array.isArray(events) && events.length
    ? events
    : ['fact_create', 'fact_update', 'fact_delete', 'meta_change'];

  const { data, error } = await supabase
    .from('basic_data_notify_subscribers')
    .upsert([{
      app_number,
      name: name || null,
      enabled,
      events: finalEvents,
    }], { onConflict: 'app_number' })
    .select().single();
  if (error) throw new Error(error.message);
  console.log(`[BasicData] 訂閱者 upsert by ${actor?.name || '?'} → ${app_number}`);
  return data;
}

async function deleteSubscriber(id) {
  const { error } = await supabase
    .from('basic_data_notify_subscribers').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { id };
}

// ════════════════════════════════════════════════════════════
//                       門市/部門選項
// ════════════════════════════════════════════════════════════

async function listStores() {
  const { data, error } = await supabase
    .from('departments')
    .select('store_erpid, store_name, is_active')
    .order('store_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteStore(erpid) {
  const id = String(erpid || '').trim();
  if (!id) throw new Error('erpid 不能空白');

  // 先檢查還有沒有 entity_facts 引用
  const { count, error: cErr } = await supabase
    .from('entity_facts')
    .select('id', { count: 'exact', head: true })
    .eq('store_erpid', id);
  if (cErr) throw new Error(cErr.message);
  if ((count || 0) > 0) {
    throw new Error(`這個門市還有 ${count} 筆資料引用，請先刪除或移動那些資料才能刪除門市`);
  }

  const { error } = await supabase
    .from('departments')
    .delete()
    .eq('store_erpid', id);
  if (error) throw new Error(error.message);
  return { store_erpid: id, deleted: true };
}

async function createStore({ store_erpid, store_name }) {
  const erpid = String(store_erpid || '').trim();
  const name  = String(store_name  || '').trim();
  if (!erpid) throw new Error('store_erpid 不能空白');
  if (!name)  throw new Error('store_name 不能空白');

  // 先檢查有沒有重複
  const { data: existing } = await supabase
    .from('departments')
    .select('store_erpid, store_name')
    .eq('store_erpid', erpid)
    .maybeSingle();
  if (existing) throw new Error(`erpid「${erpid}」已被「${existing.store_name}」使用`);

  const { data, error } = await supabase
    .from('departments')
    .insert({ store_erpid: erpid, store_name: name, is_active: true })
    .select('store_erpid, store_name, is_active')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function listSystemUsers() {
  // 給「推播名單」用 — 列出系統用戶 with app_number
  const { data, error } = await supabase
    .from('system_users')
    .select('member_id, name, role, is_active')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(u => ({
    app_number: u.member_id, name: u.name, role: u.role,
  }));
}

module.exports = {
  // 分類
  listCategories, createCategory, updateCategory, deleteCategory,
  // 欄位
  listFields, createField, updateField, deleteField,
  // 資料
  listFacts, createFact, updateFact, deleteFact,
  // 歷史
  listHistory,
  // 訂閱者
  listSubscribers, upsertSubscriber, deleteSubscriber,
  // 選項
  listStores, createStore, deleteStore, listSystemUsers,
};
