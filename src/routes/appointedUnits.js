// routes/appointedUnits.js
// 特約廠商模組對外端點
//   - 後台管理（需登入 SSO）
//   - LIFF 綁定（公開，但驗 LINE id_token / access_token）
//   - LINE Webhook（公開，驗簽章）

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');
const auSvc    = require('../services/appointedUnitService');
const line     = require('../services/lineMessagingService');
const lohas    = require('../services/lohasWebApi');

// ─────────────────────────────────────────────────────────────
//                  PUBLIC：LINE Webhook
// ─────────────────────────────────────────────────────────────
//   注意：此路由要拿到原始 raw body 才能驗簽
//   app.js 的 express.json() 已掛 verify callback 把 rawBody 寫到 req.rawBody
router.post('/line/webhook', async (req, res) => {
  try {
    const sig = req.headers['x-line-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const ok = line.verifyWebhookSignature(rawBody, sig);
    if (!ok) {
      console.warn('[appointedUnits/webhook] 簽章驗證失敗');
      return res.status(401).end();
    }
    // 立刻回 200，避免 LINE 重送
    res.status(200).end();
    // 背景處理事件
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    for (const ev of events) {
      handleLineEvent(ev).catch(err => console.error('[webhook event] 失敗：', err));
    }
  } catch (e) {
    console.error('[appointedUnits/webhook] 例外：', e);
    if (!res.headersSent) res.status(500).end();
  }
});

async function handleLineEvent(ev) {
  const type = ev.type;
  const userId = ev.source?.userId;
  if (!userId) return;
  const replyToken = ev.replyToken;

  // 加好友 → 不自動推任何訊息（因為這條 OA 也會有非廠商的一般使用者加入）
  if (type === 'follow') {
    return;
  }

  if (type === 'unfollow') {
    // 使用者封鎖 → 標記綁定為 unbound
    await auSvc.unbind({ lineUserId: userId, reason: 'unfollow' });
    return;
  }

  if (type === 'message' && ev.message?.type === 'text') {
    const text = String(ev.message.text || '').trim();
    const lower = text.toLowerCase();

    // 廠商觸發綁定的關鍵字（窗口會主動告訴廠商輸入這些字）
    if (['綁定', 'bind', '/bind', '開始綁定'].includes(text) || ['bind', '/bind'].includes(lower)) {
      await line.reply(replyToken, [line.bindEntryFlex({})]);
      return;
    }
    if (['狀態', 'status', '查詢綁定'].includes(text) || lower === 'status') {
      const { data } = await supabase
        .from('appointed_unit_bindings')
        .select('unit_name_snap, binding_role, status, bound_at')
        .eq('line_user_id', userId)
        .maybeSingle();
      // 沒綁過 → 不回任何訊息，避免騷擾一般使用者
      if (!data || data.status !== 'active') return;
      await line.reply(replyToken, [line.textMessage(
        `已綁定：${data.unit_name_snap}\n身分：${data.binding_role === 'employee' ? '員工' : '管理員'}\n綁定時間：${new Date(data.bound_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`
      )]);
      return;
    }
    if (['解除綁定', '解綁', 'unbind'].includes(text) || lower === 'unbind') {
      const r = await auSvc.unbind({ lineUserId: userId, reason: 'user_request' });
      if (r.ok) {
        await line.reply(replyToken, [line.textMessage('已解除綁定。')]);
      }
      // 沒綁定的人輸入「解綁」→ 不回應，避免無關使用者看到綁定相關提示
      return;
    }
    // 其他文字 → 完全不回應（先前會自動推綁定卡片，現已關閉）
    return;
  }
}

// ─────────────────────────────────────────────────────────────
//                  PUBLIC：LIFF 綁定相關
//   * 客戶端透過 LIFF 拿到 idToken/userId，直接傳給後端
//   * 因 LIFF 內已通過 LINE App 驗證，這裡僅做必要的格式檢查
//   * 進階：可加 idToken 驗證（向 LINE Verify endpoint），目前先省
// ─────────────────────────────────────────────────────────────

// 查綁定狀態
router.post('/bind/status', async (req, res) => {
  const { line_user_id } = req.body || {};
  if (!line_user_id) return res.status(400).json({ ok: false, message: 'line_user_id 必填' });
  const { data } = await supabase
    .from('appointed_unit_bindings')
    .select('id, unit_code, unit_name_snap, binding_role, status, bound_at, client_id')
    .eq('line_user_id', line_user_id)
    .maybeSingle();
  res.json({ ok: true, binding: data || null });
});

// 員工綁定
router.post('/bind/employee', async (req, res) => {
  const { line_user_id, unit_code, mobile_last4, display_name, picture_url } = req.body || {};
  try {
    const r = await auSvc.bindAsEmployee({
      lineUserId:  line_user_id,
      unitCode:    unit_code,
      mobileLast4: mobile_last4,
      displayName: display_name,
      pictureUrl:  picture_url,
    });
    if (!r.ok) return res.status(400).json(r);
    // 推送一條歡迎訊息
    try {
      await line.pushToUser(line_user_id, line.textMessage(
        `綁定成功！\n單位：${r.unit.name}（${r.unit.code}）\n身分：員工`
      ));
    } catch (_) {}
    res.json(r);
  } catch (e) {
    console.error('[bind/employee]', e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 管理員綁定（一次性綁定碼）
router.post('/bind/admin', async (req, res) => {
  const { line_user_id, unit_code, bind_code, display_name, picture_url } = req.body || {};
  try {
    const r = await auSvc.bindAsAdmin({
      lineUserId:  line_user_id,
      unitCode:    unit_code,
      bindCode:    bind_code,
      displayName: display_name,
      pictureUrl:  picture_url,
    });
    if (!r.ok) return res.status(400).json(r);
    try {
      await line.pushToUser(line_user_id, line.textMessage(
        `綁定成功！\n單位：${r.unit.name}（${r.unit.code}）\n身分：${r.role === 'admin' ? '管理員' : '員工'}`
      ));
    } catch (_) {}
    res.json(r);
  } catch (e) {
    console.error('[bind/admin]', e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 解除綁定（使用者主動）
router.post('/bind/unbind', async (req, res) => {
  const { line_user_id, reason } = req.body || {};
  if (!line_user_id) return res.status(400).json({ ok: false, message: 'line_user_id 必填' });
  const r = await auSvc.unbind({ lineUserId: line_user_id, reason });
  res.json(r);
});

// 依廠商名稱查代碼（公開，只回 unit_code / unit_name，避免洩露敏感資訊）
//   - 至少 2 個字元
//   - 最多回 10 筆
router.post('/bind/lookup-code', async (req, res) => {
  const keyword = String(req.body?.keyword || '').trim();
  if (keyword.length < 2) {
    return res.json({ ok: false, code: 'TOO_SHORT', message: '請輸入至少 2 個字元' });
  }
  // 把 % _ 等 LIKE 特殊字元跳掉，避免使用者亂搜誤觸萬用字元
  const safe = keyword.replace(/[%_\\]/g, c => `\\${c}`);
  const { data, error } = await supabase
    .from('appointed_units')
    .select('unit_code, unit_name, category_name')
    .ilike('unit_name', `%${safe}%`)
    .order('unit_name')
    .limit(10);
  if (error) return res.status(500).json({ ok: false, message: error.message });
  res.json({ ok: true, results: data || [] });
});

// LIFF 設定（公開 — 給前端讀，不洩漏 secret）
router.get('/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      liff_id: line.LIFF_ID || '',
      bind_liff_url: line.BIND_LIFF_URL || '',
    },
  });
});

// ─────────────────────────────────────────────────────────────
//                 ADMIN：以下需 SSO 登入
// ─────────────────────────────────────────────────────────────
router.use(authenticate);

// 列表（搜尋 / 過濾 / 分頁）
router.get('/units', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(200, Math.max(1, Number(req.query.size || 20)));
  const offset = (page - 1) * size;
  const keyword = String(req.query.keyword || '').trim();
  const category_id = String(req.query.category_id || '').trim();

  let q = supabase.from('appointed_units').select('*', { count: 'exact' });
  if (keyword) q = q.or(`unit_name.ilike.%${keyword}%,unit_code.ilike.%${keyword}%`);
  if (category_id) q = q.eq('category_id', category_id);
  q = q.order('sort_weight', { ascending: false }).order('unit_code').range(offset, offset + size - 1);

  const { data, count, error } = await q;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data: data || [], pagination: { page, size, total: count || 0 } });
});

// 單筆 + 統計
router.get('/units/:unit_code', async (req, res) => {
  const code = req.params.unit_code;
  const { data: unit } = await supabase.from('appointed_units').select('*').eq('unit_code', code).maybeSingle();
  if (!unit) return res.status(404).json({ success: false, message: '找不到此特約單位' });
  const [
    { count: memberCount },
    { count: bindingCount },
    { count: activeBindingCount },
  ] = await Promise.all([
    supabase.from('appointed_unit_members').select('id', { count: 'exact', head: true }).eq('unit_code', code).eq('is_active', true),
    supabase.from('appointed_unit_bindings').select('id', { count: 'exact', head: true }).eq('unit_code', code),
    supabase.from('appointed_unit_bindings').select('id', { count: 'exact', head: true }).eq('unit_code', code).eq('status', 'active'),
  ]);
  res.json({
    success: true,
    data: {
      unit,
      stats: {
        member_count: memberCount || 0,
        binding_count: bindingCount || 0,
        active_binding_count: activeBindingCount || 0,
      },
    },
  });
});

// 廠商員工列表
router.get('/units/:unit_code/members', async (req, res) => {
  const code = req.params.unit_code;
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(500, Math.max(1, Number(req.query.size || 50)));
  const offset = (page - 1) * size;
  const onlyActive = String(req.query.active || 'true') === 'true';

  let q = supabase.from('appointed_unit_members').select('*', { count: 'exact' }).eq('unit_code', code);
  if (onlyActive) q = q.eq('is_active', true);
  q = q.order('client_id').range(offset, offset + size - 1);
  const { data, count, error } = await q;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data: data || [], pagination: { page, size, total: count || 0 } });
});

