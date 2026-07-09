-- 010_recruitment_applicant_note.sql
-- 履歷投遞者記錄「投遞門市的備註」欄位（下拉選擇的人力需求備註 snapshot）
-- 因需求可能會關閉/改備註，這裡存 snapshot 保留歷史

ALTER TABLE recruitment_applicants
  ADD COLUMN IF NOT EXISTS target_store_note TEXT;

COMMENT ON COLUMN recruitment_applicants.target_store_note IS
  '投遞時人力需求的備註（snapshot）— 例如：早班兩人急缺、人事行政';
