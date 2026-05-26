-- migrations/008_point_redemption_cash.sql
-- 分數兌換 - 加入「現金 / 獎金」兌換型品項支援
-- 規則：
--   1. item_type='cash' 表示「兌換獎金」型品項。換算比例固定 1 分 = NT$100
--      （bonus_amount 在執行時計算 = points_cost * 100，不另存欄位）
--   2. 每個品項可設定 min_balance_after — 兌換後員工剩餘分數不得低於此值
--      （現金品項建議設 200）
--   3. point_redemptions 加 bonus_amount 欄位，記錄此筆實際寫入 MAP 的獎金金額（稽核用）

-- 1. 品項表加門檻欄位
ALTER TABLE point_redeem_items
  ADD COLUMN IF NOT EXISTS min_balance_after INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN point_redeem_items.min_balance_after IS
  '兌換後員工剩餘分數不得低於此值（例：現金品項設 200）';

-- 2. 兌換紀錄表加實際發出的獎金金額（snapshot 稽核用）
ALTER TABLE point_redemptions
  ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC NOT NULL DEFAULT 0;
COMMENT ON COLUMN point_redemptions.bonus_amount IS
  '實際寫入 MAP 的獎金金額（cash 型才 > 0）';
