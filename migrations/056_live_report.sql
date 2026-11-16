-- 056_live_report.sql（2026-11-17 Louis）：店長工具「即時月報」——部分真實值＋部分預測值，每天凌晨更新一次
--   live_lens_costs：鏡片成本表（ERP 商品 bind_id → 單片成本）；從加工中心商品主檔帶出品項，成本由營運部填
--   live_reports：每店每月每天一份快照（services/liveReport.build）；店長工具讀最新一天，趨勢圖讀整月
--   live_calibration：關帳後「預估 vs 實際」每一格的差距 → 下個月估法乘上修正係數（最近 3 個月平均）
--   設定 report_settings.live_report：{ contact_ratio:0.65, lab_fee:150, ship_fee:50, hist_months:3, ratio_codes:[card_fee,packaging,logistics] }
create table if not exists live_lens_costs (
  bind_id    bigint primary key,
  name text, brand text, catena text, model text,
  cost       numeric(12,2),                 -- 單片成本；null＝還沒填
  note       text,
  updated_by text, updated_at timestamptz not null default now()
);
create table if not exists live_reports (
  store_erpid text not null,
  ym          text not null,
  day         date not null,                -- 資料算到這一天（含）
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (store_erpid, ym, day)
);
create index if not exists live_reports_ym on live_reports (ym, day desc);
create table if not exists live_calibration (
  ym       text not null,
  key      text not null,                   -- frame／lens／lens_lab／contact／card_fee／packaging／logistics
  est      numeric not null,
  actual   numeric not null,
  factor   numeric,
  stores   int not null default 0,
  created_at timestamptz not null default now(),
  primary key (ym, key)
);
alter table live_lens_costs enable row level security;
alter table live_reports enable row level security;
alter table live_calibration enable row level security;
insert into live_lens_costs (bind_id, name, brand, catena, model)
select distinct on (bind_id) bind_id, name, brand, catena, model from proc_price_items where is_active order by bind_id, effective_from desc
on conflict (bind_id) do nothing;
insert into report_settings (key, value) values ('live_report', '{"contact_ratio":0.65,"lab_fee":150,"ship_fee":50,"hist_months":3,"ratio_codes":["card_fee","packaging","logistics"]}'::jsonb)
on conflict (key) do nothing;
