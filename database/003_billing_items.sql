-- 003_billing_items.sql
-- 為 billing_orders 補充明細項目欄位
-- 執行方式：貼到 Supabase SQL Editor → Run

-- 1. 新增 items 欄位（JSONB，存 include=items 回傳的明細陣列）
ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;

-- 2. 新增 remark 欄位（市場 API 回傳的備註文字）
ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS remark TEXT;

-- 3. 新增 billing_category 欄位（依 source_type 對應部門分類）
ALTER TABLE billing_orders
  ADD COLUMN IF NOT EXISTS billing_category VARCHAR(50);

-- 4. 補填現有資料的 billing_category（repair / maintenance 都歸工程部）
UPDATE billing_orders
SET billing_category = '工程部'
WHERE billing_category IS NULL
  AND source_type IN ('repair', 'maintenance');

-- 5. 建立 billing_category 索引，方便按部門查詢
CREATE INDEX IF NOT EXISTS idx_billing_orders_billing_category
  ON billing_orders (billing_category);
