-- migrations/006_handover.sql
-- 各類流程模組 — 第 1 個子功能：門市交接表
--
-- 設計：
--   1. 每門市可有多個「可重用模板」(handover_templates)
--   2. 每次實際交接是一個 instance (handovers)，建立時會 snapshot 模板品項
--   3. 三人 stage 流程：原 → 新 → 第三方確認 → 完成
--   4. 品項三種型別：check / number / count_module（盤點下一階段做）
--   5. 每筆 response 可帶照片（Supabase Storage 公開 URL）
--
-- items JSONB 範例（template/handover 都共用此格式）：
-- [
--   { "id":"uuid", "label":"店面鑰匙", "type":"check",  "required":true,  "allow_photo":true },
--   { "id":"uuid", "label":"未取件數量","type":"number","required":true,  "allow_photo":true },
--   { "id":"uuid", "label":"鏡框盤點","type":"count_module","required":false,"allow_photo":true }
-- ]
--
-- responses JSONB 範例（原方填的）：
-- [
--   { "item_id":"uuid","checked":true, "note":"已找到", "photo_urls":[] },
--   { "item_id":"uuid","value":35,     "note":"...", "photo_urls":["https://..."] },
--   { "item_id":"uuid","count_data":{...}, "note":"", "photo_urls":[] }
-- ]

-- ─── 1. 模板 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS handover_templates (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  store_erpid     TEXT         NOT NULL,
  store_name      TEXT         NOT NULL,
  name            TEXT         NOT NULL DEFAULT '預設交接表',
  items           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by_id   UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handover_templates_store  ON handover_templates(store_erpid);
CREATE INDEX IF NOT EXISTS idx_handover_templates_active ON handover_templates(is_active);

-- ─── 2. 交接 instance ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS handovers (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 來源
  template_id     UUID         REFERENCES handover_templates(id) ON DELETE SET NULL,
  store_erpid     TEXT         NOT NULL,
  store_name      TEXT         NOT NULL,
  -- snapshot：建立當下的品項清單
  items           JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- workflow stage
  stage           TEXT         NOT NULL DEFAULT 'pending_original',
  -- pending_original | pending_new | pending_third | completed | cancelled

  -- 原交接方
  original_member_id   TEXT,
  original_name        TEXT,
  original_filled_at   TIMESTAMPTZ,
  original_responses   JSONB,     -- 每品項的回答
  original_extra_note  TEXT,

  -- 新交接方
  new_member_id        TEXT,
  new_name             TEXT,
  new_filled_at        TIMESTAMPTZ,
  new_extra_note       TEXT,

  -- 第三方確認
  third_member_id      TEXT,
  third_name           TEXT,
  third_confirmed_at   TIMESTAMPTZ,
  third_note           TEXT,

  -- 後設
  created_by_id        UUID,
  created_by_name      TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handovers_store       ON handovers(store_erpid);
CREATE INDEX IF NOT EXISTS idx_handovers_stage       ON handovers(stage);
CREATE INDEX IF NOT EXISTS idx_handovers_created_at  ON handovers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handovers_template    ON handovers(template_id);

-- ─── 3. Storage bucket（手動建在 Supabase Dashboard，這裡只放提示）──
-- 請在 Supabase Storage 建立 public bucket：handover
-- (Dashboard → Storage → New bucket → name: handover, Public: ON)
-- 後端會把照片 upload 到 handover/<handover_id>/<random>.jpg
