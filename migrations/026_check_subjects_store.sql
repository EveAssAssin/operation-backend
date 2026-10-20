-- 026：支票紀錄（既有系統 /checks）接門市與合約（2026-10-20）
-- 營運：支票用原本的支票紀錄系統；C3 加在 recurring_expense_payments 的 check_* 欄位不再使用（保留不刪）。
-- check_subjects.store_erpid＝這個科目是哪家門市（「房租／中清」→ 中清店）；check_batches.contract_id＝這批支票付哪份合約。
ALTER TABLE check_subjects ADD COLUMN IF NOT EXISTS store_erpid TEXT;
ALTER TABLE check_batches  ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_check_subjects_store ON check_subjects(store_erpid);
CREATE INDEX IF NOT EXISTS idx_check_batches_contract ON check_batches(contract_id);

-- 「房租」底下的科目用名稱對門市（中清→中清店、後甲→愛民眼鏡後甲店）；對不到的（已關店、高鐵…）留空，頁面上可手動選
UPDATE check_subjects s SET store_erpid = d.store_erpid
FROM check_subjects p, departments d
WHERE s.parent_id = p.id AND p.name = '房租' AND s.store_erpid IS NULL
  AND d.report_kind = 'store'
  AND (d.store_name = s.name || '店' OR d.store_name LIKE '%' || s.name || '店');
