-- migrations/010_chi_vendors.sql
-- 路奇創意科技鏡片來源（chi-finance）的廠商代號對照表
-- API 送過來的 vendor code（RK01/RK02/...）由 chi-finance 決定
-- 我們這邊只維護：代號 ↔ 中文顯示名稱 / 啟停用 / 排序
--
-- 觸發時機：
--   - chi-lens sync 遇到 API 帶回但 DB 沒登記過的 code → 會 auto-upsert 一筆
--     (name 預設等於 code，管理員之後在後台改成中文名)
--   - 管理員可以在後台預先建好 code 與中文名，sync 就會直接用該中文名

CREATE TABLE IF NOT EXISTS chi_vendors (
  code           TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  display_order  INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chi_vendors_active ON chi_vendors(is_active, display_order);

-- 初始 seed
INSERT INTO chi_vendors (code, name, display_order)
VALUES
  ('RK01', '天格', 1),
  ('RK02', '康德', 2)
ON CONFLICT (code) DO NOTHING;
