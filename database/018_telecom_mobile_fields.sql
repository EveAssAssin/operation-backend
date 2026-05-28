-- ============================================================
-- 018_telecom_mobile_fields.sql
-- 在「電話與網路費」分類加入公務機相關欄位
--   公務機資料：帳單名稱（部門/公司）、長號、月租、電話代碼、合約到期日
--   既有「用戶帳號 (user_name)」欄位拿來放「使用者」（人名 / 部門 / 門市別名）
-- ============================================================

INSERT INTO entity_fact_fields (category_id, field_key, field_label, field_type, sort_order, is_system, placeholder)
SELECT c.id, v.field_key, v.field_label, v.field_type, v.sort_order, true, v.placeholder
FROM entity_fact_categories c
CROSS JOIN (VALUES
    ('bill_account_name', '帳單名稱',     'text',   25, '例：希爾頓隱形眼鏡 / 信儒眼鏡行（公司行號）'),
    ('full_phone',        '長號電話號碼', 'text',   35, '例：0906337872'),
    ('monthly_fee',       '月租',         'number', 75, '例：499'),
    ('phone_code',        '電話代碼',     'text',   80, '例：2005'),
    ('contract_end',      '合約到期日',   'text',   85, '例：114.04.14（民國年）')
) AS v(field_key, field_label, field_type, sort_order, placeholder)
WHERE c.code = 'telecom'
ON CONFLICT (category_id, field_key) DO NOTHING;
