-- ============================================================
-- 013_add_created_by_to_recruitment_needs.sql
-- 人力需求加上「建需求的人」欄位
--   用途：每天 11:00 重複需求推播時，找出對應的申請者推播
--   值：system_users.member_id（= app_number）
--   為 NULL 表示系統來源（如 market_api），無對應人員
-- ============================================================

ALTER TABLE recruitment_needs
  ADD COLUMN IF NOT EXISTS created_by_app_number VARCHAR(50);

COMMENT ON COLUMN recruitment_needs.created_by_app_number IS '建需求的人 app_number；market_api 來源為 NULL';

CREATE INDEX IF NOT EXISTS idx_recruitment_needs_created_by
  ON recruitment_needs (created_by_app_number);
