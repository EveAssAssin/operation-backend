-- 058：銀存彙整可手動建立交易（2026-11-24 營運）
--   source：import（網銀檔匯入）／manual（手動建立）
--   之後匯入的檔案裡有同一天、同金額、同方向的交易 → 手動那筆自動標成 removed（superseded_by＝檔案那筆），不會重複
ALTER TABLE bank_txns ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'import';
ALTER TABLE bank_txns ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE bank_txns ADD COLUMN IF NOT EXISTS superseded_by uuid;
CREATE INDEX IF NOT EXISTS idx_bank_txns_manual ON bank_txns(account_id, txn_date) WHERE source = 'manual';