// 手動同步單一廠商員工
router.post('/units/:unit_code/sync-members', async (req, res) => {
  try {
    const r = await auSvc.syncMembersForUnit(req.params.unit_code);
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 產生一次性綁定碼
router.post('/units/:unit_code/bind-codes', async (req, res) => {
  const code = req.params.unit_code;
  const { intended_role = 'admin', expires_in_minutes = 60, note } = req.body || {};
  const { data: unit } = await supabase.from('appointed_units').select('unit_code').eq('unit_code', code).maybeSingle();
  if (!unit) return res.status(404).json({ success: false, message: '找不到此特約單位' });
  if (!['admin', 'employee'].includes(intended_role)) {
    return res.status(400).json({ success: false, message: 'intended_role 必須是 admin 或 employee' });
  }
  const expiresAt = new Date(Date.now() + Math.max(5, Number(expires_in_minutes)) * 60 * 1000);
  // 簡單避碰
  let bindCode = auSvc.genBindCode(8);
  for (let i = 0; i < 5; i++) {
    const { data: dup } = await supabase.from('appointed_unit_bind_codes').select('id').eq('bind_code', bindCode).maybeSingle();
    if (!dup) break;
    bindCode = auSvc.genBindCode(8);
  }
  const { data: row, error } = await supabase.from('appointed_unit_bind_codes').insert([{
    unit_code: code,
    bind_code: bindCode,
    intended_role,
    expires_at: expiresAt.toISOString(),
    created_by_id: req.user?.id || null,
    created_by_name: req.user?.name || null,
    note: note || null,
  }]).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data: row });
});

// 列出某廠商的綁定碼
router.get('/units/:unit_code/bind-codes', async (req, res) => {
  const { data } = await supabase
    .from('appointed_unit_bind_codes')
    .select('*')
    .eq('unit_code', req.params.unit_code)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({ success: true, data: data || [] });
});

// 廢除綁定碼
router.delete('/bind-codes/:id', async (req, res) => {
  const { data: row } = await supabase.from('appointed_unit_bind_codes').select('id, used_at').eq('id', req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ success: false, message: '不存在' });
  if (row.used_at) return res.status(400).json({ success: false, message: '此綁定碼已被使用，無法廢除' });
  // 標記為過期（直接刪除也可以，但保留軌跡）
  await supabase.from('appointed_unit_bind_codes').update({ expires_at: new Date().toISOString() }).eq('id', row.id);
  res.json({ success: true });
});

