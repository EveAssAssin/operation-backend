// services/permissionService.js
// 分權系統 — 從 DB 讀取角色 / 模組 / 權限
//   - 5 分鐘快取（reduce DB load）
//   - is_admin=true 的角色自動視為全權

const supabase = require('../config/supabase');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { roles: null, modules: null, perms: null, loadedAt: 0 };

async function loadAll() {
  if (cache.loadedAt && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;

  const [r, m, p] = await Promise.all([
    supabase.from('roles').select('*').order('sort_order'),
    supabase.from('modules').select('*').order('sort_order'),
    supabase.from('role_module_permissions').select('*'),
  ]);
  if (r.error) throw new Error(r.error.message);
  if (m.error) throw new Error(m.error.message);
  if (p.error) throw new Error(p.error.message);

  cache = {
    roles:   r.data || [],
    modules: m.data || [],
    perms:   p.data || [],
    loadedAt: Date.now(),
  };
  return cache;
}

function invalidateCache() {
  cache = { roles: null, modules: null, perms: null, loadedAt: 0 };
}

// ────────────────────────────────────────────────────────────
//                       Public API
// ────────────────────────────────────────────────────────────

async function listRoles()   { const c = await loadAll(); return c.roles; }
async function listModules() { const c = await loadAll(); return c.modules; }

async function listPermissions() {
  const c = await loadAll();
  return c.perms;
}

/** 取一個角色能看 / 能改的模組清單 */
async function getRolePermissions(roleKey) {
  const c = await loadAll();
  const role = c.roles.find(r => r.key === roleKey);
  if (!role) return [];
  if (role.is_admin) {
    return c.modules.map(m => ({ module_key: m.key, can_view: true, can_edit: true, admin: true }));
  }
  return c.perms.filter(p => p.role_key === roleKey);
}

/** 給「我登入後能看哪些模組」用 */
async function getMyModules(roleKey) {
  const c = await loadAll();
  const role = c.roles.find(r => r.key === roleKey);
  if (!role) return [];

  if (role.is_admin) {
    return c.modules.map(m => ({ ...m, can_view: true, can_edit: true, admin: true }));
  }

  const map = new Map(c.perms.filter(p => p.role_key === roleKey).map(p => [p.module_key, p]));
  return c.modules
    .map(m => {
      const p = map.get(m.key);
      return p
        ? { ...m, can_view: p.can_view, can_edit: p.can_edit, admin: false }
        : { ...m, can_view: false, can_edit: false, admin: false };
    })
    .filter(m => m.can_view);
}

/** middleware 用：檢查某 role 對某 module 的權限 */
async function canAccess(roleKey, moduleKey, action = 'view') {
  const c = await loadAll();
  const role = c.roles.find(r => r.key === roleKey);
  if (!role) return false;
  if (role.is_admin) return true;
  const perm = c.perms.find(p => p.role_key === roleKey && p.module_key === moduleKey);
  if (!perm) return false;
  return action === 'edit' ? !!perm.can_edit : !!perm.can_view;
}

/** 更新一筆權限 */
async function setPermission({ role_key, module_key, can_view, can_edit }) {
  if (!role_key || !module_key) throw new Error('role_key / module_key 必填');

  const { data, error } = await supabase
    .from('role_module_permissions')
    .upsert([{
      role_key, module_key,
      can_view: !!can_view,
      can_edit: can_edit && can_view ? true : false,   // 不能看自然不能改
    }], { onConflict: 'role_key,module_key' })
    .select().single();
  if (error) throw new Error(error.message);

  invalidateCache();
  return data;
}

/** 批次更新（給「管理頁全表存檔」用） */
async function setPermissionsBulk(items = []) {
  if (!Array.isArray(items)) throw new Error('items 必須是陣列');
  // 一筆一筆 upsert，比較容易處理錯誤
  const results = [];
  for (const it of items) {
    results.push(await setPermission(it));
  }
  invalidateCache();
  return results;
}

module.exports = {
  // 列出
  listRoles, listModules, listPermissions,
  // 查
  getRolePermissions, getMyModules, canAccess,
  // 寫
  setPermission, setPermissionsBulk,
  // 快取
  invalidateCache,
};
