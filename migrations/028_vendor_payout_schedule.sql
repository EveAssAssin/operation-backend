-- 028：廠商請款排出款（2026-10-20）
-- 營運：會計分配好帳款後設「出款日期」＋選「出款銀行」（公司哪個帳戶付）；
--       當天系統提醒（跟支票一樣 LINE 推播＋首頁卡片），列出當天要出的款，匯出元大網銀 Excel 匯入銀行。
-- 原本程式裡的 payment_batches 從沒建表（/api/payment-batch 會 500），改用請款本身帶出款日＋這張公司帳戶表。

CREATE TABLE IF NOT EXISTS company_bank_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,                 -- 顯示名稱，例：元大 公司戶
  bank_name     TEXT,
  bank_code     TEXT NOT NULL,                 -- 總行 3 碼（元大 806）
  branch_code   TEXT,                          -- 分行 4 碼
  account_no    TEXT NOT NULL,
  account_name  TEXT NOT NULL,
  export_format TEXT NOT NULL DEFAULT 'yuanta',-- 匯出格式（目前只有元大）
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort          INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE company_bank_accounts ENABLE ROW LEVEL SECURITY;

-- 原本 company_profile 的付款帳戶當第一個
INSERT INTO company_bank_accounts (label, bank_name, bank_code, branch_code, account_no, account_name, is_default)
SELECT '元大 ' || COALESCE(payer_account_name, '公司戶'), '元大銀行', payer_bank_code, payer_branch_code, payer_account_no, payer_account_name, true
FROM company_profile
WHERE id = 1 AND payer_account_no IS NOT NULL AND payer_bank_code IS NOT NULL AND payer_account_name IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM company_bank_accounts);

ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_date         DATE;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_bank_id      UUID REFERENCES company_bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_set_by       TEXT;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_set_at       TIMESTAMPTZ;
ALTER TABLE vendor_payment_requests ADD COLUMN IF NOT EXISTS payout_exported_at  TIMESTAMPTZ;   -- 最後一次匯出元大檔
CREATE INDEX IF NOT EXISTS idx_vpr_payout ON vendor_payment_requests(payout_date) WHERE status = 'approved';

-- 每次匯出留紀錄（哪天、哪個帳戶、哪幾張、多少錢、誰）
CREATE TABLE IF NOT EXISTS vendor_payout_exports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_date  DATE NOT NULL,
  bank_id      UUID REFERENCES company_bank_accounts(id) ON DELETE SET NULL,
  request_ids  UUID[] NOT NULL,
  total_amount NUMERIC(14,2) NOT NULL,
  exported_by  TEXT,
  exported_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE vendor_payout_exports ENABLE ROW LEVEL SECURITY;
