// routes/hub.js
// AI Hub：跨系統 AI 訊息中樞 API
// 所有 Cowork AI 透過此 API 收發訊息，實現跨系統溝通
// 使用 API Key 驗證（各系統共用同一組 HUB_API_KEY）

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');

// ── API Key 驗證 ─────────────────────────────────────────────
const HUB_API_KEY = process.env.HUB_API_KEY || '';

function verifyHubKey(req, res, next) {
  const key = req.headers['x-hub-key'];
  if (!HUB_API_KEY) {
    return res.status(503).json({ success: false, message: 'AI Hub 尚未設定 HUB_API_KEY' });
  }
  if (key !== HUB_API_KEY) {
    return res.status(401).json({ success: false, message: 'Hub Key 驗證失敗' });
  }
  next();
}

router.use(verifyHubKey);

// ============================================================
// POST /api/hub/send
// 發送訊息
//
// Body:
//   from_system  — 發送方系統代碼（如 market, operation）
//   to_system    — 接收方系統代碼，或 'all' 廣播
//   category     — request / response / notify / sync
//   subject      — 主旨
//   body         — 完整內容（markdown）
//   ref_message_id — 選填，回覆哪則訊息
//   priority     — 選填，low / normal / high / urgent
// ============================================================
router.post('/send', async (req, res) => {
  try {
    const { from_system, to_system, category, subject, body, ref_message_id, priority } = req.body;

    if (!from_system || !to_system || !subject || !body) {
      return res.status(400).json({
        success: false,
        message: '缺少必填欄位：from_system, to_system, subject, body',
      });
    }

    const validCategories = ['request', 'response', 'notify', 'sync'];
    const validPriorities = ['low', 'normal', 'high', 'urgent'];

    const { data, error } = await supabase
      .from('ai_hub_messages')
      .insert({
        from_system,
        to_system,
        category: validCategories.includes(category) ? category : 'request',
        subject,
        body,
        ref_message_id: ref_message_id || null,
        priority: validPriorities.includes(priority) ? priority : 'normal',
      })
      .select()
      .single();

    if (error) {
      console.error('[Hub] 發送失敗:', error.message);
      return res.status(500).json({ success: false, message: '發送失敗：' + error.message });
    }

    // 更新發送方的 last_seen_at
    await supabase
      .from('ai_hub_systems')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', from_system);

    res.json({ success: true, message: '訊息已送出', data });

  } catch (err) {
    console.error('[Hub] send 錯誤:', err.message);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// ============================================================
// GET /api/hub/inbox/:system_id
// 收取訊息（指定系統的收件匣）
//
// Query params:
//   status   — 選填，篩選狀態（unread / read / in_progress / done）
//   category — 選填，篩選分類
//   limit    — 選填，筆數（預設 20）
//   since    — 選填，ISO 時間戳，只看此時間之後的
// ============================================================
router.get('/inbox/:system_id', async (req, res) => {
  try {
    const { system_id } = req.params;
    const { status, category, limit, since } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));

    let query = supabase
      .from('ai_hub_messages')
      .select('*')
      .or(`to_system.eq.${system_id},to_system.eq.all`)
      .order('created_at', { ascending: false })
      .limit(limitNum);

    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    if (since) query = query.gte('created_at', since);

    const { data, error } = await query;
    if (error) {
      console.error('[Hub] inbox 查詢失敗:', error.message);
      return res.status(500).json({ success: false, message: '查詢失敗：' + error.message });
    }

    // 更新 last_seen_at
    await supabase
      .from('ai_hub_systems')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', system_id);

    res.json({
      success: true,
      system_id,
      count: data.length,
      data,
    });

  } catch (err) {
    console.error('[Hub] inbox 錯誤:', err.message);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// ============================================================
// PATCH /api/hub/messages/:id/status
// 更新訊息狀態（已讀、處理中、完成等）
//
// Body:
//   status     — unread / read / in_progress / done / rejected
//   system_id  — 哪個系統在更新（紀錄用）
// ============================================================
router.patch('/messages/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, system_id } = req.body;

    const validStatuses = ['unread', 'read', 'in_progress', 'done', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: '無效的 status' });
    }

    const updates = { status };
    if (status === 'read' || status === 'in_progress') updates.read_at = new Date().toISOString();
    if (status === 'done' || status === 'rejected') updates.resolved_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('ai_hub_messages')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[Hub] 更新狀態失敗:', error.message);
      return res.status(500).json({ success: false, message: '更新失敗：' + error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, message: `找不到訊息 id=${id}` });
    }

    res.json({ success: true, data });

  } catch (err) {
    console.error('[Hub] status 更新錯誤:', err.message);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// ============================================================
// GET /api/hub/thread/:message_id
// 查詢訊息串（一則訊息及其所有回覆）
// ============================================================
router.get('/thread/:message_id', async (req, res) => {
  try {
    const { message_id } = req.params;

    // 原始訊息
    const { data: original, error: origErr } = await supabase
      .from('ai_hub_messages')
      .select('*')
      .eq('id', message_id)
      .single();

    if (origErr || !original) {
      return res.status(404).json({ success: false, message: '找不到此訊息' });
    }

    // 回覆串
    const { data: replies, error: repErr } = await supabase
      .from('ai_hub_messages')
      .select('*')
      .eq('ref_message_id', message_id)
      .order('created_at', { ascending: true });

    if (repErr) {
      console.error('[Hub] thread 查詢失敗:', repErr.message);
    }

    res.json({
      success: true,
      original,
      replies: replies || [],
    });

  } catch (err) {
    console.error('[Hub] thread 錯誤:', err.message);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// ============================================================
// GET /api/hub/systems
// 查詢所有已註冊的系統（含最後上線時間）
// ============================================================
router.get('/systems', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ai_hub_systems')
      .select('*')
      .eq('is_active', true)
      .order('id', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, message: '查詢失敗：' + error.message });
    }

    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// ============================================================
// POST /api/hub/systems/register
// 註冊新系統（或更新現有系統資訊）
// ============================================================
router.post('/systems/register', async (req, res) => {
  try {
    const { id, name, backend_url, description } = req.body;

    if (!id || !name) {
      return res.status(400).json({ success: false, message: '缺少 id 和 name' });
    }

    const { data, error } = await supabase
      .from('ai_hub_systems')
      .upsert({
        id,
        name,
        backend_url: backend_url || null,
        description: description || null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, message: '註冊失敗：' + error.message });
    }

    res.json({ success: true, message: '系統已註冊', data });

  } catch (err) {
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

module.exports = router;
