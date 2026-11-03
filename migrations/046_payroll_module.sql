-- 046：出勤薪資（lohas-payroll）掛進營運系統側欄（2026-11-03）
-- 畫面是 iframe 內嵌 https://lohas-payroll-web.onrender.com；角色由 /api/external/payroll-role 轉給 payroll 系統。
insert into modules (key, label, icon, sort_order, is_system, description)
values ('payroll', '出勤薪資', '📅', 96, true, '排班、釘釘出勤、人事公文、薪資結算（lohas-payroll）')
on conflict (key) do nothing;
insert into role_module_permissions (role_key, module_key, can_view, can_edit) values
  ('super_admin', 'payroll', true, true),
  ('operation_lead', 'payroll', true, true),
  ('operation_hr', 'payroll', true, true),
  ('operation_accounting', 'payroll', true, false)
on conflict (role_key, module_key) do nothing;
