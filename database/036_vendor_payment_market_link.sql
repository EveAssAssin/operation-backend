-- ============================================================
-- 036_vendor_payment_market_link.sql
-- 讓 vendor_payment_requests 承接來自 market-backend 的外部工務師請款
--
-- 新增：
--   1. source_system  ='internal' | 'market'   請款來源
--   2. market_payment_request_id UNIQUE        對應 market 端 payment_request UUID（去重用）
--   3. engineer_name                           外部工務師姓名（不放進 billing_sources，避免污染）
--   4. ticket_numbers TEXT[]                   對應的修繕單編號清單（RPR-YYYYMMDD-NNN）
--   5. bank_snapshot JSONB                     此請款當下的收款帳號快照（market 送來的 bank_info）
-- ============================================================

ALTER TABLE vendor_payment_requests
  ADD COLUMN IF NOT EXISTS source_system             VARCHAR(20) NOT NULL DEFAULT 'internal'
    CHECK (source_system IN ('internal','market')),
  ADD COLUMN IF NOT EXISTS market_payment_request_id UUID,
  ADD COLUMN IF NOT EXISTS engineer_name             TEXT,
  ADD COLUMN IF NOT EXISTS ticket_numbers            TEXT[],
  ADD COLUMN IF NOT EXISTS bank_snapshot             JSONB;

-- UNIQUE 是關鍵：擋重複建同一筆 market 請款
CREATE UNIQUE INDEX IF NOT EXISTS uq_vpr_market_pr_id
  ON vendor_payment_requests (market_payment_request_id)
  WHERE market_payment_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vpr_source_system
  ON vendor_payment_requests (source_system);

COMMENT ON COLUMN vendor_payment_requests.source_system IS
  'internal=系統內建或廠商自建 / market=從 market-backend 事件轉換而來（外部工務師請款）';
COMMENT ON COLUMN vendor_payment_requests.market_payment_request_id IS
  'market 端 payment_request UUID。source_system=market 才有值；用於去重。';
COMMENT ON COLUMN vendor_payment_requests.engineer_name IS
  '外部工務師姓名快照（source_system=market 時填）';
COMMENT ON COLUMN vendor_payment_requests.ticket_numbers IS
  '此請款對應的修繕單編號陣列（RPR-YYYYMMDD-NNN）';
COMMENT ON COLUMN vendor_payment_requests.bank_snapshot IS
  '請款當下的收款帳號快照 JSON（market 送來的 bank_info），不需去 vendor_bank_accounts 查';
