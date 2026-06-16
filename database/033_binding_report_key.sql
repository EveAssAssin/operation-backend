-- ============================================================
-- 033_binding_report_key.sql
--   company_profile 加 binding_report_api_key 欄位
--   讓營運部能在「公司資料」頁設對外 API key
-- ============================================================

ALTER TABLE company_profile
  ADD COLUMN IF NOT EXISTS binding_report_api_key VARCHAR(255);

COMMENT ON COLUMN company_profile.binding_report_api_key IS '特約廠商綁定報表對外 API 的 x-api-key（給其他部門對接用）';
