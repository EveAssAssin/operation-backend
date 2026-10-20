-- 合約 C3（2026-10-20）：合約連動應付（固定支出）＋支票追蹤到兌現
-- 固定支出掛到合約：每月應付金額＝合約當月金額（分段租金照天數拆）× contract_share（這位收款人實拿的比例，已扣代扣稅）
-- 例：後甲合約 95,000，張敬忠實拿 41,748 → share 0.43945；合約調漲時應付自動跟著變；合約到期自動不再產生應付
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS contract_id    UUID;
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS contract_share NUMERIC(10,6);
CREATE INDEX IF NOT EXISTS idx_re_contract ON recurring_expenses(contract_id);

-- 支票：開票日、票號、到期日（票上的日期）、兌現日（銀行實際扣款）；付款方式快照
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS pay_method        TEXT;
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS check_no          TEXT;
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS check_issue_date  DATE;
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS check_due_date    DATE;
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS check_cashed_date DATE;
ALTER TABLE recurring_expense_payments ADD COLUMN IF NOT EXISTS check_note        TEXT;
CREATE INDEX IF NOT EXISTS idx_rep_check_due ON recurring_expense_payments(check_due_date) WHERE check_no IS NOT NULL AND check_cashed_date IS NULL;
