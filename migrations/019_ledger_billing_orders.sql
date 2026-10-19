-- ============================================================
-- 019_ledger_billing_orders.sql（2026-10-20）門市月報 P1
-- ① 科目補「營業費用」「眼鏡業績（ERP 帳上，參考）」；雜費改名
-- ② 手填／調帳可記廠商（月報鏡片／藥拋照廠商分列）
-- ③ ledger_lines 併入 billing_orders（企劃部廣告預算、工程部修繕／保養、教育訓練獎金）
-- ④ 保留盈餘預設比例（審閱時可改金額）
-- 重跑安全
-- ============================================================
INSERT INTO ledger_accounts (code, group_code, name, kind, ratio_group, auto_source, sort_order) VALUES
 ('hq_opex','opex','營業費用','expense','營運費用','manual',186),
 ('glasses_sales','info','眼鏡業績（帳上）','info',NULL,'manual',5)
ON CONFLICT (code) DO NOTHING;
UPDATE ledger_accounts SET name = '雜費' WHERE code = 'consumables' AND name = '耗材雜費';

ALTER TABLE ledger_manual_entries ADD COLUMN IF NOT EXISTS vendor TEXT;
-- 同一店同一月同一科目同一廠商只留一筆手填值
DROP INDEX IF EXISTS uq_lme_value;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lme_value_v ON ledger_manual_entries(store_erpid, report_ym, ledger_code, coalesce(vendor,''))
  WHERE entry_type = 'value' AND void_at IS NULL;

INSERT INTO report_settings(key, value) VALUES ('retained_rate', '0.1') ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION ledger_lines(p_ym TEXT)
RETURNS TABLE (store_erpid TEXT, ledger_code TEXT, amount NUMERIC, fee_ym TEXT, source TEXT, ref_id TEXT, ref_title TEXT)
LANGUAGE sql STABLE AS $$
  WITH cut AS (SELECT coalesce((SELECT (value #>> '{}')::int FROM report_settings WHERE key='cutoff_day'), 26) AS d)
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
     AND coalesce(a.report_ym, b.report_ym, report_ym_for(b.period, coalesce(b.received_at, b.submitted_at, b.created_at), (SELECT d FROM cut))) = p_ym
  UNION ALL
  -- ② 各部門系統推來的開帳（企劃部廣告預算、工程部、教育訓練部）；送達＝created_at
  SELECT o.store_erpid::text,
         CASE o.source_type WHEN 'ad_budget' THEN 'ad_budget' WHEN 'education_bonus' THEN 'edu_bonus'
                            WHEN 'repair' THEN 'repair' WHEN 'maintenance' THEN 'repair' ELSE 'other' END,
         o.amount, o.billing_month::text, 'billing_order', o.id::text,
         coalesce(o.billing_category,'') || '｜' || coalesce(o.remark, o.order_id, '')
    FROM billing_orders o
   WHERE o.store_erpid IS NOT NULL AND o.billing_month IS NOT NULL
     AND report_ym_for(o.billing_month, o.created_at, (SELECT d FROM cut)) = p_ym
  UNION ALL
  -- ③ 營運費用（電費、水費、電話網路、金雞、房租）已照期間拆月
  SELECT oa.store_erpid::text, coalesce(c.ledger_code, 'other'), oa.amount, oa.year_month::text,
         'opex', oe.id::text, coalesce(c.name,'')
    FROM operational_expense_allocations oa
    JOIN operational_expenses oe ON oe.id = oa.operational_expense_id
    LEFT JOIN entity_fact_categories c ON c.id = oe.category_id
   WHERE oa.year_month = p_ym
  UNION ALL
  -- ④ 固定支出（要設 store_erpid＋in_report）
  SELECT r.store_erpid, coalesce(r.ledger_code, 'rent'), r.amount, p_ym, 'recurring', r.id::text, r.name
    FROM recurring_expenses r
   WHERE r.in_report AND r.is_active AND r.store_erpid IS NOT NULL
     AND (r.start_year_month IS NULL OR r.start_year_month <= p_ym)
     AND (r.end_year_month   IS NULL OR r.end_year_month   >= p_ym)
  UNION ALL
  -- ⑤ 每店固定金額（行銷基金、折舊）
  SELECT f.store_erpid, f.ledger_code, f.amount, p_ym, 'fixed', f.id::text, coalesce(f.note,'')
    FROM store_fixed_items f
   WHERE f.from_ym <= p_ym AND (f.to_ym IS NULL OR f.to_ym >= p_ym)
  UNION ALL
  -- ⑥ 手填值與調帳（ref_title＝廠商｜原因）
  SELECT m.store_erpid, m.ledger_code, m.amount, coalesce(m.fee_ym, m.report_ym), 'manual_' || m.entry_type, m.id::text,
         coalesce(m.vendor,'') || '｜' || coalesce(m.reason,'')
    FROM ledger_manual_entries m
   WHERE m.report_ym = p_ym AND m.void_at IS NULL
$$;
REVOKE ALL ON FUNCTION ledger_lines(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ledger_lines(TEXT) TO service_role;
