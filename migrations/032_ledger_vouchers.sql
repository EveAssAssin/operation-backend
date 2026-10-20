-- 032 開帳原始憑證（2026-10-21）
-- 所有開帳（帳單、手填、調帳、分攤、營運費用、固定支出、部門開帳）都可以掛照片／PDF；
-- 檔案放私有 bucket ledger-vouchers，只給營運部（operation_*）與超級管理員用簽名網址看。
-- 廠商請款上傳的附件（vendor_payment_files）與門市結帳資料的支出憑證（市場部 closing_expense_receipts）不搬，月報直接一起列。
CREATE TABLE IF NOT EXISTS ledger_vouchers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type         text NOT NULL CHECK (ref_type IN ('bill','manual','amort','opex','recurring','billing_order','fixed','contract')),
  ref_id           text NOT NULL,
  storage_path     text NOT NULL,
  file_name        text,
  mime_type        text,
  size_bytes       integer,
  note             text,
  uploaded_by      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  void_at          timestamptz,
  void_by          text
);
CREATE INDEX IF NOT EXISTS ledger_vouchers_ref_idx ON ledger_vouchers (ref_type, ref_id) WHERE void_at IS NULL;
ALTER TABLE ledger_vouchers ENABLE ROW LEVEL SECURITY;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('ledger-vouchers', 'ledger-vouchers', false, 20971520)
ON CONFLICT (id) DO UPDATE SET public = false;
