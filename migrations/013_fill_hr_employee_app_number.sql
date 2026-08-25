-- 013_fill_hr_employee_app_number.sql
-- 「人事」同仁（erpid=28327441）app_number 是空的，導致系統授權時 400
-- 這裡把 app_number 補上 = erpid，讓她能用 erpid 當登入 token
--
-- 未來若有其他員工同樣狀況（LeftHand 沒帶下 app_number 的手動加入者），
-- 只要 erpid 有值、app_number 空著，就一起補（保守：只補在職員工）

UPDATE employees
SET app_number = erpid,
    updated_at = NOW()
WHERE (app_number IS NULL OR app_number = '')
  AND erpid IS NOT NULL AND erpid <> ''
  AND is_active = true;
