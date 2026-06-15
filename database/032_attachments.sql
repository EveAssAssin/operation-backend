-- ============================================================
-- 032_attachments.sql
--   通用附件表：合約、醫療文件、未來任何模組都可用
--   檔案實體存 Supabase Storage 的 attachments bucket，這裡只存 meta
-- ============================================================

CREATE TABLE IF NOT EXISTS attachments (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 所屬實體
  entity_type   VARCHAR(50)  NOT NULL,  -- 'contract' / 'medical_doc' / 'recurring_expense' / 等
  entity_id     UUID         NOT NULL,  -- 對應 record id

  -- Storage 資訊
  storage_path  TEXT         NOT NULL,  -- Supabase Storage 內的 path: contract/<id>/<filename>
  public_url    TEXT,                   -- 公開 URL（bucket public 時）

  -- 檔案 meta
  original_name VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,

  -- 分類
  category      VARCHAR(50),            -- 'contract_pdf' / 'license' / 'invoice' 等（同 entity 內細分）
  note          TEXT,

  -- 上傳者
  uploaded_by   VARCHAR(50),            -- app_number
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE attachments IS '通用附件 meta（檔案實體在 Supabase Storage attachments bucket）';

CREATE INDEX IF NOT EXISTS idx_attach_entity ON attachments (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attach_uploaded ON attachments (uploaded_at DESC);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

-- ── 提醒（不執行）：
-- 需要在 Supabase Dashboard → Storage 手動建立 bucket
--   bucket name: attachments
--   public:      勾起來（讓 public_url 能直接下載）
--   file size limit: 50 MB 之類
-- 或者也可以用 SQL 建（不一定有權限）：
--   INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', true);
