-- 036 加工中心開帳（2026-10-20）
-- 加工中心主管（獨立帳密）設定商品主檔金額 → 每月依加工站 sid 22（品管消毒完待返回）完成的單算各門市金額
-- → 主管看過按「開帳」→ 寫一張帳單（來源「加工中心」、月報格子 lens_lab 代工中心代工費）進門市月報。

CREATE TABLE IF NOT EXISTS proc_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 主檔金額：bind_id＝ERP 商品 id（加工站 track_lohas_products）；effective_from（YYYY-MM）起的月份用這個價
CREATE TABLE IF NOT EXISTS proc_price_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bind_id bigint NOT NULL,
  name text, brand text, catena text, model text,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  effective_from text NOT NULL CHECK (effective_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  is_active boolean NOT NULL DEFAULT true,
  note text,
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text, updated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_price_items_uq ON proc_price_items (bind_id, effective_from) WHERE is_active;

CREATE TABLE IF NOT EXISTS proc_price_log (
  id bigserial PRIMARY KEY,
  price_id uuid, bind_id bigint, action text NOT NULL,
  before jsonb, after jsonb, by_name text, at timestamptz NOT NULL DEFAULT now()
);

-- 開帳（月份×門市）；作廢＝重新開帳前的那一筆
CREATE TABLE IF NOT EXISTS proc_month_store (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ym text NOT NULL CHECK (ym ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  store_erpid text NOT NULL,
  store_name text,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  order_count int NOT NULL DEFAULT 0,
  snapshot jsonb,
  bill_id uuid,
  report_ym text,
  opened_by text, opened_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz, voided_by text, void_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS proc_month_store_uq ON proc_month_store (ym, store_erpid) WHERE voided_at IS NULL;

-- 開帳過的單（跨月去重：同一張單重工又到 sid 22，下個月不再算）
CREATE TABLE IF NOT EXISTS proc_billed_orders (
  order_number text PRIMARY KEY,
  month_store_id uuid NOT NULL REFERENCES proc_month_store(id) ON DELETE CASCADE,
  ym text NOT NULL, store_erpid text NOT NULL,
  amount numeric(12,2) NOT NULL DEFAULT 0
);

-- 追加金額（可負數，例：已開帳後退單在下個月沖銷）
CREATE TABLE IF NOT EXISTS proc_order_extra (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ym text NOT NULL CHECK (ym ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  store_erpid text NOT NULL,
  order_number text,
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz, voided_by text
);
CREATE INDEX IF NOT EXISTS proc_order_extra_ym ON proc_order_extra (ym, store_erpid) WHERE voided_at IS NULL;

ALTER TABLE proc_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc_price_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc_price_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc_month_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc_billed_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc_order_extra ENABLE ROW LEVEL SECURITY;

-- 帳單來源「加工中心」
INSERT INTO billing_sources (name, short_name, source_type, sync_method, ledger_code, is_active, notes, code)
SELECT '加工中心', '加工中心', 'admin_dept', 'api', 'lens_lab', true, '加工中心開帳系統自動建帳單（migration 036）', 'PROC_CENTER'
WHERE NOT EXISTS (SELECT 1 FROM billing_sources WHERE code = 'PROC_CENTER');
