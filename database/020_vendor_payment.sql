-- ============================================================
-- 020_vendor_payment.sql
-- 廠商請款模組（S1）
--   1. billing_sources 擴欄位（聯絡資訊 + 廠商縮寫）
--   2. vendor_bank_accounts        廠商銀行帳號（一家廠商可多帳號）
--   3. vendor_payment_requests     廠商請款單
--   4. vendor_payment_files        請款附件（總表/明細/發票/其他）
--   5. vendor_invoices             發票主檔（從附件結構化，給財務用）
--   6. company_profile             公司付款方資料（系統設定，只 1 筆）
-- ============================================================

-- ── 1. billing_sources 擴欄位（聯絡資訊 + 廠商縮寫 + LINE ID） ─
ALTER TABLE billing_sources
  ADD COLUMN IF NOT EXISTS short_name      VARCHAR(50),     -- 廠商縮寫（附言用，例：「精華」）
  ADD COLUMN IF NOT EXISTS contact_line_id VARCHAR(100),    -- LINE ID（手填字串）
  ADD COLUMN IF NOT EXISTS address         TEXT,            -- 廠商地址
  ADD COLUMN IF NOT EXISTS tax_id          VARCHAR(20);     -- 統編

COMMENT ON COLUMN billing_sources.short_name      IS '廠商縮寫，匯款附言用，例：精華光學股份有限公司 → 精華';
COMMENT ON COLUMN billing_sources.contact_line_id IS '聯絡 LINE ID（字串）';
COMMENT ON COLUMN billing_sources.tax_id          IS '統一編號 / 身分證字號';


-- ── 2. vendor_bank_accounts 廠商銀行帳號 ─────────────────────
CREATE TABLE IF NOT EXISTS vendor_bank_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES billing_sources(id) ON DELETE CASCADE,
  bank_code       VARCHAR(10) NOT NULL,             -- 3 碼總行（008/021/...）
  branch_code     VARCHAR(10),                      -- 4 碼分行（1924/0018/...）
  account_no      VARCHAR(30) NOT NULL,             -- 收款帳號
  account_name    VARCHAR(100) NOT NULL,            -- 收款戶名
  is_default      BOOLEAN DEFAULT false,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_bank_source ON vendor_bank_accounts(source_id);

COMMENT ON TABLE  vendor_bank_accounts            IS '廠商銀行帳號（一家廠商可有多帳號，is_default=預設使用）';
COMMENT ON COLUMN vendor_bank_accounts.bank_code  IS '3 碼總行代碼';
COMMENT ON COLUMN vendor_bank_accounts.branch_code IS '4 碼分行代碼';


-- ── 3. vendor_payment_requests 廠商請款單 ────────────────────
CREATE TABLE IF NOT EXISTS vendor_payment_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no          VARCHAR(30) UNIQUE,                -- 自動產生 REQ-YYYYMM-NNNNN
  source_id           UUID NOT NULL REFERENCES billing_sources(id),
  bank_account_id     UUID REFERENCES vendor_bank_accounts(id),  -- 撥款用哪個帳號
  period              VARCHAR(7) NOT NULL,               -- 請款月份 YYYY-MM
  title               VARCHAR(200) NOT NULL,             -- 請款標題
  description         TEXT,
  total_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  invoice_amount      DECIMAL(12,2),                     -- 發票總額（含稅）
  tax_amount          DECIMAL(12,2),                     -- 稅額
  pre_tax_amount      DECIMAL(12,2),                     -- 未稅

  -- 狀態流：draft → submitted → approved → paid / rejected
  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'submitted', 'approved', 'paid', 'rejected')),

  -- 操作紀錄
  submitted_at        TIMESTAMPTZ,
  approved_at         TIMESTAMPTZ,
  approved_by         UUID REFERENCES system_users(id),
  paid_at             TIMESTAMPTZ,
  paid_by             UUID REFERENCES system_users(id),
  rejected_at         TIMESTAMPTZ,
  rejected_by         UUID REFERENCES system_users(id),
  rejection_reason    TEXT,

  -- 撥款附言（預設用 {period_mm}-{vendor_short}-貨款）
  remit_memo          VARCHAR(100),

  -- 建立者（廠商自己建 or 系統人員代建）
  created_by_type     VARCHAR(10) CHECK (created_by_type IN ('vendor', 'system')),
  created_by_vendor   UUID REFERENCES vendor_accounts(id),
  created_by_system   UUID REFERENCES system_users(id),

  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_req_period ON vendor_payment_requests(period);
CREATE INDEX IF NOT EXISTS idx_vendor_req_source ON vendor_payment_requests(source_id);
CREATE INDEX IF NOT EXISTS idx_vendor_req_status ON vendor_payment_requests(status);

COMMENT ON TABLE  vendor_payment_requests        IS '廠商請款單（廠商自助建立或系統代建）';
COMMENT ON COLUMN vendor_payment_requests.status IS 'draft=草稿 / submitted=送審 / approved=已通過 / paid=已撥款 / rejected=退回';
COMMENT ON COLUMN vendor_payment_requests.remit_memo IS '撥款附言（顯示在對方戶頭，例：04-精華-貨款）';

