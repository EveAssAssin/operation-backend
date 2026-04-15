-- ============================================================
-- 005_billing_sync_method.sql
-- billing_sources 新增 sync_method 欄位（手動 / API 自動）
-- bills 新增 source_ref 唯一索引（供 API 同步 upsert 用）
-- ============================================================

-- 1. billing_sources 新增 sync_method
ALTER TABLE billing_sources
  ADD COLUMN IF NOT EXISTS sync_method VARCHAR(20) DEFAULT 'manual'
  CHECK (sync_method IN ('manual', 'api'));

COMMENT ON COLUMN billing_sources.sync_method IS
  'manual=手動新增帳單, api=由外部 API 自動同步（如市場系統）';

-- 2. 標記工程部為 API 來源
UPDATE billing_sources
SET sync_method = 'api'
WHERE code = 'DEPT-ENGINEERING';

-- 3. bills.source_ref 加唯一索引（API 同步用，格式：mkt-{store_erpid}-{YYYY-MM}）
--    WHERE source_ref IS NOT NULL → 不影響手動帳單（source_ref 為 null）
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_source_ref
  ON bills (source_ref)
  WHERE source_ref IS NOT NULL;

COMMENT ON COLUMN bills.source_ref IS
  'API 同步帳單的唯一識別碼（格式：mkt-{store_erpid}-{YYYY-MM}），手動帳單為 NULL';
