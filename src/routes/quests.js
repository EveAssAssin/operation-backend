// routes/quests.js
// 任務派發模組 — 營運部 → 市場部
// 1. 建立任務：寫入本地 quests + 同步打市場部 /api/internal/quest/create
// 2. 列表 / 詳情：讀本地 quests
// 3. 重送：失敗的任務可再打一次
// 4. Groups：代理市場部 /api/internal/quest/groups（給前端 dropdown）
//
// 需登入（authenticate 在 app.js 統一掛）；本檔只控角色

const express   = require('express');
const router    = express.Router();
const supabase  = require('../config/supabase');
const { authorize } = require('../middleware/auth');
const marketQuest   = require('../services/marketQuestClient');

// 角色：營運部員工以上可建任務
router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ── 工具 ──────────────────────────────────────────────────────
function ok(res, data)        { res.json({ success: true, data }); }
function bad(res, msg, code = 400) { res.status(code).json({ success: false, message: msg }); }
function fail(res, e, prefix = 'Quests') {
  console.error(`[${prefix}]`, e.message);
  const status  = e.response?.status  || 500;
  const message = e.response?.data?.message || e.response?.data?.detail || e.message;
  res.status(status).json({ success: false, message });
}

function buildMarketPayload(quest, user) {
  return {
    title:               quest.title,
    description:         quest.description || '',
    task_deadline:       quest.task_deadline,
    source_system:       'operation',
    source_system_name:  '營運部系統',
    created_by_name:     user?.name || '營運部',
    external_id:         quest.id,
    award_points:        quest.award_points !== false,
    assignees:           quest.assignees,
    required_submission: quest.required_submission || ['text'],
  };
}

// ════════════════════════════════════════════════════════════
// GET /api/quests/groups
// 代理市場部「列出 employee_groups」
// query: include_members=1 → 順便帶回每組成員清單
// ════════════════════════════════════════════════════════════
router.get('/groups', async (req, res) => {
  try {
    const includeMembers = req.query.include_members === '1' || req.query.include_members === 'true';
    const data = await marketQuest.listGroups({ includeMembers });
    // 直接把市場部回應透傳：{ success, data: [...] }
    res.json(data);
  } catch (e) { fail(res, e, 'Quests/Groups'); }
});

// ════════════════════════════════════════════════════════════
// GET /api/quests
// 列出本地（營運部）發出的任務
// query: status, limit (預設 50)
// ════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    let q = supabase
      .from('quests')
      .select('id, title, description, task_deadline, status, market_task_id, created_by_name, created_at, last_error, assignees, award_points, required_submission')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// GET /api/quests/:id
// 任務詳情（含 request/response payload）
// ════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('quests')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return bad(res, '找不到此任務', 404);
      throw error;
    }
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// POST /api/quests
// 建立任務 → 寫本地 + 同步打市場部
// body: {
//   title, description, task_deadline,
//   award_points, required_submission,
//   assignees: [{type:"group", group_id:"..."}]
// }
// ════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      task_deadline,
      award_points,
      required_submission,
      assignees,
    } = req.body || {};

    // 驗證必填
    if (!title || !title.trim()) return bad(res, 'title 為必填');
    if (!task_deadline)         return bad(res, 'task_deadline 為必填（ISO 時間字串）');
    if (!Array.isArray(assignees) || assignees.length === 0) {
      return bad(res, 'assignees 不可為空，至少需要一個 group');
    }
    for (const a of assignees) {
      if (a.type !== 'group' || !a.group_id) {
        return bad(res, 'assignees 每筆必須是 { type:"group", group_id:"..." }');
      }
    }

    // 1. 先寫本地（status=pending）拿 id 當 external_id
    const insertRow = {
      title: title.trim(),
      description: description || '',
      task_deadline,
      award_points: award_points !== false,
      required_submission: Array.isArray(required_submission) && required_submission.length
        ? required_submission
        : ['text'],
      assignees,
      source_system: 'operation',
      source_system_name: '營運部系統',
      created_by_id: req.user?.id || null,
      created_by_name: req.user?.name || '營運部',
      status: 'pending',
    };

    const { data: created, error: insErr } = await supabase
      .from('quests')
      .insert(insertRow)
      .select()
      .single();
    if (insErr) throw insErr;

    // 2. 打市場部
    const payload = buildMarketPayload(created, req.user);
    let marketResp = null;
    let marketTaskId = null;
    let newStatus = 'sent';
    let lastError = null;

    try {
      marketResp = await marketQuest.createQuest(payload);
      marketTaskId = marketResp?.data?.id || marketResp?.data?.task_id || marketResp?.id || null;
    } catch (err) {
      newStatus = 'failed';
      lastError = err.response?.data?.message
        || err.response?.data?.detail
        || err.message;
      marketResp = err.response?.data || { error: err.message };
    }

    // 3. 回寫本地
    const { data: updated, error: updErr } = await supabase
      .from('quests')
      .update({
        status: newStatus,
        market_task_id: marketTaskId,
        last_error: lastError,
        request_payload: payload,
        response_payload: marketResp,
        updated_at: new Date().toISOString(),
      })
      .eq('id', created.id)
      .select()
      .single();
    if (updErr) throw updErr;

    if (newStatus === 'failed') {
      return res.status(502).json({ success: false, message: `市場部回應失敗：${lastError}`, data: updated });
    }
    ok(res, updated);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// POST /api/quests/:id/resend
// 重送一筆 failed 的任務
// ════════════════════════════════════════════════════════════
router.post('/:id/resend', async (req, res) => {
  try {
    const { data: quest, error } = await supabase
      .from('quests')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) {
      if (error.code === 'PGRST116') return bad(res, '找不到此任務', 404);
      throw error;
    }

    const payload = buildMarketPayload(quest, req.user);
    let marketResp = null;
    let marketTaskId = null;
    let newStatus = 'sent';
    let lastError = null;

    try {
      marketResp = await marketQuest.createQuest(payload);
      marketTaskId = marketResp?.data?.id || marketResp?.data?.task_id || marketResp?.id || quest.market_task_id;
    } catch (err) {
      newStatus = 'failed';
      lastError = err.response?.data?.message
        || err.response?.data?.detail
        || err.message;
      marketResp = err.response?.data || { error: err.message };
    }

    const { data: updated, error: updErr } = await supabase
      .from('quests')
      .update({
        status: newStatus,
        market_task_id: marketTaskId,
        last_error: lastError,
        request_payload: payload,
        response_payload: marketResp,
        updated_at: new Date().toISOString(),
      })
      .eq('id', quest.id)
      .select()
      .single();
    if (updErr) throw updErr;

    if (newStatus === 'failed') {
      return res.status(502).json({ success: false, message: `市場部回應失敗：${lastError}`, data: updated });
    }
    ok(res, updated);
  } catch (e) { fail(res, e); }
});

module.exports = router;
