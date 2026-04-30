-- ============================================================
-- 010_recurring_expenses.sql
-- 常態費用模組
--   recurring_expenses          費用主檔
--   recurring_expense_payments  每月應付紀錄
-- ============================================================

-- ── 1. 費用主檔 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(100) NOT NULL,                 -- 費用名稱（房租、水電、保全費...）
  description       TEXT,                                  -- 補充說明
  amount            NUMERIC(12,2) NOT NULL CHECK (amount >= 0),

  -- 週期設定（目前只支援每月固定日；保留 cycle_type 給未來擴充週/季/年）
  cycle_type        VARCHAR(30)  NOT NULL DEFAULT 'monthly_fixed_day'
                                  CHECK (cycle_type IN ('monthly_fixed_day')),
  cycle_day         INT          NOT NULL CHECK (cycle_day BETWEEN 1 AND 31),

  -- 假日規則：'previous_workday'（往前到上個工作天）/ 'none'（不調整）
  holiday_rule      VARCHAR(20)  NOT NULL DEFAULT 'previous_workday'
                                  CHECK (holiday_rule IN ('previous_workday','none')),

  -- 開帳對象（門市或部門）
  bill_target_type  VARCHAR(20)  NOT NULL CHECK (bill_target_type IN ('store','department')),
  bill_target_id    VARCHAR(50)  NOT NULL,                 -- store_erpid 或 dept_id
  bill_target_name  VARCHAR(100) NOT NULL,                 -- 顯示用的單位名稱（cache）

  -- 套用期間
  start_year_month  VARCHAR(7),                            -- YYYY-MM，不填=本月
  end_year_month    VARCHAR(7),                            -- YYYY-MM，不填=持續

  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
  note              TEXT,

  created_by        VARCHAR(50),                           -- app_number
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE recurring_expenses IS '常態費用主檔（房租、水電、保全費等定期支付項目）';

CREATE INDEX IF NOT EXISTS idx_re_active        ON recurring_expenses (is_active);
CREATE INDEX IF NOT EXISTS idx_re_bill_target   ON recurring_expenses (bill_target_type, bill_target_id);


-- ── 2. 每月應付紀錄 ──────────────────────────────────────
-- 每個 expense 每月產生一筆，由排程或 API 動態建立
CREATE TABLE IF NOT EXISTS recurring_expense_payments (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id          UUID         NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,

  year_month          VARCHAR(7)   NOT NULL,               -- YYYY-MM（該期所屬月份）
  original_due_date   DATE         NOT NULL,               -- 未調整的原始月份日期
  due_date            DATE         NOT NULL,               -- 假日順延後的實際應付日

  -- 從 expense 快照下來，避免之後改到歷史
  amount              NUMERIC(12,2) NOT NULL,
  bill_target_type    VARCHAR(20)  NOT NULL,
  bill_target_id      VARCHAR(50)  NOT NULL,
  bill_target_name    VARCHAR(100) NOT NULL,

  status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','paid','skipped')),
  paid_at             TIMESTAMPTZ,
  paid_by             VARCHAR(50),                         -- app_number
  paid_note           TEXT,

  notified_at         TIMESTAMPTZ,                         -- 推播時間（用於去重）

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (expense_id, year_month)
);
COMMENT ON TABLE recurring_expense_payments IS '常態費用的每月應付紀錄';

CREATE INDEX IF NOT EXISTS idx_rep_due_status   ON recurring_expense_payments (due_date, status);
CREATE INDEX IF NOT EXISTS idx_rep_year_month   ON recurring_expense_payments (year_month);
CREATE INDEX IF NOT EXISTS idx_rep_expense      ON recurring_expense_payments (expense_id);


-- ── 3. updated_at 自動更新 trigger ──────────────────────
-- 重用既有 update_updated_at() 函式（base schema 已建立）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at'
  ) THEN
    CREATE FUNCTION update_updated_at() RETURNS TRIGGER AS $func$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_re_updated_at  ON recurring_expenses;
DROP TRIGGER IF EXISTS trg_rep_updated_at ON recurring_expense_payments;

CREATE TRIGGER trg_re_updated_at
  BEFORE UPDATE ON recurring_expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_rep_updated_at
  BEFORE UPDATE ON recurring_expense_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── 4. RLS ────────────────────────────────────────────────
ALTER TABLE recurring_expenses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_expense_payments  ENABLE ROW LEVEL SECURITY;
