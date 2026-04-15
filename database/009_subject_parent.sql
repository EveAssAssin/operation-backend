-- 009_subject_parent.sql
-- 支票科目加入母分類（自我參照）

ALTER TABLE check_subjects
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES check_subjects(id) ON DELETE SET NULL;

-- 現有科目全部視為沒有母分類（保持 NULL）
-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_check_subjects_parent_id ON check_subjects(parent_id);
