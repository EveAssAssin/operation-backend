-- migrations/006_appointed_units.sql
-- 特約廠商模組：管理「特約單位 / 特約廠商員工 / LINE 綁定 / 推播紀錄」
-- 資料來源：樂活搜點子 webapi (lohas.realtime.tw/webapi/v010)
--   API 23 getUnitList                       → appointed_units
--   API 25 getAppointedUnitByCode            → appointed_units 補欄位
--   API 26 getAppointedUnitMembers           → appointed_unit_members
--   API 27 getAppointedUnitCategoryMembers   → appointed_unit_members（依類別補抓）
-- 綁定流程：
--   廠商員工：appointed_unit_code + 手機末 4 碼 → 比對 appointed_unit_members.mobile
--   廠商管理員：後台手動產生一次性綁定碼 → appointed_unit_bind_codes
-- 推播：
--   appointed_unit_broadcasts 紀錄發送結果（誰發、發給誰、用什麼通道、結果）

-- ───────────────────────────────────────────────────────────
-- 1. 特約單位（廠商主表）
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_units (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 來自搜點子的廠商代碼（API 25 ~ 27 的 appointed_unit_code），同時也對應 API 23 的 id
  unit_code           TEXT        NOT NULL UNIQUE,
  unit_name           TEXT        NOT NULL,
  unit_introduce      TEXT,

  -- 類別（API 25 回傳）
  category_id         TEXT,
  category_name       TEXT,

  -- 綁定門市清單（jsonb 陣列，例 [1,3,5]）
  bind_store_ids      JSONB       DEFAULT '[]'::jsonb,

  -- 合約與圖片
  contract_time       TIMESTAMPTZ,
  img_id              TEXT,
  img_path            TEXT,
  sort_weight         INT         DEFAULT 0,

  -- 是否允許在新 LINE OA 接收推播（後台可關閉）
  allow_broadcast     BOOLEAN     NOT NULL DEFAULT TRUE,

  -- 同步狀態
  last_synced_at      TIMESTAMPTZ,
  last_synced_source  TEXT,                       -- 'getUnitList' / 'getAppointedUnitByCode'

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointed_units_code        ON appointed_units(unit_code);
CREATE INDEX IF NOT EXISTS idx_appointed_units_category    ON appointed_units(category_id);
CREATE INDEX IF NOT EXISTS idx_appointed_units_synced_at   ON appointed_units(last_synced_at DESC);

-- ───────────────────────────────────────────────────────────
-- 2. 特約單位員工（廠商旗下會員）
--    來源：API 26 getAppointedUnitMembers / API 27
--    用 (unit_code, client_id) 當 unique key
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_unit_members (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_code         TEXT        NOT NULL,
  client_id         TEXT        NOT NULL,                       -- ERP 會員客編
  name              TEXT,
  mobile            TEXT,                                       -- 全碼，比對時取末 4
  mobile_last4      TEXT,                                       -- 預先算好的末 4 碼，給綁定 API 用
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_appointed_unit_members UNIQUE (unit_code, client_id)
);

CREATE INDEX IF NOT EXISTS idx_au_members_unit         ON appointed_unit_members(unit_code);
CREATE INDEX IF NOT EXISTS idx_au_members_mobile4      ON appointed_unit_members(mobile_last4);
CREATE INDEX IF NOT EXISTS idx_au_members_active       ON appointed_unit_members(is_active);

-- ───────────────────────────────────────────────────────────
-- 3. LINE 綁定主表（一個 line_user_id 只能綁一筆）
--    binding_role：
--      'employee' → 綁的是廠商員工，client_id 必填
--      'admin'    → 綁的是廠商管理員（公司本身），client_id 為空
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_unit_bindings (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  line_user_id      TEXT        NOT NULL UNIQUE,
  line_display_name TEXT,
  line_picture_url  TEXT,

  unit_code         TEXT        NOT NULL,
  unit_name_snap    TEXT,                                       -- 綁定當下的廠商名稱快照

  binding_role      TEXT        NOT NULL CHECK (binding_role IN ('employee','admin')),
  client_id         TEXT,                                       -- 員工模式才有
  member_name_snap  TEXT,
  member_mobile_snap TEXT,

  status            TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','unbound')),
  unbound_at        TIMESTAMPTZ,
  unbound_reason    TEXT,

  bound_at          TIMESTAMPTZ DEFAULT NOW(),
  last_active_at    TIMESTAMPTZ DEFAULT NOW(),

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_au_bind_unit       ON appointed_unit_bindings(unit_code);
CREATE INDEX IF NOT EXISTS idx_au_bind_role       ON appointed_unit_bindings(binding_role);
CREATE INDEX IF NOT EXISTS idx_au_bind_status     ON appointed_unit_bindings(status);
CREATE INDEX IF NOT EXISTS idx_au_bind_clientid   ON appointed_unit_bindings(client_id);

-- ───────────────────────────────────────────────────────────
-- 4. 一次性綁定碼（管理員流程用 / 員工驗證失敗的補救通道）
--    後台產生 → 請承辦人傳給廠商 → 廠商在 LIFF 輸入
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_unit_bind_codes (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_code         TEXT        NOT NULL,
  bind_code         TEXT        NOT NULL UNIQUE,                -- 6~8 碼大寫英數
  intended_role     TEXT        NOT NULL DEFAULT 'admin' CHECK (intended_role IN ('employee','admin')),
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  used_by_line_user_id TEXT,
  used_binding_id   UUID,
  created_by_id     UUID,                                       -- system_users.id
  created_by_name   TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_au_bindcode_unit    ON appointed_unit_bind_codes(unit_code);
CREATE INDEX IF NOT EXISTS idx_au_bindcode_active  ON appointed_unit_bind_codes(used_at, expires_at);

-- ───────────────────────────────────────────────────────────
-- 5. 推播紀錄（誰發、發給哪些單位、用什麼通道、結果）
--    channel：
--      'line_oa'      → 透過新 LINE OA Push API 給 line_user_id
--      'lohas_app'    → 透過樂活 APP（API 12 multipleLeftMessagePush）給 client_id
--      'both'         → 雙通道
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_unit_broadcasts (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title               TEXT        NOT NULL,
  message             TEXT        NOT NULL,
  link_url            TEXT,
  img_url             TEXT,

  channel             TEXT        NOT NULL CHECK (channel IN ('line_oa','lohas_app','both')),

  -- 收件對象（至少一個）
  target_type         TEXT        NOT NULL CHECK (target_type IN ('all','units','category','members')),
  target_unit_codes   JSONB       DEFAULT '[]'::jsonb,
  target_category_id  TEXT,
  target_client_ids   JSONB       DEFAULT '[]'::jsonb,

  -- 結果
  total_targets       INT         DEFAULT 0,
  total_sent          INT         DEFAULT 0,
  total_failed        INT         DEFAULT 0,
  status              TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','sending','done','failed')),
  last_error          TEXT,

  created_by_id       UUID,
  created_by_name     TEXT,
  scheduled_at        TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_au_bcast_status     ON appointed_unit_broadcasts(status);
CREATE INDEX IF NOT EXISTS idx_au_bcast_created    ON appointed_unit_broadcasts(created_at DESC);

-- ───────────────────────────────────────────────────────────
-- 6. 推播明細（每個收件人一筆，方便查單一廠商的推播歷史）
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointed_unit_broadcast_recipients (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  broadcast_id    UUID        NOT NULL REFERENCES appointed_unit_broadcasts(id) ON DELETE CASCADE,
  channel         TEXT        NOT NULL,                          -- 'line_oa' / 'lohas_app'
  line_user_id    TEXT,
  client_id       TEXT,
  unit_code       TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','sent','failed','skipped')),
  error_message   TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_au_bcast_recip_bid   ON appointed_unit_broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_au_bcast_recip_unit  ON appointed_unit_broadcast_recipients(unit_code);
CREATE INDEX IF NOT EXISTS idx_au_bcast_recip_lid   ON appointed_unit_broadcast_recipients(line_user_id);
CREATE INDEX IF NOT EXISTS idx_au_bcast_recip_cid   ON appointed_unit_broadcast_recipients(client_id);

-- ───────────────────────────────────────────────────────────
-- 7. updated_at 自動更新 trigger（套到上面四個有 updated_at 的表）
-- ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_au_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_au_units_updated_at ON appointed_units;
CREATE TRIGGER trg_au_units_updated_at
  BEFORE UPDATE ON appointed_units
  FOR EACH ROW EXECUTE FUNCTION trg_au_set_updated_at();

DROP TRIGGER IF EXISTS trg_au_members_updated_at ON appointed_unit_members;
CREATE TRIGGER trg_au_members_updated_at
  BEFORE UPDATE ON appointed_unit_members
  FOR EACH ROW EXECUTE FUNCTION trg_au_set_updated_at();

DROP TRIGGER IF EXISTS trg_au_bindings_updated_at ON appointed_unit_bindings;
CREATE TRIGGER trg_au_bindings_updated_at
  BEFORE UPDATE ON appointed_unit_bindings
  FOR EACH ROW EXECUTE FUNCTION trg_au_set_updated_at();