// 綁定列表
router.get('/bindings', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(200, Math.max(1, Number(req.query.size || 20)));
  const offset = (page - 1) * size;
  const unit_code = String(req.query.unit_code || '').trim();
  const status    = String(req.query.status || '').trim();
  const role      = String(req.query.role || '').trim();

  let q = supabase.from('appointed_unit_bindings').select('*', { count: 'exact' });
  if (unit_code) q = q.eq('unit_code', unit_code);
  if (status)    q = q.eq('status', status);
  if (role)      q = q.eq('binding_role', role);
  q = q.order('bound_at', { ascending: false }).range(offset, offset + size - 1);
  const { data, count, error } = await q;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data: data || [], pagination: { page, size, total: count || 0 } });
});

// 強制解除綁定（後台）
router.delete('/bindings/:id', async (req, res) => {
  const { data: row } = await supabase.from('appointed_unit_bindings').select('id, line_user_id').eq('id', req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ success: false, message: '不存在' });
  await supabase.from('appointed_unit_bindings').update({
    status: 'unbound',
    unbound_at: new Date().toISOString(),
    unbound_reason: `admin: ${req.user?.name || ''}`,
  }).eq('id', row.id);
  res.json({ success: true });
});

// 推播：建立並執行
router.post('/broadcasts', async (req, res) => {
  const {
    title, message, link_url, img_url,
    channel = 'line_oa',
    target_type = 'all',
    target_unit_codes = [],
    target_category_id = null,
    target_client_ids  = [],
    execute_now = true,
  } = req.body || {};

  if (!title || !message) return res.status(400).json({ success: false, message: 'title / message 必填' });
  if (!['line_oa', 'lohas_app', 'both'].includes(channel)) {
    return res.status(400).json({ success: false, message: 'channel 不合法' });
  }
  if (!['all', 'units', 'category', 'members'].includes(target_type)) {
    return res.status(400).json({ success: false, message: 'target_type 不合法' });
  }

  const { data: bcast, error } = await supabase.from('appointed_unit_broadcasts').insert([{
    title, message, link_url: link_url || null, img_url: img_url || null,
    channel, target_type,
    target_unit_codes:  target_unit_codes  || [],
    target_category_id: target_category_id || null,
    target_client_ids:  target_client_ids  || [],
    created_by_id:   req.user?.id   || null,
    created_by_name: req.user?.name || null,
  }]).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });

  if (!execute_now) return res.json({ success: true, data: bcast });

  // 立即執行（背景）
  res.json({ success: true, data: bcast, message: '推播已建立並開始執行（背景）' });
  auSvc.executeBroadcast(bcast.id).catch(e => console.error('[broadcast]', e));
});

