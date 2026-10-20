-- 門市月報：店長心得記是誰寫的（2026-10-20；店長經市場部店長評核 /sm 寫）
ALTER TABLE store_month_reports ADD COLUMN IF NOT EXISTS manager_note_by TEXT;
