// routes/system.js
// 系統用戶管理 API — 從 employees 匯入，賦予系統權限
// 統一使用 app_number 作為跨系統識別碼（= system_users.member_id）
//
// 權限說明：
//   GET  /employees  → operation_lead 以上可查看（system_user.view）
//   POST /grant      → super_admin 才能授權（system_user.edit）
//   PUT  /:id/role   → super_admin 才能修改角色
//   PUT  /:id/revoke → super_admin 才能撤銷

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// 營運部系統的有效角色
const VALID_ROLES = ['super_admin', 'operation_lead', 'operation_staff'];

// 各角色可以授予的角色範圍（operation_lead 只能管 operation_staff）
function getAllowedRoles(requesterRole) {
  if (requesterRole === 'super_admin') return VALID_ROLES;
  if (requesterRole === 'operation_lead') return ['operation_staff'];
  return [];
}

/**
 * GET /api/system/employees
 * 列出所有在職員工，並標示是否已有系統權限
 * 需要 operation_lead 以上
 */
router.get('/employees', authorize('system_user.view'), async (req, res) => {
  try {
    const {
      keyword,
      store_name,
      has_access,
      page  = 1,
      limit = 50,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    // 1. 取得所有在職員工
    let empQuery = supabase
      .from('employees')
      .select('id, erpid, app_number, name, jobtitle, store_name, store_erpid, is_active, line_uid')
      .eq('is_active', true)
      .order('store_name', { ascending: true })
      .order('name',       { ascending: true });

    if (keyword) {
      empQuery = empQuery.or(`name.ilike.%${keyword}%,erpid.ilike.%${keyword}%,app_number.ilike.%${keyword}%`);
    }
    if (store_name) {
      empQuery = empQuery.eq('store_name', store_name);
    }

    const { data: allEmployees, error: empErr } = await empQuery;
    if (empErr) throw empErr;

    // 2. 取得所有 system_users
    const { data: sysUsers, error: sysErr } = await supabase
      .from('system_users')
      .select('id, member_id, erpid, name, role, is_active, last_login_at');

    if (sysErr) throw sysErr;

    const sysUserMap = {};
    (sysUsers || []).forEach(su => { sysUserMap[su.member_id] = su; });

    // 3. 合併（app_number = member_id）
    let merged = (allEmployees || []).map(emp => {
      const su = sysUserMap[emp.app_number];
      return {
        employee_id:    emp.id,
        erpid:          emp.erpid,
        app_number:     emp.app_number,
        name:           emp.name,
        jobtitle:       emp.jobtitle,
        store_name:     emp.store_name,
        store_erpid:    emp.store_erpid,
        has_access:     !!su && su.is_active,
        system_user_id: su?.id || null,
        role:           su?.is_active ? su.role : null,
        last_login_at:  su?.last_login_at || null,
        line_uid:       emp.line_uid || null,
      };
    });

    // 4. 篩選有/無權限
    if (has_access === 'true')  merged = merged.filter(m => m.has_access);
    if (has_access === 'false') merged = merged.filter(m => !m.has_access);

    // 5. 分頁
    const total = merged.length;
    const from  = (pageNum - 1) * limitNum;
    const paged = merged.slice(from, from + limitNum);

    res.json({
      success: true,
      data: paged,
      pagination: {
        total,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/system/grant
 * 賦予員工系統權限（僅 super_admin）
 * body: { app_number, role }
 */
router.post('/grant', authorize('system_user.edit'), async (req, res) => {
  try {
    const { app_number, role } = req.body;
    if (!app_number || !role) {
      return res.status(400).json({ success: false, message: '缺少 app_number 或 role' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `無效角色，有效值：${VALID_ROLES.join(', ')}` });
    }
    // 主管只能授予 operation_staff 角色
    const allowedRoles = getAllowedRoles(req.user.role);
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ success: false, message: '權限不足，您無法授予此角色' });
    }

    // 查員工
    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('erpid, app_number, name')
      .eq('app_number', app_number)
      .single();

    if (empErr || !emp) {
      return res.status(404).json({ success: false, message: '找不到此員工' });
    }

    // 已存在則更新
    const { data: existing } = await supabase
      .from('system_users')
      .select('id')
      .eq('member_id', app_number)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from('system_users')
        .update({ role, is_active: true, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw error;
      return res.json({ success: true, data, message: '已更新權限' });
    }

    // 新建
    const { data, error } = await supabase
      .from('system_users')
      .insert({
        member_id:  app_number,
        erpid:      emp.erpid,
        name:       emp.name,
        role,
        is_active:  true,
        created_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data, message: `已授權：${emp.name}（${role}）` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/system/:id/role
 * 修改角色（僅 super_admin）
 */
router.put('/:id/role', authorize('system_user.edit'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `無效角色，有效值：${VALID_ROLES.join(', ')}` });
    }
    // 主管只能改成 operation_staff
    const allowedRoles = getAllowedRoles(req.user.role);
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ success: false, message: '權限不足，您無法設定此角色' });
    }
    const { data, error } = await supabase
      .from('system_users')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: '找不到此用戶' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/system/:id/revoke
 * 撤銷系統權限（僅 super_admin）
 */
router.put('/:id/revoke', authorize('system_user.edit'), async (req, res) => {
  try {
    // 先查出目標用戶的角色，確認是否有權限撤銷
    const { data: target } = await supabase
      .from('system_users')
      .select('id, role, name')
      .eq('id', req.params.id)
      .single();

    if (!target) return res.status(404).json({ success: false, message: '找不到此用戶' });

    const allowedRoles = getAllowedRoles(req.user.role);
    if (!allowedRoles.includes(target.role)) {
      return res.status(403).json({ success: false, message: '權限不足，您無法撤銷此角色的帳號' });
    }

    const { data, error } = await supabase
      .from('system_users')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: '找不到此用戶' });
    res.json({ success: true, data, message: '已撤銷系統權限' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
