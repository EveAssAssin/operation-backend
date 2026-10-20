-- 027：廠商請款入口 V1（2026-10-20）
-- 營運：廠商登入 → 上傳帳單照片／Excel → 輸入「項目名稱／請款金額／分配門市」→ 送審；
--       會計接收時可以調整（可能填錯）；付款完成才進門市月報（markPaid 時自動產生帳單＋分攤）。
-- 合約連廠商：contracts.source_id → billing_sources；廠商登入看得到自己的合約。

CREATE TABLE IF NOT EXISTS vendor_payment_allocations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES vendor_payment_requests(id) ON DELETE CASCADE,
  seq           INT  NOT NULL DEFAULT 0,
  item_name     TEXT NOT NULL,
  store_erpid   TEXT NOT NULL,
  store_name    TEXT,
  amount        NUMERIC(14,2) NOT NULL,
  vendor_amount NUMERIC(14,2),           -- 廠商原本填的（會計改過才跟 amount 不同；會計新增的列＝NULL）
  vendor_store  TEXT,                    -- 廠商原本選的門市
  adjusted_by   TEXT,
  adjusted_at   TIMESTAMPTZ,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vpa_request ON vendor_payment_allocations(request_id);
ALTER TABLE vendor_payment_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE vendor_payment_files ADD COLUMN IF NOT EXISTS storage_path TEXT;   -- 私有 bucket vendor-files 的路徑（file_url 只放顯示用）

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES billing_sources(id) ON DELETE SET NULL;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS vendor_visible BOOLEAN NOT NULL DEFAULT true;   -- 廠商登入看不看得到
CREATE INDEX IF NOT EXISTS idx_contracts_source ON contracts(source_id);

-- 廠商上傳的帳單照片／Excel 放私有 bucket（看的時候發短效簽名網址）
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('vendor-files', 'vendor-files', false, 20971520)
ON CONFLICT (id) DO NOTHING;
