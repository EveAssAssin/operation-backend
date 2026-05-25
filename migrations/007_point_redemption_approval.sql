-- migrations/007_point_redemption_approval.sql
-- 分數兌換改為「送審制」：
--   員工申請 → status=pending（不扣分）
--   營運主管審核通過 → 寫負分回 MAP + 扣庫存 → status=completed
--   駁回 → status=rejected（不扣分）
--
-- 既有 status 值：completed / cancelled / fulfilled
-- 新增 status 值：pending / rejected

-- 1. 新增審核相關欄位
ALTER TABLE point_redemptions ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ;
ALTER TABLE point_redemptions ADD COLUMN IF NOT EXISTS approved_by    TEXT;
ALTER TABLE point_redemptions ADD COLUMN IF NOT EXISTS reject_reason  TEXT;

-- 2. 若 status 欄位有 CHECK 限制，放寬以容納 pending / rejected
--    （找出並移除舊的 check constraint；沒有的話這段不影響）
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'point_redemptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE point_redemptions DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

-- 3. 重新加上涵蓋所有狀態的 CHECK
ALTER TABLE point_redemptions
  ADD CONSTRAINT point_redemptions_status_check
  CHECK (status IN ('pending','completed','rejected','cancelled','fulfilled'));

-- 4. map_write_status 在 pending 階段允許 null（尚未寫 MAP）
ALTER TABLE point_redemptions ALTER COLUMN map_write_status DROP NOT NULL;

-- 5. 索引：依狀態查（後台篩選待審）
CREATE INDEX IF NOT EXISTS idx_point_redemptions_status ON point_redemptions(status);
