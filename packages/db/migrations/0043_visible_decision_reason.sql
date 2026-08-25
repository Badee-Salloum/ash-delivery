-- ── 0043: one definition of «a reason was given» ────────────────────────────────────────────────
--
-- WHAT WAS WRONG. A decision reason is the ENTIRE audit trail for a delivery fee entering or
-- leaving BR1: an ambiguous Yallago row (decision 11) may only be counted once a manager records
-- who decided, when, and why. Three different answers to «is this reason blank» were in play:
--
--   • JavaScript `.trim()`   — the API and every UI copy of the predicate. Strips ASCII whitespace,
--                              NBSP, all `Zs` and U+FEFF, but LEAVES U+200B and the rest of `Cf`.
--   • `btrim(x)` one-arg     — these constraints and guards. Strips the ASCII SPACE and nothing
--                              else, so a lone TAB counted as a reason.
--   • `ash_has_visible_text` — 0035, already used for variance reasons, decision notes and
--                              receivable reasons. Strips whitespace AND `Cf`.
--
-- In an Arabic-first product this is not theoretical: U+200F RIGHT-TO-LEFT MARK and U+200E ride
-- along in pasted Arabic constantly, and `'‏'.trim()` is truthy. So a reason nobody could read was
-- accepted as evidence here, while `check-shift-money-integrity.mjs` judged the same row blank,
-- dropped its order from the BR1 recomputation, and reported the settlement as wrong. The audit
-- and the system disagreed about the same row, and neither was reliably right.
--
-- The rule is «at least one visible character SURVIVES the strip», so a genuine Arabic reason
-- carrying bidi marks is untouched. Only entirely invisible text is refused.
--
-- Measured on production 2026-08-25 before applying: 0 orders and 0 cash deductions carry a
-- decision reason at all, so nothing existing violates the constraints below.
--
-- Every definition here is its predecessor VERBATIM with only the blankness test swapped —
-- 11 occurrences across five functions and two CHECK constraints.

