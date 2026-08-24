-- 0040 - custom-date pre-approved shift opening
--
-- A manager may sign an opening cash/wallet authorization in advance for one driver, one local
-- business date and one inclusive minute window. The driver still supplies and confirms the full
-- BR5 start package; matching the rule replaces only the manager's later button press.

CREATE TABLE preapproved_shift_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id                uuid NOT NULL REFERENCES branches(id),
  driver_id                uuid NOT NULL REFERENCES drivers(id),
  business_date            date NOT NULL,
  window_start_minute      smallint NOT NULL CHECK (window_start_minute BETWEEN 0 AND 1439),
  window_end_minute        smallint NOT NULL CHECK (window_end_minute BETWEEN 0 AND 1439),
  cash_float_minor         bigint NOT NULL CHECK (cash_float_minor >= 0),
  wallet_topup_minor       bigint NOT NULL CHECK (wallet_topup_minor >= 0),
  active                   boolean NOT NULL DEFAULT true,
  authorized_by            uuid NOT NULL REFERENCES users(id),
  authorized_by_role       text NOT NULL REFERENCES roles(key),
  authorized_by_branch_id  uuid REFERENCES branches(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  consumed_by_shift_id     uuid REFERENCES shifts(id),
  consumed_at              timestamptz,
  CONSTRAINT preapproved_shift_rules_same_day_window
    CHECK (window_start_minute < window_end_minute),
  CONSTRAINT preapproved_shift_rules_consumption_pair
    CHECK ((consumed_by_shift_id IS NULL) = (consumed_at IS NULL)),
  CONSTRAINT preapproved_shift_rules_one_rule_per_shift UNIQUE (consumed_by_shift_id)
);

CREATE INDEX preapproved_shift_rules_branch_date_idx
  ON preapproved_shift_rules (branch_id, business_date, driver_id);

CREATE INDEX preapproved_shift_rules_match_idx
  ON preapproved_shift_rules (branch_id, driver_id, business_date, window_start_minute, window_end_minute)
  WHERE active AND consumed_by_shift_id IS NULL;

