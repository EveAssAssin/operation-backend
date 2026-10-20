-- 門市月報：藥拋業績（帳上，系統帶入、可調帳）＋實收差提醒門檻
INSERT INTO ledger_accounts (code, group_code, name, kind, ratio_group, auto_source, sort_order)
VALUES ('contact_sales', 'info', '藥拋業績（帳上）', 'info', NULL, 'erp_sales', 6)
ON CONFLICT (code) DO NOTHING;
UPDATE ledger_accounts SET auto_source = 'erp_sales' WHERE code = 'glasses_sales';
INSERT INTO report_settings (key, value) VALUES ('gap_alert_pct', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;
