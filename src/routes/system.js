// routes/system.js
// 系統用戶管理 API — 從 employees 匯入，賦予系統權限
// 統一使用 app_number 作為跨系統識別碼（= system_users.member_id）

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('system_user.edit'));

const VALID_ROLES = ['super_admin', 'dept_head', 'works_engineer', 'auditor', 'marketing_staff'];

/**
 * GET /api/system/employees
 * 列出所有在職員工，並標示是否已有系統權限
 */
router.get('/employees', async (req, res) => {
  try {
    const {
      keyword,
      store_name,
      has_access,
      page  = 1,
      limit = 30,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    // 1. 取得所有在職員工（app_number = member_id）
    let empQuery = supabase
      .from('employees')
      .select('id, erpid, app_number, name, jobtitle, store_name, is_active', { count: 'exact' })
      .eq('is_active', true)
      .order('store_name', { ascending: true })
      .order('name', { ascending: true });

    if (keyword) {
      empQuery = empQuery.or(`name.ilike.%${keyword}%,erpid.ilike.%${keyword}%,app_number.ilike.%${keyword}%`);
    }
    if (store_name) {
      empQuery = empQuery.eq('store_name', store_name);
    }

    const { data: allEmployees, error: empErr } = await empQuery;
    if (empErr) throw empErr;

    // 2. 取得所有 system_users（用 member_id = app_number 做 map）
    const { data: sysUsers, error: sysErr } = await supabase
      .from('system_users')
      .select('id, member_id, erpid, name, role, is_active, last_login_at');

    if (sysErr) throw sysErr;

    const sysUserMap = {};
    (sysUsers || []).forEach(su => { sysUserMap[su.member_id] = su; });

    // 3. 合併資料（用 member_id = app_number 做比對）
    let merged = (allEmployees || []).map(emp => {
      const su = sysUserMap[emp.app_number];
      return {
        employee_id:    emp.id,
        erpid:          emp.erpid,
        app_number:     emp.app_number,
        member_id:      emp.app_number,  // app_number 就是 member_id
        name:           emp.name,
        jobtitle:       emp.jobtitle,
        store_name:     emp.store_name,
        has_access:     !!su && su.is_active,
        system_user_id: su?.id || null,
        role:           su?.role || null,
        sys_active:     su?.is_active ?? null,
        last_login_at:  su?.last_login_at || null,
      };
    });

    // 4. 篩選有/無權限
    if (has_access === 'true')  merged = merged.filter(m => m.has_access);
    if (has_access === 'false') merged = merged.filter(m => !m.has_access);

    // 5. 分頁
    const filteredTotal = merged.length;
    const from = (pageNum - 1) * limitNum;
    const paged = merged.slice(from, from + limitNum);

    res.json({
      success: true,
      data: paged,
      pagination: {
        total: filteredTotal,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil(filteredTotal / limitNum),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/system/grant
 * 賦予員工系統權限
 * body: { app_number, role }
 * app_number = member_id（從 employees 表自動帶入）
 */
router.post('/grant', async (req, res) => {
  try {
    const { app_number, role } = req.body;
    if (!app_number || !role) {
      return res.status(400).json({ success: false, message: '缺少 app_number 或 role' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `無效角色：${role}` });
    }

    // 查員工資料
    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('erpid, app_number, name')
      .eq('app_number', app_number)
      .single();

    if (empErr || !emp) {
      return res.status(404).json({ success: false, message: '找不到此員工' });
    }

    // 檢查是否已存在（member_id = app_number）
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
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/system/:id/role
 */
router.put('/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: '無效角色' });
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
 */
router.put('/:id/revoke', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('system_users')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ success: false, message: '找不到此用戶' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
