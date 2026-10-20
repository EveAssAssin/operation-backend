-- 029：人事工具（2026-10-20）
-- 離職案件在市場部（market migration 182 resign_requests）；這邊是畫面＋設定，經 /api/internal/resign 讀寫。
-- 投保單位（勞保保險證號、健保投保單位代號）每家公司可能不同 → report_settings.insurance_units，人事在畫面上填。
insert into modules (key, label, icon, sort_order, is_system, description)
values ('hr_tool', '人事工具', '🧾', 95, true, '離職申請後續：退保、資遣通報、關閉登入、結案')
on conflict (key) do nothing;
insert into role_module_permissions (role_key, module_key, can_view, can_edit)
values ('operation_hr', 'hr_tool', true, true)
on conflict (role_key, module_key) do nothing;
insert into report_settings (key, value) values ('insurance_units', '[]'::jsonb) on conflict (key) do nothing;
