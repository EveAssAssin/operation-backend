-- ============================================================
-- 029_contracts.sql
--   「合約管理」模組
--     contracts             合約主檔（房租/廠商/員工 三種類型）
--     contract_reminders    合約提醒（到期前 N 天 LINE 推給游宜嘉）
-- ============================================================

CREATE TABLE IF NOT EXISTS contracts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 類型
  type            VARCHAR(20)  NOT NULL CHECK (type IN ('rent', 'vendor', 'employee')),
  -- rent     房租合約（門市 vs 房東）
  -- vendor   廠商合約（連動 S1 vendor_payment_requests 的貨款進度）
  -- employee 員工雇用合約

  -- 基本資訊
  name            VARCHAR(200) NOT NULL,   -- 合約名稱（例：北屯店房租合約 / 元大物流貨款合約）

  -- 對方
  party_type      VARCHAR(20),             -- store / vendor / employee / individual / company
  party_id        VARCHAR(50),             -- store_erpid / vendor_id / app_number / freeform
  party_name      VARCHAR(200),            -- cache 顯示用

  -- 我方對應（房租 = 哪家店；廠商 = 沒；員工 = 員工 app_number 本身）
  our_side_type   VARCHAR(20),             -- store / department / none
  our_side_id     VARCHAR(50),
  our_side_name   VARCHAR(100),

  -- 時間
  start_date      DATE,
  end_date        DATE,
  signed_date     DATE,                    -- 簽約日

  -- 金額
  total_amount    NUMERIC(14,2),           -- 合約總額（房租=月租 × 月數；廠商=合約總額；員工=年薪）
  monthly_amount  NUMERIC(14,2),           -- 月額（房租用；其他可留空）
  currency        VARCHAR(10) DEFAULT 'TWD',

  -- 類型專屬欄位（不同類型很不一樣，用 JSONB 彈性存）
  -- 房租 type_data 範例:
  --   { rent_increase_date: '2026-08-15', rent_increase_amount: 40000, deposit: 80000,
  --     landlord_account: '00812602158300', landlord_bank: '816 0083' }
  -- 廠商 type_data 範例:
  --   { reward_rate: 0.05, cost_target: 1500000, payment_terms: '月結 60 天', warranty_months: 12 }
  -- 員工 type_data 範例:
  --   { probation_end: '2026-09-01', salary_base: 38000, position: '營運專員',
  --     resignation_notice_days: 30, salary_history: [{year:2025, salary:36000}, {year:2026, salary:38000}] }
  type_data       JSONB        DEFAULT '{}'::jsonb,

  -- 檔案
  file_url        TEXT,                    -- 合約掃描檔的 URL（Supabase Storage 之後接）

  -- 狀態
  status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'expired', 'terminated', 'pending', 'archived')),
  note            TEXT,

  created_by      VARCHAR(50),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE contracts IS '合約主檔（房租/廠商/員工 三種類型，用 type_data JSONB 存各類型專屬欄位）';

CREATE INDEX IF NOT EXISTS idx_contracts_type        ON contracts (type);
CREATE INDEX IF NOT EXISTS idx_contracts_status      ON contracts (status);
CREATE INDEX IF NOT EXISTS idx_contracts_end_date    ON contracts (end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contracts_our_side    ON contracts (our_side_type, our_side_id);
CREATE INDEX IF NOT EXISTS idx_contracts_party       ON contracts (party_type, party_id);

-- ── 提醒設定（同一份合約可以有多個提醒，例如「到期前 60 天」「30 天」「7 天」）
CREATE TABLE IF NOT EXISTS contract_reminders (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID         NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

  label           VARCHAR(100),            -- '到期前 30 天' / '租金調漲日' / '保固結束' 等
  fire_date       DATE         NOT NULL,   -- 實際提醒日（一定要先算好 = 目標日 - days_before）
  target_date     DATE,                    -- 目標日（合約到期 / 調漲日）
  days_before     INT          DEFAULT 0,  -- 提前幾天

  notified_at     TIMESTAMPTZ,             -- 已通知時間（已通知就不再推）

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cr_fire_date  ON contract_reminders (fire_date) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cr_contract   ON contract_reminders (contract_id);

-- ── updated_at trigger
DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts;
CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS
ALTER TABLE contracts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_reminders ENABLE ROW LEVEL SECURITY;
