-- ============================================================
-- 017_monthly_report_ledger.sql（2026-10-20）
-- 門市月報＋開帳系統化 P0：全公司科目表、帳本補欄位、月報／調帳／固定項目／股東
-- 規劃：app/pet-feature/PLAN_門市月報與開帳_20261020.md
-- 全部 IF NOT EXISTS／ON CONFLICT，重跑安全
-- ============================================================

-- ── 1. 全公司科目表（照月報版型：大類＝區塊、小類＝列）──
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code        TEXT PRIMARY KEY,
  group_code  TEXT NOT NULL CHECK (group_code IN ('revenue','opex','frame','lens','contact','planning','ads','misc','info')),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('revenue','expense','info')),
  ratio_group TEXT,            -- 成本率分組：人事／包裝／鏡片／鏡框／營運費用／藥拋（月報下方那張表）
  auto_source TEXT,            -- 自動來源說明（erp_sales／erp_cost／opex／recurring／bill／manual…）
  sort_order  INT  NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
COMMENT ON TABLE ledger_accounts IS '月報科目表（全公司共用）；group_code＝月報區塊';

INSERT INTO ledger_accounts (code, group_code, name, kind, ratio_group, auto_source, sort_order) VALUES
 ('glasses_receipt','revenue','眼鏡實收','revenue',NULL,'manual',10),
 ('contact_receipt','revenue','藥拋實收','revenue',NULL,'manual',20),
 ('api_pay','revenue','API 支付（儲值金消費）','revenue',NULL,'manual',30),
 ('stored_value','info','儲值收款（不列業績）','info',NULL,'erp_stored',40),
 ('rent','opex','租金','expense','營運費用','recurring',110),
 ('salary','opex','薪資','expense','人事','manual',120),
 ('labor_insurance','opex','勞健保','expense','人事','manual',125),
 ('edu_bonus','opex','教育訓練獎金','expense','人事','billing_order',128),
 ('card_fee','opex','刷卡手續費','expense','營運費用','manual',130),
 ('store_misc','opex','分店支出雜項','expense','營運費用','erp_cost',140),
 ('electricity','opex','電費','expense','營運費用','opex',150),
 ('water','opex','水費','expense','營運費用','opex',155),
 ('telecom','opex','電話網路費','expense','營運費用','opex',160),
 ('golden_chicken','opex','金雞','expense','營運費用','opex',165),
 ('franchise_fee','opex','加盟金','expense','營運費用','manual',170),
 ('info_fee','opex','資訊使用費','expense','營運費用','manual',172),
 ('rent_tax','opex','租賃所得稅','expense','營運費用','manual',174),
 ('nhi2','opex','二代健保','expense','營運費用','manual',176),
 ('income_tax','opex','綜所稅','expense','營運費用','manual',178),
 ('tax_supplement','opex','補納稅額','expense','營運費用','manual',180),
 ('business_tax','opex','營業稅（雙月）','expense','營運費用','manual',182),
 ('logistics','opex','物流運費','expense','營運費用','bill',184),
 ('marketing_fund','opex','行銷基金','expense','營運費用','fixed',190),
 ('depreciation','opex','固定資產折舊','expense','營運費用','fixed',192),
 ('frame_hq','frame','總部出貨（鏡框）','expense','鏡框','bill',210),
 ('frame_vendor','frame','鏡框廠商','expense','鏡框','bill',220),
 ('lens_hq','lens','總部出貨（鏡片）','expense','鏡片','bill',310),
 ('lens_lab','lens','代工中心代工費','expense','鏡片','bill',320),
 ('lens_vendor','lens','鏡片廠商','expense','鏡片','bill',330),
 ('contact_hq','contact','總部出貨（藥拋）','expense','藥拋','bill',410),
 ('contact_vendor','contact','藥拋廠商','expense','藥拋','bill',420),
 ('packaging','planning','代工中心包裝費','expense','包裝','bill',510),
 ('planning_goods','planning','企劃品','expense','包裝','bill',520),
 ('ad_budget','ads','廣告費','expense','營運費用','billing_order',610),
 ('survey','ads','市調電訪','expense','營運費用','bill',620),
 ('image','ads','形象維持','expense','營運費用','bill',630),
 ('repair','misc','工程修繕','expense','營運費用','billing_order',710),
 ('consumables','misc','耗材雜費','expense','營運費用','bill',720),
 ('other','misc','其他','expense','營運費用','manual',790)
