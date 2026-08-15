-- 0033 - an unverified operation clock is evidence, never money
--
-- Older classifiers kept `unknown` rows included while also blocking approval. That still let the
-- row alter BR1 and the settlement before a manager decided whether it belonged to the shift. The
-- protected classifier now excludes unknown rows by default and preserves only a fully attributed,
-- reasoned manager decision.

CREATE FUNCTION operation_window_included_automatically(p_status operation_window_status)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary')
$$;

REVOKE ALL ON FUNCTION operation_window_included_automatically(operation_window_status) FROM PUBLIC;

CREATE OR REPLACE FUNCTION reclassify_shift_operations(p_shift_id uuid)
RETURNS TABLE(order_updates integer, deduction_updates integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_order_updates     integer := 0;
  v_deduction_updates integer := 0;
BEGIN
  PERFORM 1 FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such shift %', p_shift_id USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.operation_window_reclassification_context (backend_pid, transaction_id, shift_id)
  VALUES (pg_backend_pid(), txid_current(), p_shift_id)
  ON CONFLICT (backend_pid) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id,
        shift_id = EXCLUDED.shift_id;

  BEGIN
    WITH classified AS (
      SELECT o.id,
             public.classify_operation_window(
               o.occurred_date,
               o.occurred_minute,
               s.open_approved_at,
               s.submitted_at,
               b.timezone
             ) AS status
        FROM public.shift_orders o
        JOIN public.shifts s ON s.id = o.shift_id
        JOIN public.branches b ON b.id = s.branch_id
       WHERE o.shift_id = p_shift_id
         AND o.kind <> 'manual'
    )
    UPDATE public.shift_orders o
       SET window_status = c.status,
           included = CASE
             WHEN o.decided_by IS NOT NULL
                  AND o.decided_at IS NOT NULL
                  AND NULLIF(btrim(o.decision_reason), '') IS NOT NULL
               THEN o.included
             ELSE public.operation_window_included_automatically(c.status)
           END
      FROM classified c
     WHERE o.id = c.id
       AND (
         o.window_status IS DISTINCT FROM c.status
         OR o.included IS DISTINCT FROM (CASE
              WHEN o.decided_by IS NOT NULL
                   AND o.decided_at IS NOT NULL
                   AND NULLIF(btrim(o.decision_reason), '') IS NOT NULL
                THEN o.included
              ELSE public.operation_window_included_automatically(c.status)
            END)
       );
    GET DIAGNOSTICS v_order_updates = ROW_COUNT;

    WITH classified AS (
      SELECT d.id,
             public.classify_operation_window(
               d.occurred_date,
               d.occurred_minute,
               s.open_approved_at,
               s.submitted_at,
               b.timezone
             ) AS status
        FROM public.cash_deductions d
        JOIN public.shifts s ON s.id = d.shift_id
        JOIN public.branches b ON b.id = s.branch_id
       WHERE d.shift_id = p_shift_id
    )
    UPDATE public.cash_deductions d
       SET window_status = c.status,
           included = CASE
             WHEN d.decided_by IS NOT NULL
                  AND d.decided_at IS NOT NULL
                  AND NULLIF(btrim(d.decision_reason), '') IS NOT NULL
               THEN d.included
             ELSE public.operation_window_included_automatically(c.status)
           END
      FROM classified c
     WHERE d.id = c.id
       AND (
         d.window_status IS DISTINCT FROM c.status
         OR d.included IS DISTINCT FROM (CASE
              WHEN d.decided_by IS NOT NULL
                   AND d.decided_at IS NOT NULL
                   AND NULLIF(btrim(d.decision_reason), '') IS NOT NULL
                THEN d.included
              ELSE public.operation_window_included_automatically(c.status)
            END)
       );
    GET DIAGNOSTICS v_deduction_updates = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM public.operation_window_reclassification_context
     WHERE backend_pid = pg_backend_pid()
       AND transaction_id = txid_current()
       AND shift_id = p_shift_id;
    RAISE;
  END;

  DELETE FROM public.operation_window_reclassification_context
   WHERE backend_pid = pg_backend_pid()
     AND transaction_id = txid_current()
     AND shift_id = p_shift_id;

  RETURN QUERY SELECT v_order_updates, v_deduction_updates;
END
$$;

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
           AND NULLIF(btrim(OLD.decision_reason), '') IS NOT NULL
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
       AND (NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = '')
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
           AND NULLIF(btrim(OLD.decision_reason), '') IS NOT NULL
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
     OR btrim(NEW.decision_reason) = ''
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

COMMENT ON FUNCTION operation_window_included_automatically(operation_window_status) IS
  'Automatic operation inclusion requires a verified minute; unknown requires an audited manager decision.';
