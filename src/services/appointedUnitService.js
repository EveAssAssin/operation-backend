// services/appointedUnitService.js
// 特約廠商模組業務邏輯
//   - 同步特約單位 / 廠商員工
//   - 廠商員工綁定（廠商代碼 + 手機末 4 碼）
//   - 廠商管理員綁定（廠商代碼 + 一次性綁定碼）
//   - 推播分眾與發送

const supabase = require('../config/supabase');
const lohas    = require('./lohasWebApi');
const line     = require('./lineMessagingService');

// ─── 工具函式 ─────────────────────────────────────────────────
function tsToISO(ts) {
  // 文件中 contracttime 是 unix timestamp（秒）字串或數字
  if (!ts) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function safeJsonParse(maybeJson, fallback = []) {
  if (Array.isArray(maybeJson) || (maybeJson && typeof maybeJson === 'object')) return maybeJson;
  if (typeof maybeJson !== 'string') return fallback;
  try {
    const v = JSON.parse(maybeJson);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function last4(mobile) {
  if (!mobile) return null;
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

function genBindCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除 I O 0 1
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── 同步：特約單位主表 ────────────────────────────────────────
async function syncAllUnits() {
  const units = await lohas.getAllUnits();
  // 對每筆做 upsert
  let inserted = 0, updated = 0, errors = [];
  for (const u of units) {
    const row = {
      unit_code:      String(u.id),                    // API 23 的 id 對應 unit_code
      unit_name:      u.title || '',
      unit_introduce: u.introduce || null,
      bind_store_ids: safeJsonParse(u.bindstore, []),
      contract_time:  tsToISO(u.contracttime),
      img_id:         u.img_id != null ? String(u.img_id) : null,
      img_path:       u.img_path || null,
      sort_weight:    Number(u.sortweight || 0),
      last_synced_at: new Date().toISOString(),
      last_synced_source: 'getUnitList',
    };
    try {
      const { data: existing } = await supabase
        .from('appointed_units')
        .select('id')
        .eq('unit_code', row.unit_code)
        .maybeSingle();
      if (existing) {
        await supabase.from('appointed_units').update(row).eq('id', existing.id);
        updated++;
      } else {
        await supabase.from('appointed_units').insert([row]);
        inserted++;
      }
    } catch (e) {
      errors.push({ unit_code: row.unit_code, error: e.message });
    }
  }
  return { total: units.length, inserted, updated, errors };
}

// ─── 補資料：用 25 號 API 把 category 補齊 ──────────────────────
async function enrichUnitCategories({ limit = 50 } = {}) {
  // 找出 category_id 還是 null 的單位來補
  const { data: units } = await supabase
    .from('appointed_units')
    .select('id, unit_code')
    .is('category_id', null)
    .limit(limit);
  if (!units || units.length === 0) return { enriched: 0 };
  let enriched = 0;
  for (const u of units) {
    try {
      const list = await lohas.getAppointedUnitByCode({ appointed_unit_code: u.unit_code });
      const detail = Array.isArray(list) ? list[0] : list;
      if (!detail) continue;
      await supabase.from('appointed_units').update({
        category_id:        detail.category_id != null ? String(detail.category_id) : null,
        category_name:      detail.category_name || null,
        unit_name:          detail.unit_name || undefined,
        unit_introduce:     detail.unit_introduce || undefined,
        bind_store_ids:     safeJsonParse(detail.bind_store_ids, []),
        last_synced_at:     new Date().toISOString(),
        last_synced_source: 'getAppointedUnitByCode',
      }).eq('id', u.id);
      enriched++;
    } catch (e) {
      // 單筆失敗不影響其他
      console.warn(`[appointed_units] 補抓 ${u.unit_code} 失敗：`, e.message);
    }
  }
  return { enriched };
}

// ─── 同步：特約單位旗下會員 ────────────────────────────────────
async function syncMembersForUnit(unitCode) {
  const members = await lohas.getAppointedUnitMembers(unitCode);
  let inserted = 0, updated = 0;
  const seenClientIds = new Set();
  for (const m of members) {
    const client_id = String(m.client_id || '').trim();
    if (!client_id) continue;
    seenClientIds.add(client_id);
    const row = {
      unit_code,
      client_id,
      name:           m.name || null,
      mobile:         m.mobile || null,
      mobile_last4:   last4(m.mobile),
      is_active:      true,
      last_synced_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase
      .from('appointed_unit_members')
      .select('id')
      .eq('unit_code', unitCode)
      .eq('client_id', client_id)
      .maybeSingle();
    if (existing) {
      await supabase.from('appointed_unit_members').update(row).eq('id', existing.id);
      updated++;
    } else {
      await supabase.from('appointed_unit_members').insert([row]);
      inserted++;
    }
  }
  // 標記已不在 API 中的會員為 inactive
  const { data: localMembers } = await supabase
    .from('appointed_unit_members')
    .select('id, client_id')
    .eq('unit_code', unitCode)
    .eq('is_active', true);
  let deactivated = 0;
  for (const lm of (localMembers || [])) {
    if (!seenClientIds.has(String(lm.client_id))) {
      await supabase
        .from('appointed_unit_members')
        .update({ is_active: false, last_synced_at: new Date().toISOString() })
        .eq('id', lm.id);
      deactivated++;
    }
  }
  return { unitCode, total: members.length, inserted, updated, deactivated };
}

async function syncAllMembers({ batchSize = 1000 } = {}) {
  const { data: units } = await supabase
    .from('appointed_units')
    .select('unit_code')
    .order('sort_weight', { ascending: false })
    .limit(batchSize);
  const summary = { units: 0, total: 0, inserted: 0, updated: 0, deactivated: 0, errors: [] };
  for (const u of (units || [])) {
    try {
      const r = await syncMembersForUnit(u.unit_code);
      summary.units++;
      summary.total       += r.total;
      summary.inserted    += r.inserted;
      summary.updated     += r.updated;
      summary.deactivated += r.deactivated;
    } catch (e) {
      summary.errors.push({ unit_code: u.unit_code, error: e.message });
    }
  }
  return summary;
}

// ─── 綁定：員工流程（廠商代碼 + 手機末 4 碼）────────────────────
async function bindAsEmployee({ lineUserId, unitCode, mobileLast4, displayName, pictureUrl }) {
  if (!lineUserId || !unitCode || !mobileLast4) {
    return { ok: false, code: 'MISSING', message: '參數不完整' };
  }
  // 檢查是否已綁定
  const { data: existing } = await supabase
    .from('appointed_unit_bindings')
    .select('id, status, unit_code, binding_role')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (existing && existing.status === 'active') {
    return { ok: false, code: 'ALREADY_BOUND', message: '此 LINE 帳號已綁定其他單位', binding: existing };
  }

  // 找廠商
  const { data: unit } = await supabase
    .from('appointed_units')
    .select('id, unit_code, unit_name')
    .eq('unit_code', String(unitCode))
    .maybeSingle();
  if (!unit) return { ok: false, code: 'UNIT_NOT_FOUND', message: '找不到此特約廠商代碼' };

  // 找會員（先看本地，如果找不到就即時打 API 26 補一次）
  let { data: members } = await supabase
    .from('appointed_unit_members')
    .select('id, client_id, name, mobile, mobile_last4, is_active')
    .eq('unit_code', unit.unit_code)
    .eq('mobile_last4', String(mobileLast4))
    .eq('is_active', true);
  if (!members || members.length === 0) {
    try { await syncMembersForUnit(unit.unit_code); } catch (e) { /* 忽略，下面處理 */ }
    const r = await supabase
      .from('appointed_unit_members')
      .select('id, client_id, name, mobile, mobile_last4, is_active')
      .eq('unit_code', unit.unit_code)
      .eq('mobile_last4', String(mobileLast4))
      .eq('is_active', true);
    members = r.data || [];
  }
  if (!members || members.length === 0) {
    return { ok: false, code: 'MOBILE_NOT_MATCH', message: '此手機末 4 碼不在該特約廠商員工名單' };
  }
  if (members.length > 1) {
    // 超過一筆吻合 → 安全考量：不直接讓使用者綁
    return { ok: false, code: 'AMBIGUOUS', message: '末 4 碼有多筆吻合，請改用一次性綁定碼' };
  }
  const member = members[0];

  // 寫入綁定（如果之前 unbound 過，更新該筆）
  const row = {
    line_user_id:       lineUserId,
    line_display_name:  displayName || null,
    line_picture_url:   pictureUrl || null,
    unit_code:          unit.unit_code,
    unit_name_snap:     unit.unit_name,
    binding_role:       'employee',
    client_id:          member.client_id,
    member_name_snap:   member.name,
    member_mobile_snap: member.mobile,
    status:             'active',
    bound_at:           new Date().toISOString(),
    last_active_at:     new Date().toISOString(),
    unbound_at:         null,
    unbound_reason:     null,
  };
  if (existing) {
    await supabase.from('appointed_unit_bindings').update(row).eq('id', existing.id);
  } else {
    await supabase.from('appointed_unit_bindings').insert([row]);
  }
  return { ok: true, role: 'employee', unit: { code: unit.unit_code, name: unit.unit_name }, client_id: member.client_id };
}

// ─── 綁定：管理員流程（廠商代碼 + 一次性綁定碼）─────────────────
async function bindAsAdmin({ lineUserId, unitCode, bindCode, displayName, pictureUrl }) {
  if (!lineUserId || !unitCode || !bindCode) {
    return { ok: false, code: 'MISSING', message: '參數不完整' };
  }
  const { data: existing } = await supabase
    .from('appointed_unit_bindings')
    .select('id, status')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (existing && existing.status === 'active') {
    return { ok: false, code: 'ALREADY_BOUND', message: '此 LINE 帳號已綁定其他單位' };
  }
  const { data: unit } = await supabase
    .from('appointed_units')
    .select('id, unit_code, unit_name')
    .eq('unit_code', String(unitCode))
    .maybeSingle();
  if (!unit) return { ok: false, code: 'UNIT_NOT_FOUND', message: '找不到此特約廠商代碼' };

  // 找有效綁定碼
  const { data: bindCodeRow } = await supabase
    .from('appointed_unit_bind_codes')
    .select('id, unit_code, bind_code, intended_role, expires_at, used_at')
    .eq('unit_code', unit.unit_code)
    .eq('bind_code', String(bindCode).toUpperCase())
    .maybeSingle();
  if (!bindCodeRow) return { ok: false, code: 'CODE_NOT_FOUND', message: '綁定碼錯誤' };
  if (bindCodeRow.used_at) return { ok: false, code: 'CODE_USED', message: '此綁定碼已被使用' };
  if (new Date(bindCodeRow.expires_at).getTime() < Date.now()) {
    return { ok: false, code: 'CODE_EXPIRED', message: '此綁定碼已過期' };
  }

  const role = bindCodeRow.intended_role || 'admin';
  const bindingRow = {
    line_user_id:      lineUserId,
    line_display_name: displayName || null,
    line_picture_url:  pictureUrl || null,
    unit_code:         unit.unit_code,
    unit_name_snap:    unit.unit_name,
    binding_role:      role,
    client_id:         null,
    status:            'active',
    bound_at:          new Date().toISOString(),
    last_active_at:    new Date().toISOString(),
    unbound_at:        null,
    unbound_reason:    null,
  };
  let bindingId;
  if (existing) {
    await supabase.from('appointed_unit_bindings').update(bindingRow).eq('id', existing.id);
    bindingId = existing.id;
  } else {
    const { data: ins } = await supabase.from('appointed_unit_bindings').insert([bindingRow]).select('id').single();
    bindingId = ins.id;
  }
  await supabase.from('appointed_unit_bind_codes').update({
    used_at: new Date().toISOString(),
    used_by_line_user_id: lineUserId,
    used_binding_id: bindingId,
  }).eq('id', bindCodeRow.id);

  return { ok: true, role, unit: { code: unit.unit_code, name: unit.unit_name } };
}

// ─── 解除綁定 ─────────────────────────────────────────────────
async function unbind({ lineUserId, reason }) {
  const { data: existing } = await supabase
    .from('appointed_unit_bindings')
    .select('id, status')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  if (existing.status !== 'active') return { ok: true, message: '已解除' };
  await supabase.from('appointed_unit_bindings').update({
    status: 'unbound',
    unbound_at: new Date().toISOString(),
    unbound_reason: reason || null,
  }).eq('id', existing.id);
  return { ok: true };
}

// ─── 推播：取得收件人列表 ──────────────────────────────────────
async function resolveBroadcastTargets({ target_type, target_unit_codes, target_category_id, target_client_ids, channel }) {
  const lineUserIds = new Set();
  const clientIds   = new Set();
  const lookup = { unit_code_by_line: new Map(), unit_code_by_cid: new Map() };

  // 取出符合條件的綁定 / 會員
  if (channel === 'line_oa' || channel === 'both') {
    let q = supabase.from('appointed_unit_bindings').select('line_user_id, unit_code').eq('status', 'active');
    if (target_type === 'units') q = q.in('unit_code', (target_unit_codes || []).map(String));
    if (target_type === 'category') {
      // 透過 unit_code 配對到 category
      const { data: us } = await supabase
        .from('appointed_units')
        .select('unit_code')
        .eq('category_id', String(target_category_id || ''));
      const codes = (us || []).map(u => u.unit_code);
      if (codes.length === 0) {
        // category 沒對應任何單位 → 沒人可送
        q = q.in('unit_code', ['__none__']);
      } else {
        q = q.in('unit_code', codes);
      }
    }
    if (target_type === 'members') {
      // 用 client_id 找對應的 line_user_id
      q = q.in('client_id', (target_client_ids || []).map(String));
    }
    const { data } = await q;
    for (const r of (data || [])) {
      lineUserIds.add(r.line_user_id);
      lookup.unit_code_by_line.set(r.line_user_id, r.unit_code);
    }
  }

  if (channel === 'lohas_app' || channel === 'both') {
    let q = supabase.from('appointed_unit_members').select('client_id, unit_code').eq('is_active', true);
    if (target_type === 'units')   q = q.in('unit_code', (target_unit_codes || []).map(String));
    if (target_type === 'members') q = q.in('client_id', (target_client_ids || []).map(String));
    if (target_type === 'category') {
      const { data: us } = await supabase
        .from('appointed_units')
        .select('unit_code')
        .eq('category_id', String(target_category_id || ''));
      const codes = (us || []).map(u => u.unit_code);
      q = q.in('unit_code', codes.length ? codes : ['__none__']);
    }
    const { data } = await q;
    for (const r of (data || [])) {
      clientIds.add(r.client_id);
      lookup.unit_code_by_cid.set(r.client_id, r.unit_code);
    }
  }
  return {
    lineUserIds: Array.from(lineUserIds),
    clientIds:   Array.from(clientIds),
    lookup,
  };
}

// ─── 推播：執行（同步呼叫，非常多筆建議改背景）─────────────────
async function executeBroadcast(broadcastId) {
  const { data: bcast } = await supabase
    .from('appointed_unit_broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .single();
  if (!bcast) throw new Error('Broadcast 不存在');
  if (bcast.status !== 'pending') throw new Error(`Broadcast 狀態不是 pending（${bcast.status}）`);

  await supabase.from('appointed_unit_broadcasts').update({
    status: 'sending',
    started_at: new Date().toISOString(),
  }).eq('id', broadcastId);

  let totalTargets = 0, totalSent = 0, totalFailed = 0;
  try {
    const { lineUserIds, clientIds, lookup } = await resolveBroadcastTargets({
      target_type:        bcast.target_type,
      target_unit_codes:  Array.isArray(bcast.target_unit_codes) ? bcast.target_unit_codes : [],
      target_category_id: bcast.target_category_id,
      target_client_ids:  Array.isArray(bcast.target_client_ids) ? bcast.target_client_ids : [],
      channel:            bcast.channel,
    });
    totalTargets = lineUserIds.length + clientIds.length;

    // ── LINE OA 通道 ──────────────────────────────────────────
    if ((bcast.channel === 'line_oa' || bcast.channel === 'both') && lineUserIds.length > 0) {
      const flex = line.broadcastFlex({
        title: bcast.title, message: bcast.message,
        link_url: bcast.link_url, img_url: bcast.img_url,
      });
      // 切批 multicast
      for (let i = 0; i < lineUserIds.length; i += 500) {
        const chunk = lineUserIds.slice(i, i + 500);
        try {
          await line.multicast(chunk, [flex]);
          totalSent += chunk.length;
          // 記每個收件人為 sent
          const rows = chunk.map(uid => ({
            broadcast_id: broadcastId,
            channel: 'line_oa',
            line_user_id: uid,
            unit_code: lookup.unit_code_by_line.get(uid) || null,
            status: 'sent',
            sent_at: new Date().toISOString(),
          }));
          await supabase.from('appointed_unit_broadcast_recipients').insert(rows);
        } catch (e) {
          totalFailed += chunk.length;
          const rows = chunk.map(uid => ({
            broadcast_id: broadcastId,
            channel: 'line_oa',
            line_user_id: uid,
            unit_code: lookup.unit_code_by_line.get(uid) || null,
            status: 'failed',
            error_message: e.message,
          }));
          await supabase.from('appointed_unit_broadcast_recipients').insert(rows);
        }
      }
    }

    // ── 樂活 APP 通道（API 12 multipleLeftMessagePush）───────
    if ((bcast.channel === 'lohas_app' || bcast.channel === 'both') && clientIds.length > 0) {
      // 文件未明示上限，保險起見每批 500
      for (let i = 0; i < clientIds.length; i += 500) {
        const chunk = clientIds.slice(i, i + 500);
        const client_data = chunk.map(cid => ({ client_id: String(cid), url: bcast.link_url || null }));
        try {
          await lohas.multipleLeftMessagePush({
            client_data, title: bcast.title, message: bcast.message, img_url: bcast.img_url,
          });
          totalSent += chunk.length;
          const rows = chunk.map(cid => ({
            broadcast_id: broadcastId,
            channel: 'lohas_app',
            client_id: cid,
            unit_code: lookup.unit_code_by_cid.get(cid) || null,
            status: 'sent',
            sent_at: new Date().toISOString(),
          }));
          await supabase.from('appointed_unit_broadcast_recipients').insert(rows);
        } catch (e) {
          totalFailed += chunk.length;
          const rows = chunk.map(cid => ({
            broadcast_id: broadcastId,
            channel: 'lohas_app',
            client_id: cid,
            unit_code: lookup.unit_code_by_cid.get(cid) || null,
            status: 'failed',
            error_message: e.message,
          }));
          await supabase.from('appointed_unit_broadcast_recipients').insert(rows);
        }
      }
    }

    await supabase.from('appointed_unit_broadcasts').update({
      status: 'done',
      total_targets: totalTargets,
      total_sent: totalSent,
      total_failed: totalFailed,
      finished_at: new Date().toISOString(),
    }).eq('id', broadcastId);

    return { ok: true, totalTargets, totalSent, totalFailed };
  } catch (e) {
    await supabase.from('appointed_unit_broadcasts').update({
      status: 'failed',
      last_error: e.message,
      total_targets: totalTargets,
      total_sent: totalSent,
      total_failed: totalFailed,
      finished_at: new Date().toISOString(),
    }).eq('id', broadcastId);
    throw e;
  }
}

module.exports = {
  // sync
  syncAllUnits,
  enrichUnitCategories,
  syncMembersForUnit,
  syncAllMembers,
  // bind
  bindAsEmployee,
  bindAsAdmin,
  unbind,
  // broadcast
  resolveBroadcastTargets,
  executeBroadcast,
  // utils
  genBindCode,
  last4,
};
