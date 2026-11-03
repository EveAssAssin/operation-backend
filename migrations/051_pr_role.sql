-- 051_pr_role.sql
-- 公關部（零用金）角色：只開零用金管理，其他功能都看不到
INSERT INTO roles (key, label, is_admin, sort_order, color, text_color, description, is_system)
VALUES ('pr_staff', '公關部', false, 70, '#fefcbf', '#744210', '只能使用零用金管理', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
VALUES ('pr_staff', 'petty_cash', true, true)
ON CONFLICT (role_key, module_key) DO NOTHING;
