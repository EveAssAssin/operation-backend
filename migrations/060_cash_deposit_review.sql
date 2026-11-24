-- 060：銀存審核（2026-11-24 營運）
--   bank_accounts.is_cash_book：「現金銀存專用本子」（門市存現金都存進這幾本）→ 匯入明細後自動跟門市的上繳回報對帳
--   bank_txns.cash_deposit_id：這筆存入對到哪一筆上繳（市場部 cash_deposits.id）
--   模組 cash_deposit：權限管理可單獨設定（先照 bank_ledger 複製，會計一定開）
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_cash_book boolean NOT NULL DEFAULT false;
ALTER TABLE bank_txns ADD COLUMN IF NOT EXISTS cash_deposit_id text;
CREATE INDEX IF NOT EXISTS idx_bank_txns_cash_dep ON bank_txns(cash_deposit_id) WHERE cash_deposit_id IS NOT NULL;

INSERT INTO modules (key, label, icon, sort_order, is_system, description)
VALUES ('cash_deposit', '銀存審核', '💵', 47, true, '門市存現金回報：審核、跟現金銀存專用本子自動對帳')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
SELECT role_key, 'cash_deposit', can_view, can_edit FROM role_module_permissions WHERE module_key = 'bank_ledger'
ON CONFLICT (role_key, module_key) DO NOTHING;
INSERT INTO role_module_permissions (role_key, module_key, can_view, can_edit)
VALUES ('operation_accounting', 'cash_deposit', true, true)
ON CONFLICT (role_key, module_key) DO UPDATE SET can_view = true, can_edit = true;
