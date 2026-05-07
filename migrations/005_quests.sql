-- migrations/005_quests.sql
-- 任務派發模組：營運部 → 市場部
-- 本表存的是「營運部端發出的任務副本」，真正的任務狀態以市場部為主
-- 透過 market_task_id 對應到市場部 quests.id

-- ─── 任務派發紀錄 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quests (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 任務內容（送出當下的快照）
  title              TEXT        NOT NULL,
  description        TEXT,
  task_deadline      TIMESTAMPTZ NOT NULL,
  award_points       BOOLEAN     NOT NULL DEFAULT TRUE,
  required_submission JSONB      NOT NULL DEFAULT '["text"]'::jsonb,  -- 例 ["text","image"]
  assignees          JSONB       NOT NULL,                            -- [{type:"group",group_id:"..."}]

  -- 送出資訊
  external_id        TEXT,                       -- 給市場部回傳辨識用（= operation 端的 quest id 或自訂）
  source_system      TEXT        NOT NULL DEFAULT 'operation',
  source_system_name TEXT        NOT NULL DEFAULT '營運部系統',
  created_by_id      UUID,                       -- system_users.id
  created_by_name    TEXT,                       -- 顯示用快照（user.name 或「營運部」）

  -- 與市場部後端的對應與狀態
  market_task_id     TEXT,                       -- 市場部回傳的 quest.id
  status             TEXT        NOT NULL DEFAULT 'pending',
  -- pending: 尚未送出（理論上不會出現，建立時會立刻送）
  -- sent:    已送出，市場部已接收
  -- failed:  送出失敗（看 last_error）
  last_error         TEXT,

  -- 原始 payload / response（debug 用）
  request_payload    JSONB,
  response_payload   JSONB,

  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quests_status        ON quests(status);
CREATE INDEX IF NOT EXISTS idx_quests_created_at    ON quests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quests_market_id     ON quests(market_task_id);
CREATE INDEX IF NOT EXISTS idx_quests_created_by    ON quests(created_by_id);
