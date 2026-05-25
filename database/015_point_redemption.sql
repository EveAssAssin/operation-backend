-- 015_point_redemption.sql
-- 分數兌換模組
-- 員工用 MAP 分數（getemployeescorerecord 歷史加總）兌換獎品。
-- 兌換時用 MAP setemployeescore 寫一筆負分回 MAP，餘額由 MAP 歷史自動反映。
-- 執行方式：貼到 Supabase SQL Editor → Run

-- ───────────────────────────────────────────────────────────
-- 1. 兌換品項目錄
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_redeem_items (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,                       -- 品項名稱
  description   TEXT,                                       -- 品項說明
  item_type     VARCHAR(20) NOT NULL DEFAULT 'physical',    -- physical 實體獎品 / cash 獎金禮券 / title 稱號權限 / other 其他
  points_cost   INTEGER     NOT NULL CHECK (points_cost > 0),-- 兌換所需分數
  image_url     TEXT,                                       -- 品項圖片
  stock         INTEGER,                                    -- 剩餘庫存；NULL = 不限量
  is_active     BOOLEAN     NOT NULL DEFAULT true,          -- 是否上架
  sort_order    INTEGER     NOT NULL DEFAULT 0,             -- 排序（小的在前）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  point_redeem_items            IS '分數兌換品項目錄';
COMMENT ON COLUMN point_redeem_items.item_type  IS 'physical 實體獎品 / cash 獎金禮券 / title 稱號權限 / other 其他';
COMMENT ON COLUMN point_redeem_items.stock      IS '剩餘庫存，NULL 表示不限量';

CREATE INDEX IF NOT EXISTS idx_point_redeem_items_active
  ON point_redeem_items (is_active, sort_order);

-- ───────────────────────────────────────────────────────────
-- 2. 兌換紀錄
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_redemptions (
  id                  BIGSERIAL PRIMARY KEY,
  employee_erpid      TEXT        NOT NULL,                 -- 員工 ERP 編號
  employee_app_number TEXT,                                 -- 員工推播會員編號
  employee_name       TEXT,                                 -- 員工姓名（快照）
  store_name          TEXT,                                 -- 員工門市（快照）
  item_id             BIGINT      REFERENCES point_redeem_items(id) ON DELETE SET NULL,
  item_name           TEXT        NOT NULL,                 -- 品項名稱（快照）
  item_type           VARCHAR(20),                          -- 品項類型（快照）
  points_cost         INTEGER     NOT NULL,                 -- 本次扣除分數（正數）
  status              VARCHAR(20) NOT NULL DEFAULT 'completed',
                      -- completed 已兌換 / fulfilled 已發放（實體）/ cancelled 已取消
  map_write_status    VARCHAR(20) NOT NULL DEFAULT 'pending',
                      -- success 寫回 MAP 成功 / failed 失敗
  map_write_message   TEXT,                                 -- MAP API 回傳訊息
  note                TEXT,                                 -- 備註
  fulfilled_at        TIMESTAMPTZ,                          -- 實體獎品發放時間
  fulfilled_by        TEXT,                                 -- 發放經手人
  redeemed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  point_redemptions                   IS '分數兌換紀錄';
COMMENT ON COLUMN point_redemptions.status            IS 'completed 已兌換 / fulfilled 已發放 / cancelled 已取消';
COMMENT ON COLUMN point_redemptions.map_write_status  IS 'success 寫回 MAP 成功 / failed 失敗';
COMMENT ON COLUMN point_redemptions.points_cost       IS '本次兌換扣除的分數（存正數，寫回 MAP 時為負）';

CREATE INDEX IF NOT EXISTS idx_point_redemptions_erpid
  ON point_redemptions (employee_erpid, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_redemptions_status
  ON point_redemptions (status, redeemed_at DESC);

-- ───────────────────────────────────────────────────────────
-- 3. updated_at 自動更新 trigger
-- ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_pr_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pr_items_updated_at ON point_redeem_items;
CREATE TRIGGER trg_pr_items_updated_at
  BEFORE UPDATE ON point_redeem_items
  FOR EACH ROW EXECUTE FUNCTION trg_pr_set_updated_at();