-- Serialize writers for one driver/date and reject even minute-edge overlap. The advisory lock is
-- what makes the EXISTS check race-safe when two managers publish at the same instant.
CREATE FUNCTION guard_preapproved_shift_rule() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_is_revoke boolean;
  v_is_consume boolean;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
       OR NEW.business_date IS DISTINCT FROM OLD.business_date
       OR NEW.window_start_minute IS DISTINCT FROM OLD.window_start_minute
       OR NEW.window_end_minute IS DISTINCT FROM OLD.window_end_minute
       OR NEW.cash_float_minor IS DISTINCT FROM OLD.cash_float_minor
       OR NEW.wallet_topup_minor IS DISTINCT FROM OLD.wallet_topup_minor
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
       OR NEW.authorized_by_role IS DISTINCT FROM OLD.authorized_by_role
       OR NEW.authorized_by_branch_id IS DISTINCT FROM OLD.authorized_by_branch_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'pre-approved shift rule terms are immutable; create a replacement'
        USING ERRCODE = '55000', CONSTRAINT = 'preapproved_shift_rule_terms_immutable';
    END IF;

    IF OLD.active = false AND NEW.active = true THEN
      RAISE EXCEPTION 'a revoked pre-approved shift rule cannot be reactivated'
        USING ERRCODE = '55000', CONSTRAINT = 'preapproved_shift_rule_no_reactivation';
    END IF;

    IF OLD.consumed_by_shift_id IS NOT NULL
       AND (NEW.consumed_by_shift_id IS DISTINCT FROM OLD.consumed_by_shift_id
            OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
            OR NEW.active IS DISTINCT FROM OLD.active)
    THEN
      RAISE EXCEPTION 'a consumed pre-approved shift rule is immutable'
        USING ERRCODE = '55000', CONSTRAINT = 'preapproved_shift_rule_consumed_immutable';
    END IF;

    v_is_revoke :=
      OLD.active AND NOT NEW.active
      AND OLD.consumed_by_shift_id IS NULL AND NEW.consumed_by_shift_id IS NULL
      AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL;
    v_is_consume :=
      OLD.active AND NEW.active
      AND OLD.consumed_by_shift_id IS NULL AND NEW.consumed_by_shift_id IS NOT NULL
      AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL;

    IF NOT v_is_revoke AND NOT v_is_consume THEN
      RAISE EXCEPTION 'unsupported pre-approved shift rule mutation'
        USING ERRCODE = '55000', CONSTRAINT = 'preapproved_shift_rule_update_shape';
    END IF;

    -- Revocation may be performed by any currently authorised manager at the rule's scope.
    IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.users u
        JOIN public.role_permissions rp
          ON rp.role_key = u.role_key
         AND rp.permission_key = 'shift.approve'
       WHERE u.id = v_actor
         AND u.active
         AND (
           rp.scope = 'all'
           OR (rp.scope = 'branch' AND u.branch_id = OLD.branch_id)
         )
    ) THEN
      RAISE EXCEPTION 'pre-approved shift rule update requires an active scoped approver'
        USING ERRCODE = '23514', CONSTRAINT = 'preapproved_shift_rule_update_actor';
    END IF;

    IF v_is_consume THEN
      -- The advance signature is attributed to its original manager. The driver confirmation lives
      -- on the shift; the opening transaction deliberately runs under this authorizing actor.
      IF v_actor IS DISTINCT FROM OLD.authorized_by THEN
        RAISE EXCEPTION 'pre-approved shift rule must be consumed under its authorizing manager'
          USING ERRCODE = '23514', CONSTRAINT = 'preapproved_shift_rule_consumption_actor';
      END IF;

      -- A direct SQL client cannot spend this authority on another driver/date or before BR5's
      -- first signature. Match the time against the immutable driver-confirmed instant, not against
      -- database now(), so an application retry cannot drift outside the signed minute.
      IF NOT EXISTS (
        SELECT 1
          FROM public.shifts s
          JOIN public.branches b ON b.id = s.branch_id
         WHERE s.id = NEW.consumed_by_shift_id
           AND s.branch_id = OLD.branch_id
           AND s.driver_id = OLD.driver_id
           AND s.business_date = OLD.business_date
           AND s.state = 'awaiting_open_approval'
           AND s.driver_confirmed_at IS NOT NULL
           -- The manager must have signed before (or at the stored precision of) the driver's
           -- confirmation; a rule published during post-confirmation side effects is too late.
           AND OLD.created_at <= s.driver_confirmed_at
           AND (s.driver_confirmed_at AT TIME ZONE b.timezone)::date = OLD.business_date
           AND (
             EXTRACT(hour FROM (s.driver_confirmed_at AT TIME ZONE b.timezone))::integer * 60
             + EXTRACT(minute FROM (s.driver_confirmed_at AT TIME ZONE b.timezone))::integer
           ) BETWEEN OLD.window_start_minute AND OLD.window_end_minute
      ) THEN
        RAISE EXCEPTION 'pre-approved shift rule does not match the confirmed shift identity/window'
          USING ERRCODE = '23514', CONSTRAINT = 'preapproved_shift_rule_consumption_identity';
      END IF;
    END IF;

    -- Revocation and consumption both remove an available rule; neither can introduce an overlap.
    RETURN NEW;
  END IF;

  -- An INSERT is publication only. A direct SQL client may not publish an already-revoked rule
  -- or pre-fill its consumption fields to bypass the UPDATE-only identity and time-window checks.
  IF NOT NEW.active OR NEW.consumed_by_shift_id IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a pre-approved shift rule must be published active and unconsumed'
      USING ERRCODE = '23514', CONSTRAINT = 'preapproved_shift_rule_publication_shape';
  END IF;

  -- Publication must be the authenticated manager's own signature. Snapshot fields are checked
  -- against that user's current identity so a direct app_user INSERT cannot forge a stronger role.
  IF v_actor IS NULL
     OR NEW.authorized_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = 'shift.approve'
         JOIN public.drivers d
           ON d.id = NEW.driver_id
          AND d.branch_id = NEW.branch_id
        WHERE u.id = v_actor
          AND u.active
          AND d.active
          AND u.role_key = NEW.authorized_by_role
          AND u.branch_id IS NOT DISTINCT FROM NEW.authorized_by_branch_id
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'pre-approved shift rule requires its attributed active scoped manager'
      USING ERRCODE = '23514', CONSTRAINT = 'preapproved_shift_rule_publication_actor';
  END IF;

  IF NEW.active AND NEW.consumed_by_shift_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'ash:preapproved-shift:' || NEW.driver_id::text || ':' || NEW.business_date::text,
        0
      )
    );

    IF EXISTS (
      SELECT 1
        FROM public.preapproved_shift_rules r
       WHERE r.driver_id = NEW.driver_id
         AND r.business_date = NEW.business_date
         AND r.active
         AND r.consumed_by_shift_id IS NULL
         -- Both window ends are inclusive; equality at either edge is therefore an overlap.
         AND r.window_start_minute <= NEW.window_end_minute
         AND NEW.window_start_minute <= r.window_end_minute
    ) THEN
      RAISE EXCEPTION 'overlapping active pre-approved shift rule'
        USING ERRCODE = '23P01', CONSTRAINT = 'preapproved_shift_rules_no_overlap';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER preapproved_shift_rules_guard
  BEFORE INSERT OR UPDATE ON preapproved_shift_rules
  FOR EACH ROW EXECUTE FUNCTION guard_preapproved_shift_rule();

CREATE TRIGGER audit_preapproved_shift_rules
  AFTER INSERT OR UPDATE OR DELETE ON preapproved_shift_rules
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Authorizations and their consumption history are retained. Revocation is `active = false`.
REVOKE DELETE, TRUNCATE ON preapproved_shift_rules FROM app_user;
GRANT SELECT, INSERT, UPDATE ON preapproved_shift_rules TO app_user;

COMMENT ON TABLE preapproved_shift_rules IS
  'Advance manager authorization for one driver/date/time window; consumption opens through the ordinary BR5 and ledger path.';
