-- 048_vendor_sort.sql
-- 廠商管理：廠商清單可自訂排序（數字小的在前；沒設的排在後面、照名稱）
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS sort_order integer;
