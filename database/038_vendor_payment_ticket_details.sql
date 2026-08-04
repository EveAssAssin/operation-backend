-- ============================================================
-- 038_vendor_payment_ticket_details.sql
-- 讓 market / chi-lens 事件能帶「每筆明細的門市 + 金額」
-- 通過審核時系統會依此自動建 bills + bill_allocations，
-- 讓外部工務師/廠商請款也能認列到各門市月報。
-- ============================================================

ALTER TABLE vendor_payment_requests
  ADD COLUMN IF NOT EXISTS ticket_details JSONB,
  ADD COLUMN IF NOT EXISTS linked_bill_id UUID REFERENCES bills(id) ON DELETE SET NULL;

COMMENT ON COLUMN vendor_payment_requests.ticket_details IS
  '每張修繕單/明細的完整資料（含 store_erpid, store_name, amount 等）；ingest 從外部事件塞入，approve 時用於自動建 bill_allocations';
COMMENT ON COLUMN vendor_payment_requests.linked_bill_id IS
  '通過時自動建立的 bills.id，用於一鍵導覽 + 避免重複建。';

CREATE INDEX IF NOT EXISTS idx_vpr_linked_bill ON vendor_payment_requests(linked_bill_id);
