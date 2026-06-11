-- ============================================================
-- 026_backfill_recurring_periods.sql
-- 補填已匯入 40 筆的 start/end_year_month (依 name 對應)
-- 只更新「start_year_month 還是 NULL」的，已手動填過不覆蓋
-- ============================================================

UPDATE recurring_expenses SET start_year_month = '2025-08', end_year_month = '2030-08' WHERE name = '楠梓店隔壁間房租' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-07', end_year_month = '2027-06' WHERE name = '群茂營所稅' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-10', end_year_month = '2027-09' WHERE name = '114年樂活光學暫繳分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-07', end_year_month = '2027-03' WHERE name = '109年樂活有限公司營業稅分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-11', end_year_month = '2028-10' WHERE name = '111年吳郁蓁綜所稅分期(六家)' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-11', end_year_month = '2027-10' WHERE name = '113年黃信儒綜所稅分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2026-01', end_year_month = '2026-12' WHERE name = '112年吳郁蓁綜所稅利息分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2026-06', end_year_month = '2028-05' WHERE name = '114年樂活光學營所分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-10', end_year_month = '2027-09' WHERE name = '新竹114年營所稅暫繳分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-10', end_year_month = '2028-09' WHERE name = '樂活光學有限公司營所稅暫繳分期' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2024-10', end_year_month = '2026-09' WHERE name = '高應大房租' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-01', end_year_month = '2026-01' WHERE name = '中壢房租' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2026-06', end_year_month = '2026-11' WHERE name = '左手設計有限公司' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-10', end_year_month = '2027-09' WHERE name = '後甲房東 - 張敬忠' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-10', end_year_month = '2027-09' WHERE name = '後甲房東 - 溫秀卿' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-10', end_year_month = '2027-09' WHERE name = '後甲房東 - 溫秀紅' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-10', end_year_month = '2027-09' WHERE name = '後甲房東 - 温秀敏(ATM付)' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2023-10', end_year_month = '2027-09' WHERE name = '後甲房東 - 温榮彬(ATM付)' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2024-12', end_year_month = '2030-11' WHERE name = '北屯房東-成香投資有限公司' AND start_year_month IS NULL AND end_year_month IS NULL;
UPDATE recurring_expenses SET start_year_month = '2025-01', end_year_month = '2030-01' WHERE name = '大墩房東-誠友開發股份有限公司' AND start_year_month IS NULL AND end_year_month IS NULL;

-- 共 20 筆有抽出可填的套用期間