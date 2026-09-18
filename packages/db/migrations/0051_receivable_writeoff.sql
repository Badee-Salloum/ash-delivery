-- 0051 - audited ordinary-receivable write-offs
--
-- A write-off is not a collection. The office already surrendered value when the ordinary
-- receivable was created, so recognising the loss must credit that driver asset and debit one
-- dedicated loss account without touching office_cash or office_wallet. The immutable event keeps
-- the human reason, before/after balances, actor, journal, and idempotency key together.

ALTER TABLE receivable_events
  DROP CONSTRAINT IF EXISTS receivable_events_intent_check;

ALTER TABLE receivable_events
  ADD CONSTRAINT receivable_events_intent_check
    CHECK (intent IN ('command', 'correction', 'writeoff'));

ALTER TABLE receivable_events
  ADD CONSTRAINT receivable_events_writeoff_shape_ck CHECK (
    intent <> 'writeoff'
    OR (receivable_kind = 'ordinary' AND direction = 'collect')
  );

CREATE INDEX receivable_events_writeoff_idx
  ON receivable_events (branch_id, driver_id, created_at)
  WHERE intent = 'writeoff';

-- One canonical matcher is shared by the insert-time event guard and the deferred journal-line
-- guard. That prevents the two enforcement paths from drifting as new event intents are added.
CREATE FUNCTION receivable_event_lines_match(
  p_journal_entry_id bigint,
  p_branch_id uuid,
  p_driver_id uuid,
  p_receivable_kind text,
  p_channel text,
  p_direction text,
  p_amount_minor bigint,
  p_intent text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = p_branch_id
         AND f.code = CASE p_receivable_kind
           WHEN 'shift_funding' THEN
             'driver_shift_funding_' || p_channel || ':' || p_driver_id::text
           ELSE 'driver_receivable_' || p_channel || ':' || p_driver_id::text
         END
         AND f.type::text = CASE p_receivable_kind
           WHEN 'shift_funding' THEN 'driver_shift_funding_' || p_channel
           ELSE 'driver_receivable_' || p_channel
         END
         AND f.owner_kind = 'driver'
         AND f.owner_id = p_driver_id
         AND jl.side = CASE p_direction WHEN 'create' THEN 'D' ELSE 'C' END
         AND jl.amount_minor = p_amount_minor
         AND jl.line_role = CASE
           WHEN p_intent = 'writeoff' THEN 'receivable_written_off'
           WHEN p_direction = 'create' THEN 'receivable_created'
           ELSE 'receivable_cleared'
         END
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = p_branch_id
         AND f.code = CASE
           WHEN p_intent = 'writeoff' THEN 'cost_center:receivable_writeoff_loss'
           ELSE 'office_' || p_channel
         END
         AND f.type::text = CASE
           WHEN p_intent = 'writeoff' THEN 'cost_center'
           ELSE 'office_' || p_channel
         END
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = CASE
           WHEN p_intent = 'writeoff' THEN 'D'
           WHEN p_direction = 'create' THEN 'C'
           ELSE 'D'
         END
         AND jl.amount_minor = p_amount_minor
         AND jl.line_role = CASE
           WHEN p_intent = 'writeoff' THEN 'receivable_writeoff_loss'
           WHEN p_direction = 'create' THEN 'office_value_reclassified'
           ELSE 'receivable_collected'
         END
     ) = 1
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = p_journal_entry_id
$$;

