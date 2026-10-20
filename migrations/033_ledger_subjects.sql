-- 033 會計科目（2026-10-21）
-- 月報格子（ledger_accounts）是大分類；會計科目是格子底下的細項，之後分析費用用（例：雜費 → 營運雜貨／文具／清潔用品）。
-- 規則：手填／調帳（支出格子）、分攤開帳、帳單管理手動開的帳單、廠商請款通過，一律要選科目；選了科目＝決定月報格子。
-- 每個支出格子先建一個同名的「預設科目」（is_default），系統自動同步進來的帳（路奇、企劃、倉庫、水電…）沒選科目就算在預設科目。
CREATE TABLE IF NOT EXISTS ledger_subjects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_code  text NOT NULL REFERENCES ledger_accounts(code),
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ledger_code, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_subjects_default_uq ON ledger_subjects (ledger_code) WHERE is_default;
ALTER TABLE ledger_subjects ENABLE ROW LEVEL SECURITY;

INSERT INTO ledger_subjects (ledger_code, name, is_default, sort_order, created_by)
SELECT code, name, true, 0, 'migration 033' FROM ledger_accounts WHERE kind = 'expense'
ON CONFLICT DO NOTHING;

ALTER TABLE ledger_manual_entries   ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id);
ALTER TABLE bills                   ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id);
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES ledger_subjects(id);
