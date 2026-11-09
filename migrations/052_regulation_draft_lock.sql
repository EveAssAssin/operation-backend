-- 052_regulation_draft_lock.sql — 規範草稿：AI 擋下紀錄、提醒、自動清除（2026-11-09 Louis）
--   status 新增 'expired'（自動清除＝軟刪除，可還原；不在 OPEN_STATUSES → 鎖自動釋放）
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS blocked_at       TIMESTAMPTZ;   -- 最近一次送審被擋的時間
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS blocked_reason   JSONB;         -- { kind: ai|check, message, issues:[{title,detail}] }
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;   -- 最近一次提醒作者
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS remind_count     INT NOT NULL DEFAULT 0;
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS expired_at       TIMESTAMPTZ;
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS expire_reason    TEXT;
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS expired_from     TEXT;          -- 清除前的狀態（draft／returned），還原用
CREATE INDEX IF NOT EXISTS idx_regver_open_updated ON regulation_versions(status, updated_at) WHERE status IN ('draft','returned');