-- request_no 自動產生 trigger
CREATE OR REPLACE FUNCTION generate_request_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix  TEXT;
  seq_num INT;
BEGIN
  prefix := 'REQ-' || TO_CHAR(now(), 'YYYYMM') || '-';
  SELECT COUNT(*) + 1 INTO seq_num
    FROM vendor_payment_requests
    WHERE request_no LIKE prefix || '%';
  NEW.request_no := prefix || LPAD(seq_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_req_no ON vendor_payment_requests;
CREATE TRIGGER trg_vendor_req_no
  BEFORE INSERT ON vendor_payment_requests
  FOR EACH ROW
  WHEN (NEW.request_no IS NULL)
  EXECUTE FUNCTION generate_request_no();


-- ── 4. vendor_payment_files 請款附件 ─────────────────────────
CREATE TABLE IF NOT EXISTS vendor_payment_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES vendor_payment_requests(id) ON DELETE CASCADE,
  file_type       VARCHAR(20) NOT NULL
                  CHECK (file_type IN ('summary', 'detail', 'invoice', 'other')),
  file_name       VARCHAR(255) NOT NULL,
  file_url        TEXT NOT NULL,             -- Supabase Storage URL
  file_size       INTEGER,
  mime_type       VARCHAR(100),
  uploaded_by_type VARCHAR(10),              -- vendor / system
  uploaded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_files_request ON vendor_payment_files(request_id);
CREATE INDEX IF NOT EXISTS idx_vendor_files_type    ON vendor_payment_files(file_type);

COMMENT ON COLUMN vendor_payment_files.file_type IS 'summary=總表 / detail=明細表 / invoice=發票 / other=其他';


-- ── 5. vendor_invoices 發票主檔（給財務分析用） ──────────────
CREATE TABLE IF NOT EXISTS vendor_invoices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id              UUID NOT NULL REFERENCES vendor_payment_requests(id) ON DELETE CASCADE,
  file_id                 UUID REFERENCES vendor_payment_files(id),  -- 對應的影像檔
  invoice_no              VARCHAR(50) NOT NULL,        -- 發票號碼
  invoice_date            DATE,
  vendor_tax_id           VARCHAR(20),                 -- 開立方統編
  buyer_tax_id            VARCHAR(20),                 -- 買方統編（通常是樂活）
  amount                  DECIMAL(12,2) NOT NULL,      -- 含稅金額
  pre_tax_amount          DECIMAL(12,2),               -- 未稅
  tax_amount              DECIMAL(12,2),               -- 稅額
  tax_type                VARCHAR(20) DEFAULT 'taxable',  -- taxable / zero_rate / tax_free
  is_input_tax_eligible   BOOLEAN DEFAULT true,        -- 是否可扣抵進項稅額
  ocr_data                JSONB,                       -- OCR 原始結果（未來用）
  note                    TEXT,
  exported_at             TIMESTAMPTZ,                 -- 匯出給財務的時間
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_request ON vendor_invoices(request_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_no      ON vendor_invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_date    ON vendor_invoices(invoice_date);

COMMENT ON TABLE  vendor_invoices                       IS '發票主檔，給財務做進項稅額分析';
COMMENT ON COLUMN vendor_invoices.is_input_tax_eligible IS '是否可扣抵進項稅額（預設 true，部分發票如餐飲不可扣）';


-- ── 6. company_profile 公司付款方資料 ────────────────────────
-- 系統設定，只 1 筆，給匯款批次用
CREATE TABLE IF NOT EXISTS company_profile (
  id                    SMALLINT PRIMARY KEY DEFAULT 1
                        CHECK (id = 1),                       -- 強制只能有 1 筆
  company_name          VARCHAR(100) NOT NULL,
  tax_id                VARCHAR(20),
  payer_account_name    VARCHAR(100),                          -- 付款戶名（如：黃信儒）
  payer_account_no      VARCHAR(30),                           -- 付款帳號
  payer_bank_code       VARCHAR(10),                           -- 付款總行（3 碼）
  payer_branch_code     VARCHAR(10),                           -- 付款分行（4 碼）
  default_overdue_code  VARCHAR(5) DEFAULT '1',                -- 逾時處理指示
  default_fee_burden    VARCHAR(5) DEFAULT '15',               -- 手續費負擔別
  default_notify_method VARCHAR(5) DEFAULT '0',                -- 通知方式
  updated_at            TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE  company_profile IS '公司付款方資料（系統設定，只 1 筆，元大網銀匯款用）';


-- ── 7. 共用 trigger：自動更新 updated_at ─────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_bank_updated   ON vendor_bank_accounts;
CREATE TRIGGER trg_vendor_bank_updated   BEFORE UPDATE ON vendor_bank_accounts   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_vendor_req_updated    ON vendor_payment_requests;
CREATE TRIGGER trg_vendor_req_updated    BEFORE UPDATE ON vendor_payment_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_vendor_invoices_updated ON vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_updated BEFORE UPDATE ON vendor_invoices       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_company_profile_updated ON company_profile;
CREATE TRIGGER trg_company_profile_updated BEFORE UPDATE ON company_profile       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
