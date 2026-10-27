-- migrations/039_regulations.sql
-- 規範系統（Phase 1）：營運系統成為規範主檔；MAP 只負責接收扣分紀錄
--   regulations           每份規範（匯入的沿用 MAP 規範編號；自建的從 900001 起）
--   regulation_versions   每一版的完整內容（草稿 / 送審 / 通過 / 退回），永久保留
--   regulation_clauses    「現行版」條文索引：引用扣分、搜尋用；條文代碼永久不變
--   regulation_deductions 引用條文的扣分單 → 審核通過後寫入 MAP（#25 setemployeescore）

-- 中文模糊搜尋用 pg_trgm；建不起來也不影響其他表（搜尋退回一般 ILIKE）
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm 無法建立：%', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS regulations (
  id              BIGINT PRIMARY KEY,
  title           TEXT NOT NULL,
  category        TEXT,
  doc_type        TEXT,                         -- 作業流程 / 行政規定 / 產品知識 / 工作職掌 …（未分類為 NULL）
  summary         TEXT,
  scenario        TEXT,
  owner_dept      TEXT,
  roles           TEXT[] NOT NULL DEFAULT '{}', -- 適用身分（沿用 MAP 身分別名稱）
  keywords        TEXT,
  legacy_meta     TEXT,                         -- 舊樣板表頭（編寫人／目的…）
  status          TEXT NOT NULL DEFAULT 'active',   -- active / disabled
  current_version INT  NOT NULL DEFAULT 1,
  used_codes      TEXT[] NOT NULL DEFAULT '{}', -- 曾經用過的條文代碼（新條文不得重用）
  score           INT  NOT NULL DEFAULT -1,     -- MAP 整份事由分數（未逐條設定時的預設扣分）
  bonus           INT  NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'map_import',  -- map_import / native
  map_reason_id   INT,
  map_version     INT,
  map_update_time TIMESTAMPTZ,
  map_sync_status TEXT,                         -- synced / pending（等左手寫入 API）/ failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS regulations_native_seq START 900001;

CREATE TABLE IF NOT EXISTS regulation_versions (
  id               BIGSERIAL PRIMARY KEY,
  regulation_id    BIGINT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  version          INT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft',   -- draft / pending / approved / returned / discarded
  doc              JSONB NOT NULL,                  -- { title, category, doc_type, summary, scenario, owner_dept, roles, sections }
  change_note      TEXT,
  source           TEXT,                            -- map_import / editor / ai
  created_by_name  TEXT,
  created_by_id    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at     TIMESTAMPTZ,
  review           JSONB,                           -- { summary[], notes[], risk, impact{}, checks[], diff[] }
  reviewed_by_name TEXT,
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT,
  reviewer_edited  BOOLEAN NOT NULL DEFAULT false,
  published_at     TIMESTAMPTZ,
  UNIQUE (regulation_id, version)
);
CREATE INDEX IF NOT EXISTS idx_regver_status ON regulation_versions(status);

CREATE TABLE IF NOT EXISTS regulation_clauses (
  code           TEXT PRIMARY KEY,
  regulation_id  BIGINT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  version        INT NOT NULL,
  parent_code    TEXT,
  section_title  TEXT,
  display_no     TEXT,
  ctype          TEXT,                          -- 規定 / 流程 / 說明（未分類為 NULL）
  text           TEXT NOT NULL,
  notes          JSONB NOT NULL DEFAULT '[]',
  penalty        INT,                           -- NULL = 未逐條設定（扣分時預設用 regulations.score）
  sort           INT NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT true  -- 已從現行版移除的條文 = false（舊扣分紀錄仍可查）
);
CREATE INDEX IF NOT EXISTS idx_regclause_reg ON regulation_clauses(regulation_id, sort);
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_regulations_title_trgm ON regulations USING gin (title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_regclause_text_trgm ON regulation_clauses USING gin (text gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'trgm 索引略過：%', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS regulation_deductions (
  id                  BIGSERIAL PRIMARY KEY,
  employee_erpid      TEXT NOT NULL,
  employee_name       TEXT,
  employee_app_number TEXT,
  store_name          TEXT,
  regulation_id       BIGINT NOT NULL REFERENCES regulations(id),
  regulation_title    TEXT,
  version             INT NOT NULL,
  clause_code         TEXT NOT NULL,
  clause_text         TEXT NOT NULL,              -- 扣分當下的條文內容快照
  score               INT NOT NULL,
  bonus               INT NOT NULL DEFAULT 0,
  incident_date       DATE,
  note                TEXT,
  photos              JSONB NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  map_status          TEXT,                             -- success / failed
  map_message         TEXT,
  created_by_name     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_name    TEXT,
  reviewed_at         TIMESTAMPTZ,
  reject_reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_regded_status ON regulation_deductions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_regded_clause ON regulation_deductions(clause_code);

-- 審核人設定（固定送給同一人；之後可加代理人）
INSERT INTO report_settings (key, value)
VALUES ('regulation_reviewer', '{"erpid":null,"app_number":null,"name":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 模組
INSERT INTO modules (key, label, icon, sort_order, is_system, description)
VALUES ('regulations', '規範管理', '📘', 96, true, '規範主檔、版本、送審審核、引用條文扣分')
ON CONFLICT (key) DO NOTHING;

-- RLS：只走後端 service_role
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['regulations','regulation_versions','regulation_clauses','regulation_deductions'] LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
