-- ============================================================
-- 023_recurring_expenses_extend.sql
-- 常態費用主檔擴充：對應 Excel 「常態.xlsx」格式
--   新增 5 個欄位：
--     payment_method   支付方式（臨櫃無褶/現金繳納/匯款/自動扣款/群茂代繳/信用卡/支票）
--     payee_name       匯入戶名（受款人 / 銀行帳戶名稱）
--     needs_billing    是否需要開帳（false = 純內部支出，不走帳單）
--     period_text      約期 free text（含多段+不同金額）
--     cycle_day_text   每月幾號支付的原始文字（保留「5號」「18號前」格式）
--   把 bill_target_* 改為 nullable（needs_billing=false 可不填）
-- ============================================================

ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS payment_method  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS payee_name      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS needs_billing   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS period_text     TEXT,
  ADD COLUMN IF NOT EXISTS cycle_day_text  VARCHAR(20);

-- bill_target_* 改為 nullable（needs_billing=false 時可不填）
ALTER TABLE recurring_expenses ALTER COLUMN bill_target_type DROP NOT NULL;
ALTER TABLE recurring_expenses ALTER COLUMN bill_target_id   DROP NOT NULL;
ALTER TABLE recurring_expenses ALTER COLUMN bill_target_name DROP NOT NULL;

COMMENT ON COLUMN recurring_expenses.payment_method IS '支付方式: 臨櫃無褶/現金繳納/匯款/自動扣款/群茂代繳/信用卡/支票/其他';
COMMENT ON COLUMN recurring_expenses.payee_name     IS '匯入戶名（受款人/銀行帳戶）';
COMMENT ON COLUMN recurring_expenses.needs_billing  IS '是否需要開帳（true=會走帳單，false=純內部支出）';
COMMENT ON COLUMN recurring_expenses.period_text    IS '約期 free text（含多段+不同金額的情形）';
COMMENT ON COLUMN recurring_expenses.cycle_day_text IS '每月幾號支付的原始文字（保留「5號」「18號前」等格式）';

-- ── 給排程一個 hint：needs_billing=false 的單也要產 payment row（為了元大匯款 Excel 用）
-- 排程邏輯保持原樣，only 影響顯示
