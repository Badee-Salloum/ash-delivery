-- 0054 - the operation window opens when the DRIVER CONFIRMS, not when the manager approves
--
-- Owner decision, 2026-08-31, amending decision 11's lower bound. The upper bound (driver close
-- submission) is unchanged.
--
-- WHY. Measured on production: 29 order rows worth 6,795.00 were excluded as `pre_open` — the clock
-- was read correctly, the delivery simply happened before the manager pressed approve. The gap
-- between the driver confirming his start package and the manager approving it reached 426 minutes.
-- Six of Nazeer's rows on 2026-08-28 were re-included by hand with the reason «توصيل بين تأكيد
-- السائق 12:46 واعتماد المدير …». The manager overrides this rule every shift, and a rule a human
-- always overrides is the wrong rule.
--
-- WHY A STORED COLUMN AND NOT AN INLINE COALESCE. The lower bound is read in four independent
-- places: the TypeScript classifier, this SQL mirror of the same rule, and two separate comparisons
-- inside the close-draft service. An inline `COALESCE(driver_confirmed_at, open_approved_at)` would
-- also re-judge a SETTLED shift the moment anything reclassified it. One stored instant lets an
-- approved shift keep the exact bound it was judged by while everything still in flight moves.
--
-- WHAT IS DELIBERATELY NOT TOUCHED. `classify_operation_window` itself — its six-value truth table,
-- its `unknown` short-circuits, its boundary strictness — is not edited here at all. Only the
-- COLUMN its callers read changes. Its third parameter therefore keeps the now-inexact name
-- `p_open_approved_at`: PostgreSQL cannot rename an input parameter through CREATE OR REPLACE, and
-- a DROP/CREATE of a function four triggers depend on is a far worse risk than one stale parameter
-- name. The four callers below were extracted VERBATIM from 0043 and re-emitted with exactly five
-- tokens substituted; nothing else in their 427 lines differs.

ALTER TABLE shifts ADD COLUMN window_opens_at timestamptz;

COMMENT ON COLUMN shifts.window_opens_at IS
  'Lower bound of the operation window: driver confirmation for shifts opened after 2026-08-31, and the manager open-approval instant for everything settled before it.';

-- The two DEFERRED constraint triggers on `shifts` re-validate a shift's close journals and its
-- receivable projection on ANY update, including one that only writes a derived column. Left on,
-- they queue an event per row, which (a) makes the ALTER below fail with 55006 `pending trigger
-- events` and (b) re-runs a business validation over history this migration does not touch — one
-- production shift already fails it, and a derivation must not be the thing that surfaces that.
--
-- Same precedent as 0037's backfill: suspend only the guard that has nothing to say about this
-- change, and restore it inside the same transaction, so any failure rolls the whole thing back.
-- `audit_shifts` deliberately stays ON: this writes a real column and the change is auditable.
ALTER TABLE shifts DISABLE TRIGGER shift_close_journals_from_shift;
ALTER TABLE shifts DISABLE TRIGGER shift_receivable_projection_from_shift;

-- Finished shifts keep the instant they were actually judged by, to the millisecond.
--
-- `week_locked` sits beside `approved` because BR7 makes those entries immutable, so their
-- classification must be too. `cancelled` sits there for the same reason: it is a closed outcome,
-- not work in progress, and re-judging its rows would restate a shift nobody can act on. The
-- enum in 0005 did not have `cancelled` — a later migration added it — and a first draft of this
-- file left it out and moved all 33 of production's cancelled shifts. The rehearsal caught it.
UPDATE shifts
   SET window_opens_at = open_approved_at
 WHERE state IN ('approved', 'week_locked', 'cancelled');

-- Everything still in flight gets the corrected rule now. Nobody has been paid out on these, so no
-- settlement can be contradicted — and a shift open at deploy time is exactly the one that should
-- stop losing its first hour.
--
-- COALESCE is a safety net, not decoration. `driver_confirmed_at` is stamped on every path that
-- reaches an open shift, but a legacy row must degrade to today's behaviour and never to NULL,
-- which `classify_operation_window` reads as `unknown` — excluding a whole shift's orders rather
-- than one row.
UPDATE shifts
   SET window_opens_at = COALESCE(driver_confirmed_at, open_approved_at)
 WHERE state NOT IN ('approved', 'week_locked', 'cancelled');

ALTER TABLE shifts ENABLE TRIGGER shift_close_journals_from_shift;
ALTER TABLE shifts ENABLE TRIGGER shift_receivable_projection_from_shift;

-- A shift that has been approved-open must carry a bound, or every one of its rows classifies as
-- `unknown` and the shift cannot be approved at all.
ALTER TABLE shifts
  ADD CONSTRAINT shifts_window_opens_at_ck CHECK (
    open_approved_at IS NULL OR window_opens_at IS NOT NULL
  );

-- ── The four callers, extracted verbatim from 0043 with `s.open_approved_at` → `s.window_opens_at`
--    and nothing else changed. The triggers already bind these by name, so replacing the function
--    bodies is sufficient and no trigger is recreated.

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
             s.window_opens_at,
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
             s.window_opens_at,
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
        o.occurred_date, o.occurred_minute, s.window_opens_at, s.submitted_at, b.timezone
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
        d.occurred_date, d.occurred_minute, s.window_opens_at, s.submitted_at, b.timezone
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
               s.window_opens_at,
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
