-- 0028: canonical shift windows, operation decisions, cash deductions and evidence freshness

-- Added in its own committed migration before the application can emit it. Nothing later in this
-- file uses the enum value inside this transaction (PostgreSQL forbids that until commit).
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'driver_cash_deduction';

-- ── The two canonical shift-window instants ────────────────────────────────────────────────

ALTER TABLE shifts
  ADD COLUMN odo_end_ocr integer,
  ADD COLUMN odo_end_anomaly_confirmed_at timestamptz,
  ADD COLUMN odo_end_anomaly_confirmed_by uuid REFERENCES users(id),
  ADD CONSTRAINT shifts_odo_end_anomaly_confirmation_ck
    CHECK (
      (odo_end_anomaly_confirmed_at IS NULL AND odo_end_anomaly_confirmed_by IS NULL)
      OR
      (odo_end_anomaly_confirmed_at IS NOT NULL AND odo_end_anomaly_confirmed_by IS NOT NULL)
    ),
  ADD CONSTRAINT shifts_odo_end_anomaly_requires_confirmation_ck
    CHECK (
      odo_end IS NULL OR odo_start IS NULL OR odo_end >= odo_start
      OR (odo_end_anomaly_confirmed_at IS NOT NULL AND odo_end_anomaly_confirmed_by IS NOT NULL)
    );

COMMENT ON COLUMN shifts.odo_end_ocr IS
  'Pre-correction OCR end odometer. NULL when the close reader did not run.';
COMMENT ON COLUMN shifts.odo_end_anomaly_confirmed_at IS
  'Instant at which an end odometer below the opening reading was explicitly accepted.';
COMMENT ON COLUMN shifts.odo_end_anomaly_confirmed_by IS
  'Driver or manager who explicitly accepted the anomalous end odometer.';

-- A replacement/rolled-over odometer can legitimately finish below the opening reading. Keep
-- each reading non-negative, but do not encode continuity between two different instruments.
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_odo_ck;
ALTER TABLE shifts
  ADD CONSTRAINT shifts_odo_nonnegative_ck
    CHECK (
      (odo_start IS NULL OR odo_start >= 0)
      AND (odo_end IS NULL OR odo_end >= 0)
      AND (odo_end_ocr IS NULL OR odo_end_ocr >= 0)
    )
    NOT VALID;

COMMENT ON COLUMN shifts.open_approved_at IS
  'Canonical first manager-approved open instant. Never replaced by resume or a rejected close.';
COMMENT ON COLUMN shifts.open_approved_by IS
  'Manager who approved the first open; distinct from approved_by at the close gate.';
COMMENT ON COLUMN shifts.submitted_at IS
  'Most recent driver close-package submission instant; the upper shift-window boundary.';

-- Older application code never mapped the three open columns. Reconstruct only the unambiguous
-- awaiting_open_approval -> open audit transition. Its DB time is closest to the state change;
-- the append-only decision supplies the actor when the old shift repo left the audit actor blank,
-- and is also the timestamp fallback on installations whose early audit history is incomplete.
WITH open_candidates AS (
  SELECT
    s.id,
    COALESCE(a.occurred_at, d.decided_at) AS opened_at,
    COALESCE(a.actor_id, d.decided_by) AS opened_by
  FROM shifts s
  LEFT JOIN LATERAL (
    SELECT al.occurred_at, al.actor_id
      FROM audit_log al
     WHERE al.table_name = 'shifts'
       AND al.record_id = s.id::text
       AND al.action = 'UPDATE'
       AND al.before ->> 'state' = 'awaiting_open_approval'
       AND al.after  ->> 'state' = 'open'
     ORDER BY al.occurred_at, al.id
     LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT sd.decided_at, sd.decided_by
      FROM shift_decisions sd
     WHERE sd.shift_id = s.id
       AND sd.gate = 'open'
       AND sd.decision = 'approved'
     ORDER BY sd.decided_at, sd.id
     LIMIT 1
  ) d ON true
  WHERE s.open_approved_at IS NULL OR s.open_approved_by IS NULL
)
UPDATE shifts s
   SET open_approved_at = COALESCE(s.open_approved_at, c.opened_at),
       open_approved_by = COALESCE(s.open_approved_by, c.opened_by)
  FROM open_candidates c
 WHERE s.id = c.id
   AND (c.opened_at IS NOT NULL OR c.opened_by IS NOT NULL);

