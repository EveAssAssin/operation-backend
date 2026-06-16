-- ============================================================
-- 034_document_library.sql
--   文件庫：以「廠商 / 門市 / 員工」分類存放文件 + tag
--   獨立於 contracts，純文件歸檔用
-- ============================================================

CREATE TABLE IF NOT EXISTS document_library (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  doc_type      VARCHAR(20)  NOT NULL CHECK (doc_type IN ('vendor', 'rent', 'employee')),
  -- vendor   廠商文件庫（以廠商名為分類）
  -- rent     門市文件庫（以門市名為分類）
  -- employee 員工文件庫（以員工姓名為分類）

  category      VARCHAR(100) NOT NULL,    -- 廠商名 / 門市名 / 員工名
  category_ref  VARCHAR(50),              -- 連動的 reference：departments.store_erpid 等（選填）
  tags          TEXT[]       NOT NULL DEFAULT '{}',

  -- 檔案 meta
  storage_path  TEXT         NOT NULL,
  public_url    TEXT,
  original_name VARCHAR(255),
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,

  description   TEXT,
  uploaded_by   VARCHAR(50),
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doclib_type_cat ON document_library (doc_type, category);
CREATE INDEX IF NOT EXISTS idx_doclib_uploaded ON document_library (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_doclib_tags     ON document_library USING GIN (tags);

ALTER TABLE document_library ENABLE ROW LEVEL SECURITY;
