-- ============================================================
-- 012_add_introducer_to_bindings.sql
-- 特約廠商綁定加上「介紹門市」與「介紹人」欄位
--   用途：紀錄該特約廠商是透過哪間門市的哪位員工介紹綁定的
--        未來作活動目標分眾、業績歸屬
-- ============================================================

ALTER TABLE appointed_unit_bindings
  ADD COLUMN IF NOT EXISTS introducer_store_erpid VARCHAR(50),
  ADD COLUMN IF NOT EXISTS introducer_store_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS introducer_member_id   VARCHAR(50),   -- = employees.app_number
  ADD COLUMN IF NOT EXISTS introducer_member_name VARCHAR(50);

COMMENT ON COLUMN appointed_unit_bindings.introducer_store_erpid IS '介紹門市代號（綁定時自選）';
COMMENT ON COLUMN appointed_unit_bindings.introducer_store_name  IS '介紹門市名稱（綁定時自選，cache）';
COMMENT ON COLUMN appointed_unit_bindings.introducer_member_id   IS '介紹人 app_number（綁定時自選）';
COMMENT ON COLUMN appointed_unit_bindings.introducer_member_name IS '介紹人姓名（綁定時自選，cache）';

CREATE INDEX IF NOT EXISTS idx_aub_introducer_store
  ON appointed_unit_bindings (introducer_store_erpid);
CREATE INDEX IF NOT EXISTS idx_aub_introducer_member
  ON appointed_unit_bindings (introducer_member_id);
