// middleware/auth.js
// SSO 驗證中介軟體
// 目前為 Placeholder 架構，SSO 串接確認後填入實際邏輯

const supabase = require('../config/supabase');
const { ROLES, MODULE_PERMISSIONS } = require('../config/constants');

/**
 * SSO Token 驗證
 * 流程：
 *   1. 從 Authorization header 取得 Bearer token
 *   2. 向 SSO 系統驗證 token（目前為 placeholder）
 *   3. 從 system_users 表查詢用戶角色
 *   4. 將用戶資訊掛載至 req.user
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '未提供認證 Token' });
    }

    const token = authHeader.substring(7);

    // ── TODO：SSO API 確認後替換此區塊 ──────────────────────────
    // 目前使用 app_number 直接查詢（開發測試用）
    // 正式流程：
    //   const ssoUser = await verifySSOToken(token);
    //   const appNumber = ssoUser.app_number;
    //
    // 暫時以 token 作為 app_number（= system_users.member_id）
    const memberId = token;
    // ────────────────────────────────────────────────────────────

    const { data: user, error } = await supabase
      .from('system_users')
      .select('id, member_id, erpid, name, role, is_active')
      .eq('member_id', memberId)
      .eq('is_active', true)
      .single();

    if (error || !user) {
      return res.status(403).json({ success: false, message: '無此系統帳號或帳號已停用' });
    }

    // 更新最後登入時間
    await supabase
      .from('system_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] 驗證失敗：', err.message);
    return res.status(500).json({ success: false, message: '認證服務異常' });
  }
};

/**
 * 模組權限檢查
 * 支援兩種用法：
 *   1. 權限字串：authorize('personnel.sync') — 查 MODULE_PERMISSIONS 層級
 *   2. 角色白名單：authorize('super_admin', 'dept_head', 'auditor') — 直接檢查角色
 */
const authorize = (...args) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: '請先登入' });
    }

    const userRole = req.user.role;

    // 角色白名單模式：如果任一參數是已知角色名稱
    const knownRoles = Object.keys(ROLES);
    const isRoleMode = args.some(a => knownRoles.includes(a));

    if (isRoleMode) {
      // 檢查使用者角色是否在白名單中
      if (!args.includes(userRole)) {
        return res.status(403).json({
          success: false,
          message: '權限不足，您的角色無法執行此操作',
        });
      }
      return next();
    }

    // 權限字串模式（向下相容）
    const permission = args[0];
    const userLevel = ROLES[userRole] || 0;
    const requiredLevel = MODULE_PERMISSIONS[permission] || 999;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        success: false,
        message: `權限不足，此操作需要更高角色`,
      });
    }

    next();
  };
};

module.exports = { authenticate, authorize };
