-- migrations/016_point_redeem_office_threshold.sql
-- 分數兌換：辦公室（內部部門）人員另設「兌換後最低餘額」
-- 判斷規則（程式端）：employees.store_name 不含「店」→ 內部部門（含商城門市）
-- NULL = 辦公室人員沿用 min_balance_after

ALTER TABLE point_redeem_items
  ADD COLUMN IF NOT EXISTS min_balance_after_office INT NULL;
COMMENT ON COLUMN point_redeem_items.min_balance_after_office IS
  '辦公室/內部部門人員的兌換後最低餘額；NULL = 沿用 min_balance_after';

-- 現金型品項：辦公室人員門檻 100
UPDATE point_redeem_items
   SET min_balance_after_office = 100
 WHERE item_type = 'cash' AND min_balance_after_office IS NULL;
