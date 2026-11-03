-- 047_vendor_subjects.sql
-- 廠商指定會計科目：廠商分配請款時，每一列只能選樂活在廠商檔案指定的科目
--   billing_sources.allowed_subject_ids   這家廠商可用的科目（空＝沒限制，由會計通過時選）
--   vendor_payment_allocations.subject_id 廠商分配的每一列科目
--   bill_allocations.subject_id           付款後產生帳單時，每個門市×科目一列，月報依列科目歸格子

ALTER TABLE billing_sources
  ADD COLUMN IF NOT EXISTS allowed_subject_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE vendor_payment_allocations
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id) ON DELETE SET NULL;

ALTER TABLE bill_allocations
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id) ON DELETE SET NULL;
