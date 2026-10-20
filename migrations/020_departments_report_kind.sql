-- 020_departments_report_kind.sql（2026-10-20）門市月報：哪些單位是「門市」
-- departments 混了門市、行政部門與佔位代碼（000000、00099…）；營運費用也會分到部門（董事長室電費、營運部電話…）
-- report_kind：store＝出門市月報、dept＝部門（不出門市月報，費用另列）、hidden＝不顯示；NULL＝程式依名稱猜（「…店」＝store）
-- 左手同步 upsert 只寫 store_erpid／store_name／is_active，不會蓋掉這欄
ALTER TABLE departments ADD COLUMN IF NOT EXISTS report_kind TEXT CHECK (report_kind IN ('store','dept','hidden'));
UPDATE departments SET report_kind = 'store' WHERE report_kind IS NULL AND (store_name LIKE '%店' OR store_name = 'SUBANG SS15');
UPDATE departments SET report_kind = 'dept' WHERE report_kind IS NULL;
