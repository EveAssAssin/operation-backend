-- 042 加工中心開帳改回舊方式（2026-10-30 營運）
-- 依「下單日期」開帳，週期＝上月 21 日～本月 20 日（例：2026-10 期＝9/21～10/20，列入 10 月門市月報）；
-- 舊方式開到 2026-08-20 → 新系統第一期 2026-09（8/21～9/20）。
-- 取消的單：加工做完了照算、沒做完不算；開帳後才取消且加工沒做完 → 下一期自動沖回（credit_*）。
-- ERP 晚送進來的單：下單日期在已開帳的期別、還沒開過 → 下一期補開。
ALTER TABLE proc_billed_orders ADD COLUMN IF NOT EXISTS credit_ym text;
ALTER TABLE proc_billed_orders ADD COLUMN IF NOT EXISTS credit_month_store_id uuid REFERENCES proc_month_store(id) ON DELETE SET NULL;
ALTER TABLE proc_billed_orders ADD COLUMN IF NOT EXISTS order_date date;
CREATE INDEX IF NOT EXISTS proc_billed_orders_ym ON proc_billed_orders (ym) WHERE credit_ym IS NULL;
CREATE INDEX IF NOT EXISTS proc_billed_orders_credit ON proc_billed_orders (credit_month_store_id);

INSERT INTO report_settings (key, value)
VALUES ('proc_cycle', '{"start":"2026-08-21","end_day":20,"lookback_days":90,"include_no_lens":false,"credit_months":6}'::jsonb)
ON CONFLICT (key) DO NOTHING;
