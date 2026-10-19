-- ============================================================
-- 018_ledger_lines.sql（2026-10-20）門市月報 P0：各來源 → 統一帳本列
--   ledger_lines('2026-09')  ＝ 這個月報的每一列（店、科目、金額、來源、原始單）
--   ledger_store_month('2026-09') ＝ 每店×科目加總
-- 來源：bill_allocations（開帳／廠商帳單，confirmed 或 distributed）、
--       operational_expense_allocations（電費水費…已照用電期間拆月）、
--       recurring_expenses（in_report＋store_erpid 才算）、store_fixed_items、ledger_manual_entries
-- 重跑安全
-- ============================================================

ALTER TABLE billing_sources ADD COLUMN IF NOT EXISTS ledger_code TEXT REFERENCES ledger_accounts(code);
UPDATE billing_sources SET ledger_code = 'repair'      WHERE ledger_code IS NULL AND (name LIKE '%工程部%' OR name LIKE '%工務%');
UPDATE billing_sources SET ledger_code = 'lens_vendor' WHERE ledger_code IS NULL AND (name LIKE '%路奇%' OR name LIKE '%天格%' OR name LIKE '%康德%');
UPDATE billing_sources SET ledger_code = 'contact_vendor' WHERE ledger_code IS NULL AND name LIKE '%晶碩%';

-- 2026-10-20 以前建的帳單：列入月報＝費用月（截止日規則只對之後新進的帳單）
UPDATE bills SET report_ym = period WHERE report_ym IS NULL AND created_at < '2026-10-20';

CREATE OR REPLACE FUNCTION ledger_lines(p_ym TEXT)
RETURNS TABLE (store_erpid TEXT, ledger_code TEXT, amount NUMERIC, fee_ym TEXT, source TEXT, ref_id TEXT, ref_title TEXT)
LANGUAGE sql STABLE AS $$
  -- ① 開帳／廠商帳單
  SELECT a.store_erpid::text,
         coalesce(a.ledger_code, b.ledger_code, ac.ledger_code, s.ledger_code, 'other'),
         a.allocated_amount,
         coalesce(a.fee_ym, b.period)::text,
         'bill', b.id::text, coalesce(s.name,'') || '｜' || coalesce(b.title,'')
    FROM bill_allocations a
    JOIN bills b ON b.id = a.bill_id
    LEFT JOIN billing_sources s ON s.id = b.source_id
    LEFT JOIN accounting_categories ac ON ac.id = b.accounting_category_id
   WHERE b.status IN ('confirmed','distributed')
     AND coalesce(a.report_ym, b.report_ym, report_ym_for(b.period, coalesce(b.received_at, b.submitted_at, b.created_at),
                  coalesce((SELECT (value #>> '{}')::int FROM report_settings WHERE key='cutoff_day'), 26))) = p_ym
  UNION ALL
  -- ② 營運費用（電費、水費、電話網路、金雞、房租）已照期間拆月
  SELECT oa.store_erpid::text, coalesce(c.ledger_code, 'other'), oa.amount, oa.year_month::text,
         'opex', oe.id::text, coalesce(c.name,'')
    FROM operational_expense_allocations oa
    JOIN operational_expenses oe ON oe.id = oa.operational_expense_id
    LEFT JOIN entity_fact_categories c ON c.id = oe.category_id
   WHERE oa.year_month = p_ym
  UNION ALL
  -- ③ 固定支出（房租等；要設 store_erpid＋in_report）
  SELECT r.store_erpid, coalesce(r.ledger_code, 'rent'), r.amount, p_ym, 'recurring', r.id::text, r.name
    FROM recurring_expenses r
   WHERE r.in_report AND r.is_active AND r.store_erpid IS NOT NULL
     AND (r.start_year_month IS NULL OR r.start_year_month <= p_ym)
     AND (r.end_year_month   IS NULL OR r.end_year_month   >= p_ym)
  UNION ALL
  -- ④ 每店固定金額（行銷基金、折舊）
  SELECT f.store_erpid, f.ledger_code, f.amount, p_ym, 'fixed', f.id::text, coalesce(f.note,'')
    FROM store_fixed_items f
   WHERE f.from_ym <= p_ym AND (f.to_ym IS NULL OR f.to_ym >= p_ym)
  UNION ALL
  -- ⑤ 手填值與調帳
  SELECT m.store_erpid, m.ledger_code, m.amount, coalesce(m.fee_ym, m.report_ym), 'manual_' || m.entry_type, m.id::text, coalesce(m.reason,'')
    FROM ledger_manual_entries m
   WHERE m.report_ym = p_ym AND m.void_at IS NULL
$$;

CREATE OR REPLACE FUNCTION ledger_store_month(p_ym TEXT)
RETURNS TABLE (store_erpid TEXT, ledger_code TEXT, group_code TEXT, kind TEXT, amount NUMERIC, lines INT)
LANGUAGE sql STABLE AS $$
  SELECT l.store_erpid, l.ledger_code, la.group_code, la.kind, sum(l.amount), count(*)::int
    FROM ledger_lines(p_ym) l
    LEFT JOIN ledger_accounts la ON la.code = l.ledger_code
   GROUP BY 1,2,3,4
$$;

-- 這兩支只給後端用（service_role）
REVOKE ALL ON FUNCTION ledger_lines(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ledger_store_month(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION report_ym_for(TEXT, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ledger_lines(TEXT), ledger_store_month(TEXT), report_ym_for(TEXT, TIMESTAMPTZ, INT) TO service_role;