-- `submitted_at` was equally present in the original schema but absent from the old adapter.
-- A re-photo/rejection can produce several close submissions; the most recent exact transition
-- into pending review is the active upper boundary. Missing/unclear audit history stays NULL.
WITH close_candidates AS (
  SELECT
    s.id,
    (
      SELECT al.occurred_at
        FROM audit_log al
       WHERE al.table_name = 'shifts'
         AND al.record_id = s.id::text
         AND al.action = 'UPDATE'
         AND al.before ->> 'state' IN ('open', 'suspended')
         AND al.after  ->> 'state' = 'pending_review'
       ORDER BY al.occurred_at DESC, al.id DESC
       LIMIT 1
    ) AS submitted_at
  FROM shifts s
  WHERE s.submitted_at IS NULL
    -- A rejected/re-photoed close returns to open and clears the active upper boundary. Its old
    -- transition remains in audit history but must not be resurrected by this backfill.
    AND s.state IN ('pending_review', 'approved', 'week_locked', 'cancelled')
)
UPDATE shifts s
   SET submitted_at = c.submitted_at
  FROM close_candidates c
 WHERE s.id = c.id
   AND c.submitted_at IS NOT NULL;

-- The initial open is historical identity, not mutable shift state. Filling a previously missing
-- half is allowed for repair; replacing a value that already exists is not.
CREATE FUNCTION guard_shift_open_approval_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.open_approved_at IS NOT NULL
     AND NEW.open_approved_at IS DISTINCT FROM OLD.open_approved_at THEN
    RAISE EXCEPTION 'shift open_approved_at is immutable'
      USING ERRCODE = '25006';
  END IF;
  IF OLD.open_approved_by IS NOT NULL
     AND NEW.open_approved_by IS DISTINCT FROM OLD.open_approved_by THEN
    RAISE EXCEPTION 'shift open_approved_by is immutable'
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shifts_open_approval_immutable
  BEFORE UPDATE OF open_approved_at, open_approved_by ON shifts
  FOR EACH ROW EXECUTE FUNCTION guard_shift_open_approval_immutable();

-- DB-first rollout compatibility. The previously deployed ShiftRepo did not map any of these
-- columns, so a manager transition occurring between migration and API deployment would otherwise
-- miss the canonical boundary forever. Preserve explicit values from the new API; fill only what
-- the legacy transition omitted. Reopening a rejected close clears the obsolete upper boundary.
CREATE FUNCTION maintain_shift_window_on_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'awaiting_open_approval' AND NEW.state = 'open'
     AND NEW.open_approved_at IS NULL THEN
    NEW.open_approved_at := clock_timestamp();
  END IF;

  IF OLD.state IN ('open', 'suspended')
     AND NEW.state IN ('pending_review', 'approved')
     AND NEW.submitted_at IS NULL THEN
    NEW.submitted_at := clock_timestamp();
  ELSIF OLD.state = 'pending_review' AND NEW.state IN ('open', 'suspended') THEN
    NEW.submitted_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shifts_window_transition_compat
  BEFORE UPDATE OF state, open_approved_at, submitted_at ON shifts
  FOR EACH ROW EXECUTE FUNCTION maintain_shift_window_on_transition();

-- The old service wrote the approving decision immediately after the state transition. Use that
-- append-only fact to fill the manager id that its ShiftRepo could not persist. New API writes are
-- already complete and make this UPDATE a no-op.
CREATE FUNCTION fill_shift_open_approver_from_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gate = 'open' AND NEW.decision = 'approved' THEN
    UPDATE shifts
       SET open_approved_at = COALESCE(open_approved_at, NEW.decided_at),
           open_approved_by = COALESCE(open_approved_by, NEW.decided_by)
     WHERE id = NEW.shift_id
       AND (open_approved_at IS NULL OR open_approved_by IS NULL);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_decisions_fill_open_approver
  AFTER INSERT ON shift_decisions
  FOR EACH ROW EXECUTE FUNCTION fill_shift_open_approver_from_decision();

