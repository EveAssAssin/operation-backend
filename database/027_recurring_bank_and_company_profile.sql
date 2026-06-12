-- ============================================================
-- 027_recurring_bank_and_company_profile.sql
--   (A) recurring_expenses 加銀行三欄
--   (B) company_profile 插入預設值（黃信儒/21102000344321/806/1102）
--   給「產生本月元大匯款 Excel」使用
-- ============================================================

-- ── (A) recurring_expenses 加銀行三欄 ────────────────
ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS bank_code    VARCHAR(10),   -- 收款總行（3 碼，如 806 元大）
  ADD COLUMN IF NOT EXISTS bank_branch  VARCHAR(10),   -- 收款分行（4 碼，如 0083）
  ADD COLUMN IF NOT EXISTS bank_account VARCHAR(30);   -- 收款帳號（如 00812602158300）

COMMENT ON COLUMN recurring_expenses.bank_code    IS '收款總行（3 碼）';
COMMENT ON COLUMN recurring_expenses.bank_branch  IS '收款分行（4 碼）';
COMMENT ON COLUMN recurring_expenses.bank_account IS '收款帳號';

-- ── (B) company_profile 預設值 ───────────────────────
-- (id PK CHECK id=1) 確保只 1 筆
INSERT INTO company_profile (
  id, company_name, tax_id,
  payer_account_name, payer_account_no,
  payer_bank_code, payer_branch_code,
  default_overdue_code, default_fee_burden, default_notify_method
) VALUES (
  1,
  '樂活光學',           -- 公司名稱（之後可在「公司資料」頁修改）
  NULL,                 -- 統編
  '黃信儒', '21102000344321',
  '806', '1102',
  '1', '15', '0'
) ON CONFLICT (id) DO NOTHING;
