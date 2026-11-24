-- 059：廠商回饋（2026-11-24 營運）
--   billing_sources.rebate_pct／rebate_mode：回饋 %、inclusive（帳單內含：帳單 100 → 實付 90）／exclusive（帳單外加：帳單 90 → 門市分帳 100，實付 90）
--   vendor_payment_requests：送審時照廠商設定快照 → gross_amount（帳面＝門市分帳合計）、rebate_amount、payout_amount（實際出款）
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS rebate_pct numeric;
ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS rebate_mode text;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS rebate_pct numeric;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS rebate_mode text;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS gross_amount numeric;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS rebate_amount numeric;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_amount numeric;
