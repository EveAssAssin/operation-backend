-- 055_expense_vouchers.sql（2026-11-15 Louis：門市費用申請 → 差旅費）
--   諮詢頻道（市場部）審核通過 → /api/external/expense/post 寫月報（ledger_manual_entries entry_type='expense'，科目「差旅費」）
--   報帳憑證（黏存單／支出證明單）存 expense_vouchers，營運部「帳單管理 → 🧾 報帳憑證」看與列印
alter table ledger_manual_entries drop constraint if exists ledger_manual_entries_entry_type_check;
alter table ledger_manual_entries add constraint ledger_manual_entries_entry_type_check check (entry_type in ('value','adjust','amort','petty','expense'));
alter table ledger_manual_entries add column if not exists expense_ref text;
create index if not exists ledger_manual_entries_expense_ref on ledger_manual_entries (expense_ref) where expense_ref is not null;

-- 會計科目「差旅費」掛在「分店支出雜項」（之後要改格子：會計科目管理把這個科目停用、另建一個同名的即可）
insert into ledger_subjects (ledger_code, name, note, created_by)
select 'store_misc', '差旅費', '門市費用申請（交通費／油資）', 'migration 055'
where not exists (select 1 from ledger_subjects where name = '差旅費');

create table if not exists expense_vouchers (
  id               uuid primary key default gen_random_uuid(),
  voucher_no       text not null unique,                     -- EV202611-0001
  kind             text not null check (kind in ('paste','proof')),   -- paste＝黏存單（有發票／收據）；proof＝支出證明單（沒有單據）
  source_ref       text,                                     -- market-expense:<id>
  ledger_entry_id  uuid,
  company          text,                                     -- 公司（申請人投保單位）
  applicant_name   text, applicant_erpid text, applicant_app text,
  store_erpid      text, store_name text,
  report_ym        text,
  voucher_date     date not null default ((now() at time zone 'Asia/Taipei')::date),
  subject_name     text not null default '差旅費',
  ledger_code      text,
  purpose          text not null,                            -- 事由（洽公目的）
  amount           numeric not null check (amount > 0),
  amount_words     text,
  items            jsonb not null default '[]'::jsonb,       -- 明細（起訖／公里／單據金額）
  files            jsonb not null default '[]'::jsonb,       -- [{path,name,amount}] bucket ledger-vouchers
  attach_count     int not null default 0,
  no_receipt_reason text,
  note             text,
  status           text not null default 'issued' check (status in ('issued','void')),
  created_by       text, created_at timestamptz not null default now(),
  void_at          timestamptz, void_by text
);
create index if not exists expense_vouchers_ym on expense_vouchers (report_ym);
create index if not exists expense_vouchers_ref on expense_vouchers (source_ref);
alter table expense_vouchers enable row level security;
