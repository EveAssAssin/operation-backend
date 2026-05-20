-- ============================================================
-- 014_billing_orders_allow_new_source_types.sql
-- 放寬 billing_orders.source_type 的 CHECK constraint
--   原本：只允許 maintenance / repair
--   新增：education_bonus（教育訓練獎金）/ ad_budget（企劃部廣告費）
-- ============================================================

ALTER TABLE billing_orders
  DROP CONSTRAINT IF EXISTS billing_orders_source_type_check;

ALTER TABLE billing_orders
  ADD CONSTRAINT billing_orders_source_type_check
  CHECK (source_type IN ('maintenance', 'repair', 'education_bonus', 'ad_budget'));

COMMENT ON COLUMN billing_orders.source_type IS
  'maintenance=養護單 / repair=報修單 / education_bonus=教育訓練獎金 / ad_budget=企劃部廣告費';
