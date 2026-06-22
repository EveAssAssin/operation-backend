-- migrations/009_score_application.sql
-- 分數加分申請（與分數兌換相對的方向）：
--   員工申請加分 → 主管審核 → 通過時調整分數 → 寫正分到 MAP
--
-- 流程：
--   1. 管理者預先設定「申請類型」（含預設分數）
--   2. 員工從 /points → 申請加分 tab → 選類型 → 填說明 + 上傳附件 → 送出 (status=pending)
--   3. 主管審核：可在類型預設分數的基礎上手動調整 → 通過時 MAP setemployeescore 寫 score=+X
--   4. 也可駁回（填原因）

-- ─── 1. 申請類型（管理者預先建好）────────────────────────────
CREATE TABLE IF NOT EXISTS score_application_types (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT         NOT NULL,
  description     TEXT,
  default_score   INT          NOT NULL DEFAULT 1,   -- 員工申請時帶入；主管審核可改
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order      INT          NOT NULL DEFAULT 0,
  created_by_id   UUID,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_app_types_active ON score_application_types(is_active);
CREATE INDEX IF NOT EXISTS idx_score_app_types_sort   ON score_application_types(sort_order);

-- ─── 2. 加分申請紀錄 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_applications (
  id                  UUID         DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 申請類型 snapshot
  type_id             UUID         REFERENCES score_application_types(id) ON DELETE SET NULL,
  type_name           TEXT         NOT NULL,             -- 建立當下的類型名稱
  default_score       INT          NOT NULL DEFAULT 1,   -- 建立當下的預設分數

  -- 員工資料
  employee_erpid      TEXT         NOT NULL,
  employee_app_number TEXT,
  employee_name       TEXT,
  store_name          TEXT,

  -- 申請內容
  apply_reason        TEXT,                              -- 員工填的說明
  attachments         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- attachments 結構：[{ url, name, mime, size }, ...]

  -- 狀態
  status              TEXT         NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected

  -- 審核結果
  approved_score      INT,                               -- 通過時實際給的分數（審核者可調整）
  reject_reason       TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,

  -- MAP 寫入結果
  map_write_status    TEXT,                              -- success | failed | null
  map_write_message   TEXT,

  applied_at          TIMESTAMPTZ  DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  DEFAULT NOW(),

  CONSTRAINT score_applications_status_check
    CHECK (status IN ('pending','approved','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_score_apps_employee ON score_applications(employee_erpid);
CREATE INDEX IF NOT EXISTS idx_score_apps_status   ON score_applications(status);
CREATE INDEX IF NOT EXISTS idx_score_apps_applied  ON score_applications(applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_apps_type     ON score_applications(type_id);
