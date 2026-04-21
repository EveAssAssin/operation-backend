-- migrations/004_recruitment.sql
-- 人力招募模組：人力需求、履歷紀錄、面試紀錄

-- ─── 1. 人力需求表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_needs (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_erpid     TEXT        NOT NULL,
  store_name      TEXT        NOT NULL,
  total_needed    INTEGER     NOT NULL DEFAULT 1,   -- 總缺人數
  urgent_needed   INTEGER     NOT NULL DEFAULT 0,   -- 急缺人數
  filled          INTEGER     NOT NULL DEFAULT 0,   -- 已補人數（到職後 +1）
  status          TEXT        NOT NULL DEFAULT 'open',  -- open | fulfilled | closed
  note            TEXT,
  source          TEXT        NOT NULL DEFAULT 'hub',   -- hub | manual
  hub_message_id  TEXT        UNIQUE,               -- 防重複匯入
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 2. 履歷投遞者 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_applicants (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  date                DATE        NOT NULL DEFAULT CURRENT_DATE,
  platform            TEXT        NOT NULL,          -- '1111' | '104'
  name                TEXT        NOT NULL,
  code                TEXT,                          -- 人工輸入的平台代碼
  target_store_erpid  TEXT,
  target_store_name   TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending', -- pending | rejected | invited
  reject_reason       TEXT,
  interview_date      DATE,
  need_id             UUID        REFERENCES recruitment_needs(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 3. 面試紀錄 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_interviews (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  applicant_id     UUID        NOT NULL REFERENCES recruitment_applicants(id) ON DELETE CASCADE,
  notes            TEXT,
  audio_url        TEXT,        -- Supabase Storage URL
  result           TEXT,        -- null（待面試）| 'pass' | 'fail'
  education_linked BOOLEAN     DEFAULT FALSE,  -- 是否已在教訓系統新增新人
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rec_needs_status   ON recruitment_needs(status);
CREATE INDEX IF NOT EXISTS idx_rec_needs_store    ON recruitment_needs(store_erpid);
CREATE INDEX IF NOT EXISTS idx_rec_app_date       ON recruitment_applicants(date);
CREATE INDEX IF NOT EXISTS idx_rec_app_platform   ON recruitment_applicants(platform);
CREATE INDEX IF NOT EXISTS idx_rec_app_status     ON recruitment_applicants(status);
CREATE INDEX IF NOT EXISTS idx_rec_int_applicant  ON recruitment_interviews(applicant_id);
