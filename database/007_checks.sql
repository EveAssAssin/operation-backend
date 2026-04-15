-- ============================================================
-- 007_checks.sql
-- 支票紀錄系統
--   check_batches  — 支票批次（一次對廠商/房東開多張）
--   checks         — 個別支票（每張有各自兌現日期）
--   check_notify_targets — 早上10點通知名單
-- ============================================================

-- 1. 支票批次
CREATE TABLE IF NOT EXISTS check_batches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no     VARCHAR(20) UNIQUE,           -- 系統自動編號 CHK-YYYYMM-NNNNN
  payee_name   VARCHAR(100) NOT NULL,         -- 收款人（廠商/房東名稱）
  payee_type   VARCHAR(20)  NOT NULL DEFAULT 'vendor'
               CHECK (payee_type IN ('vendor','landlord','other')),
  purpose      TEXT,                          -- 用途說明
  total_amount NUMERIC(12,2) NOT NULL,        -- 批次總金額
  check_count  INT          NOT NULL,         -- 支票張數
  status       VARCHAR(20)  NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','completed','voided')),
  notes        TEXT,
  created_by   UUID,                          -- system_users.id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE check_batches IS '支票批次：對同一收款人開出的一批分期支票';
COMMENT ON COLUMN check_batches.status IS 'active=進行中, completed=全數兌現, voided=已作廢';

-- 2. 個別支票
CREATE TABLE IF NOT EXISTS checks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     UUID        NOT NULL REFERENCES check_batches(id) ON DELETE CASCADE,
  seq_no       INT         NOT NULL,           -- 第幾張（1,2,3...）
  check_no     VARCHAR(50),                    -- 支票號碼（銀行票號）
  bank_name    VARCHAR(100),                   -- 銀行名稱
  bank_account VARCHAR(30),                    -- 帳號後四碼 / 帳號
  amount       NUMERIC(12,2) NOT NULL,         -- 此張支票金額
  due_date     DATE         NOT NULL,          -- 兌現日期
  status       VARCHAR(20)  NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','paid','voided')),
  paid_at      TIMESTAMPTZ,                    -- 實際付款時間
  paid_by      UUID,                           -- 誰標記付款
  void_reason  TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (batch_id, seq_no)
);

COMMENT ON TABLE checks IS '個別支票，每張有自己的兌現日期';
COMMENT ON COLUMN checks.status IS 'pending=待兌現, paid=已付款, voided=作廢';

-- Index
CREATE INDEX IF NOT EXISTS idx_checks_due_date  ON checks (due_date);
CREATE INDEX IF NOT EXISTS idx_checks_status    ON checks (status);
CREATE INDEX IF NOT EXISTS idx_checks_batch_id  ON checks (batch_id);

-- 3. LINE 通知目標（早上10點推撥名單）
CREATE TABLE IF NOT EXISTS check_notify_targets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(50) NOT NULL,      -- 顯示名稱
  app_number VARCHAR(20) NOT NULL,      -- LINE Bot app_number
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE check_notify_targets IS '每日10點支票到期通知的收件名單（by app_number）';

-- 4. batch_no 自動編號 trigger（格式 CHK-YYYYMM-NNNNN）
CREATE OR REPLACE FUNCTION generate_batch_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT;
  seq    INT;
BEGIN
  prefix := 'CHK-' || TO_CHAR(NOW(), 'YYYYMM') || '-';
  SELECT COUNT(*) + 1
    INTO seq
    FROM check_batches
   WHERE batch_no LIKE prefix || '%';

  NEW.batch_no := prefix || LPAD(seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_batch_no ON check_batches;
CREATE TRIGGER trigger_batch_no
  BEFORE INSERT ON check_batches
  FOR EACH ROW
  WHEN (NEW.batch_no IS NULL)
  EXECUTE FUNCTION generate_batch_no();
