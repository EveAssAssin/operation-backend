-- ============================================================
-- 002_billing.sql
-- 開帳系統：帳單訂單 + 同步記錄
-- 在 Supabase SQL Editor 執行此檔案
-- ============================================================

-- ── billing_orders：帳單明細 ────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_orders (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id      varchar(64) NOT NULL UNIQUE,          -- 市場系統訂單 ID
  source_type   varchar(20) NOT NULL                  -- 'maintenance'（養護單）| 'repair'（報修單）
                CHECK (source_type IN ('maintenance', 'repair')),
  store_erpid   varchar(20) NOT NULL,                 -- 門市 ERP ID
  amount        numeric(10, 2) NOT NULL DEFAULT 0,    -- 金額
  signed_at     timestamptz NOT NULL,                 -- 簽收時間（歸月依據）
  billing_month varchar(7)  NOT NULL,                 -- YYYY-MM（由 signed_at 計算）
  raw_data      jsonb,                                -- 原始 API 回傳資料
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_orders_month
  ON billing_orders(billing_month);
CREATE INDEX IF NOT EXISTS idx_billing_orders_store
  ON billing_orders(store_erpid);
CREATE INDEX IF NOT EXISTS idx_billing_orders_signed_at
  ON billing_orders(signed_at);
CREATE INDEX IF NOT EXISTS idx_billing_orders_source_type
  ON billing_orders(source_type);

COMMENT ON TABLE  billing_orders               IS '帳單明細，每筆對應一張養護/報修訂單';
COMMENT ON COLUMN billing_orders.order_id      IS '市場系統唯一訂單 ID，用於 UPSERT 防重';
COMMENT ON COLUMN billing_orders.source_type   IS 'maintenance=養護單, repair=報修單';
COMMENT ON COLUMN billing_orders.billing_month IS '帳單歸屬月份（YYYY-MM），依 signed_at 計算';


-- ── billing_sync_logs：同步執行記錄 ─────────────────────────
CREATE TABLE IF NOT EXISTS billing_sync_logs (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_type      varchar(20) NOT NULL DEFAULT 'scheduled' -- 'scheduled' | 'manual' | 'incremental'
                 CHECK (sync_type IN ('scheduled', 'manual', 'incremental')),
  target_month   varchar(7),                              -- 指定月份同步時填入，增量同步為 NULL
  since_ts       timestamptz,                             -- 增量同步的 since 參數
  status         varchar(20) NOT NULL DEFAULT 'success'
                 CHECK (status IN ('success', 'error')),
  orders_synced  int          DEFAULT 0,                  -- 本次 upsert 筆數
  error_message  text,
  synced_at      timestamptz  DEFAULT now()
);

COMMENT ON TABLE billing_sync_logs IS '開帳系統同步記錄';
