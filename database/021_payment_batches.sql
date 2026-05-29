-- ============================================================
-- 021_payment_batches.sql
-- 匯款批次模組（S2）
--   1. payment_batches      批次主表（一次匯款一張）
--   2. payment_batch_items  批次明細（多張請款歸入同批次）
--   3. input_invoice_export_log  進項發票匯出紀錄
--
--   流程：選「已通過」的 vendor_payment_requests → 建批次 → 匯出元大 xlsx
--        → 上傳網銀執行 → 標記已撥款 → 同步 requests 狀態
-- ============================================================

-- ── 1. 批次主表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_batches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no           VARCHAR(30) UNIQUE,                   -- PAY-YYYYMM-NNN
  payment_date       DATE NOT NULL,                        -- 預計撥款日

  -- 付款方資料 snapshot（從 company_profile 帶入）
  payer_account_name VARCHAR(100),
  payer_account_no   VARCHAR(30),
  payer_bank_code    VARCHAR(10),
  payer_branch_code  VARCHAR(10),

  total_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_items        INTEGER NOT NULL DEFAULT 0,

  -- 狀態：preparing → exported → paid（或 cancelled）
  status             VARCHAR(20) NOT NULL DEFAULT 'preparing'
                     CHECK (status IN ('preparing', 'exported', 'paid', 'cancelled')),
  exported_at        TIMESTAMPTZ,
  exported_by        UUID REFERENCES system_users(id),
  paid_at            TIMESTAMPTZ,
  paid_by            UUID REFERENCES system_users(id),
  cancelled_at       TIMESTAMPTZ,
  cancelled_by       UUID REFERENCES system_users(id),
  cancelled_reason   TEXT,

  note               TEXT,

  created_by         UUID REFERENCES system_users(id),
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON payment_batches(status);
CREATE INDEX IF NOT EXISTS idx_payment_batches_date   ON payment_batches(payment_date DESC);

COMMENT ON COLUMN payment_batches.status IS 'preparing=準備中 / exported=已匯出 / paid=已撥款 / cancelled=已取消';


-- ── 2. 批次明細 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_batch_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  request_id         UUID NOT NULL REFERENCES vendor_payment_requests(id),
  bank_account_id    UUID REFERENCES vendor_bank_accounts(id),

  -- snapshot（避免廠商之後改帳號影響歷史批次）
  source_id          UUID,
  source_name        VARCHAR(100),
  bank_code          VARCHAR(10),
  branch_code        VARCHAR(10),
  account_no         VARCHAR(30),
  account_name       VARCHAR(100),
  amount             DECIMAL(12,2) NOT NULL,
  memo               VARCHAR(100),                          -- 附言（例：04-精華-貨款）

  -- 元大格式固定欄位（可在批次層級覆蓋預設）
  fee_burden_code    VARCHAR(5)  DEFAULT '15',
  notify_method      VARCHAR(5)  DEFAULT '0',
  id_type_code       VARCHAR(5),                            -- 識別碼類別（空 / 53 / 6）
  id_no              VARCHAR(20),                           -- 識別碼

  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_items_batch   ON payment_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_request ON payment_batch_items(request_id);

COMMENT ON TABLE payment_batch_items IS '批次明細，每筆對應一張 vendor_payment_request';


-- ── 3. batch_no 自動產生 trigger ──────────────────────────────
CREATE OR REPLACE FUNCTION generate_batch_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix  TEXT;
  seq_num INT;
BEGIN
  prefix := 'PAY-' || TO_CHAR(now(), 'YYYYMM') || '-';
  SELECT COUNT(*) + 1 INTO seq_num
    FROM payment_batches
    WHERE batch_no LIKE prefix || '%';
  NEW.batch_no := prefix || LPAD(seq_num::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batch_no ON payment_batches;
CREATE TRIGGER trg_batch_no
  BEFORE INSERT ON payment_batches
  FOR EACH ROW
  WHEN (NEW.batch_no IS NULL)
  EXECUTE FUNCTION generate_batch_no();


-- ── 4. 進項發票匯出紀錄 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS input_invoice_export_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period          VARCHAR(7) NOT NULL,        -- 匯出的月份 YYYY-MM
  invoice_count   INTEGER,
  total_amount    DECIMAL(12,2),
  exported_by     UUID REFERENCES system_users(id),
  exported_at     TIMESTAMPTZ DEFAULT now(),
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_input_export_period ON input_invoice_export_log(period DESC);


-- ── 5. 共用 trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_batches_updated ON payment_batches;
CREATE TRIGGER trg_payment_batches_updated BEFORE UPDATE ON payment_batches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
