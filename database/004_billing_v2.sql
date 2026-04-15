-- ============================================================
-- 004_billing_v2.sql
-- 開帳系統 v2：來源單位 / 會計科目 / 帳單 / 門市分配 / 廠商帳號
-- 執行方式：貼到 Supabase SQL Editor → Run
-- ============================================================


-- ── billing_sources：來源單位（廠商 / 行政部門 / 營運費用類型）
CREATE TABLE IF NOT EXISTS billing_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   VARCHAR(20) NOT NULL
                CHECK (source_type IN ('admin_dept', 'vendor', 'operational')),
  -- admin_dept = 行政部門費用（6-1）
  -- vendor     = 廠商費用（6-2）
  -- operational= 營運費用（6-3，租金、水電等）
  code          VARCHAR(50) UNIQUE,        -- 識別碼（可自訂）
  name          VARCHAR(100) NOT NULL,     -- 來源名稱
  dept_erpid    VARCHAR(20),               -- 對應行政部門 erpid（admin_dept 用）
  contact_name  VARCHAR(50),              -- 聯絡人
  contact_phone VARCHAR(30),
  contact_email VARCHAR(100),
  notes         TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE  billing_sources            IS '帳單來源單位（廠商 / 行政部門 / 營運費用類型）';
COMMENT ON COLUMN billing_sources.source_type IS 'admin_dept=行政部門費用, vendor=廠商費用, operational=營運費用';
COMMENT ON COLUMN billing_sources.dept_erpid  IS '對應左手系統行政部門 erpid（admin_dept 類型使用）';


-- ── vendor_accounts：廠商登入帳號 ────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES billing_sources(id) ON DELETE CASCADE,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- bcrypt
  last_login_at TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE vendor_accounts IS '廠商後台登入帳號，FK 到 billing_sources（vendor 類型）';


-- ── accounting_categories：會計科目（每個來源單位各自維護）──
CREATE TABLE IF NOT EXISTS accounting_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID NOT NULL REFERENCES billing_sources(id) ON DELETE CASCADE,
  code        VARCHAR(50),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_accounting_categories_source
  ON accounting_categories(source_id);

COMMENT ON TABLE accounting_categories IS '會計科目，每個來源單位各自維護自己的科目清單';


-- ── bills：帳單主表 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no                VARCHAR(30) UNIQUE,    -- 系統自動生成帳單編號（如 BILL-2025-00001）
  source_id              UUID NOT NULL REFERENCES billing_sources(id),
  accounting_category_id UUID REFERENCES accounting_categories(id),
  period                 VARCHAR(7) NOT NULL,   -- 帳單歸屬月份 YYYY-MM
  title                  VARCHAR(200) NOT NULL, -- 帳單標題
  description            TEXT,
  total_amount           DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency               VARCHAR(3) DEFAULT 'TWD',

  -- 狀態流程：draft → submitted → confirmed → distributed → void
  status  VARCHAR(20) DEFAULT 'draft'
          CHECK (status IN ('draft','submitted','confirmed','distributed','void')),

  -- 外部參考（廠商發票等）
  source_ref    VARCHAR(100),   -- 外部單號（如廠商系統編號）
  invoice_no    VARCHAR(50),    -- 發票號碼
  invoice_date  DATE,           -- 發票日期

  -- 附件
  attachment_urls JSONB DEFAULT '[]',  -- [{ name, url, uploaded_at }]

  -- 審核紀錄
  submitted_at   TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  confirmed_by   UUID REFERENCES system_users(id),
  distributed_at TIMESTAMPTZ,
  distributed_by UUID REFERENCES system_users(id),
  void_at        TIMESTAMPTZ,
  void_by        UUID REFERENCES system_users(id),
  void_reason    TEXT,

  notes TEXT,

  -- 建立者（system user 或廠商）
  created_by_type   VARCHAR(10) CHECK (created_by_type IN ('system','vendor')),
  created_by_system UUID REFERENCES system_users(id),
  created_by_vendor UUID REFERENCES vendor_accounts(id),

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bills_period   ON bills(period);
CREATE INDEX IF NOT EXISTS idx_bills_source   ON bills(source_id);
CREATE INDEX IF NOT EXISTS idx_bills_status   ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_bill_no  ON bills(bill_no);

COMMENT ON TABLE  bills         IS '帳單主表，支援三種來源類型（行政部門 / 廠商 / 營運費用）';
COMMENT ON COLUMN bills.bill_no IS 'BILL-YYYYMM-NNNNN 格式，建立時自動產生';
COMMENT ON COLUMN bills.status  IS 'draft=草稿, submitted=已送審, confirmed=已確認, distributed=已分配, void=作廢';


-- ── bill_allocations：帳單門市分配 ──────────────────────────
-- 一張帳單可拆分給多個門市（如水電費 5000 → 大里 3000 + 東山 2000）
CREATE TABLE IF NOT EXISTS bill_allocations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  store_erpid      VARCHAR(20) NOT NULL,
  store_name       VARCHAR(100),
  allocated_amount DECIMAL(12,2) NOT NULL,  -- 分配金額
  allocation_note  TEXT,                    -- 分配說明

  -- 門市確認狀態
  confirm_status   VARCHAR(20) DEFAULT 'pending'
                   CHECK (confirm_status IN ('pending','confirmed','disputed')),
  confirmed_by     UUID REFERENCES system_users(id),
  confirmed_at     TIMESTAMPTZ,
  dispute_reason   TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (bill_id, store_erpid)
);

CREATE INDEX IF NOT EXISTS idx_bill_allocations_bill
  ON bill_allocations(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_allocations_store
  ON bill_allocations(store_erpid);
CREATE INDEX IF NOT EXISTS idx_bill_allocations_period
  ON bill_allocations(bill_id);  -- 透過 JOIN bills 查月份

COMMENT ON TABLE  bill_allocations                  IS '帳單門市分配，一張帳單可拆分多門市';
COMMENT ON COLUMN bill_allocations.allocated_amount IS '分配到此門市的金額';
COMMENT ON COLUMN bill_allocations.confirm_status   IS 'pending=待確認, confirmed=已確認, disputed=有異議';


-- ── 建立帳單序號函式（BILL-YYYYMM-NNNNN）────────────────────
CREATE OR REPLACE FUNCTION generate_bill_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix   TEXT;
  seq_num  INT;
BEGIN
  prefix  := 'BILL-' || TO_CHAR(now(), 'YYYYMM') || '-';
  SELECT COUNT(*) + 1 INTO seq_num
  FROM bills
  WHERE bill_no LIKE prefix || '%';
  NEW.bill_no := prefix || LPAD(seq_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_bills_bill_no
  BEFORE INSERT ON bills
  FOR EACH ROW
  WHEN (NEW.bill_no IS NULL)
  EXECUTE FUNCTION generate_bill_no();


-- ── 初始化：加入既有工程部帳單的來源單位 ────────────────────
-- 工程部（handling existing billing_orders）
INSERT INTO billing_sources (source_type, code, name, dept_erpid, notes)
VALUES
  ('admin_dept', 'DEPT-ENGINEERING', '工程部', NULL, '報修單 / 養護單，資料由市場系統 API 同步')
ON CONFLICT (code) DO NOTHING;
