-- 050_petty_cash.sql
-- 零用金管理（營運管理底下）
--   petty_cash_funds：金庫（可多個，例：總公司零用金、北部辦公室零用金），各自餘額
--   petty_cash_txns ：收入／支出流水；支出可「同步開帳」→ 列入門市月報（ledger_manual_entries entry_type='petty'，可拆多間店）
--   作廢留紀錄，不刪除

CREATE TABLE IF NOT EXISTS petty_cash_funds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  keeper_name   text,
  store_erpid   text,                 -- 開帳時預設的門市／部門
  note          text,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS petty_cash_txns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id        uuid NOT NULL REFERENCES petty_cash_funds(id),
  txn_date       date NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('in', 'out')),
  amount         numeric NOT NULL CHECK (amount > 0),
  category       text,                -- 收入：撥補／退回…；支出：用途
  description    text,
  payee          text,                -- 支出：付給誰（廠商／店家）；收入：從哪來
  receipt_no     text,                -- 發票／收據號碼
  handled_by     text,                -- 經手人
  post_to_ledger boolean NOT NULL DEFAULT false,
  report_ym      varchar(7),          -- 開帳入帳月份
  allocations    jsonb,               -- [{store_erpid, subject_id, amount}]
  void_at        timestamptz,
  void_by        text,
  void_reason    text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_petty_txns_fund_date ON petty_cash_txns(fund_id, txn_date);

-- 開帳產生的月報列 → 對回零用金那一筆
ALTER TABLE ledger_manual_entries ADD COLUMN IF NOT EXISTS petty_txn_id uuid REFERENCES petty_cash_txns(id);

INSERT INTO modules (key, label, icon, sort_order, is_system, description)
VALUES ('petty_cash', '零用金管理', '💰', 97, true, '零用金金庫、收入支出紀錄、支出同步開帳列入門市月報')
ON CONFLICT (key) DO NOTHING;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['petty_cash_funds','petty_cash_txns'] LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
