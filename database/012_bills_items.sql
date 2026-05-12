-- 012_bills_items.sql
-- bills 新增 items 欄位（JSONB），用來存單張帳單下的明細列表
-- 主要用途：API 自動同步進來的帳單（例如路奇天格鏡片），
--   把每一筆完成/退回單存在 bills.items 裡，
--   點開帳單詳情可以看到清單（日期、客戶單號、規格、數量、金額）

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bills.items IS
  '帳單明細列表（JSONB Array）。
   API 同步進來時填，手動建立的帳單可留空陣列。
   範例（路奇天格鏡片）：
   [{
     "type": "completion" | "return",
     "seq_no": 1,
     "item_date": "2026-04-07",
     "customer_order": "AI.廖如意7943",
     "doc_number": "268016405998",
     "product_spec": "1.67 悅視無界優抗明晰 10mm,...",
     "quantity": 1,
     "markup": 100,
     "unit_price": 840,
     "total": 840
   }]';