ALTER TABLE shift_orders
  DROP CONSTRAINT shift_orders_decision_ck;

ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_decision_ck CHECK (
    (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR
    (decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND (decision_reason IS NULL OR ash_has_visible_text(decision_reason)))
  );

ALTER TABLE cash_deductions
  DROP CONSTRAINT cash_deductions_decision_ck;

ALTER TABLE cash_deductions
  ADD CONSTRAINT cash_deductions_decision_ck CHECK (
    (decision_reason IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR
    (decision_reason IS NOT NULL AND ash_has_visible_text(decision_reason)
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION guard_shift_order_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor            uuid;
  v_automatic        boolean;
  v_expected         public.operation_window_status;
  v_expected_included boolean;
  v_window_changed   boolean;
  v_metadata_changed boolean;
  v_value_changed    boolean;
BEGIN
  v_window_changed := (
    NEW.included IS DISTINCT FROM OLD.included
    OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
    OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
    OR NEW.window_status IS DISTINCT FROM OLD.window_status
  );
  v_metadata_changed := (
    NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
    OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
  );
  v_value_changed := (
    NEW.fee_minor IS DISTINCT FROM OLD.fee_minor
    OR NEW.wallet_amount_minor IS DISTINCT FROM OLD.wallet_amount_minor
  );

  IF NOT v_window_changed AND NOT v_metadata_changed THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.operation_window_reclassification_context c
     WHERE c.backend_pid = pg_backend_pid()
       AND c.transaction_id = txid_current()
       AND c.shift_id = NEW.shift_id
  ) INTO v_automatic;

  IF v_automatic THEN
    SELECT public.classify_operation_window(
             NEW.occurred_date,
             NEW.occurred_minute,
             s.open_approved_at,
             s.submitted_at,
             b.timezone
           )
      INTO v_expected
      FROM public.shifts s
      JOIN public.branches b ON b.id = s.branch_id
     WHERE s.id = NEW.shift_id;

    v_expected_included := CASE
      WHEN OLD.decided_by IS NOT NULL
           AND OLD.decided_at IS NOT NULL
           AND ash_has_visible_text(OLD.decision_reason)
        THEN OLD.included
      ELSE public.operation_window_included_automatically(v_expected)
    END;

    IF NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.window_status IS DISTINCT FROM v_expected
       OR NEW.included IS DISTINCT FROM v_expected_included
    THEN
      RAISE EXCEPTION 'invalid automatic operation-window reclassification'
        USING ERRCODE = '23514', CONSTRAINT = 'shift_orders_window_decision_reason_guard';
    END IF;
    RETURN NEW;
  END IF;

  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF (
       (v_window_changed OR NOT v_value_changed)
       AND (NEW.decision_reason IS NULL OR NOT ash_has_visible_text(NEW.decision_reason))
     )
     OR NEW.decided_by IS NULL
     OR NEW.decided_at IS NULL
     OR NEW.decided_by IS DISTINCT FROM v_actor
     OR NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     OR ROW(NEW.decision_reason, NEW.decided_by, NEW.decided_at)
          IS NOT DISTINCT FROM ROW(OLD.decision_reason, OLD.decided_by, OLD.decided_at)
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.shifts s ON s.id = NEW.shift_id
        WHERE u.id = v_actor
          AND u.active
          AND (
            u.role_key IN ('general_manager', 'system_admin')
            OR (u.role_key = 'branch_manager' AND u.branch_id = s.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'operation-window changes require a fresh attributed manager reason'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_orders_window_decision_reason_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_cash_deduction_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor            uuid;
  v_automatic        boolean;
  v_expected         public.operation_window_status;
  v_expected_included boolean;
  v_window_changed   boolean;
  v_metadata_changed boolean;
BEGIN
  v_window_changed := (
    NEW.included IS DISTINCT FROM OLD.included
    OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
    OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
    OR NEW.window_status IS DISTINCT FROM OLD.window_status
  );
  v_metadata_changed := (
    NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
    OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
  );

  IF NOT v_window_changed AND NOT v_metadata_changed THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.operation_window_reclassification_context c
     WHERE c.backend_pid = pg_backend_pid()
       AND c.transaction_id = txid_current()
       AND c.shift_id = NEW.shift_id
  ) INTO v_automatic;

  IF v_automatic THEN
    SELECT public.classify_operation_window(
             NEW.occurred_date,
             NEW.occurred_minute,
             s.open_approved_at,
             s.submitted_at,
             b.timezone
           )
      INTO v_expected
      FROM public.shifts s
      JOIN public.branches b ON b.id = s.branch_id
     WHERE s.id = NEW.shift_id;

    v_expected_included := CASE
      WHEN OLD.decided_by IS NOT NULL
           AND OLD.decided_at IS NOT NULL
           AND ash_has_visible_text(OLD.decision_reason)
        THEN OLD.included
      ELSE public.operation_window_included_automatically(v_expected)
    END;

    IF NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.window_status IS DISTINCT FROM v_expected
       OR NEW.included IS DISTINCT FROM v_expected_included
    THEN
      RAISE EXCEPTION 'invalid automatic cash-deduction window reclassification'
        USING ERRCODE = '23514', CONSTRAINT = 'cash_deductions_window_decision_reason_guard';
    END IF;
    RETURN NEW;
  END IF;

  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF NEW.decision_reason IS NULL
     OR NOT ash_has_visible_text(NEW.decision_reason)
     OR NEW.decided_by IS NULL
     OR NEW.decided_at IS NULL
     OR NEW.decided_by IS DISTINCT FROM v_actor
     OR NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     OR ROW(NEW.decision_reason, NEW.decided_by, NEW.decided_at)
          IS NOT DISTINCT FROM ROW(OLD.decision_reason, OLD.decided_by, OLD.decided_at)
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.shifts s ON s.id = NEW.shift_id
        WHERE u.id = v_actor
          AND u.active
          AND (
            u.role_key IN ('general_manager', 'system_admin')
            OR (u.role_key = 'branch_manager' AND u.branch_id = s.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'cash-deduction window changes require a fresh attributed manager reason'
      USING ERRCODE = '23514', CONSTRAINT = 'cash_deductions_window_decision_reason_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION reclassify_shift_operations(p_shift_id uuid)
RETURNS TABLE(order_updates integer, deduction_updates integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_order_updates integer := 0; v_deduction_updates integer := 0;
BEGIN
  PERFORM 1 FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such shift %', p_shift_id USING ERRCODE = '23503'; END IF;
  INSERT INTO public.operation_window_reclassification_context (backend_pid, transaction_id, shift_id)
  VALUES (pg_backend_pid(), txid_current(), p_shift_id)
  ON CONFLICT (backend_pid) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id, shift_id = EXCLUDED.shift_id;
  BEGIN
    WITH classified AS (
      SELECT o.id, public.classify_operation_window(
        o.occurred_date, o.occurred_minute, s.open_approved_at, s.submitted_at, b.timezone
      ) AS status
      FROM public.shift_orders o
      JOIN public.shifts s ON s.id = o.shift_id
      JOIN public.branches b ON b.id = s.branch_id
      WHERE o.shift_id = p_shift_id AND o.kind <> 'manual'
        AND NOT (
          (
            o.window_basis = 'screen_position' AND o.occurred_minute IS NULL AND o.included
            AND public.close_draft_screen_position_valid(
              o.shift_id, o.close_draft_observation_id, o.position_evidence
            )
          )
          OR (NOT o.included AND jsonb_array_length(o.close_draft_review_reasons) > 0)
        )
    )
    UPDATE public.shift_orders o
       SET window_status = c.status,
           included = CASE WHEN o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL
                                AND ash_has_visible_text(o.decision_reason)
                           THEN o.included
                           ELSE public.operation_window_included_automatically(c.status) END
      FROM classified c
     WHERE o.id = c.id AND (
       o.window_status IS DISTINCT FROM c.status OR
       o.included IS DISTINCT FROM CASE WHEN o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL
                                             AND ash_has_visible_text(o.decision_reason)
                                        THEN o.included
                                        ELSE public.operation_window_included_automatically(c.status) END
     );
    GET DIAGNOSTICS v_order_updates = ROW_COUNT;

    WITH classified AS (
      SELECT d.id, public.classify_operation_window(
        d.occurred_date, d.occurred_minute, s.open_approved_at, s.submitted_at, b.timezone
      ) AS status
      FROM public.cash_deductions d
      JOIN public.shifts s ON s.id = d.shift_id
      JOIN public.branches b ON b.id = s.branch_id
      WHERE d.shift_id = p_shift_id
        AND NOT (
          (
            d.window_basis = 'screen_position' AND d.occurred_minute IS NULL AND d.included
            AND public.close_draft_screen_position_valid(
              d.shift_id, d.close_draft_observation_id, d.position_evidence
            )
          )
          OR (NOT d.included AND jsonb_array_length(d.close_draft_review_reasons) > 0)
        )
    )
    UPDATE public.cash_deductions d
       SET window_status = c.status,
           included = CASE WHEN d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL
                                AND ash_has_visible_text(d.decision_reason)
                           THEN d.included
                           ELSE public.operation_window_included_automatically(c.status) END
      FROM classified c
     WHERE d.id = c.id AND (
       d.window_status IS DISTINCT FROM c.status OR
       d.included IS DISTINCT FROM CASE WHEN d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL
                                             AND ash_has_visible_text(d.decision_reason)
                                        THEN d.included
                                        ELSE public.operation_window_included_automatically(c.status) END
     );
    GET DIAGNOSTICS v_deduction_updates = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.operation_window_reclassification_context
     WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current() AND shift_id = p_shift_id;
    RAISE;
  END;
  DELETE FROM public.operation_window_reclassification_context
   WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current() AND shift_id = p_shift_id;
  RETURN QUERY SELECT v_order_updates, v_deduction_updates;
END
$$;

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

  IF row_count = 0 THEN
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

CREATE OR REPLACE FUNCTION guard_close_draft_operation_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  expected_status public.operation_window_status;
  expected_included boolean;
BEGIN
  IF public.close_draft_materialization_active(NEW.shift_id) AND
     NOT public.close_draft_materialized_operation_valid(
       TG_TABLE_NAME,
       to_jsonb(NEW),
       CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
       TG_OP
     ) THEN
    RAISE EXCEPTION 'canonical operation does not match the locked close draft'
      USING ERRCODE = '23514', CONSTRAINT = 'close_draft_materialization_guard';
  END IF;

  IF NEW.close_draft_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shift_close_draft_observations o
     WHERE o.id = NEW.close_draft_observation_id AND o.shift_id = NEW.shift_id
  ) THEN
    RAISE EXCEPTION 'close-draft observation belongs to another shift'
      USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
  END IF;

  IF NEW.window_basis = 'screen_position' THEN
    IF NEW.close_draft_observation_id IS NULL OR jsonb_typeof(NEW.position_evidence) <> 'object' THEN
      RAISE EXCEPTION 'screen-position inclusion requires immutable observation evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
    END IF;
    IF NOT public.close_draft_screen_position_valid(
         NEW.shift_id, NEW.close_draft_observation_id, NEW.position_evidence
       ) OR (
         (NEW.position_evidence ->> 'lowerInstant') = (NEW.position_evidence ->> 'upperInstant')
         AND concat(NEW.occurred_date::text, ' ', NEW.occurred_minute)
             IS DISTINCT FROM (NEW.position_evidence ->> 'lowerInstant')
       ) OR (
         (NEW.position_evidence ->> 'lowerInstant') <> (NEW.position_evidence ->> 'upperInstant')
         AND NEW.occurred_minute IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'invalid screen-position operation interval'
        USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
    END IF;
    IF (NEW.position_evidence ->> 'lowerInstant') = (NEW.position_evidence ->> 'upperInstant') THEN
      SELECT public.classify_operation_window(
               NEW.occurred_date,
               NEW.occurred_minute,
               s.open_approved_at,
               LEAST(h.attached_at, COALESCE(s.submitted_at, h.attached_at)),
               b.timezone
             )
        INTO expected_status
        FROM public.shift_close_draft_observations o
        JOIN public.shifts s ON s.id = o.shift_id
        JOIN public.branches b ON b.id = s.branch_id
        JOIN LATERAL (
          SELECT history.attached_at
            FROM public.shift_media_attachment_history history
           WHERE history.shift_id = o.shift_id
             AND history.attachment_token = o.attachment_token
           ORDER BY history.id DESC LIMIT 1
        ) h ON true
       WHERE o.id = NEW.close_draft_observation_id AND o.shift_id = NEW.shift_id;
      expected_included := public.operation_window_included_automatically(expected_status);
      IF jsonb_array_length(NEW.close_draft_review_reasons) > 0 THEN
        IF NEW.included OR NEW.window_status <> 'unknown' THEN
          RAISE EXCEPTION 'review-required screen-position row must stay excluded'
            USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
        END IF;
      ELSIF expected_status IS NULL OR NEW.included IS DISTINCT FROM expected_included OR
            (expected_included AND NEW.window_status NOT IN (expected_status, 'in_window')) OR
            (NOT expected_included AND NEW.window_status IS DISTINCT FROM expected_status) THEN
        RAISE EXCEPTION 'screen-position exact result disagrees with its shift window'
          USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
      END IF;
    ELSIF jsonb_array_length(NEW.close_draft_review_reasons) > 0 THEN
      IF NEW.included OR NEW.window_status <> 'unknown' THEN
        RAISE EXCEPTION 'review-required positional interval must stay excluded'
          USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
      END IF;
    ELSIF NEW.window_status <> 'in_window' OR NOT NEW.included THEN
      RAISE EXCEPTION 'verified positional interval must be included'
        USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
    END IF;
  ELSIF NEW.position_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'position evidence requires screen_position basis'
      USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
  ELSIF NEW.window_basis = 'printed_time' AND
        (NEW.occurred_date IS NULL OR NEW.occurred_minute IS NULL) THEN
    RAISE EXCEPTION 'printed-time basis requires an exact date and minute'
      USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
  ELSIF NEW.window_basis = 'manager' AND (
    NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NOT ash_has_visible_text(NEW.decision_reason)
  ) THEN
    RAISE EXCEPTION 'manager basis requires an attributed reason'
      USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NOT public.close_draft_materialization_active(NEW.shift_id)
     AND ROW(
       NEW.window_basis, NEW.position_evidence, NEW.close_draft_observation_id,
       NEW.close_draft_review_reasons
     ) IS DISTINCT FROM ROW(
       OLD.window_basis, OLD.position_evidence, OLD.close_draft_observation_id,
       OLD.close_draft_review_reasons
     ) THEN
    BEGIN actor_id := NULLIF(current_setting('app.actor_id', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN actor_id := NULL; END;
    IF actor_id IS NULL OR NEW.decided_by IS DISTINCT FROM actor_id
      OR NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
      OR NOT ash_has_visible_text(NEW.decision_reason)
    THEN
      RAISE EXCEPTION 'operation provenance changes require a fresh attributed manager reason'
        USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON COLUMN shift_orders.decision_reason IS
  'لماذا قرر المدير ضم هذا الطلب أو استبعاده. The only audit trail for a fee entering BR1. Since 0043 it must contain at least one character a human can see (ash_has_visible_text), matching the API and the integrity checker exactly.';

COMMENT ON COLUMN cash_deductions.decision_reason IS
  'لماذا قرر المدير ضم هذا الخصم أو استبعاده. Same visible-text rule as shift_orders.decision_reason since 0043.';
