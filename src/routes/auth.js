// routes/auth.js
// 認證相關 API（SSO 登入 / 用戶資訊）

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/auth/login
 * SSO 登入
 *
 * Body: { app_number: "員工編號（跨系統統一識別碼）" }
 *
 * 流程說明（目前為開發模式）：
 *   1. 接收統一入口傳入的 app_number
 *   2. 查詢 system_users 表確認是否有此帳號
 *   3. 回傳用戶資訊與可操作的模組清單
 *
 * ── TODO：SSO 串接確認後替換此邏輯 ──────────────────────────
 * 正式流程：前端導向 SSO 登入頁 → SSO 回傳 token → 傳入此 API 驗證
 */
router.post('/login', async (req, res) => {
  try {
    const { app_number } = req.body;

    if (!app_number) {
      return res.status(400).json({ success: false, message: '缺少員工編號（app_number）' });
    }

    // app_number = system_users.member_id（跨系統統一識別碼）
    const { data: user, error } = await supabase
      .from('system_users')
      .select('id, member_id, erpid, name, role, is_active')
      .eq('member_id', app_number)
      .eq('is_active', true)
      .single();

    if (error || !user) {
      return res.status(403).json({ success: false, message: '無操作權限，請聯繫系統管理員' });
    }

    // 更新最後登入時間
    await supabase
      .from('system_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    // 補查 line_uid（從 employees 表，以 erpid 對應）
    let lineUid = null;
    if (user.erpid) {
      const { data: emp } = await supabase
        .from('employees')
        .select('line_uid')
        .eq('erpid', user.erpid)
        .maybeSingle();
      lineUid = emp?.line_uid || null;
    }

    // 根據角色回傳可操作的模組清單
    const modules = getModulesForRole(user.role);

    res.json({
      success: true,
      user: {
        id:         user.id,
        memberId:   user.member_id,
        app_number: user.member_id,
        erpid:      user.erpid,
        name:       user.name,
        role:       user.role,
        line_uid:   lineUid,
      },
      modules,
      token: app_number,
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/auth/me
 * 取得當前登入用戶資訊（需帶 Token）
 */
/**
 * GET /api/auth/sso?app_number=XXXXX
 * 統一入口 SSO 登入：帶會員編號進來，系統自行判斷角色並回傳 token
 */
router.get('/sso', async (req, res) => {
  try {
    const { app_number } = req.query;
    if (!app_number) {
      return res.status(400).json({ success: false, message: '缺少 app_number 參數' });
    }

    const { data: user, error } = await supabase
      .from('system_users')
      .select('id, member_id, erpid, name, role, is_active')
      .eq('member_id', app_number)
      .eq('is_active', true)
      .single();

    if (error || !user) {
      return res.status(403).json({ success: false, message: '您沒有此系統的操作權限' });
    }

    await supabase
      .from('system_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    let lineUid = null;
    if (user.erpid) {
      const { data: emp } = await supabase
        .from('employees')
        .select('line_uid')
        .eq('erpid', user.erpid)
        .maybeSingle();
      lineUid = emp?.line_uid || null;
    }

    const modules = getModulesForRole(user.role);
    res.json({
      success: true,
      user: { id: user.id, memberId: user.member_id, app_number: user.member_id, erpid: user.erpid, name: user.name, role: user.role, line_uid: lineUid },
      modules,
      token: app_number,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/me', authenticate, async (req, res) => {
  const modules = getModulesForRole(req.user.role);
  res.json({
    success: true,
    user:    req.user,
    modules,
  });
});

// ── 根據角色返回可操作模組清單 ────────────────────────────────
function getModulesForRole(role) {
  const allModules = [
    { key: 'dashboard',    label: '系統首頁',     roles: ['marketing_staff', 'works_engineer', 'auditor', 'dept_head', 'super_admin'] },
    { key: 'personnel',    label: '人員管理',     roles: ['marketing_staff', 'works_engineer', 'auditor', 'dept_head', 'super_admin'] },
    { key: 'maintenance',  label: '例行養護',     roles: ['works_engineer', 'dept_head', 'super_admin'] },
    { key: 'repair',       label: '工務報修管理', roles: ['works_engineer', 'dept_head', 'super_admin'] },
    { key: 'audit',        label: '例行稽查',     roles: ['auditor', 'dept_head', 'super_admin'] },
    { key: 'system',       label: '系統用戶管理', roles: ['super_admin'] },
    { key: 'quest',        label: '任務看板',     roles: ['marketing_staff', 'works_engineer', 'dept_head', 'super_admin'] },
    // 未來模組（尚未開發，先定義佔位）
    { key: 'performance',  label: '業績管理',     roles: ['works_engineer', 'dept_head', 'super_admin'],  comingSoon: true },
    { key: 'workorder',    label: '工單管理',     roles: ['works_engineer', 'dept_head', 'super_admin'],  comingSoon: true },
    { key: 'marketing',    label: '行銷活動',     roles: ['marketing_staff', 'dept_head', 'super_admin'], comingSoon: true },
    { key: 'refund',       label: '退單管理',     roles: ['works_engineer', 'dept_head', 'super_admin'],  comingSoon: true },
    { key: 'evaluation',   label: '人員評價',     roles: ['dept_head', 'super_admin'],                    comingSoon: true },
    { key: 'training',     label: '教育訓練',     roles: ['marketing_staff', 'dept_head', 'super_admin'], comingSoon: true },
  ];

  return allModules.filter(m => m.roles.includes(role));
}

module.exports = router;
