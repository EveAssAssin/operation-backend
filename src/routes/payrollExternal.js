// routes/payrollExternal.js — 給 lohas-payroll 問「這個 app_number 在營運系統是什麼角色」（2026-11-03）
// 驗證：header x-payroll-key = PAYROLL_SYNC_KEY（兩邊 Render 都設同一把）
// 對應：super_admin／operation_lead → admin；payroll 模組可編 → hr；只能看 → accounting；其他 → null
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const perm = require('../services/permissionService');

router.get('/payroll-role', async (req, res) => {
  const key = process.env.PAYROLL_SYNC_KEY || '';
  if (!key || req.get('x-payroll-key') !== key) return res.status(403).json({ success: false, message: 'forbidden' });
  const app = String(req.query.app_number || '').trim();
  if (!app) return res.status(400).json({ success: false, message: 'app_number' });
  const { data: u } = await supabase.from('system_users').select('member_id, erpid, name, role, is_active').eq('member_id', app).maybeSingle();
  if (!u || !u.is_active) return res.json({ success: true, data: null });
  const canView = await perm.canAccess(u.role, 'payroll', 'view');
  const canEdit = await perm.canAccess(u.role, 'payroll', 'edit');
  let role = null;
  if (['super_admin', 'operation_lead'].includes(u.role)) role = 'admin';
  else if (canEdit) role = 'hr';
  else if (canView) role = 'accounting';
  return res.json({ success: true, data: { app_number: u.member_id, erpid: u.erpid, name: u.name, op_role: u.role, role } });
});
module.exports = router;
