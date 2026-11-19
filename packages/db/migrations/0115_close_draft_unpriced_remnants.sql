-- Allow strict, non-financial withdrawal of an excluded unpriced draft remnant.
-- No data backfill or relaxation of attributed manager decisions.
CREATE OR REPLACE FUNCTION close_draft_materialized_operation_valid(
  p_table text,
  p_new jsonb,
  p_old jsonb,
  p_operation text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft_payload jsonb;
  draft_row jsonb;
  draft_rows jsonb;
  review_reasons jsonb;
  client_key text;
  row_count integer;
  expected_included boolean;
  manager_versioned boolean := false;
  preserve_manager_window boolean := false;
  expected_source text;
BEGIN
  SELECT d.payload INTO draft_payload
    FROM public.close_draft_materialization_context c
    JOIN public.shift_close_drafts d ON d.shift_id = c.shift_id
   WHERE c.backend_pid = pg_backend_pid()
     AND c.transaction_id = txid_current()
     AND c.shift_id = (p_new ->> 'shift_id')::uuid
     AND d.revision = c.draft_revision
     AND d.draft_hash = c.draft_hash
     AND d.submitted_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  -- A newly materialized close-draft row belongs to the driver even when a manager invokes force
  -- preparation. An UPDATE, however, may target a pre-existing manager-authored manual row; its
  -- owner must remain byte-for-byte unchanged (checked below), not be rewritten as the driver.
  IF p_operation = 'INSERT' AND NOT EXISTS (
    SELECT 1
      FROM public.shifts s
      JOIN public.drivers driver ON driver.id = s.driver_id
     WHERE s.id = (p_new ->> 'shift_id')::uuid
       AND driver.user_id = (p_new ->> 'created_by')::uuid
  ) THEN RETURN false; END IF;

  client_key := p_new ->> 'close_draft_client_key';
  draft_rows := CASE p_table
    WHEN 'shift_orders' THEN draft_payload #> '{operations,orders}'
    WHEN 'cash_deductions' THEN draft_payload #> '{operations,cashDeductions}'
    ELSE NULL
  END;
  IF jsonb_typeof(draft_rows) <> 'array' THEN RETURN false; END IF;
  SELECT count(*), min(value::text)::jsonb
    INTO row_count, draft_row
    FROM jsonb_array_elements(draft_rows) item(value)
   WHERE value ->> 'clientKey' = client_key;

  -- Unpriced excluded remnants are omitted by closeDraftOperationsInput, just as absent rows
  -- are. Reconciliation may only withdraw their old evidence flags while preserving every
  -- stored amount, identity and manager decision through the strict checks below.
  IF row_count = 0 OR (
    row_count = 1
    AND NOT COALESCE((draft_row ->> 'included')::boolean, false)
    AND (CASE p_table
      WHEN 'shift_orders' THEN draft_row ->> 'fee'
      WHEN 'cash_deductions' THEN draft_row ->> 'amount'
      ELSE 'unsupported'
    END) IS NULL
  ) THEN
    -- Safe reconciliation of a pre-draft driver row: keep every value/identity byte-for-byte and
    -- only turn it into visible, non-financial evidence. Manager/manual/corrected ownership is
    -- filtered in the service and rechecked here through decision/driver/kind constraints.
    IF p_operation <> 'UPDATE' OR p_old IS NULL OR
       COALESCE((p_old ->> 'decided_by') <> '', false) OR
       COALESCE((p_old ->> 'decided_at') <> '', false) OR
       NOT COALESCE((p_new -> 'close_draft_review_reasons') @> '["evidence_removed"]'::jsonb, false) OR
       COALESCE((p_new ->> 'included')::boolean, true) OR
       p_new ->> 'window_status' <> 'unknown' OR
       p_new ->> 'window_basis' IS NOT NULL OR
       p_new -> 'position_evidence' <> 'null'::jsonb OR
       p_new ->> 'close_draft_observation_id' IS NOT NULL THEN
      RETURN false;
    END IF;
    IF (p_new - ARRAY[
          'included','window_status','window_basis','position_evidence',
          'close_draft_observation_id','close_draft_review_reasons'
        ]) IS DISTINCT FROM
       (p_old - ARRAY[
          'included','window_status','window_basis','position_evidence',
          'close_draft_observation_id','close_draft_review_reasons'
        ]) THEN RETURN false; END IF;
    IF p_table = 'shift_orders' AND p_old ->> 'kind' = 'manual' THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1
        FROM public.shifts s
        JOIN public.drivers driver ON driver.id = s.driver_id
       WHERE s.id = (p_new ->> 'shift_id')::uuid
         AND driver.user_id = (p_old ->> 'created_by')::uuid
    );
  END IF;
  IF row_count <> 1 OR draft_row IS NULL OR client_key IS NULL THEN RETURN false; END IF;

  review_reasons := COALESCE(draft_row -> 'reviewReasons', '[]'::jsonb);
  IF jsonb_typeof(review_reasons) <> 'array' THEN RETURN false; END IF;
  expected_included := COALESCE((draft_row ->> 'included')::boolean, false)
    AND jsonb_array_length(review_reasons) = 0;
  manager_versioned := p_old IS NOT NULL AND p_old ->> 'decided_at' IS NOT NULL;
  preserve_manager_window := manager_versioned
    AND p_old ->> 'window_basis' = 'manager'
    AND ash_has_visible_text(p_old ->> 'decision_reason');
  expected_source := CASE WHEN draft_row ->> 'source' = 'manual' THEN 'manual' ELSE 'ocr' END;

  IF p_new -> 'close_draft_review_reasons' IS DISTINCT FROM review_reasons THEN RETURN false; END IF;
  IF p_operation = 'UPDATE' AND p_old IS NULL THEN RETURN false; END IF;
  IF p_operation = 'UPDATE' AND ROW(
       p_new -> 'id', p_new -> 'shift_id', p_new -> 'created_by',
       p_new -> 'decision_reason', p_new -> 'decided_by', p_new -> 'decided_at'
     ) IS DISTINCT FROM ROW(
       p_old -> 'id', p_old -> 'shift_id', p_old -> 'created_by',
       p_old -> 'decision_reason', p_old -> 'decided_by', p_old -> 'decided_at'
     ) THEN RETURN false; END IF;

  IF p_table = 'shift_orders' THEN
    IF p_operation = 'UPDATE' AND ROW(
         p_new -> 'provider_order_no', p_new -> 'kind', p_new -> 'driver_share_minor',
         p_new -> 'company_share_minor', p_new -> 'notes', p_new -> 'driver_confirmed'
       ) IS DISTINCT FROM ROW(
         p_old -> 'provider_order_no', p_old -> 'kind', p_old -> 'driver_share_minor',
         p_old -> 'company_share_minor', p_old -> 'notes', p_old -> 'driver_confirmed'
       ) THEN RETURN false; END IF;
    IF (draft_row ->> 'providerOrderNo') <> '' AND
       p_new ->> 'provider_order_no' IS DISTINCT FROM draft_row ->> 'providerOrderNo' THEN RETURN false; END IF;
    IF (draft_row ->> 'providerOrderNo') = '' AND p_new ->> 'provider_order_no' !~ '^YAL-[a-f0-9]{32}$' THEN
      RETURN false;
    END IF;
    IF (p_new ->> 'pay_mode') IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN p_old ->> 'pay_mode' ELSE draft_row ->> 'payMode' END)
       OR (p_new ->> 'fee_minor')::numeric IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN (p_old ->> 'fee_minor')::numeric
         ELSE round((draft_row ->> 'fee')::numeric * 100) END)
       OR (p_new ->> 'source') IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN p_old ->> 'source' ELSE expected_source END)
       OR (p_new ->> 'fee_ocr_minor')::numeric IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN (p_old ->> 'fee_ocr_minor')::numeric
         WHEN draft_row ->> 'feeOcr' IS NULL THEN NULL
         ELSE round((draft_row ->> 'feeOcr')::numeric * 100) END)
       OR p_new -> 'wallet_amount_minor' IS DISTINCT FROM COALESCE(p_old -> 'wallet_amount_minor', 'null'::jsonb)
       OR p_new -> 'zone' IS DISTINCT FROM COALESCE(p_old -> 'zone', 'null'::jsonb) THEN
      RETURN false;
    END IF;
    IF p_operation = 'INSERT' AND (
      p_new ->> 'kind' <> 'yallago' OR p_new -> 'driver_share_minor' <> 'null'::jsonb OR
      p_new -> 'company_share_minor' <> 'null'::jsonb OR p_new -> 'notes' <> 'null'::jsonb OR
      NOT COALESCE((p_new ->> 'driver_confirmed')::boolean, false) OR
      p_new ->> 'decided_by' IS NOT NULL OR p_new ->> 'decided_at' IS NOT NULL
    ) THEN RETURN false; END IF;
  ELSE
    IF p_new ->> 'operation_key' IS DISTINCT FROM draft_row ->> 'operationKey'
       OR (p_new ->> 'amount_minor')::numeric IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN (p_old ->> 'amount_minor')::numeric
         ELSE round((draft_row ->> 'amount')::numeric * 100) END)
       OR (p_new ->> 'source') IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN p_old ->> 'source' ELSE expected_source END)
       OR (p_new ->> 'amount_ocr_minor')::numeric IS DISTINCT FROM (CASE
         WHEN manager_versioned THEN (p_old ->> 'amount_ocr_minor')::numeric
         WHEN draft_row ->> 'amountOcr' IS NULL THEN NULL
         ELSE round((draft_row ->> 'amountOcr')::numeric * 100) END) THEN
      RETURN false;
    END IF;
    IF p_operation = 'INSERT' AND (p_new ->> 'decided_by' IS NOT NULL OR p_new ->> 'decided_at' IS NOT NULL) THEN
      RETURN false;
    END IF;
  END IF;

  IF preserve_manager_window THEN
    IF ROW(
      p_new -> 'included', p_new -> 'occurred_date', p_new -> 'occurred_minute',
      p_new -> 'window_status', p_new -> 'window_basis', p_new -> 'position_evidence',
      p_new -> 'close_draft_observation_id'
    ) IS DISTINCT FROM ROW(
      p_old -> 'included', p_old -> 'occurred_date', p_old -> 'occurred_minute',
      p_old -> 'window_status', p_old -> 'window_basis', p_old -> 'position_evidence',
      p_old -> 'close_draft_observation_id'
    ) THEN RETURN false; END IF;
  ELSE
    IF COALESCE((p_new ->> 'included')::boolean, false) IS DISTINCT FROM expected_included
       OR p_new ->> 'occurred_date' IS DISTINCT FROM draft_row ->> 'occurredDate'
       OR p_new ->> 'occurred_minute' IS DISTINCT FROM draft_row ->> 'occurredMinute'
       OR p_new ->> 'window_basis' IS DISTINCT FROM draft_row ->> 'windowBasis'
       OR p_new -> 'position_evidence' IS DISTINCT FROM COALESCE(draft_row -> 'position', 'null'::jsonb)
       OR p_new ->> 'close_draft_observation_id' IS DISTINCT FROM draft_row ->> 'observationId'
       OR (jsonb_array_length(review_reasons) > 0 AND p_new ->> 'window_status' <> 'unknown')
       OR (expected_included AND p_new ->> 'window_status' <> 'in_window')
       OR (NOT expected_included AND jsonb_array_length(review_reasons) = 0
           AND p_new ->> 'window_status' = 'in_window') THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR data_exception THEN
  RETURN false;
END
$$;

