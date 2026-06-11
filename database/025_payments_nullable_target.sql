-- ============================================================
-- 025_payments_nullable_target.sql
-- recurring_expense_payments.bill_target_* 也改 nullable
--   配合 023 主檔 needs_billing=false 的單，每月應付紀錄也可不填開帳對象
-- ============================================================

ALTER TABLE recurring_expense_payments ALTER COLUMN bill_target_type DROP NOT NULL;
ALTER TABLE recurring_expense_payments ALTER COLUMN bill_target_id   DROP NOT NULL;
ALTER TABLE recurring_expense_payments ALTER COLUMN bill_target_name DROP NOT NULL;
