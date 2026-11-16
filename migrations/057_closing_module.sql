-- 057_closing_module.sql
-- 結帳資料（門市每月結帳清點）原本掛在「部門開帳 billing」權限底下，權限管理裡沒有獨立項目可以設定（2026-11-17 Louis：會計看不到）
-- → 獨立模組 closing；先照 billing 現有的角色權限複製一份，之後在「權限管理」單獨開關
INSERT INTO modules (key, label, icon, sort_order, is_system, description)
VALUES ('closing', '結帳資料', '📦', 46, true, '門市每月結帳清點：通過／退回、支出憑證核對、清單設定')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
SELECT role_key, 'closing', can_view, can_edit FROM role_module_permissions WHERE module_key = 'billing'
ON CONFLICT (role_key, module_key) DO NOTHING;

-- 會計一定要看得到、可以操作
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
VALUES ('operation_accounting', 'closing', true, true)
ON CONFLICT (role_key, module_key) DO UPDATE SET can_view = true, can_edit = true;
