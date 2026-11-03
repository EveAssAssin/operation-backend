-- 044_bill_scan.sql
-- 營運費用「掃碼入帳」
--   bill_barcode_bindings：帳單條碼裡的識別碼（銷帳編號 / 用戶識別）→ 對應哪個 fact（電號/帳號）＋門市
--                         第一次掃到手動選一次，之後自動帶出
--   bill_scans          ：每張掃進來的帳單（識別碼 + 帳單年月 唯一，防重複入帳）
--                         刪除營運費用時一併刪除，可重新掃

CREATE TABLE IF NOT EXISTS bill_barcode_bindings (
  id           bigserial PRIMARY KEY,
  barcode_key  text NOT NULL UNIQUE,
  category_id  bigint REFERENCES entity_fact_categories(id) ON DELETE SET NULL,
  fact_id      bigint REFERENCES entity_facts(id) ON DELETE CASCADE,
  store_erpid  varchar,
  label        text,
  created_by   varchar,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bill_scans (
  id           bigserial PRIMARY KEY,
  barcode_key  text NOT NULL,
  bill_ym      varchar(7) NOT NULL,          -- 帳單年月 YYYY-MM
  amount       numeric NOT NULL DEFAULT 0,
  due_date     date,
  raw_codes    jsonb,
  expense_id   uuid REFERENCES operational_expenses(id) ON DELETE CASCADE,
  created_by   varchar,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (barcode_key, bill_ym)
);

CREATE INDEX IF NOT EXISTS idx_bill_scans_expense ON bill_scans(expense_id);
