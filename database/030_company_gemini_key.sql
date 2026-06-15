-- ============================================================
-- 030_company_gemini_key.sql
--   company_profile 加 gemini_api_key 欄位
--   讓營運部能在「公司資料」頁設 API key，不需要登 Render dashboard
-- ============================================================

ALTER TABLE company_profile
  ADD COLUMN IF NOT EXISTS gemini_api_key VARCHAR(255);

COMMENT ON COLUMN company_profile.gemini_api_key IS 'Gemini API Key（合約 PDF 自動解析用）';
