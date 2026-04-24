-- ── 推播群組管理 ─────────────────────────────────────────────
-- push_groups: 推播群組定義
CREATE TABLE IF NOT EXISTS push_groups (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by   VARCHAR(100)
);

-- push_group_members: 群組成員（儲存推播所需資訊快照）
CREATE TABLE IF NOT EXISTS push_group_members (
  id            SERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES push_groups(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL,
  employee_name VARCHAR(100) NOT NULL,
  app_number    VARCHAR(50),
  store_name    VARCHAR(100),
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(group_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_pgm_group_id ON push_group_members(group_id);