CREATE OR REPLACE FUNCTION guard_receivable_event_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor               uuid;
  v_receivable_code     text;
  v_receivable_type     text;
  v_receivable_fund_id  uuid;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = 'journal.manual.write'
        WHERE u.id = v_actor
          AND u.active
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'receivable command requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.drivers d
     WHERE d.id = NEW.driver_id
       AND d.branch_id = NEW.branch_id
       AND (NEW.direction = 'collect' OR d.active)
  ) THEN
    RAISE EXCEPTION 'receivable driver must belong to the command branch and be active for creation'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_driver_guard';
  END IF;

  IF NEW.intent = 'writeoff'
     AND (NEW.receivable_kind <> 'ordinary' OR NEW.direction <> 'collect')
  THEN
    RAISE EXCEPTION 'write-off requires an ordinary receivable decrease'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_writeoff_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = NEW.journal_entry_id
       AND je.branch_id = NEW.branch_id
       AND je.event_type = 'receivable_adjustment'
       AND je.shift_id IS NULL
       AND je.occurrence_key = NEW.idempotency_key
       AND je.business_date = NEW.business_date
       AND je.posting_date = NEW.business_date
       AND je.week_start_date =
         (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
       AND je.reason IS NOT DISTINCT FROM NEW.reason
       AND je.created_by = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'receivable command identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_journal_guard';
  END IF;

  IF NOT public.receivable_event_lines_match(
    NEW.journal_entry_id,
    NEW.branch_id,
    NEW.driver_id,
    NEW.receivable_kind,
    NEW.channel,
    NEW.direction,
    NEW.amount_minor,
    NEW.intent
  ) THEN
    RAISE EXCEPTION 'receivable command amount/direction/intent differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_lines_guard';
  END IF;

  v_receivable_code := CASE NEW.receivable_kind
    WHEN 'shift_funding' THEN 'driver_shift_funding_' || NEW.channel || ':' || NEW.driver_id::text
    ELSE 'driver_receivable_' || NEW.channel || ':' || NEW.driver_id::text
  END;
  v_receivable_type := CASE NEW.receivable_kind
    WHEN 'shift_funding' THEN 'driver_shift_funding_' || NEW.channel
    ELSE 'driver_receivable_' || NEW.channel
  END;

  IF NEW.direction = 'collect' THEN
    -- Lock the asset after the journal lines exist, then re-read its post-entry balance. This makes
    -- concurrent collections and write-offs serialize on the same driver/channel fund.
    SELECT f.id
      INTO v_receivable_fund_id
      FROM public.funds f
     WHERE f.branch_id = NEW.branch_id
       AND f.code = v_receivable_code
       AND f.type::text = v_receivable_type
       AND f.owner_kind = 'driver'
       AND f.owner_id = NEW.driver_id
     FOR UPDATE;

    IF v_receivable_fund_id IS NULL THEN
      RAISE EXCEPTION 'receivable command names no matching driver asset'
        USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_lines_guard';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.journal_lines jl
       WHERE jl.fund_id = v_receivable_fund_id
      HAVING COALESCE(
        SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),
        0
      ) >= 0
    ) THEN
      RAISE EXCEPTION 'receivable collection or write-off exceeds the outstanding balance'
        USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_overcollection_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- Re-check the shared canonical recipe if anybody appends a line after the event was inserted.
CREATE OR REPLACE FUNCTION check_receivable_journal_lines() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event       public.receivable_events%ROWTYPE;
  v_event_type  text;
BEGIN
  SELECT je.event_type::text
    INTO v_event_type
    FROM public.journal_entries je
   WHERE je.id = NEW.entry_id;

  IF NOT FOUND OR v_event_type <> 'receivable_adjustment' THEN
    RETURN NEW;
  END IF;

  SELECT re.*
    INTO v_event
    FROM public.receivable_events re
   WHERE re.journal_entry_id = NEW.entry_id;

  -- The entry-side deferred guard owns the orphan case and preserves journal-first runtime order.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT public.receivable_event_lines_match(
    v_event.journal_entry_id,
    v_event.branch_id,
    v_event.driver_id,
    v_event.receivable_kind,
    v_event.channel,
    v_event.direction,
    v_event.amount_minor,
    v_event.intent
  ) THEN
    RAISE EXCEPTION 'immutable receivable journal requires its exact two-line recipe'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION reject_receivable_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'receivable events are immutable; append a collection, correction, or write-off'
    USING ERRCODE = '55000';
END
$$;
