-- ============================================================
-- 006_billing_api_start_period.sql
-- billing_sources 新增 api_start_period：
--   記錄從哪個月份起改為 API 自動同步
--   API sync 只處理 >= api_start_period 的月份，避免覆蓋舊手動帳單
-- ============================================================

ALTER TABLE billing_sources
  ADD COLUMN IF NOT EXISTS api_start_period VARCHAR(7)
  CHECK (api_start_period ~ '^\d{4}-\d{2}$');

COMMENT ON COLUMN billing_sources.api_start_period IS
  '開始 API 自動同步的月份（YYYY-MM）。
   sync_method=api 時必填；
   API sync 只同步 >= 此月份的資料，較早的月份保留為手動帳單';

-- 工程部從一開始就是 API，設定為最早的 billing_orders 月份
UPDATE billing_sources
SET api_start_period = (
  SELECT MIN(billing_month) FROM billing_orders
)
WHERE code = 'DEPT-ENGINEERING'
  AND api_start_period IS NULL;
