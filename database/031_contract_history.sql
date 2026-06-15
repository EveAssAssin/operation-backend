-- ============================================================
-- 031_contract_history.sql
--   合約變更歷史記錄（自動 trigger）
--   只要 UPDATE contracts，就會自動寫一筆到 contract_history
-- ============================================================

CREATE TABLE IF NOT EXISTS contract_history (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   UUID         NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  changed_by    VARCHAR(50),
  -- 變動的欄位（多欄一次改的話會寫多筆，每欄一筆）
  field         VARCHAR(80)  NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  -- 整列 snapshot（json，方便之後查）
  row_before    JSONB,
  row_after     JSONB
);

CREATE INDEX IF NOT EXISTS idx_ch_contract  ON contract_history (contract_id, changed_at DESC);

-- ── trigger function ────────────────────────────────────
CREATE OR REPLACE FUNCTION contracts_history_trigger() RETURNS TRIGGER AS $$
DECLARE
  k TEXT;
  ov TEXT;
  nv TEXT;
  monitored TEXT[] := ARRAY[
    'name', 'party_name', 'our_side_name',
    'signed_date', 'start_date', 'end_date',
    'total_amount', 'monthly_amount',
    'status', 'note', 'type_data'
  ];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;

  FOREACH k IN ARRAY monitored LOOP
    ov := COALESCE(to_jsonb(OLD) ->> k, '');
    nv := COALESCE(to_jsonb(NEW) ->> k, '');
    IF ov IS DISTINCT FROM nv THEN
      INSERT INTO contract_history (contract_id, field, old_value, new_value, row_before, row_after, changed_by)
      VALUES (NEW.id, k, ov, nv, to_jsonb(OLD), to_jsonb(NEW), NEW.created_by);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contracts_history ON contracts;
CREATE TRIGGER trg_contracts_history
  AFTER UPDATE ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION contracts_history_trigger();
