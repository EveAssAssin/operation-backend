-- migrations/009_point_redemption_quantity.sql
-- 分數兌換 — 支援單筆申請輸入數量（特別針對現金型「一次換多分」）
--
-- 例：item 設 points_cost=1（現金型 1分=NT$100），員工申請 quantity=50
--     → points_cost 欄位存「總扣分 50」、bonus_amount 存「NT$5000」、quantity 存 50
--
-- 既有資料：quantity DEFAULT 1，舊紀錄自動視為「兌換 1 次」，邏輯不變。

ALTER TABLE point_redemptions
  ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN point_redemptions.quantity IS
  '兌換單位數（cash 型 = 兌換的倍數；其他型 = 件數）。points_cost 與 bonus_amount 為已乘上 quantity 的總值。';
