-- migrations/041_regulation_questions.sql
-- 人員「查規範」的 AI 問答紀錄：用來找出常被問、但規範沒寫清楚或沒寫到的地方
CREATE TABLE IF NOT EXISTS regulation_questions (
  id              BIGSERIAL PRIMARY KEY,
  employee_erpid  TEXT,
  employee_name   TEXT,
  store_name      TEXT,
  question        TEXT NOT NULL,
  answer          TEXT,
  citations       TEXT[] NOT NULL DEFAULT '{}',
  found           BOOLEAN,                 -- AI 是否在規範中找到答案
  helpful         BOOLEAN,                 -- 人員回饋：有幫助／沒幫助
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regq_created ON regulation_questions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_regq_found ON regulation_questions(found, created_at DESC);
DO $$ BEGIN EXECUTE 'ALTER TABLE IF EXISTS regulation_questions ENABLE ROW LEVEL SECURITY'; END $$;
