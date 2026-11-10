-- 054_bank_accounts_opening_cred.sql
-- 銀存彙整：期初餘額、網銀網址、網銀帳密（加密存放，查看要另外輸入查看密碼）
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_date date;            -- 期初日期（這天開始前的餘額）
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_balance numeric;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS bank_url text;                -- 網銀網址
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS cred_enc text;                -- 帳密（AES-256-GCM 加密的 JSON：[{label, value, secret}]）
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS cred_labels jsonb;            -- 只存欄位名稱＋是否私密（不含值），清單畫面顯示用
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS cred_updated_at timestamptz;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS cred_updated_by text;

-- 誰在什麼時候看過／改過帳密
CREATE TABLE IF NOT EXISTS bank_cred_logs (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES bank_accounts(id) ON DELETE CASCADE,
  action      text NOT NULL,          -- reveal／update／pin_set／pin_fail
  ok          boolean NOT NULL DEFAULT true,
  by_user     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS bank_cred_logs ENABLE ROW LEVEL SECURITY;
