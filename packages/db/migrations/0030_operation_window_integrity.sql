-- 0030 - make operation-window decisions impossible to change accidentally
--
-- 0028 allowed any UPDATE made while decided_by was NULL to change the printed time or inclusion
-- without a reason.  That was needed for the close classifier, but it also left the same hole open
-- to every ordinary SQL client.  This migration replaces that broad exception with one protected,
-- deterministic database operation.  The application role can ask for reclassification, but it
-- cannot choose the result and cannot manufacture the short-lived context used by the triggers.

-- The shared audit trigger predates this migration and is SECURITY DEFINER.  Pin its lookup order
-- before adding more audited tables so an application session cannot redirect durable audit rows
-- to a same-named temporary relation.  0029 similarly replaces the only other older definer.
ALTER FUNCTION public.audit_row_change()
  SET search_path = pg_catalog, public, pg_temp;

-- One row exists only while the SECURITY DEFINER classifier is executing.  It is keyed by backend
-- and transaction so a marker can neither leak through a pooled connection nor authorize a second
-- transaction.  Normal application SQL has no privileges on this table.
CREATE TABLE operation_window_reclassification_context (
  backend_pid   integer PRIMARY KEY,
  transaction_id bigint NOT NULL,
  shift_id      uuid NOT NULL
);

REVOKE ALL ON operation_window_reclassification_context FROM PUBLIC;
REVOKE ALL ON operation_window_reclassification_context FROM app_user;

COMMENT ON TABLE operation_window_reclassification_context IS
  'Internal, transient capability used only by reclassify_shift_operations; always empty outside that function.';

CREATE FUNCTION operation_window_local_minute(p_instant timestamptz, p_timezone text)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF p_instant IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN to_char(p_instant AT TIME ZONE p_timezone, 'YYYY-MM-DD HH24:MI');
  EXCEPTION WHEN invalid_parameter_value THEN
    -- Legacy branch data predating timezone validation must remain classifiable.  Damascus is the
    -- platform default and matches the API clock fallback used for those rows.
    RETURN to_char(p_instant AT TIME ZONE 'Asia/Damascus', 'YYYY-MM-DD HH24:MI');
  END;
END
$$;

CREATE FUNCTION classify_operation_window(
  p_occurred_date date,
  p_occurred_minute text,
  p_open_approved_at timestamptz,
  p_submitted_at timestamptz,
  p_timezone text
)
RETURNS operation_window_status
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_operation text;
  v_opened    text;
  v_submitted text;
BEGIN
  IF p_occurred_date IS NULL
     OR p_occurred_minute IS NULL
     OR p_occurred_minute !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  THEN
    RETURN 'unknown';
  END IF;

  v_operation := to_char(p_occurred_date, 'YYYY-MM-DD') || ' ' || p_occurred_minute;
  v_opened := operation_window_local_minute(p_open_approved_at, p_timezone);
  IF v_opened IS NULL THEN
    RETURN 'unknown';
  END IF;
  IF v_operation < v_opened THEN
    RETURN 'pre_open';
  END IF;
  IF v_operation = v_opened THEN
    RETURN 'open_minute_boundary';
  END IF;

  v_submitted := operation_window_local_minute(p_submitted_at, p_timezone);
  IF v_submitted IS NOT NULL THEN
    IF v_operation > v_submitted THEN
      RETURN 'post_close';
    END IF;
    IF v_operation = v_submitted THEN
      RETURN 'close_minute_boundary';
    END IF;
  END IF;
  RETURN 'in_window';
END
$$;

-- The only reasonless UPDATE path.  Both window edges and the branch timezone are read from the
-- locked database row; callers supply only the shift identity and therefore cannot forge an
-- inclusion result.  Unknown timestamps stay unknown/included and continue to block approval.
CREATE FUNCTION reclassify_shift_operations(p_shift_id uuid)
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
             WHEN o.decided_by IS NOT NULL THEN o.included
             ELSE c.status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown')
           END
      FROM classified c
     WHERE o.id = c.id
       AND (
         o.window_status IS DISTINCT FROM c.status
         OR (
           o.decided_by IS NULL
           AND o.included IS DISTINCT FROM
             (c.status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown'))
         )
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
             WHEN d.decided_by IS NOT NULL THEN d.included
             ELSE c.status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown')
           END
      FROM classified c
     WHERE d.id = c.id
       AND (
         d.window_status IS DISTINCT FROM c.status
         OR (
           d.decided_by IS NULL
           AND d.included IS DISTINCT FROM
             (c.status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown'))
         )
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

REVOKE ALL ON FUNCTION reclassify_shift_operations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reclassify_shift_operations(uuid) TO app_user;

-- A direct manager correction is accepted only when this very UPDATE supplies a fresh decision,
-- the decision is attributed to the transaction actor, and that actor is an active manager for
-- the shift's branch.  Reusing metadata from an earlier decision is not a new reasoned decision.
CREATE OR REPLACE FUNCTION guard_shift_order_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor            uuid;
  v_automatic        boolean;
  v_expected         public.operation_window_status;
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
  -- Manager fee/wallet corrections use the decision timestamp as an optimistic version even when
  -- they do not decide the operation window. Preserve that established API path (where a reason is
  -- optional), while still requiring an attributed active manager below.
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

    IF NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.window_status IS DISTINCT FROM v_expected
       OR NEW.included IS DISTINCT FROM (CASE
            WHEN OLD.decided_by IS NOT NULL THEN OLD.included
            ELSE (v_expected IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown'))
          END)
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
       -- A metadata-only write can otherwise manufacture the exact marker used to resolve an
       -- unknown operation without changing inclusion/time. Only genuine value corrections retain
       -- the pre-0030 optional-reason behaviour.
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

DROP TRIGGER shift_orders_window_decision_reason_guard ON shift_orders;
CREATE TRIGGER shift_orders_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, window_status,
                   decision_reason, decided_by, decided_at ON shift_orders
  FOR EACH ROW EXECUTE FUNCTION guard_shift_order_window_decision_reason();

CREATE OR REPLACE FUNCTION guard_cash_deduction_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor            uuid;
  v_automatic        boolean;
  v_expected         public.operation_window_status;
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

    IF NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.window_status IS DISTINCT FROM v_expected
       OR NEW.included IS DISTINCT FROM (CASE
            WHEN OLD.decided_by IS NOT NULL THEN OLD.included
            ELSE (v_expected IN ('in_window', 'open_minute_boundary', 'close_minute_boundary', 'unknown'))
          END)
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

DROP TRIGGER cash_deductions_window_decision_reason_guard ON cash_deductions;
CREATE TRIGGER cash_deductions_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, window_status,
                   decision_reason, decided_by, decided_at ON cash_deductions
  FOR EACH ROW EXECUTE FUNCTION guard_cash_deduction_window_decision_reason();
