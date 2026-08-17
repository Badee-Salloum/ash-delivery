-- 0034 — revisioned, recoverable end-of-shift draft and evidence-bound OCR observations

CREATE FUNCTION guard_active_shift_media_duplicate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A common immutable-media lock serializes two concurrent attempts targeting different slots.
  PERFORM 1 FROM public.media WHERE id = NEW.media_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.shift_media sm
     WHERE sm.shift_id = NEW.shift_id AND sm.media_id = NEW.media_id
       AND (sm.package, sm.slot) <> (NEW.package, NEW.slot)
  ) THEN
    RAISE EXCEPTION 'the same evidence is already active in another slot'
      USING ERRCODE = '23505', CONSTRAINT = 'shift_media_active_media_once_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_media_active_duplicate_guard
  BEFORE INSERT OR UPDATE OF shift_id, media_id, package, slot ON shift_media
  FOR EACH ROW EXECUTE FUNCTION guard_active_shift_media_duplicate();

-- `shift_media.created_at` is a security boundary for close-window causality. 0028 accepted an
-- application-supplied timestamp so tests and historical imports could be deterministic, but a
-- close attachment must never be able to move its own causal ceiling into the future (or past).
-- Stamp every real generation in the database; an exact idempotent retry does not execute an
-- INSERT/UPDATE and therefore preserves the existing generation and timestamp.
CREATE FUNCTION stamp_shift_media_attachment_time() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.media_id IS DISTINCT FROM OLD.media_id THEN
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_media_attachment_server_time_guard
  BEFORE INSERT OR UPDATE OF media_id ON shift_media
  FOR EACH ROW EXECUTE FUNCTION stamp_shift_media_attachment_time();

