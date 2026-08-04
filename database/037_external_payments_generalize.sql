-- ============================================================
-- 037_external_payments_generalize.sql
-- 把外部請款事件流程通用化，讓 chi-finance-lens 也能接進來（跟 market 同架構）
--
-- 1. vendor_payment_requests.source_system 放寬 CHECK：加入 'chi_lens'
-- 2. vendor_payment_requests 加 vendor_code（chi-lens 用來對應廠商）
-- 3. 新增 chi_lens_payment_events 表（結構同 market_payment_events）
-- ============================================================

-- 1. 放寬 source_system CHECK
ALTER TABLE vendor_payment_requests
  DROP CONSTRAINT IF EXISTS vendor_payment_requests_source_system_check;
ALTER TABLE vendor_payment_requests
  ADD CONSTRAINT vendor_payment_requests_source_system_check
  CHECK (source_system IN ('internal','market','chi_lens'));

-- 2. 加 vendor_code（chi-lens 用來對應他們端的廠商代號）
ALTER TABLE vendor_payment_requests
  ADD COLUMN IF NOT EXISTS vendor_code TEXT;
COMMENT ON COLUMN vendor_payment_requests.vendor_code IS
  'source_system=chi_lens 時填；用來對應 chi_vendors.vendor_code。market 型不會填。';

-- 3. chi-lens 事件 raw log（結構同 market_payment_events）
CREATE TABLE IF NOT EXISTS chi_lens_payment_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id  TEXT        NOT NULL,                              -- chi-lens 端的 request id（他們用什麼都行，字串）
  event               TEXT        NOT NULL
                      CHECK (event IN ('requested','paid','received','cancelled')),
  idempotency_key     TEXT        NOT NULL,
  raw_body            JSONB       NOT NULL,
  processed_at        TIMESTAMPTZ,
  operation_ref       TEXT,
  error_message       TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_chi_lens_evt_payment_request_id
  ON chi_lens_payment_events (payment_request_id);
CREATE INDEX IF NOT EXISTS idx_chi_lens_evt_event
  ON chi_lens_payment_events (event);
CREATE INDEX IF NOT EXISTS idx_chi_lens_evt_received_at
  ON chi_lens_payment_events (received_at DESC);

COMMENT ON TABLE chi_lens_payment_events IS
  '路奇天格鏡片（chi-finance-lens）請款事件 raw log。idempotency_key UNIQUE 擋重複。';
