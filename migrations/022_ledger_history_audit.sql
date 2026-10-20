-- 門市月報：歷史基準（舊試算表匯入）＋查帳提醒的「已確認」紀錄（2026-10-20）
-- ledger_history：系統上線前的月份，用會計試算表的數字當比較基準（查帳的上月／同期比）
CREATE TABLE IF NOT EXISTS ledger_history (
  id BIGSERIAL PRIMARY KEY,
  store_erpid TEXT NOT NULL,
  ym TEXT NOT NULL,                      -- 2026-08
  ledger_code TEXT NOT NULL,             -- 科目代碼；_glasses_sales/_total_in 等底線開頭＝合計欄
  vendor TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'sheet',  -- sheet＝門市月報試算表
  source_ref TEXT,                       -- 試算表 file id／分頁
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ledger_history_sym ON ledger_history (store_erpid, ym);

-- 查帳提醒：會計看過、確認沒問題（或已處理）就記一筆，下次同一則不再列在「待看」
CREATE TABLE IF NOT EXISTS ledger_audit_acks (
  id BIGSERIAL PRIMARY KEY,
  store_erpid TEXT NOT NULL,
  ym TEXT NOT NULL,
  rule_key TEXT NOT NULL,                -- 例 jump:electricity、peer:lens_vendor
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','fixed','follow')),
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store_erpid, ym, rule_key)
);

ALTER TABLE ledger_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_audit_acks ENABLE ROW LEVEL SECURITY;
