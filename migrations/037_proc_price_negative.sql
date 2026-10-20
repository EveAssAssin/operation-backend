-- 037：加工中心主檔金額可以是負數（2026-10-21 營運：例如折讓／退還品項）
ALTER TABLE proc_price_items DROP CONSTRAINT IF EXISTS proc_price_items_amount_check;
