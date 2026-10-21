-- 2026-10-21 營運：月報真實實收只填一格「總真實實收」（receipt_total）
-- 舊的 glasses_receipt／contact_receipt 保留（9 月已從試算表填的值照用；沒填總數時兩格相加）
insert into ledger_accounts (code, group_code, name, kind, ratio_group, auto_source, sort_order, is_active, note)
values ('receipt_total', 'revenue', '總真實實收', 'revenue', null, 'manual', 5, true, '2026-10-21：會計依銀行實際收到的錢手填一格；眼鏡／隱眼分店損益照帳面實收比例拆')
on conflict (code) do update set name = excluded.name, is_active = true, sort_order = 5;
update ledger_accounts set note = coalesce(note,'') || '｜2026-10-21 起改填「總真實實收」，這格只留舊資料' where code in ('glasses_receipt','contact_receipt') and note not like '%總真實實收%';
