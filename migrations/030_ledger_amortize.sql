-- 030 月報「分攤開帳」（2026-10-20）：一筆金額分好幾個月列入同一家店的同一個科目
-- 每個月一列 ledger_manual_entries（entry_type='amort'），同一筆分攤共用 amort_group；ledger_lines 的 source＝manual_amort
alter table ledger_manual_entries add column if not exists amort_group text, add column if not exists amort_seq int, add column if not exists amort_n int, add column if not exists amort_total numeric;
create index if not exists ledger_manual_entries_amort_idx on ledger_manual_entries(amort_group) where amort_group is not null;
alter table ledger_manual_entries drop constraint if exists ledger_manual_entries_entry_type_check;
alter table ledger_manual_entries add constraint ledger_manual_entries_entry_type_check check (entry_type in ('value','adjust','amort'));
