-- 011_recruitment_tags_followup.sql
-- 履歷 + 面試紀錄：加上「人才標記」與「待追蹤」相關欄位
--
-- 需求：
--   1. 標記人才（星等 + 文字說明）
--   2. 記錄求職者反應（思考中 / 已回覆 / 已就任其他 / 待聯絡）
--   3. 預計何時給答案（求職者說的日期）
--   4. 下次追蹤日 + 追蹤備註（提醒人事）
--
-- 履歷跟面試都要，因為履歷喜歡的 vs 面試喜歡的可能是兩件事

ALTER TABLE recruitment_applicants
  ADD COLUMN IF NOT EXISTS tag_stars           INTEGER,
  ADD COLUMN IF NOT EXISTS tag_notes           TEXT,
  ADD COLUMN IF NOT EXISTS candidate_status    TEXT,
  ADD COLUMN IF NOT EXISTS expected_reply_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_date      DATE,
  ADD COLUMN IF NOT EXISTS follow_up_notes     TEXT;

ALTER TABLE recruitment_interviews
  ADD COLUMN IF NOT EXISTS tag_stars           INTEGER,
  ADD COLUMN IF NOT EXISTS tag_notes           TEXT,
  ADD COLUMN IF NOT EXISTS candidate_status    TEXT,
  ADD COLUMN IF NOT EXISTS expected_reply_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_date      DATE,
  ADD COLUMN IF NOT EXISTS follow_up_notes     TEXT;

-- 加索引方便撈「待追蹤」查詢（follow_up_date <= today+3）
CREATE INDEX IF NOT EXISTS idx_applicants_follow_up_date
  ON recruitment_applicants(follow_up_date)
  WHERE follow_up_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interviews_follow_up_date
  ON recruitment_interviews(follow_up_date)
  WHERE follow_up_date IS NOT NULL;

-- 註解
COMMENT ON COLUMN recruitment_applicants.tag_stars           IS '人才評等：0~5 星（NULL=未評）';
COMMENT ON COLUMN recruitment_applicants.tag_notes           IS '星等文字說明（例：溝通能力強、經驗豐富）';
COMMENT ON COLUMN recruitment_applicants.candidate_status    IS '求職者反應：思考中 / 已回覆 / 已就任其他 / 待聯絡 / (null)';
COMMENT ON COLUMN recruitment_applicants.expected_reply_date IS '求職者說要在此日之前給答案';
COMMENT ON COLUMN recruitment_applicants.follow_up_date      IS '下次追蹤日（人事應該在此日之前主動聯繫）';
COMMENT ON COLUMN recruitment_applicants.follow_up_notes     IS '追蹤備註（例：週三上午打電話）';
