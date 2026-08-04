-- 012_recruitment_followup_notify.sql
-- 待追蹤 LINE 推播：加 notified_at 欄位（避免同一筆重複推）
-- 履歷 + 面試 兩張表都要

ALTER TABLE recruitment_applicants
  ADD COLUMN IF NOT EXISTS follow_up_notified_at TIMESTAMPTZ;

ALTER TABLE recruitment_interviews
  ADD COLUMN IF NOT EXISTS follow_up_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN recruitment_applicants.follow_up_notified_at IS
  '待追蹤 LINE 推播的最後一次推送時間。使用者改動 follow_up_date 時會被 backend 清空，讓下次排程再推一次';
COMMENT ON COLUMN recruitment_interviews.follow_up_notified_at IS
  '待追蹤 LINE 推播的最後一次推送時間。同 applicants 表。';

-- 加索引方便查「有 follow_up_date 但還沒推」
CREATE INDEX IF NOT EXISTS idx_applicants_followup_pending
  ON recruitment_applicants(follow_up_date)
  WHERE follow_up_date IS NOT NULL AND follow_up_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_interviews_followup_pending
  ON recruitment_interviews(follow_up_date)
  WHERE follow_up_date IS NOT NULL AND follow_up_notified_at IS NULL;
