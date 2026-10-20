-- 034 股東持股可以有小數（2026-10-21；試算表有 1.5%、2.5% 這種）
ALTER TABLE store_shareholders ALTER COLUMN shares TYPE numeric(6,3) USING shares::numeric;