ON CONFLICT (code) DO NOTHING;

-- 各來源原本自己的科目 → 對到全公司科目
ALTER TABLE accounting_categories ADD COLUMN IF NOT EXISTS ledger_code TEXT REFERENCES ledger_accounts(code);
-- 依「來源（廠商）」對：晶碩＝藥拋廠商、路奇＝鏡片廠商（會計可在後台改）
UPDATE accounting_categories c SET ledger_code = 'contact_vendor' FROM billing_sources s
 WHERE s.id = c.source_id AND c.ledger_code IS NULL AND s.name LIKE '%晶碩%';
UPDATE accounting_categories c SET ledger_code = 'lens_vendor' FROM billing_sources s
 WHERE s.id = c.source_id AND c.ledger_code IS NULL AND s.name LIKE '%路奇%';

-- 營運費用類別（電費／水費…）→ 科目
ALTER TABLE entity_fact_categories ADD COLUMN IF NOT EXISTS ledger_code TEXT REFERENCES ledger_accounts(code);
UPDATE entity_fact_categories SET ledger_code = CASE code
  WHEN 'electricity' THEN 'electricity' WHEN 'telecom' THEN 'telecom' WHEN 'rent' THEN 'rent'
  WHEN 'water' THEN 'water' WHEN 'golden_chicken' THEN 'golden_chicken' END
 WHERE ledger_code IS NULL;

-- 固定支出（房租、借證照…）要知道哪家店、哪個科目才能進月報
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS store_erpid TEXT;
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS ledger_code TEXT REFERENCES ledger_accounts(code);
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS in_report BOOLEAN NOT NULL DEFAULT false;

