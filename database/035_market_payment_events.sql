-- ============================================================
-- 035_market_payment_events.sql
-- 外部工務師（market-backend）請款事件 raw log 表
--   - 每筆事件（requested / paid / received / cancelled）進來時，
--     原封不動塞一筆到這裡（含完整 raw_body、idempotency_key）
--   - 之後 marketPaymentIngest 服務再把這筆事件轉換到 vendor_payment_requests
--   - 用 idempotency_key UNIQUE 直接擋重複投遞
--
-- 對應規格：營運部_請款API規格.md §4
-- ============================================================

CREATE TABLE IF NOT EXISTS market_payment_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id  UUID        NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_mpe_payment_request_id
  ON market_payment_events (payment_request_id);
CREATE INDEX IF NOT EXISTS idx_mpe_event
  ON market_payment_events (event);
CREATE INDEX IF NOT EXISTS idx_mpe_received_at
  ON market_payment_events (received_at DESC);

COMMENT ON TABLE  market_payment_events IS
  '外部工務師請款事件 raw log（market → operation）。idempotency_key UNIQUE 擋重複。';
COMMENT ON COLUMN market_payment_events.payment_request_id IS
  'market 端的 payment_request UUID（不是本地 vendor_payment_requests.id）';
COMMENT ON COLUMN market_payment_events.idempotency_key IS
  '格式 "<market_payment_request_id>:<event>"。UNIQUE 用來去重。';
