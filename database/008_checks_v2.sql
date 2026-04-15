-- ============================================================
-- 008_checks_v2.sql
-- 支票紀錄系統 v2（重設計）
-- 廢除舊 007 schema，重建正確資料結構
-- ============================================================

-- 0. 清除舊表
DROP TABLE IF EXISTS check_notify_targets CASCADE;
DROP TABLE IF EXISTS checks             CASCADE;
DROP TABLE IF EXISTS check_batches      CASCADE;
DROP FUNCTION IF EXISTS generate_batch_no() CASCADE;

-- ── 1. 台灣國定假日快取 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS taiwan_holidays (
  id         SERIAL      PRIMARY KEY,
  date       DATE        UNIQUE NOT NULL,
  name       VARCHAR(100),
  year       INT         NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE taiwan_holidays IS '台灣國定假日快取，每年初自動從政府 API 更新';

-- ── 2. 支票科目 ──────────────────────────────────────────
CREATE TABLE check_subjects (
  id         SERIAL       PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,  -- e.g. 東山, 河堤, 文心
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE check_subjects IS '支票備註科目下拉選單（Excel 匯入時自動建立）';

-- ── 3. 支票批次 ──────────────────────────────────────────
CREATE TABLE check_batches (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no       VARCHAR(20) UNIQUE,           -- 自動編號 CHK-YYYYMM-NNNNN
  subject_id     INT         REFERENCES check_subjects(id),
  drawer_name    VARCHAR(50) NOT NULL,          -- 出款人：黃信儒 / 黃志雄
  bank_name      VARCHAR(50) NOT NULL DEFAULT '高銀', -- 出款銀行：高銀 / 三信
  total_amount   NUMERIC(12,2),                -- 批次總金額（可選填）
  check_count    INT         NOT NULL DEFAULT 1,
  renewal_needed BOOLEAN     NOT NULL DEFAULT FALSE, -- 是否需要續票提醒
  prev_batch_id  UUID        REFERENCES check_batches(id), -- 前一輪批次（續票鏈）
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','completed','voided')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE check_batches IS '支票批次：同一科目同一出款人開出的一組分期支票';
COMMENT ON COLUMN check_batches.drawer_name   IS '出款人（開票者）：黃信儒 / 黃志雄';
COMMENT ON COLUMN check_batches.bank_name     IS '出款銀行：高銀 / 三信';
COMMENT ON COLUMN check_batches.renewal_needed IS '剩 1 張時觸發續票 LINE 提醒';
COMMENT ON COLUMN check_batches.prev_batch_id  IS '上一輪批次 ID，用以串起續票歷史';

-- ── 4. 個別支票 ──────────────────────────────────────────
CREATE TABLE checks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    UUID        NOT NULL REFERENCES check_batches(id) ON DELETE CASCADE,
  seq_no      INT         NOT NULL,             -- 批次內序號 1,2,3...
  check_no    VARCHAR(50),                      -- 支票號碼（可空）
  amount      NUMERIC(12,2),                    -- 此張金額（可空，批次平均）
  due_date    DATE        NOT NULL,             -- 到期日（支票日期）
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','paid','voided','bounced')),
  paid_at     TIMESTAMPTZ,                      -- 標記付款時間
  void_reason TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (batch_id, seq_no)
);
COMMENT ON TABLE checks IS '個別支票，每張有自己的到期日';
COMMENT ON COLUMN checks.due_date IS '到期日；前一工作天由應用層計算，不存 DB';
COMMENT ON COLUMN checks.status   IS 'pending=待出款, paid=已出款, voided=作廢, bounced=退票';

CREATE INDEX IF NOT EXISTS idx_checks_due_date ON checks (due_date);
CREATE INDEX IF NOT EXISTS idx_checks_status   ON checks (status);
CREATE INDEX IF NOT EXISTS idx_checks_batch_id ON checks (batch_id);

-- ── 5. 通知名單 ──────────────────────────────────────────
CREATE TABLE check_notify_targets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(50) NOT NULL,
  app_number VARCHAR(20) NOT NULL UNIQUE,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE check_notify_targets IS '每日出款提醒的 LINE 通知收件名單';

-- ── 6. batch_no 自動編號 trigger ─────────────────────────
CREATE OR REPLACE FUNCTION generate_batch_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix TEXT;
  seq    INT;
BEGIN
  prefix := 'CHK-' || TO_CHAR(NOW(), 'YYYYMM') || '-';
  SELECT COUNT(*) + 1
    INTO seq
    FROM check_batches
   WHERE batch_no LIKE prefix || '%';
  NEW.batch_no := prefix || LPAD(seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_batch_no ON check_batches;
CREATE TRIGGER trigger_batch_no
  BEFORE INSERT ON check_batches
  FOR EACH ROW
  WHEN (NEW.batch_no IS NULL)
  EXECUTE FUNCTION generate_batch_no();

-- ── 7. updated_at 自動更新 trigger ───────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batches_updated ON check_batches;
CREATE TRIGGER trg_batches_updated
  BEFORE UPDATE ON check_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_checks_updated ON checks;
CREATE TRIGGER trg_checks_updated
  BEFORE UPDATE ON checks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
