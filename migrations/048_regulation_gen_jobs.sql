-- 048：規範 AI 產生工作存 DB（2026-11-10）：以前只放記憶體，營運部系統一重新部署，企劃 AI 的卡片就永遠停在「寫草稿中」
create table if not exists regulation_gen_jobs (id text primary key, owner text not null, status text not null default 'running', result jsonb, error text, created_at timestamptz default now(), updated_at timestamptz default now());
alter table regulation_gen_jobs enable row level security;
