-- 047：月報 AI（2026-11-09）：對話、動作單、開發需求；模組 report_ai（會計＋營運主管＋super_admin）
create table if not exists report_ai_chats (id bigserial primary key, app_number text not null, title text, stores jsonb default '[]'::jsonb, ym text, messages jsonb not null default '[]'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
create index if not exists report_ai_chats_app on report_ai_chats(app_number, updated_at desc);
create table if not exists report_ai_orders (id bigserial primary key, chat_id bigint references report_ai_chats(id) on delete set null, run_id bigint, kind text not null, payload jsonb not null, summary text, reason text, stores jsonb, ym text,
  status text not null default 'pending', decided_by text, decided_at timestamptz, result jsonb, error text, created_at timestamptz default now());
create index if not exists report_ai_orders_status on report_ai_orders(status, created_at desc);
create table if not exists report_ai_dev_needs (id bigserial primary key, chat_id bigint, title text not null, text text, status text default 'open', by_app text, created_at timestamptz default now());
alter table report_ai_chats enable row level security; alter table report_ai_orders enable row level security; alter table report_ai_dev_needs enable row level security;
insert into modules (key, label, icon, sort_order, is_system, description) values ('report_ai', '月報 AI', '🤖', 46, true, '跟 AI 討論月報、查帳、開帳／分攤／調帳（動作單確認後執行）') on conflict (key) do nothing;
insert into role_module_permissions (role_key, module_key, can_view, can_edit) values ('super_admin','report_ai',true,true),('operation_lead','report_ai',true,true),('operation_accounting','report_ai',true,true) on conflict (role_key, module_key) do nothing;
