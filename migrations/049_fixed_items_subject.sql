-- 049_fixed_items_subject.sql
-- 門市基礎設定「每月固定費用」：除了行銷基金／折舊，可以選任何會計科目，設定起訖月份後每個月自動列入月報
ALTER TABLE store_fixed_items ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id) ON DELETE SET NULL;