CREATE TABLE shift_close_drafts (
  shift_id       uuid PRIMARY KEY REFERENCES shifts(id) ON DELETE CASCADE,
  revision       bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  draft_hash     text NOT NULL CHECK (draft_hash ~ '^[a-f0-9]{64}$'),
  payload        jsonb NOT NULL,
  updated_at     timestamptz NOT NULL,
  updated_by     uuid NOT NULL REFERENCES users(id),
  submitted_at   timestamptz,
  CONSTRAINT shift_close_drafts_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE shift_close_drafts IS
  'Optimistically-versioned recovery state for the driver close flow; accounting remains in canonical shift tables.';

-- A short-lived, transaction-bound capability for the one internal path that copies an exact
-- durable draft into canonical operations. Ordinary app_user UPDATEs still pass the manager
-- decision guards from 0033; only this SECURITY DEFINER preflight can create the marker.
CREATE TABLE close_draft_materialization_context (
  backend_pid    integer PRIMARY KEY,
  transaction_id bigint NOT NULL,
  shift_id       uuid NOT NULL,
  draft_revision bigint NOT NULL,
  draft_hash     text NOT NULL
);

REVOKE ALL ON close_draft_materialization_context FROM PUBLIC;
REVOKE ALL ON close_draft_materialization_context FROM app_user;

CREATE FUNCTION begin_close_draft_materialization(
  p_shift_id uuid,
  p_revision bigint,
  p_draft_hash text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.shifts s
    JOIN public.shift_close_drafts d ON d.shift_id = s.id
   WHERE s.id = p_shift_id
     AND s.state IN ('open', 'suspended')
     AND s.submitted_at IS NULL
     AND d.submitted_at IS NULL
     AND d.revision = p_revision
     AND d.draft_hash = p_draft_hash
   FOR UPDATE OF s, d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close draft changed before canonical materialization'
      USING ERRCODE = '40001', CONSTRAINT = 'close_draft_materialization_guard';
  END IF;
  INSERT INTO public.close_draft_materialization_context
    (backend_pid, transaction_id, shift_id, draft_revision, draft_hash)
  VALUES (pg_backend_pid(), txid_current(), p_shift_id, p_revision, p_draft_hash)
  ON CONFLICT (backend_pid) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id,
        shift_id = EXCLUDED.shift_id,
        draft_revision = EXCLUDED.draft_revision,
        draft_hash = EXCLUDED.draft_hash;
END
$$;

CREATE FUNCTION end_close_draft_materialization(p_shift_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.close_draft_materialization_context
   WHERE backend_pid = pg_backend_pid()
     AND transaction_id = txid_current()
     AND shift_id = p_shift_id;
END
$$;

REVOKE ALL ON FUNCTION begin_close_draft_materialization(uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION end_close_draft_materialization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION begin_close_draft_materialization(uuid, bigint, text) TO app_user;
GRANT EXECUTE ON FUNCTION end_close_draft_materialization(uuid) TO app_user;

CREATE FUNCTION close_draft_materialization_active(p_shift_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.close_draft_materialization_context c
     WHERE c.backend_pid = pg_backend_pid()
       AND c.transaction_id = txid_current()
       AND c.shift_id = p_shift_id
  )
$$;

REVOKE ALL ON FUNCTION close_draft_materialization_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_draft_materialization_active(uuid) TO app_user;

-- Keep the mature 0033 manager/reclassification guard for every ordinary write. The exact draft
-- capability above is the sole exception; 0034's provenance trigger still verifies immutable
-- observations and positional bounds for those rows.
DROP TRIGGER shift_orders_window_decision_reason_guard ON shift_orders;
CREATE TRIGGER shift_orders_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, window_status,
                   decision_reason, decided_by, decided_at ON shift_orders
  FOR EACH ROW
  WHEN (NOT public.close_draft_materialization_active(NEW.shift_id))
  EXECUTE FUNCTION guard_shift_order_window_decision_reason();

DROP TRIGGER cash_deductions_window_decision_reason_guard ON cash_deductions;
CREATE TRIGGER cash_deductions_window_decision_reason_guard
  BEFORE UPDATE OF included, occurred_date, occurred_minute, window_status,
                   decision_reason, decided_by, decided_at ON cash_deductions
  FOR EACH ROW
  WHEN (NOT public.close_draft_materialization_active(NEW.shift_id))
  EXECUTE FUNCTION guard_cash_deduction_window_decision_reason();

CREATE TABLE shift_close_draft_reads (
  id                uuid PRIMARY KEY,
  shift_id          uuid NOT NULL REFERENCES shift_close_drafts(shift_id) ON DELETE CASCADE,
  media_id          uuid NOT NULL REFERENCES media(id),
  attachment_token  uuid NOT NULL,
  package           text NOT NULL DEFAULT 'end' CHECK (package = 'end'),
  slot              text NOT NULL,
  field             text NOT NULL CHECK (field IN ('orders','payments_log','wallet','odometer','bms')),
  status            text NOT NULL CHECK (status IN ('idle','running','complete','failed')),
  failure           text CHECK (failure IN ('unavailable','timeout','no_fields','refused','wrong_screen')),
  attempts          smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result            jsonb,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  UNIQUE (id, shift_id, media_id, attachment_token, slot),
  CONSTRAINT shift_close_draft_reads_failure_ck CHECK (
    (status = 'failed' AND failure IS NOT NULL) OR (status <> 'failed' AND failure IS NULL)
  )
);

CREATE INDEX shift_close_draft_reads_shift_slot_idx
  ON shift_close_draft_reads (shift_id, package, slot, updated_at DESC);

CREATE TABLE shift_close_draft_observations (
  id                uuid PRIMARY KEY,
  read_id           uuid NOT NULL REFERENCES shift_close_draft_reads(id) ON DELETE CASCADE,
  shift_id          uuid NOT NULL REFERENCES shift_close_drafts(shift_id) ON DELETE CASCADE,
  media_id          uuid NOT NULL REFERENCES media(id),
  attachment_token  uuid NOT NULL,
  slot              text NOT NULL,
  row_index         integer NOT NULL CHECK (row_index >= 0),
  row_count         integer NOT NULL CHECK (row_count > 0 AND row_index < row_count),
  date_section      text,
  y_top             numeric CHECK (y_top IS NULL OR (y_top >= 0 AND y_top <= 1)),
  y_bottom          numeric CHECK (y_bottom IS NULL OR (y_bottom >= 0 AND y_bottom <= 1)),
  row_data          jsonb NOT NULL,
  created_at        timestamptz NOT NULL,
  UNIQUE (read_id, row_index),
  UNIQUE (id, shift_id),
  FOREIGN KEY (read_id, shift_id, media_id, attachment_token, slot)
    REFERENCES shift_close_draft_reads(id, shift_id, media_id, attachment_token, slot) ON DELETE CASCADE,
  CONSTRAINT shift_close_draft_observation_bounds_ck CHECK (
    y_top IS NULL OR y_bottom IS NULL OR y_top <= y_bottom
  )
);

CREATE INDEX shift_close_draft_observations_shift_media_idx
  ON shift_close_draft_observations (shift_id, media_id, attachment_token, row_index);

CREATE TABLE shift_media_restore_decisions (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id                   uuid NOT NULL,
  attachment_history_id      bigint NOT NULL,
  package                    text NOT NULL CHECK (package IN ('start','end')),
  slot                       text NOT NULL,
  media_id                   uuid NOT NULL,
  from_attachment_token      uuid,
  to_attachment_token        uuid NOT NULL,
  reason                     text NOT NULL CHECK (btrim(reason) <> ''),
  restored_by                uuid NOT NULL REFERENCES users(id),
  restored_at                timestamptz NOT NULL,
  UNIQUE (shift_id, to_attachment_token)
);

COMMENT ON TABLE shift_media_restore_decisions IS
  'Append-only, non-PII audit of an explicit historical attachment restore.';

CREATE FUNCTION reject_shift_media_restore_decision_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'shift_media_restore_decisions are append-only' USING ERRCODE = '25006';
  RETURN NULL;
END
$$;

CREATE TRIGGER shift_media_restore_decisions_append_only
  BEFORE UPDATE OR DELETE ON shift_media_restore_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_shift_media_restore_decision_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON shift_media_restore_decisions FROM app_user;
GRANT SELECT, INSERT ON shift_media_restore_decisions TO app_user;

ALTER TABLE shift_orders
  ADD COLUMN window_basis text CHECK (window_basis IN ('printed_time','screen_position','manager')),
  ADD COLUMN position_evidence jsonb,
  ADD COLUMN close_draft_observation_id uuid,
  ADD COLUMN close_draft_client_key text,
  ADD COLUMN close_draft_review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(close_draft_review_reasons) = 'array'),
  ADD FOREIGN KEY (close_draft_observation_id, shift_id)
    REFERENCES shift_close_draft_observations(id, shift_id);

ALTER TABLE cash_deductions
  ADD COLUMN window_basis text CHECK (window_basis IN ('printed_time','screen_position','manager')),
  ADD COLUMN position_evidence jsonb,
  ADD COLUMN close_draft_observation_id uuid,
  ADD COLUMN close_draft_client_key text,
  ADD COLUMN close_draft_review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(close_draft_review_reasons) = 'array'),
  ADD FOREIGN KEY (close_draft_observation_id, shift_id)
    REFERENCES shift_close_draft_observations(id, shift_id);

CREATE UNIQUE INDEX shift_orders_close_draft_client_key_uq
  ON shift_orders (shift_id, close_draft_client_key)
  WHERE close_draft_client_key IS NOT NULL;
CREATE UNIQUE INDEX cash_deductions_close_draft_client_key_uq
  ON cash_deductions (shift_id, close_draft_client_key)
  WHERE close_draft_client_key IS NOT NULL;

CREATE FUNCTION close_draft_screen_position_valid(
  p_shift_id uuid,
  p_observation_id uuid,
  p_position jsonb
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_read_id uuid;
  target_row_index integer;
  target_row_count integer;
  target_token uuid;
  target_date_section text;
  target_exact_instant text;
  lower_instant text;
  upper_instant text;
  open_minute text;
  causal_close_minute text;
  is_exact boolean;
BEGIN
  IF p_observation_id IS NULL OR jsonb_typeof(p_position) <> 'object'
     OR jsonb_typeof(p_position -> 'anchorObservationIds') <> 'array'
     OR jsonb_array_length(p_position -> 'anchorObservationIds') < 2
     OR jsonb_typeof(p_position -> 'rowIndex') <> 'number'
     OR jsonb_typeof(p_position -> 'rowCount') <> 'number'
     OR (p_position ->> 'rowIndex') !~ '^\d+$'
     OR (p_position ->> 'rowCount') !~ '^[1-9]\d*$'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_position -> 'anchorObservationIds') anchor_id
        WHERE jsonb_typeof(anchor_id) <> 'string'
     ) THEN
    RETURN false;
  END IF;

  SELECT o.read_id, o.row_index, o.row_count, o.attachment_token, o.date_section,
         concat(o.row_data ->> 'dateIso', ' ', o.row_data ->> 'time'),
         to_char(s.open_approved_at AT TIME ZONE b.timezone, 'YYYY-MM-DD HH24:MI'),
         to_char(LEAST(h.attached_at, COALESCE(s.submitted_at, h.attached_at))
                   AT TIME ZONE b.timezone, 'YYYY-MM-DD HH24:MI')
    INTO target_read_id, target_row_index, target_row_count, target_token, target_date_section,
         target_exact_instant, open_minute, causal_close_minute
    FROM public.shift_close_draft_observations o
    JOIN public.shift_close_draft_reads r
      ON r.id = o.read_id
     AND r.shift_id = o.shift_id
     AND r.media_id = o.media_id
     AND r.attachment_token = o.attachment_token
     AND r.slot = o.slot
    JOIN public.shifts s ON s.id = o.shift_id
    JOIN public.branches b ON b.id = s.branch_id
    LEFT JOIN LATERAL (
      SELECT history.attached_at
        FROM public.shift_media_attachment_history history
       WHERE history.shift_id = o.shift_id
         AND history.attachment_token = o.attachment_token
       ORDER BY history.id DESC
       LIMIT 1
    ) h ON true
   WHERE o.id = p_observation_id AND o.shift_id = p_shift_id
     AND r.package = 'end'
     AND r.field = 'orders'
     AND r.status = 'complete'
     AND r.slot ~ '^dashboard(_([2-9]|[1-9][0-9]+))?$';
  IF NOT FOUND OR open_minute IS NULL OR causal_close_minute IS NULL OR target_date_section IS NULL THEN
    RETURN false;
  END IF;
  IF (p_position ->> 'rowIndex')::integer IS DISTINCT FROM target_row_index
     OR (p_position ->> 'rowCount')::integer IS DISTINCT FROM target_row_count
     OR target_row_index < 0 OR target_row_index >= target_row_count THEN RETURN false; END IF;

  lower_instant := p_position ->> 'lowerInstant';
  upper_instant := p_position ->> 'upperInstant';
  IF lower_instant !~ '^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$'
     OR upper_instant !~ '^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$'
     OR lower_instant > upper_instant
     OR upper_instant > causal_close_minute THEN
    RETURN false;
  END IF;

  -- Every cited anchor is immutable, belongs to this exact read/generation and stays inside the
  -- same printed date section. Crossing a date header is not evidence of chronological position.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(p_position -> 'anchorObservationIds') ids(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.shift_close_draft_observations anchor
        WHERE anchor.id::text = ids.id
          AND anchor.shift_id = p_shift_id
          AND anchor.read_id = target_read_id
          AND anchor.attachment_token = target_token
          AND anchor.date_section IS NOT DISTINCT FROM target_date_section
          AND anchor.row_count = target_row_count
     )
  ) THEN RETURN false; END IF;

  is_exact := lower_instant = upper_instant;
  IF is_exact THEN
    -- A markerless AM/PM candidate can be exact at a page edge (Muhammad's 01:18 above 00:57).
    -- Its own immutable observation plus one same-section monotonic neighbour and the attachment
    -- timestamp are sufficient; demanding both an above and below anchor would reject every edge.
    IF target_exact_instant IS DISTINCT FROM lower_instant
       OR NOT (p_position -> 'anchorObservationIds' @> to_jsonb(ARRAY[p_observation_id::text]))
       OR NOT EXISTS (
         SELECT 1
           FROM public.shift_close_draft_observations anchor,
                jsonb_array_elements_text(p_position -> 'anchorObservationIds') ids(id)
          WHERE anchor.id::text = ids.id
            AND anchor.id <> p_observation_id
            AND anchor.shift_id = p_shift_id
            AND anchor.read_id = target_read_id
            AND anchor.attachment_token = target_token
            AND anchor.date_section = target_date_section
            AND anchor.row_count = target_row_count
            AND concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time')
                ~ '^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$'
            AND concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time') <= causal_close_minute
            AND (
              (anchor.row_index < target_row_index AND
               concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time') >= lower_instant)
              OR
              (anchor.row_index > target_row_index AND
               concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time') <= lower_instant)
            )
       ) THEN RETURN false; END IF;
    RETURN true;
  END IF;

  -- An interval-only row has no accepted clock. It counts only when two exact same-section
  -- observations bracket it and the entire interval is inside the open-to-capture window.
  IF NULLIF(split_part(target_exact_instant, ' ', 2), '') IS NOT NULL
     OR lower_instant < open_minute
     OR NOT EXISTS (
       SELECT 1
         FROM public.shift_close_draft_observations anchor,
              jsonb_array_elements_text(p_position -> 'anchorObservationIds') ids(id)
        WHERE anchor.id::text = ids.id
          AND anchor.read_id = target_read_id
          AND anchor.attachment_token = target_token
          AND anchor.date_section = target_date_section
          AND anchor.row_index < target_row_index
          AND concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time') = upper_instant
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.shift_close_draft_observations anchor,
              jsonb_array_elements_text(p_position -> 'anchorObservationIds') ids(id)
        WHERE anchor.id::text = ids.id
          AND anchor.read_id = target_read_id
          AND anchor.attachment_token = target_token
          AND anchor.date_section = target_date_section
          AND anchor.row_index > target_row_index
          AND concat(anchor.row_data ->> 'dateIso', ' ', anchor.row_data ->> 'time') = lower_instant
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION close_draft_screen_position_valid(uuid, uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION close_draft_materialized_operation_valid(
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
    AND NULLIF(btrim(p_old ->> 'decision_reason'), '') IS NOT NULL;
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

REVOKE ALL ON FUNCTION close_draft_materialized_operation_valid(text, jsonb, jsonb, text) FROM PUBLIC;

CREATE FUNCTION guard_close_draft_operation_provenance() RETURNS trigger
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
    NEW.decided_by IS NULL OR NEW.decided_at IS NULL OR NULLIF(btrim(NEW.decision_reason), '') IS NULL
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
      OR NULLIF(btrim(NEW.decision_reason), '') IS NULL
    THEN
      RAISE EXCEPTION 'operation provenance changes require a fresh attributed manager reason'
        USING ERRCODE = '23514', CONSTRAINT = 'close_draft_operation_provenance_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_orders_close_draft_provenance_guard
  BEFORE INSERT OR UPDATE ON shift_orders
  FOR EACH ROW EXECUTE FUNCTION guard_close_draft_operation_provenance();

CREATE TRIGGER cash_deductions_close_draft_provenance_guard
  BEFORE INSERT OR UPDATE ON cash_deductions
  FOR EACH ROW EXECUTE FUNCTION guard_close_draft_operation_provenance();

-- Preserve a DB-verified interval inclusion; every ordinary/exact clock still follows 0033.
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
                                AND NULLIF(btrim(o.decision_reason), '') IS NOT NULL
                           THEN o.included
                           ELSE public.operation_window_included_automatically(c.status) END
      FROM classified c
     WHERE o.id = c.id AND (
       o.window_status IS DISTINCT FROM c.status OR
       o.included IS DISTINCT FROM CASE WHEN o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL
                                             AND NULLIF(btrim(o.decision_reason), '') IS NOT NULL
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
                                AND NULLIF(btrim(d.decision_reason), '') IS NOT NULL
                           THEN d.included
                           ELSE public.operation_window_included_automatically(c.status) END
      FROM classified c
     WHERE d.id = c.id AND (
       d.window_status IS DISTINCT FROM c.status OR
       d.included IS DISTINCT FROM CASE WHEN d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL
                                             AND NULLIF(btrim(d.decision_reason), '') IS NOT NULL
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

CREATE FUNCTION guard_shift_close_draft_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE current_state shift_state;
BEGIN
  SELECT state INTO current_state FROM public.shifts WHERE id = NEW.shift_id FOR UPDATE;
  IF current_state IS NULL OR current_state NOT IN ('open', 'suspended') THEN
    RAISE EXCEPTION 'close draft is not editable while shift % is %', NEW.shift_id, current_state
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_draft_editable_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.submitted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    IF NOT (
      NEW.submitted_at IS NULL
      AND NEW.revision = OLD.revision + 1
      AND NEW.payload IS NOT DISTINCT FROM OLD.payload
      AND NEW.draft_hash IS NOT DISTINCT FROM OLD.draft_hash
    ) THEN
      RAISE EXCEPTION 'a submitted close draft is immutable'
        USING ERRCODE = '25006';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_close_drafts_write_guard
  BEFORE INSERT OR UPDATE ON shift_close_drafts
  FOR EACH ROW EXECUTE FUNCTION guard_shift_close_draft_write();

CREATE FUNCTION guard_shift_close_draft_read_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE current_state shift_state;
BEGIN
  SELECT s.state INTO current_state
    FROM public.shifts s
    JOIN public.shift_close_drafts d ON d.shift_id = s.id
   WHERE s.id = NEW.shift_id AND d.submitted_at IS NULL
   FOR UPDATE OF s;
  IF current_state IS NULL OR current_state NOT IN ('open', 'suspended') THEN
    RAISE EXCEPTION 'close-draft OCR is not editable while shift % is %', NEW.shift_id, current_state
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_draft_read_editable_guard';
  END IF;
  IF NOT (
    (NEW.field = 'orders' AND NEW.slot ~ '^dashboard(_([2-9]|[1-9][0-9]+))?$') OR
    (NEW.field = 'payments_log' AND NEW.slot ~ '^payments_log(_([2-9]|[1-9][0-9]+))?$') OR
    (NEW.field = 'wallet' AND NEW.slot = 'wallet') OR
    (NEW.field = 'odometer' AND NEW.slot = 'odometer') OR
    (NEW.field = 'bms' AND NEW.slot ~ '^bms_[1-9][0-9]*$')
  ) THEN
    RAISE EXCEPTION 'close-draft OCR field does not match its evidence slot'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_draft_read_slot_field_guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.shift_media sm
     WHERE sm.shift_id = NEW.shift_id AND sm.package = NEW.package AND sm.slot = NEW.slot
       AND sm.media_id = NEW.media_id AND sm.attachment_token = NEW.attachment_token
  ) THEN
    RAISE EXCEPTION 'close-draft OCR attachment generation changed'
      USING ERRCODE = '40001', CONSTRAINT = 'shift_close_draft_read_attachment_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shift_close_draft_reads_write_guard
  BEFORE INSERT OR UPDATE ON shift_close_draft_reads
  FOR EACH ROW EXECUTE FUNCTION guard_shift_close_draft_read_write();

CREATE FUNCTION reject_shift_close_draft_read_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.shift_close_drafts WHERE shift_id = OLD.shift_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'shift_close_draft_reads are append-only' USING ERRCODE = '25006';
  RETURN NULL;
END
$$;

CREATE TRIGGER shift_close_draft_reads_append_only
  BEFORE UPDATE OR DELETE ON shift_close_draft_reads
  FOR EACH ROW EXECUTE FUNCTION reject_shift_close_draft_read_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON shift_close_draft_reads FROM app_user;

CREATE FUNCTION reject_shift_close_draft_observation_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.shift_close_draft_reads WHERE id = OLD.read_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'shift_close_draft_observations are append-only' USING ERRCODE = '25006';
  RETURN NULL;
END
$$;

CREATE TRIGGER shift_close_draft_observations_append_only
  BEFORE UPDATE OR DELETE ON shift_close_draft_observations
  FOR EACH ROW EXECUTE FUNCTION reject_shift_close_draft_observation_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON shift_close_draft_observations FROM app_user;
GRANT SELECT, INSERT ON shift_close_draft_observations TO app_user;
GRANT SELECT, INSERT ON shift_close_draft_reads TO app_user;
GRANT SELECT, INSERT, UPDATE ON shift_close_drafts TO app_user;
REVOKE DELETE, TRUNCATE ON shift_close_drafts FROM app_user;
