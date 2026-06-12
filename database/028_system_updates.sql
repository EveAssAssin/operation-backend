-- ============================================================
-- 028_system_updates.sql
--   「系統更新」模組 — 用來展示開發績效
--     system_update_members  成員（如 營運部工程師、愛民眼鏡）
--     system_update_repos    每個成員綁定的 GitHub repo
-- ============================================================

CREATE TABLE IF NOT EXISTS system_update_members (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(50)  NOT NULL UNIQUE,
  description   TEXT,
  display_order INT          NOT NULL DEFAULT 0,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE system_update_members IS '「系統更新」模組的成員（負責人）';

CREATE TABLE IF NOT EXISTS system_update_repos (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     UUID         NOT NULL REFERENCES system_update_members(id) ON DELETE CASCADE,
  repo_label    VARCHAR(50),                  -- 顯示用標籤：營運後端 / 營運前端
  github_owner  VARCHAR(100) NOT NULL,
  github_repo   VARCHAR(100) NOT NULL,
  github_token  VARCHAR(255),                 -- 可選；private repo 需要
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, github_owner, github_repo)
);
COMMENT ON TABLE system_update_repos IS '每個成員綁定的 GitHub repo（一個成員可以綁多個）';

CREATE INDEX IF NOT EXISTS idx_sur_member ON system_update_repos (member_id);

-- ── 預設成員 ────────────────────────────────────────────
INSERT INTO system_update_members (name, description, display_order) VALUES
  ('營運部工程師', '營運部系統開發（operation-backend / operation-frontend）', 1),
  ('愛民眼鏡',     '愛民眼鏡相關開發',                                       2)
ON CONFLICT (name) DO NOTHING;

-- ── 預設 repo（營運部工程師）─────────────────────────────
-- token 留 NULL，service 端會 fallback 到環境變數 GITHUB_TOKEN（Render 已設）
INSERT INTO system_update_repos (member_id, repo_label, github_owner, github_repo)
  SELECT id, '營運後端', 'EveAssAssin', 'operation-backend'
  FROM system_update_members WHERE name = '營運部工程師'
ON CONFLICT (member_id, github_owner, github_repo) DO NOTHING;

INSERT INTO system_update_repos (member_id, repo_label, github_owner, github_repo)
  SELECT id, '營運前端', 'EveAssAssin', 'operation-frontend'
  FROM system_update_members WHERE name = '營運部工程師'
ON CONFLICT (member_id, github_owner, github_repo) DO NOTHING;
