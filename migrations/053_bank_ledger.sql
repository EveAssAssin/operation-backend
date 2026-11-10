-- 053_bank_ledger.sql
-- 金流 → 銀存彙整（2026-11）：匯入各銀行網銀交易明細，自動登錄、重複區間自動校正、分類／門市標記
--   bank_accounts ：銀行帳戶（存摺）
--   bank_imports  ：每次匯入紀錄（可整筆撤銷）
--   bank_txns     ：交易明細；fingerprint＝日期|時間|支出|存入|餘額|摘要#同檔第幾筆，同帳戶唯一 → 重複匯入不會重複
--                   status：active／removed（後來匯入的同區間檔案裡沒有這筆＝自動校正掉，留紀錄可還原）
--   bank_rules    ：分類／門市規則（備註含某字 → 類別／門市）

CREATE TABLE IF NOT EXISTS bank_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_name    text NOT NULL,
  account_no   text,                 -- 完整或遮罩（例 526376***1110）
  alias        text NOT NULL,        -- 顯示名稱（例：元大 總公司）
  holder       text,
  note         text,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES bank_accounts(id),
  file_name    text,
  bank_name    text,
  period_from  date,
  period_to    date,
  rows_total   integer NOT NULL DEFAULT 0,
  rows_new     integer NOT NULL DEFAULT 0,
  rows_dup     integer NOT NULL DEFAULT 0,
  rows_removed integer NOT NULL DEFAULT 0,
  rows_restored integer NOT NULL DEFAULT 0,
  balance_breaks jsonb,
  undone_at    timestamptz,
  undone_by    text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_txns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES bank_accounts(id),
  import_id       uuid REFERENCES bank_imports(id),
  fingerprint     text NOT NULL,
  txn_date        date NOT NULL,
  txn_time        text,
  value_date      date,
  ord             bigint NOT NULL DEFAULT 0,
  summary         text,
  out_amt         numeric NOT NULL DEFAULT 0,
  in_amt          numeric NOT NULL DEFAULT 0,
  balance         numeric,
  memo            text,
  memo2           text,
  counter_account text,
  branch          text,
  cheque_no       text,
  raw             jsonb,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  removed_import_id uuid REFERENCES bank_imports(id),
  category        text,
  store_erpid     text,
  tag_source      text,               -- auto／rule／manual
  note            text,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_bank_txns_acc_date ON bank_txns(account_id, txn_date, ord);
CREATE INDEX IF NOT EXISTS idx_bank_txns_date ON bank_txns(txn_date);
CREATE INDEX IF NOT EXISTS idx_bank_txns_store ON bank_txns(store_erpid, txn_date);

CREATE TABLE IF NOT EXISTS bank_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid REFERENCES bank_accounts(id) ON DELETE CASCADE,   -- 空＝所有帳戶
  pattern      text NOT NULL,          -- 摘要／備註／註記 含這段字
  direction    text CHECK (direction IN ('in', 'out')),               -- 空＝都適用
  category     text,
  store_erpid  text,
  priority     integer NOT NULL DEFAULT 100,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO modules (key, label, icon, sort_order, is_system, description)
VALUES ('bank_ledger', '銀存彙整', '🏦', 98, true, '匯入各銀行網銀交易明細、自動去重校正、分類與門市存入彙整')
ON CONFLICT (key) DO NOTHING;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts','bank_imports','bank_txns','bank_rules'] LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
