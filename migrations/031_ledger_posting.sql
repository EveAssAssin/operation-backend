-- 031 入帳月份／科目／分攤＋已關帳自動順延（2026-10-20，已在 Supabase 套用）
-- ① 廠商請款：會計通過時設定入帳月份 report_ym、科目 ledger_code、分攤月數 amort_months
-- ② bill_alloc_schedule：一筆帳單分配（某店）拆成多個月；金額加總＝分配金額才生效，否則照原本一筆算
-- ③ ledger_open_ym(store, ym, at)：那個月已關帳、而這筆帳是關帳之後才進來 → 自動往後找第一個沒關帳的月份
--    ledger_lines 的帳單（沒手動指定月份的）與部門開帳單都套用；手動指定的月份照指定（寫入時就擋關帳）
alter table vendor_payment_requests
  add column if not exists report_ym text,
  add column if not exists ledger_code text references ledger_accounts(code),
  add column if not exists amort_months int,
  add column if not exists acct_set_by text,
  add column if not exists acct_set_at timestamptz;
create table if not exists bill_alloc_schedule (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references bill_allocations(id) on delete cascade,
  seq int not null, report_ym text not null, amount numeric not null,
  shifted_from text, created_by text, created_at timestamptz not null default now(),
  unique (allocation_id, seq)
);
create index if not exists bill_alloc_schedule_ym on bill_alloc_schedule(report_ym);
alter table bill_alloc_schedule enable row level security;
-- ledger_open_ym 與新版 ledger_lines 全文見 Supabase（apply_migration 031_ledger_posting）
