// routes/pushGroups.js
// 推播群組管理 + LINE 推播發送
// 需登入（operation_staff 以上）

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authorize } = require('../middleware/auth');
const { pushToUsers } = require('../services/linePushService');

router.use(authorize('operation_staff', 'operation_lead', 'dept_head', 'super_admin'));

// ── 工具 ──────────────────────────────────────────────────────
function ok(res, data)  { res.json({ success: true, data }); }
function bad(res, msg)  { res.status(400).json({ success: false, message: msg }); }
function fail(res, e)   {
  console.error('[PushGroups]', e.message);
  res.status(500).json({ success: false, message: e.message });
}

// ════════════════════════════════════════════════════════════
// 取得可加入群組的員工清單（有 app_number 且在職）
// GET /api/push-groups/employees
// ════════════════════════════════════════════════════════════
router.get('/employees', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('id, name, app_number, store_name, jobtitle, line_uid')
      .eq('is_active', true)
      .not('app_number', 'is', null)
      .order('store_name', { ascending: true })
      .order('name',       { ascending: true });

    if (error) throw error;
    ok(res, data || []);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 群組列表（含成員數）
// GET /api/push-groups
// ════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('push_groups')
      .select('id, name, description, created_at, push_group_members(count)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const groups = (data || []).map(g => ({
      id:          g.id,
      name:        g.name,
      description: g.description,
      created_at:  g.created_at,
      member_count: g.push_group_members?.[0]?.count ?? 0,
    }));

    ok(res, groups);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 建立群組（含成員）
// POST /api/push-groups
// body: { name, description, members: [{ employee_id, employee_name, app_number, store_name }] }
// ════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const { name, description, members = [] } = req.body;
  if (!name?.trim()) return bad(res, '群組名稱為必填');

  try {
    // 1. 建立群組
    const { data: group, error: ge } = await supabase
      .from('push_groups')
      .insert({ name: name.trim(), description: description?.trim() || null, created_by: req.user?.name || null })
      .select()
      .single();
    if (ge) throw ge;

    // 2. 新增成員
    if (members.length > 0) {
      const rows = members.map(m => ({
        group_id:      group.id,
        employee_id:   m.employee_id,
        employee_name: m.employee_name,
        app_number:    m.app_number,
        store_name:    m.store_name || null,
      }));
      const { error: me } = await supabase.from('push_group_members').insert(rows);
      if (me) throw me;
    }

    ok(res, group);
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 取得單一群組（含完整成員）
// GET /api/push-groups/:id
// ════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { data: group, error: ge } = await supabase
      .from('push_groups')
      .select('id, name, description, created_at')
      .eq('id', req.params.id)
      .single();
    if (ge) throw ge;
    if (!group) return bad(res, '群組不存在');

    const { data: members, error: me } = await supabase
      .from('push_group_members')
      .select('employee_id, employee_name, app_number, store_name')
      .eq('group_id', group.id)
      .order('store_name', { ascending: true })
      .order('employee_name', { ascending: true });
    if (me) throw me;

    ok(res, { ...group, members: members || [] });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 更新群組（名稱 + 成員全量替換）
// PUT /api/push-groups/:id
// ════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  const { name, description, members = [] } = req.body;
  if (!name?.trim()) return bad(res, '群組名稱為必填');

  try {
    // 更新群組基本資料
    const { error: ue } = await supabase
      .from('push_groups')
      .update({ name: name.trim(), description: description?.trim() || null })
      .eq('id', req.params.id);
    if (ue) throw ue;

    // 成員全量替換：先刪後寫
    const { error: de } = await supabase
      .from('push_group_members')
      .delete()
      .eq('group_id', req.params.id);
    if (de) throw de;

    if (members.length > 0) {
      const rows = members.map(m => ({
        group_id:      req.params.id,
        employee_id:   m.employee_id,
        employee_name: m.employee_name,
        app_number:    m.app_number,
        store_name:    m.store_name || null,
      }));
      const { error: me } = await supabase.from('push_group_members').insert(rows);
      if (me) throw me;
    }

    ok(res, { id: req.params.id });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 刪除群組
// DELETE /api/push-groups/:id
// ════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('push_groups')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    ok(res, { id: req.params.id });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════════════
// 發送推播
// POST /api/push-groups/send
// body: {
//   group_ids:    number[]   // 選擇整個群組
//   employee_ids: number[]   // 個別員工（employees.id）
//   message:      string     // 推播內容
// }
// ════════════════════════════════════════════════════════════
router.post('/send', async (req, res) => {
  const { group_ids = [], employee_ids = [], message } = req.body;
  if (!message?.trim()) return bad(res, '推播內容為必填');
  if (group_ids.length === 0 && employee_ids.length === 0) {
    return bad(res, '請選擇至少一個群組或一位人員');
  }

  try {
    const appNumberSet = new Set();

    // 從群組收集 app_number
    if (group_ids.length > 0) {
      const { data: groupMembers, error: gme } = await supabase
        .from('push_group_members')
        .select('app_number')
        .in('group_id', group_ids)
        .not('app_number', 'is', null);
      if (gme) throw gme;
      (groupMembers || []).forEach(m => m.app_number && appNumberSet.add(m.app_number));
    }

    // 從個別員工收集 app_number
    if (employee_ids.length > 0) {
      const { data: employees, error: ee } = await supabase
        .from('employees')
        .select('app_number')
        .in('id', employee_ids)
        .not('app_number', 'is', null);
      if (ee) throw ee;
      (employees || []).forEach(e => e.app_number && appNumberSet.add(e.app_number));
    }

    const appNumbers = [...appNumberSet];
    if (appNumbers.length === 0) {
      return bad(res, '所選對象中沒有可用的 app_number，無法發送推播');
    }

    const result = await pushToUsers(appNumbers, message.trim());

    ok(res, {
      sent_count: appNumbers.length,
      line_result: result,
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
