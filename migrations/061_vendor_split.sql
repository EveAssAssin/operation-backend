-- 061：寄銷對帳單拆分＋中間商（2026-11-24 營運；第一家晶碩）
--   billing_sources.split_rules：[{ match:'38%抽成', rate:38, intermediary:2, hq:1 }]（門市拿 rate − 中間商 − 總部）
--   billing_sources.split_store_map：{ 店號: store_erpid }（自動對不到的，會計設一次）
--   billing_sources.intermediary：{ name, bank_code, branch_code, account_no, account_name }（中間商出款資料；出款時跟廠商一起匯出）
--   vendor_payment_requests.split：拆分結果（每店 廠商請款／中間商回饋／總部收入／門市開帳）；廠商端看不到
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS split_rules jsonb;
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS split_store_map jsonb;
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS intermediary jsonb;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS split jsonb;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS intermediary_amount numeric;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS hq_amount numeric;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS intermediary_snapshot jsonb;