-- ── One shared, explicit operation-window vocabulary ──────────────────────────────────────

CREATE TYPE operation_window_status AS ENUM (
  'in_window',
  'pre_open',
  'post_close',
  'open_minute_boundary',
  'close_minute_boundary',
  'unknown'
);

ALTER TABLE shift_orders
  ADD COLUMN window_status operation_window_status NOT NULL DEFAULT 'unknown',
  ADD COLUMN decision_reason text,
  ADD COLUMN decided_by uuid REFERENCES users(id),
  ADD COLUMN decided_at timestamptz,
  ADD CONSTRAINT shift_orders_decision_ck CHECK (
    (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR
    (decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND (decision_reason IS NULL OR btrim(decision_reason) <> ''))
  );

COMMENT ON COLUMN shift_orders.window_status IS
  'Printed local date/minute relative to the approved-open and close-submission window; boundary minutes remain explicit.';
COMMENT ON COLUMN shift_orders.decision_reason IS
  'Manager explanation when correcting whether the row belongs to this shift.';

-- A value-only correction still advances decided_at so a stale driver sync cannot overwrite it,
-- but the requested policy requires a written reason specifically when inclusion or printed time
-- is changed. Automatic close-boundary reclassification keeps decided_by NULL and is therefore
-- allowed to move an undecided row without inventing a manager explanation.
CREATE FUNCTION guard_shift_order_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by IS NOT NULL
     AND (
       NEW.included IS DISTINCT FROM OLD.included
       OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
     )
     AND (NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = '') THEN
    RAISE EXCEPTION 'manager operation-window changes require a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_orders_window_decision_reason_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_orders_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, decision_reason, decided_by ON shift_orders
  FOR EACH ROW EXECUTE FUNCTION guard_shift_order_window_decision_reason();

-- The old expression accepted 24:00 through 29:59. The replacement is NOT VALID so impossible
-- historical OCR values remain visible evidence instead of being destroyed during deployment;
-- every new or subsequently updated row is checked against a real 24-hour clock.
ALTER TABLE shift_orders DROP CONSTRAINT IF EXISTS shift_orders_minute_ck;
ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_minute_ck
    CHECK (occurred_minute IS NULL OR occurred_minute ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    NOT VALID;

ALTER TABLE shift_wallet_movements
  DROP CONSTRAINT IF EXISTS shift_wallet_movements_occurred_minute_check;
ALTER TABLE shift_wallet_movements
  ADD CONSTRAINT shift_wallet_movements_minute_ck
    CHECK (occurred_minute = '' OR occurred_minute ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    NOT VALID;

-- `order_id`'s original FK proves only that an order exists. A wallet row belongs to one shift and
-- must never point across that boundary, even through a direct repository call outside a batch.
CREATE FUNCTION guard_wallet_movement_order_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    PERFORM 1
      FROM shift_orders o
     WHERE o.id = NEW.order_id AND o.shift_id = NEW.shift_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wallet movement order % does not belong to shift %', NEW.order_id, NEW.shift_id
        USING ERRCODE = '23514', CONSTRAINT = 'shift_wallet_movements_order_shift_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_wallet_movements_order_shift_guard
  BEFORE INSERT OR UPDATE OF shift_id, order_id ON shift_wallet_movements
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_movement_order_shift();

-- The reverse direction matters too: changing an order's parent after a movement was linked would
-- otherwise manufacture the same cross-shift reference without touching the guarded movement row.
-- An order is historical shift evidence and has no legitimate re-parenting operation.
CREATE FUNCTION guard_shift_order_parent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id THEN
    RAISE EXCEPTION 'shift order % cannot move from shift % to %', NEW.id, OLD.shift_id, NEW.shift_id
      USING ERRCODE = '23514', CONSTRAINT = 'shift_orders_parent_immutable_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_orders_parent_immutable_guard
  BEFORE UPDATE OF shift_id ON shift_orders
  FOR EACH ROW EXECUTE FUNCTION guard_shift_order_parent_immutable();

-- ── Positive cash deductions from the provider operation history ─────────────────────────

CREATE TABLE cash_deductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id          uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  operation_key     text NOT NULL CHECK (btrim(operation_key) <> ''),

  -- Positive magnitude only. Direction is expressed by the record/table itself, never a sign
  -- that a later BR1/ledger adapter can accidentally negate twice.
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  occurred_date     date,
  occurred_minute   text CHECK (
    occurred_minute IS NULL OR occurred_minute ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  source            text NOT NULL CHECK (source IN ('ocr', 'manual')),
  -- Evidence baseline, not authoritative money: preserve even a zero/signed OCR mistake so the
  -- correction delta remains explainable. Only `amount_minor` is the positive deduction magnitude.
  amount_ocr_minor  bigint,
  point_a           text,
  point_b           text,

  included          boolean NOT NULL DEFAULT true,
  window_status     operation_window_status NOT NULL DEFAULT 'unknown',
  decision_reason   text,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,

  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cash_deductions_operation_uq UNIQUE (shift_id, operation_key),
  CONSTRAINT cash_deductions_decision_ck CHECK (
    (decision_reason IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR
    (decision_reason IS NOT NULL AND btrim(decision_reason) <> ''
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX cash_deductions_shift_occurrence_idx
  ON cash_deductions (shift_id, occurred_date, occurred_minute, operation_key);

COMMENT ON TABLE cash_deductions IS
  'Positive cash deductions read from provider operations; retained even when excluded from the shift window.';
COMMENT ON COLUMN cash_deductions.amount_ocr_minor IS
  'Pre-correction OCR magnitude. NULL for a manual/refused read.';

CREATE TRIGGER audit_cash_deductions
  AFTER INSERT OR UPDATE OR DELETE ON cash_deductions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE FUNCTION guard_cash_deduction_window_decision_reason() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by IS NOT NULL
     AND (
       NEW.included IS DISTINCT FROM OLD.included
       OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
       OR NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute
     )
     AND (NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = '') THEN
    RAISE EXCEPTION 'manager cash-deduction window changes require a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'cash_deductions_window_decision_reason_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cash_deductions_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, decision_reason, decided_by ON cash_deductions
  FOR EACH ROW EXECUTE FUNCTION guard_cash_deduction_window_decision_reason();

-- ── Attachment freshness and intentional reuse ───────────────────────────────────────────

ALTER TABLE shift_media
  -- Historical provenance deliberately has no FK: deleting a never-opened source shift must not
  -- turn later reuse of its bytes back into apparently fresh evidence.
  ADD COLUMN reused_from_shift_id uuid,
  ADD COLUMN attachment_token uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN stale_acknowledged_at timestamptz,
  ADD COLUMN stale_acknowledged_by uuid REFERENCES users(id),
  ADD CONSTRAINT shift_media_stale_ack_ck
    CHECK ((stale_acknowledged_at IS NULL) = (stale_acknowledged_by IS NULL));

COMMENT ON COLUMN shift_media.created_at IS
  'Authoritative server attachment time; refreshed whenever the slot is replaced.';
COMMENT ON COLUMN shift_media.reused_from_shift_id IS
  'Historical shift id containing an earlier attachment; may equal shift_id for another slot and survives source deletion.';
COMMENT ON COLUMN shift_media.attachment_token IS
  'Opaque generation changed on every real slot replacement and preserved by exact attachment retries.';
COMMENT ON COLUMN shift_media.stale_acknowledged_at IS
  'Authorized uploader acknowledgment time for evidence warned as reused or stale.';

-- Mark historical cross-shift or cross-slot reuse without guessing from the phone clock. The
-- immediately prior attachment of the same immutable media bytes is the provenance link.
UPDATE shift_media current_attachment
   SET reused_from_shift_id = (
     SELECT prior.shift_id
       FROM shift_media prior
      WHERE prior.media_id = current_attachment.media_id
        AND prior.id <> current_attachment.id
        AND (prior.created_at, prior.id) < (current_attachment.created_at, current_attachment.id)
      ORDER BY prior.created_at DESC, prior.id DESC
      LIMIT 1
   )
 WHERE EXISTS (
   SELECT 1
     FROM shift_media prior
    WHERE prior.media_id = current_attachment.media_id
      AND prior.id <> current_attachment.id
      AND (prior.created_at, prior.id) < (current_attachment.created_at, current_attachment.id)
 );

-- `shift_media` is the current slot projection. This append-only table is the durable fact that
-- makes reuse detectable after a slot is replaced/detached or a never-opened shift is deleted.
-- Historical identifiers intentionally carry no FKs: provenance must outlive its source rows.
CREATE TABLE shift_media_attachment_history (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id             uuid NOT NULL,
  media_id             uuid NOT NULL,
  package              text NOT NULL CHECK (package IN ('start', 'end')),
  slot                 text NOT NULL,
  attached_at          timestamptz NOT NULL,
  reused_from_shift_id uuid,
  attachment_token     uuid NOT NULL
);

CREATE INDEX shift_media_attachment_history_media_idx
  ON shift_media_attachment_history (media_id, id DESC);

COMMENT ON TABLE shift_media_attachment_history IS
  'Append-only attachment provenance; current slot state remains in shift_media.';

INSERT INTO shift_media_attachment_history
  (shift_id, media_id, package, slot, attached_at, reused_from_shift_id, attachment_token)
SELECT shift_id, media_id, package, slot, created_at, reused_from_shift_id, attachment_token
  FROM shift_media
 ORDER BY created_at, id;

-- Keep the database safe during the required DB -> API -> PWA rollout as well as afterwards.
-- The previous API used a bare shift_media upsert, so repository checks alone would leave a window
-- in which it could replace review evidence and fail to rotate the attachment generation. This
-- trigger supplies the same state/branch/provenance invariants to both old and new application code.
CREATE FUNCTION guard_and_prepare_shift_media_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_shift_id uuid;
  target_package text;
  current_shift_state shift_state;
  shift_branch_id uuid;
  media_branch_id uuid;
  prior_shift_id uuid;
BEGIN
  target_shift_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.shift_id ELSE NEW.shift_id END;
  target_package := CASE WHEN TG_OP = 'DELETE' THEN OLD.package ELSE NEW.package END;

  SELECT s.state, s.branch_id
    INTO current_shift_state, shift_branch_id
    FROM shifts s
   WHERE s.id = target_shift_id
   FOR UPDATE;

  -- A parent shift deletion reaches this trigger through the FK cascade after the parent row has
  -- ceased to be visible to the command. A child cannot otherwise exist without its parent.
  IF TG_OP = 'DELETE' AND current_shift_state IS NULL THEN
    RETURN OLD;
  END IF;

  IF current_shift_state IS NULL
     OR (target_package = 'start' AND current_shift_state <> 'draft')
     OR (target_package = 'end' AND current_shift_state NOT IN ('open', 'suspended')) THEN
    RAISE EXCEPTION 'evidence package % is not editable in shift state %',
      target_package, COALESCE(current_shift_state::text, 'missing')
      USING ERRCODE = '23514', CONSTRAINT = 'shift_media_package_editable_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.shift_id IS DISTINCT FROM OLD.shift_id
       OR NEW.package IS DISTINCT FROM OLD.package
       OR NEW.slot IS DISTINCT FROM OLD.slot
     ) THEN
    RAISE EXCEPTION 'an evidence attachment identity is immutable; replace its media instead'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_media_identity_immutable_guard';
  END IF;

  SELECT m.branch_id
    INTO media_branch_id
    FROM media m
   WHERE m.id = NEW.media_id
   FOR UPDATE;
  IF media_branch_id IS NULL OR media_branch_id IS DISTINCT FROM shift_branch_id THEN
    RAISE EXCEPTION 'media % does not belong to shift % branch', NEW.media_id, NEW.shift_id
      USING ERRCODE = '23514', CONSTRAINT = 'shift_media_branch_guard';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT h.shift_id
      INTO prior_shift_id
      FROM shift_media_attachment_history h
     WHERE h.media_id = NEW.media_id
     ORDER BY h.id DESC
     LIMIT 1;
    NEW.reused_from_shift_id := prior_shift_id;
  ELSIF NEW.media_id IS DISTINCT FROM OLD.media_id THEN
    SELECT h.shift_id
      INTO prior_shift_id
      FROM shift_media_attachment_history h
     WHERE h.media_id = NEW.media_id
     ORDER BY h.id DESC
     LIMIT 1;
    NEW.reused_from_shift_id := prior_shift_id;
    -- Fill fields omitted by the old API, while preserving explicit values from the new repo.
    IF NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN NEW.created_at := now(); END IF;
    IF NEW.attachment_token IS NOT DISTINCT FROM OLD.attachment_token THEN
      NEW.attachment_token := gen_random_uuid();
    END IF;
    NEW.stale_acknowledged_at := NULL;
    NEW.stale_acknowledged_by := NULL;
  ELSIF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.attachment_token IS DISTINCT FROM OLD.attachment_token
     OR NEW.reused_from_shift_id IS DISTINCT FROM OLD.reused_from_shift_id THEN
    RAISE EXCEPTION 'attachment provenance cannot change without replacing the media'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_media_provenance_immutable_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER shift_media_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON shift_media
  FOR EACH ROW EXECUTE FUNCTION guard_and_prepare_shift_media_write();

-- History is a database invariant, not an application convention. A legacy upsert and a direct
-- repository write now leave the same durable provenance as the new aggregate adapter.
CREATE FUNCTION append_shift_media_attachment_history() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.shift_media_attachment_history
      (shift_id, media_id, package, slot, attached_at, reused_from_shift_id, attachment_token)
    VALUES
      (NEW.shift_id, NEW.media_id, NEW.package, NEW.slot, NEW.created_at,
       NEW.reused_from_shift_id, NEW.attachment_token);
  ELSIF NEW.media_id IS DISTINCT FROM OLD.media_id THEN
    INSERT INTO public.shift_media_attachment_history
      (shift_id, media_id, package, slot, attached_at, reused_from_shift_id, attachment_token)
    VALUES
      (NEW.shift_id, NEW.media_id, NEW.package, NEW.slot, NEW.created_at,
       NEW.reused_from_shift_id, NEW.attachment_token);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_media_attachment_history_append
  AFTER INSERT OR UPDATE OF media_id ON shift_media
  FOR EACH ROW EXECUTE FUNCTION append_shift_media_attachment_history();

CREATE FUNCTION reject_shift_media_attachment_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shift_media_attachment_history is append-only'
    USING ERRCODE = '25006';
  RETURN NULL;
END
$$;

CREATE TRIGGER shift_media_attachment_history_append_only
  BEFORE UPDATE OR DELETE ON shift_media_attachment_history
  FOR EACH ROW EXECUTE FUNCTION reject_shift_media_attachment_history_mutation();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON shift_media_attachment_history FROM app_user;
GRANT SELECT ON shift_media_attachment_history TO app_user;

-- The link used to be audit-exempt because it held no decision. Reuse and stale-evidence
-- acknowledgment make its mutations authoritative and therefore auditable.
CREATE TRIGGER audit_shift_media
  AFTER INSERT OR UPDATE OR DELETE ON shift_media
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- â”€â”€ Battery readings must belong to the evidence currently under review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
--
-- The API prechecks these rules for useful messages. This trigger is the atomic authority: it locks
-- the shift, so an approval/submission or evidence replacement cannot cross between the state/media
-- checks and the reading write. Existing rows are untouched; the guard applies to future writes.
CREATE FUNCTION guard_shift_battery_reading_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_shift_state shift_state;
  current_vehicle_id uuid;
  current_slot_no smallint;
  current_media_id uuid;
  state_is_editable boolean;
BEGIN
  -- Swap-phase readings use the dedicated battery-swap workflow and have no shift_media package.
  -- Preserve that existing path; this guard protects the ordinary opening/closing BMS evidence.
  IF NEW.package NOT IN ('start', 'end') THEN
    RETURN NEW;
  END IF;

  SELECT s.state, s.vehicle_id
    INTO current_shift_state, current_vehicle_id
    FROM shifts s
   WHERE s.id = NEW.shift_id
   FOR UPDATE;

  IF NEW.source = 'manager' THEN
    state_is_editable :=
      (NEW.package = 'start' AND current_shift_state = 'awaiting_open_approval')
      OR (NEW.package = 'end' AND current_shift_state = 'pending_review');
  ELSE
    state_is_editable :=
      (NEW.package = 'start' AND current_shift_state = 'draft')
      OR (NEW.package = 'end' AND current_shift_state IN ('open', 'suspended'));
  END IF;

  IF current_shift_state IS NULL OR NOT state_is_editable THEN
    RAISE EXCEPTION 'battery reading package % is not editable in shift state % for source %',
      NEW.package, COALESCE(current_shift_state::text, 'missing'), NEW.source
      USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
  END IF;

  PERFORM 1
    FROM batteries b
   WHERE b.id = NEW.battery_id
     AND b.vehicle_id = current_vehicle_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'battery % is not fitted to shift % vehicle', NEW.battery_id, NEW.shift_id
      USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
  END IF;

  -- A driver declaration that the BMS app is unavailable intentionally carries no image and moves
  -- the obligation to the manager. Every other driver reading must name the exact current slot
  -- attachment; replacing the photo therefore invalidates an old reading automatically.
  IF NEW.source <> 'manager' AND NOT NEW.unavailable THEN
    SELECT b.slot_no
      INTO current_slot_no
      FROM batteries b
     WHERE b.id = NEW.battery_id
     FOR SHARE;

    SELECT sm.media_id
      INTO current_media_id
      FROM shift_media sm
     WHERE sm.shift_id = NEW.shift_id
       AND sm.package = NEW.package
       AND sm.slot = 'bms_' || current_slot_no::text;

    IF current_slot_no IS NULL THEN
      RAISE EXCEPTION 'battery % is not fitted to a numbered slot', NEW.battery_id
        USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
    END IF;

    -- Backward-compatible staging: older PWAs persist their OCR result just before uploading its
    -- photo. This also applies to a RETAKE while the old attachment is still current. A NULL link
    -- is deliberately safe/incomplete: BR5 rejects it, and the following bms_N attachment update
    -- binds it atomically. Current PWAs name an expected media id and never use this staging path.
    IF NEW.media_id IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.media_id IS DISTINCT FROM current_media_id THEN
      RAISE EXCEPTION 'battery reading media does not match current slot bms_%', current_slot_no
        USING ERRCODE = '23514', CONSTRAINT = 'shift_battery_readings_write_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER shift_battery_readings_write_guard
  BEFORE INSERT OR UPDATE ON shift_battery_readings
  FOR EACH ROW EXECUTE FUNCTION guard_shift_battery_reading_write();

-- Complete the old-PWA read-before-upload sequence. Only an unlinked, available driver reading is
-- eligible. A plain replacement does NOT move an already-linked row; a cached PWA retake explicitly
-- stages its new reading as NULL first, so only the following replacement can bind that generation.
CREATE FUNCTION link_pending_bms_reading_to_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parsed_slot_no smallint;
BEGIN
  IF NEW.package NOT IN ('start', 'end') OR NEW.slot !~ '^bms_[1-8]$' THEN
    RETURN NEW;
  END IF;

  parsed_slot_no := substring(NEW.slot FROM 5)::smallint;
  UPDATE shift_battery_readings r
     SET media_id = NEW.media_id
    FROM shifts s
    JOIN batteries b
      ON b.vehicle_id = s.vehicle_id
     AND b.slot_no = parsed_slot_no
   WHERE s.id = NEW.shift_id
     AND r.shift_id = NEW.shift_id
     AND r.battery_id = b.id
     AND r.package = NEW.package
     AND r.media_id IS NULL
     AND r.source <> 'manager'
     AND NOT r.unavailable;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_media_link_pending_bms_reading
  AFTER INSERT OR UPDATE OF media_id ON shift_media
  FOR EACH ROW EXECUTE FUNCTION link_pending_bms_reading_to_evidence();
