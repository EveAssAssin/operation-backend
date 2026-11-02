-- 043_recruitment_source.sql
-- 人力招募：新增「人才來源」欄位
-- 來源三選一：主動投遞 / 關注者媒合 / 條件媒合
-- 預設值：主動投遞（相容既有資料）

ALTER TABLE recruitment_applicants
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '主動投遞';

-- 限制值域
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_applicants_source_check'
  ) THEN
    ALTER TABLE recruitment_applicants
      ADD CONSTRAINT recruitment_applicants_source_check
      CHECK (source IN ('主動投遞', '關注者媒合', '條件媒合'));
  END IF;
END$$;

-- 索引（之後若要以來源做分析/篩選）
CREATE INDEX IF NOT EXISTS idx_recruitment_applicants_source
  ON recruitment_applicants(source);
