-- 0058 - a «ذمة» may be reclassified as a «سلفة» (owner request, 2026-09-01)
--
-- «حول ذمة انس رميح إلى سلفة». The same debt, filed differently: a driver receivable becomes a
-- named advance. NOTHING PHYSICAL HAPPENS, and the posting says so —
--
--   D  advance_receivable_<channel>:<advance>     'advance_created'
--   C  driver_receivable_<channel>:<driver>       'receivable_converted_to_advance'
--
-- — one counted asset falls and another rises, no box is touched, office capital is unchanged, and
-- الترميم sees exactly what it saw a second earlier.
--
-- WHY NOT COMPOSE THE TWO ROUTES THAT ALREADY EXIST. Collecting the receivable and then paying an
-- advance reaches the same end state and is one line of code. It also writes a COLLECTION into the
-- driver's history — «تحصيل» for money that never came back — and shows cash entering and leaving
-- the box on a day neither happened. `ReceivableEventRecord.intent` in ports.ts names that exact
-- lie as the thing the ledger exists to prevent. A true statement is worth a migration.
--
-- THE CHANNEL IS INHERITED, NEVER CHOSEN. A debt owed in cash stays owed in cash, so a later
-- repayment lands in the box it was always owed to and no leg of الترميم moves sideways.
--
-- ── HOW THE GUARD BELOW WAS PRODUCED ─────────────────────────────────────────────────────────
-- `guard_advance_insert` is already live. It was NOT retyped: extracted verbatim from
-- `0056_advances.sql:114-231` and changed by six named hunks, proven by `diff -u`.
--
--   1. CREATE OR REPLACE, because it is deployed
--   2. two locals for the alternative credit leg
--   3. a source driver must belong to this branch
--   4. the credit leg is chosen by origin — a box, or the receivable being reclassified
--   5. the line matcher checks that leg, including its different owner shape (a receivable fund
--      belongs to a DRIVER; an office fund to nobody)
--   6. the receivable may not be driven below zero, with the same FOR UPDATE discipline the
--      repayment guard uses against the two-connection write skew
--
-- Untouched: the actor check against the live RBAC matrix, the category check, the vehicle check,
-- the journal identity check, and the entire debit leg.

-- Nullable, so every existing advance stays exactly what it was: paid out of a box.
ALTER TABLE advances ADD COLUMN source_driver_id uuid REFERENCES drivers(id) ON DELETE RESTRICT;

COMMENT ON COLUMN advances.source_driver_id IS
  'Set when this advance was reclassified from that driver''s «ذمة» rather than paid out of a box. '
  'The credit leg is his receivable fund, not office cash or wallet, and no money moved.';

CREATE INDEX advances_source_driver_idx
  ON advances (source_driver_id) WHERE source_driver_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_advance_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor          uuid;
  v_advance_code   text;
  v_advance_type   text;
  v_office_code    text;
  v_credit_code    text;
  v_credit_role    text;
  v_lines_match    boolean;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  -- Match the API's live, editable RBAC matrix. There is deliberately no compiled-role fallback:
  -- an empty/missing grant fails closed, and revoking a formerly privileged role takes effect on
  -- direct SQL immediately. Paying an advance is `expense.write`, the same key that records the
  -- صرفية it is a variant of.
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = 'expense.write'
        WHERE u.id = v_actor
          AND u.active
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'advance requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_categories ec WHERE ec.id = NEW.category_id AND ec.active
  ) THEN
    RAISE EXCEPTION 'advance names an unknown or inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_category_guard';
  END IF;

  -- A vehicle cost centre must name a vehicle of THIS branch, or the cost lands on another
  -- branch's profitability and the conversion would later file it there for good.
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id AND v.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'advance names a vehicle from another branch'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_vehicle_guard';
  END IF;

  -- A «سلفة» converted from a «ذمة» must name a driver of this branch. The channel is inherited
  -- from the receivable and never chosen, so a debt owed in cash stays owed in cash.
  IF NEW.source_driver_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.drivers d
     WHERE d.id = NEW.source_driver_id AND d.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'advance names a source driver from another branch'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_source_driver_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = NEW.journal_entry_id
       AND je.branch_id = NEW.branch_id
       AND je.event_type = 'advance'
       AND je.shift_id IS NULL
       AND je.occurrence_key = NEW.id::text
       AND je.business_date = NEW.business_date
       AND je.posting_date = NEW.business_date
       AND je.week_start_date =
         (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
       AND je.reason IS NOT DISTINCT FROM NEW.description
       AND je.created_by = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'advance identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_journal_guard';
  END IF;

  v_advance_type := 'advance_receivable_' || CASE NEW.channel
    WHEN 'office_cash' THEN 'cash' ELSE 'wallet' END;
  v_advance_code := v_advance_type || ':' || NEW.id::text;
  -- WHERE THE VALUE CAME FROM. A box, or a receivable being reclassified — in which case no box
  -- moves at all, because nothing physical happened: the same debt is simply filed differently.
  IF NEW.source_driver_id IS NULL THEN
    v_credit_code := NEW.channel;
    v_credit_role := 'office_value_advanced';
  ELSE
    v_credit_code := 'driver_receivable_'
      || CASE NEW.channel WHEN 'office_cash' THEN 'cash' ELSE 'wallet' END
      || ':' || NEW.source_driver_id::text;
    v_credit_role := 'receivable_converted_to_advance';
  END IF;
  v_office_code  := NEW.channel;

  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_advance_code
         AND f.type::text = v_advance_type
         -- The advance asset is branch-owned with its identity in the code — the shape
         -- `cost_center:cash_count_variance:<branch>:<fund>` already uses. `funds_owner_ck`
         -- requires exactly this pairing.
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = 'D'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = 'advance_created'
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_credit_code
         AND (
           (NEW.source_driver_id IS NULL
             AND f.type::text = v_office_code
             AND f.owner_kind = 'none'
             AND f.owner_id IS NULL)
           OR
           (NEW.source_driver_id IS NOT NULL
             AND f.owner_kind = 'driver'
             AND f.owner_id = NEW.source_driver_id)
         )
         AND jl.side = 'C'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = v_credit_role
     ) = 1
    INTO v_lines_match
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.journal_entry_id;

  IF NOT COALESCE(v_lines_match, false) THEN
    RAISE EXCEPTION 'advance amount/channel differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_lines_guard';
  END IF;

  -- Converting more than the driver actually owes would invent office capital out of nothing and
  -- leave his «ذمة» negative, which every reader in this system treats as corruption. Lock the
  -- receivable fund row first, exactly as the repayment guard locks the advance fund: advisory
  -- locks order normal requests, but this closes the two-connection write skew.
  IF NEW.source_driver_id IS NOT NULL THEN
    PERFORM 1 FROM public.funds f
      WHERE f.branch_id = NEW.branch_id AND f.code = v_credit_code AND f.owner_id = NEW.source_driver_id
      FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
        FROM public.journal_lines jl
        JOIN public.funds f ON f.id = jl.fund_id
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_credit_code
      HAVING COALESCE(
        SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),
        0
      ) >= 0
    ) THEN
      RAISE EXCEPTION 'converting this advance would leave the driver receivable negative'
        USING ERRCODE = '23514', CONSTRAINT = 'advances_source_receivable_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