-- ── 2. 帳本補欄位（bills＝開帳單、bill_allocations＝分到各店）──
ALTER TABLE bills ADD COLUMN IF NOT EXISTS source_system  TEXT;          -- planning／ops／warehouse／engineering／vendor_portal／chi_lens…
ALTER TABLE bills ADD COLUMN IF NOT EXISTS received_at    TIMESTAMPTZ;   -- 帳單送達（算「列入月報」用）；沒填用 submitted_at／created_at
ALTER TABLE bills ADD COLUMN IF NOT EXISTS report_ym      VARCHAR(7);    -- 列入月報；period＝費用月
ALTER TABLE bills ADD COLUMN IF NOT EXISTS report_ym_manual BOOLEAN NOT NULL DEFAULT false;  -- 會計手動改過就不再自動算
ALTER TABLE bills ADD COLUMN IF NOT EXISTS original_files JSONB NOT NULL DEFAULT '[]';     -- 原始帳單（月報尋線點到這份）
ALTER TABLE bills ADD COLUMN IF NOT EXISTS ledger_code    TEXT REFERENCES ledger_accounts(code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_source_ref ON bills(source_system, source_ref)
  WHERE source_system IS NOT NULL AND source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_report_ym ON bills(report_ym);

ALTER TABLE bill_allocations ADD COLUMN IF NOT EXISTS ledger_code TEXT REFERENCES ledger_accounts(code);  -- 這一列的科目（沒填用帳單／來源科目）
ALTER TABLE bill_allocations ADD COLUMN IF NOT EXISTS cost_amount NUMERIC(12,2);   -- 成本（加成前）；allocated_amount＝開帳金額
ALTER TABLE bill_allocations ADD COLUMN IF NOT EXISTS fee_ym      VARCHAR(7);      -- 這一列的費用月（分期攤提用；沒填＝帳單 period）
ALTER TABLE bill_allocations ADD COLUMN IF NOT EXISTS report_ym   VARCHAR(7);      -- 這一列列入哪個月報（沒填＝帳單 report_ym）
CREATE INDEX IF NOT EXISTS idx_bill_alloc_store ON bill_allocations(store_erpid);

-- ── 3. 設定（截止日等）──
CREATE TABLE IF NOT EXISTS report_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO report_settings(key, value) VALUES ('cutoff_day', '26') ON CONFLICT (key) DO NOTHING;

-- 費用月 fee_ym 的帳單在 received 送達 → 列入哪個月報
-- 規則：fee_ym 的下個月 cutoff 日（含）前送達＝fee_ym；之後每過一個月的 cutoff 就往後一個月（營運 10-20）
CREATE OR REPLACE FUNCTION report_ym_for(fee_ym TEXT, received TIMESTAMPTZ, cutoff INT DEFAULT 26)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  m DATE := to_date(fee_ym || '-01', 'YYYY-MM-DD');
  r DATE := (received AT TIME ZONE 'Asia/Taipei')::date;
  lim DATE;
BEGIN
  IF fee_ym IS NULL OR received IS NULL THEN RETURN fee_ym; END IF;
  LOOP
    lim := (m + INTERVAL '1 month')::date + (cutoff - 1);
    EXIT WHEN r <= lim;
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
  RETURN to_char(m, 'YYYY-MM');
END $$;

-- ── 4. 每店每月月報（狀態＋手填值＋關帳快照）──
CREATE TABLE IF NOT EXISTS store_month_reports (
  store_erpid      TEXT NOT NULL,
  ym               VARCHAR(7) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','closed')),
  retained_amount  NUMERIC(12,2),          -- 保留盈餘（審閱時決定）
  snapshot         JSONB,                  -- 關帳當下整份月報
  manager_note     TEXT,                   -- 店長心得
  manager_note_at  TIMESTAMPTZ,
  reviewer_note    TEXT,                   -- 主管／審閱回覆
  submitted_by     TEXT, submitted_at TIMESTAMPTZ,   -- 會計送審閱
  closed_by        TEXT, closed_at    TIMESTAMPTZ,
  reopened_by      TEXT, reopened_at  TIMESTAMPTZ, reopen_reason TEXT,
  updated_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (store_erpid, ym)
);

-- ── 5. 手填值與手動調帳（都進帳本；調帳必填原因）──
CREATE TABLE IF NOT EXISTS ledger_manual_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('value','adjust')),  -- value＝手填該格（實收、薪資…）／adjust＝調帳加減
  store_erpid  TEXT NOT NULL,
  report_ym    VARCHAR(7) NOT NULL,
  fee_ym       VARCHAR(7),
  ledger_code  TEXT NOT NULL REFERENCES ledger_accounts(code),
  amount       NUMERIC(12,2) NOT NULL,
  reason       TEXT,
  files        JSONB NOT NULL DEFAULT '[]',
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  void_at      TIMESTAMPTZ, void_by TEXT,
  CHECK (entry_type <> 'adjust' OR coalesce(length(trim(reason)),0) > 0)
);
CREATE INDEX IF NOT EXISTS idx_lme_store_ym ON ledger_manual_entries(store_erpid, report_ym);
-- 同一店同一月同一格只留一筆「手填值」（調帳可多筆）
CREATE UNIQUE INDEX IF NOT EXISTS uq_lme_value ON ledger_manual_entries(store_erpid, report_ym, ledger_code)
  WHERE entry_type = 'value' AND void_at IS NULL;

-- ── 6. 每店固定金額（行銷基金、折舊累計…設定一次每月帶入）──
CREATE TABLE IF NOT EXISTS store_fixed_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_erpid TEXT NOT NULL,
  ledger_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  amount      NUMERIC(12,2) NOT NULL,
  from_ym     VARCHAR(7) NOT NULL,
  to_ym       VARCHAR(7),
  note        TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sfi_store ON store_fixed_items(store_erpid);

-- ── 7. 股東群（每店最多 100 股、每人至少 1 股＝1%）──
CREATE TABLE IF NOT EXISTS store_shareholders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_erpid  TEXT NOT NULL,
  erpid        TEXT,                 -- 左手人員 erpid（從「股東群」匯入）
  app_number   TEXT,
  name         TEXT NOT NULL,
  shares       INT NOT NULL CHECK (shares BETWEEN 1 AND 100),
  from_ym      VARCHAR(7) NOT NULL,
  to_ym        VARCHAR(7),
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ssh_store ON store_shareholders(store_erpid);

-- ── 8. RLS：本系統只走後端 service_role；原本 18 張表沒開 RLS（anon 金鑰可讀寫，含 vendor_accounts 密碼雜湊）──
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_accounts','report_settings','store_month_reports','ledger_manual_entries','store_fixed_items','store_shareholders',
    'billing_sync_logs','bill_allocations','billing_orders','check_subjects','check_batches','checks','check_notify_targets','accounting_categories',
    'vendor_accounts','bills','billing_sources','push_group_members','operational_expenses','operational_expense_allocations','market_payment_events','chi_lens_payment_events','taiwan_holidays','_migrations_applied']
  LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