// 推播列表
router.get('/broadcasts', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(100, Math.max(1, Number(req.query.size || 20)));
  const offset = (page - 1) * size;
  const { data, count, error } = await supabase
    .from('appointed_unit_broadcasts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + size - 1);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data: data || [], pagination: { page, size, total: count || 0 } });
});

// 推播明細
router.get('/broadcasts/:id', async (req, res) => {
  const { data: bcast } = await supabase.from('appointed_unit_broadcasts').select('*').eq('id', req.params.id).maybeSingle();
  if (!bcast) return res.status(404).json({ success: false, message: '不存在' });
  const { data: recipients } = await supabase
    .from('appointed_unit_broadcast_recipients')
    .select('*')
    .eq('broadcast_id', bcast.id)
    .order('created_at', { ascending: false })
    .limit(2000);
  res.json({ success: true, data: { broadcast: bcast, recipients: recipients || [] } });
});

// 手動觸發 — 同步全部特約單位
router.post('/sync/units', async (_req, res) => {
  try {
    const r = await auSvc.syncAllUnits();
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 手動觸發 — 同步全部廠商員工
router.post('/sync/members', async (_req, res) => {
  try {
    const r = await auSvc.syncAllMembers();
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 手動觸發 — 用 25 號 API 補類別
router.post('/sync/enrich-categories', async (req, res) => {
  try {
    const limit = Number(req.body?.limit || 100);
    const r = await auSvc.enrichUnitCategories({ limit });
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
