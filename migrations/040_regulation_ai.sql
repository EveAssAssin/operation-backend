-- migrations/040_regulation_ai.sql
-- 規範系統 Phase 2：AI 監督檢查結果、AI 助理紀錄、每週巡檢

ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS ai_checks JSONB;            -- { at, doc_hash, issues:[], resolved:{ id: {how, reason} } }
ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS assist_log JSONB NOT NULL DEFAULT '[]'::jsonb;  -- AI 助理：需求、方案、採用哪個
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS last_audited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS regulation_audit_findings (
  id             BIGSERIAL PRIMARY KEY,
  regulation_id  BIGINT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  version        INT NOT NULL,
  batch_id       TEXT,                              -- 同一次巡檢
  severity       TEXT NOT NULL DEFAULT 'warn',      -- warn / info
  kind           TEXT,                              -- 矛盾 / 衝突 / 模糊 / 過時 / 重複 / 引用 / 其他
  title          TEXT NOT NULL,
  detail         TEXT,
  codes          TEXT[] NOT NULL DEFAULT '{}',      -- 涉及的條文代碼（含其他規範）
  fix            JSONB,                             -- { label, ops:[] }（套在這份規範上）
  status         TEXT NOT NULL DEFAULT 'open',      -- open / ignored / drafted / resolved
  ignore_reason  TEXT,
  draft_version_id BIGINT,
  handled_by     TEXT,
  handled_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regaudit_status ON regulation_audit_findings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_regaudit_reg ON regulation_audit_findings(regulation_id);

DO $$ BEGIN
  EXECUTE 'ALTER TABLE IF EXISTS regulation_audit_findings ENABLE ROW LEVEL SECURITY';
END $$;
