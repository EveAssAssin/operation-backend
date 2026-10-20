-- 035：持股可以小於 1%（試算表有 0.5%）。原本 CHECK shares >= 1 讓 034 改成小數後 0.5 還是存不進去。
ALTER TABLE store_shareholders DROP CONSTRAINT IF EXISTS store_shareholders_shares_check;
ALTER TABLE store_shareholders ADD CONSTRAINT store_shareholders_shares_check CHECK (shares > 0 AND shares <= 100);
