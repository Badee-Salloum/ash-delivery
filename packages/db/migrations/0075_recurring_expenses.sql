-- 0075 — branch recurring expenses («الصرفيات الثابتة»)
--
-- Nothing in this migration posts money automatically. Schedules are promises shown on read;
-- a human pays or skips each occurrence explicitly. A paid occurrence points at one ordinary,
-- ledger-backed `expenses` row, so every existing profit and cash report sees the cost once.

CREATE FUNCTION ash_recurrence_matches(
  p_kind text,
  p_starts_on date,
  p_weekday smallint,
  p_interval_days smallint,
  p_due_date date
) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_due_date >= p_starts_on
     AND CASE p_kind
       WHEN 'weekly' THEN extract(dow FROM p_due_date)::integer = p_weekday
       WHEN 'monthly_first' THEN extract(day FROM p_due_date)::integer = 1
       WHEN 'every_n_days' THEN (p_due_date - p_starts_on) % p_interval_days = 0
       ELSE false
     END
$$;

CREATE TABLE recurring_expense_templates (
  id                   uuid PRIMARY KEY,
  branch_id            uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  title                 text NOT NULL
                          CHECK (ash_has_visible_text(title) AND char_length(title) <= 200),
  category_id           uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  cost_center_kind      text NOT NULL CHECK (cost_center_kind IN ('vehicle', 'branch', 'general')),
  vehicle_id            uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  channel               text NOT NULL CHECK (channel IN ('office_cash', 'office_wallet')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  schedule_kind         text NOT NULL CHECK (schedule_kind IN ('weekly', 'monthly_first', 'every_n_days')),
  weekday               smallint,
  interval_days         smallint,
  starts_on             date NOT NULL,
  ends_on               date,
  active                boolean NOT NULL DEFAULT true,
  deactivated_on        date,
  deactivated_at        timestamptz,
  deactivated_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_reason   text,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_expense_templates_vehicle_ck
    CHECK ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL)),
  CONSTRAINT recurring_expense_templates_schedule_ck CHECK (
    (schedule_kind = 'weekly' AND weekday BETWEEN 0 AND 6 AND interval_days IS NULL)
    OR (schedule_kind = 'monthly_first' AND weekday IS NULL AND interval_days IS NULL)
    OR (schedule_kind = 'every_n_days' AND weekday IS NULL AND interval_days BETWEEN 1 AND 366)
  ),
  CONSTRAINT recurring_expense_templates_range_ck
    CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT recurring_expense_templates_deactivation_ck CHECK (
    (active AND deactivated_on IS NULL AND deactivated_at IS NULL
            AND deactivated_by IS NULL AND deactivation_reason IS NULL)
    OR
    (NOT active AND deactivated_on IS NOT NULL AND deactivated_at IS NOT NULL
                AND deactivated_by IS NOT NULL
                AND ash_has_visible_text(deactivation_reason)
                AND char_length(deactivation_reason) <= 500)
  )
);

CREATE INDEX recurring_expense_templates_branch_active_idx
  ON recurring_expense_templates (branch_id, active, starts_on, id);

CREATE TABLE recurring_expense_occurrences (
  id              uuid NOT NULL UNIQUE,
  template_id     uuid NOT NULL REFERENCES recurring_expense_templates(id) ON DELETE RESTRICT,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  due_date        date NOT NULL,
  status          text NOT NULL CHECK (status IN ('paid', 'skipped')),
  expense_id      uuid UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  reason          text,
  acted_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acted_at        timestamptz NOT NULL,
  PRIMARY KEY (template_id, due_date),
  CONSTRAINT recurring_expense_occurrences_shape_ck CHECK (
    (status = 'paid' AND expense_id IS NOT NULL
       AND (reason IS NULL OR (ash_has_visible_text(reason) AND char_length(reason) <= 500)))
    OR
    (status = 'skipped' AND expense_id IS NULL
       AND ash_has_visible_text(reason) AND char_length(reason) <= 500)
  )
);

CREATE INDEX recurring_expense_occurrences_branch_due_idx
  ON recurring_expense_occurrences (branch_id, due_date, template_id);

CREATE TRIGGER recurring_expense_templates_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER recurring_expense_occurrences_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON recurring_expense_occurrences
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');

CREATE FUNCTION guard_recurring_expense_template() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.users u
      JOIN public.role_permissions rp
        ON rp.role_key = u.role_key AND rp.permission_key = 'expense.write'
     WHERE u.id = v_actor AND u.active
       AND (rp.scope = 'all' OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id))
  ) THEN
    RAISE EXCEPTION 'recurring expense template requires an active scoped expense writer'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_categories c WHERE c.id = NEW.category_id AND c.active
  ) THEN
    RAISE EXCEPTION 'recurring expense template names an inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_category_guard';
  END IF;

  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicles v
     WHERE v.id = NEW.vehicle_id AND v.branch_id = NEW.branch_id AND v.active
  ) THEN
    RAISE EXCEPTION 'recurring expense template names a vehicle from another branch'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_vehicle_guard';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_actor OR NEW.updated_by IS DISTINCT FROM v_actor OR NOT NEW.active THEN
      RAISE EXCEPTION 'recurring expense template creation attribution is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_creation_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'recurring expense template identity is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'recurring_expense_template_identity_immutable';
  END IF;

  IF NEW.updated_by IS DISTINCT FROM v_actor OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'recurring expense template update attribution is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_update_attribution_guard';
  END IF;

  IF NOT OLD.active THEN
    RAISE EXCEPTION 'a deactivated recurring expense template is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'recurring_expense_template_inactive_immutable';
  END IF;

  IF OLD.active AND NOT NEW.active THEN
    IF NEW.deactivated_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'recurring expense deactivation must name the acting user'
        USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_deactivation_actor_guard';
    END IF;
    -- Deactivation is its own operation: terms cannot be silently edited at the same time.
    IF (to_jsonb(NEW) - ARRAY['active','deactivated_on','deactivated_at','deactivated_by',
                              'deactivation_reason','updated_by','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['active','deactivated_on','deactivated_at','deactivated_by',
                              'deactivation_reason','updated_by','updated_at'])
    THEN
      RAISE EXCEPTION 'deactivation cannot also edit recurring expense terms'
        USING ERRCODE = '55000', CONSTRAINT = 'recurring_expense_template_deactivation_shape';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.deactivated_on IS NOT NULL OR NEW.deactivated_at IS NOT NULL
     OR NEW.deactivated_by IS NOT NULL OR NEW.deactivation_reason IS NOT NULL
  THEN
    RAISE EXCEPTION 'active recurring expense template cannot carry deactivation fields'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_active_shape';
  END IF;

  -- Resolved history must remain valid under an edited schedule. A manager may adjust future
  -- terms, but changing yesterday from monthly to weekly cannot rewrite what was paid yesterday.
  IF EXISTS (
    SELECT 1
      FROM public.recurring_expense_occurrences o
     WHERE o.template_id = OLD.id
       AND (
         NOT public.ash_recurrence_matches(
           NEW.schedule_kind, NEW.starts_on, NEW.weekday, NEW.interval_days, o.due_date
         )
         OR (NEW.ends_on IS NOT NULL AND o.due_date > NEW.ends_on)
       )
  ) THEN
    RAISE EXCEPTION 'edited schedule would invalidate a resolved occurrence'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_history_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER recurring_expense_templates_guard
  BEFORE INSERT OR UPDATE ON recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION guard_recurring_expense_template();

CREATE FUNCTION guard_recurring_expense_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_template public.recurring_expense_templates%ROWTYPE;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  SELECT * INTO v_template
    FROM public.recurring_expense_templates t
   WHERE t.id = NEW.template_id;

  IF NOT FOUND OR NEW.branch_id IS DISTINCT FROM v_template.branch_id THEN
    RAISE EXCEPTION 'recurring occurrence branch differs from its template'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_template_guard';
  END IF;

  IF NOT public.ash_recurrence_matches(
       v_template.schedule_kind, v_template.starts_on,
       v_template.weekday, v_template.interval_days, NEW.due_date
     )
     OR (v_template.ends_on IS NOT NULL AND NEW.due_date > v_template.ends_on)
     OR (v_template.deactivated_on IS NOT NULL AND NEW.due_date >= v_template.deactivated_on)
  THEN
    RAISE EXCEPTION 'date is not produced by the recurring expense schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_schedule_guard';
  END IF;

  IF v_actor IS NULL OR NEW.acted_by IS DISTINCT FROM v_actor OR NOT EXISTS (
    SELECT 1
      FROM public.users u
      JOIN public.role_permissions rp
        ON rp.role_key = u.role_key AND rp.permission_key = 'expense.write'
     WHERE u.id = v_actor AND u.active
       AND (rp.scope = 'all' OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id))
  ) THEN
    RAISE EXCEPTION 'recurring occurrence requires its active scoped expense writer'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_actor_guard';
  END IF;

  IF NEW.status = 'paid' AND NOT EXISTS (
    SELECT 1
      FROM public.expenses e
     WHERE e.id = NEW.expense_id
       AND e.branch_id = NEW.branch_id
       AND e.category_id = v_template.category_id
       AND e.cost_center_kind = v_template.cost_center_kind
       AND e.vehicle_id IS NOT DISTINCT FROM v_template.vehicle_id
       AND e.channel = v_template.channel
       AND e.created_by = NEW.acted_by
       AND e.business_date >= NEW.due_date
       AND (e.amount_minor = v_template.amount_minor OR ash_has_visible_text(NEW.reason))
  ) THEN
    RAISE EXCEPTION 'paid recurring occurrence differs from its ordinary expense'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_expense_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER recurring_expense_occurrences_guard
  BEFORE INSERT ON recurring_expense_occurrences
  FOR EACH ROW EXECUTE FUNCTION guard_recurring_expense_occurrence();

CREATE TRIGGER audit_recurring_expense_templates
  AFTER INSERT OR UPDATE OR DELETE ON recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_recurring_expense_occurrences
  AFTER INSERT OR UPDATE OR DELETE ON recurring_expense_occurrences
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Templates are deactivated, never deleted. Occurrences are immutable decisions.
REVOKE DELETE, TRUNCATE ON recurring_expense_templates FROM app_user;
GRANT SELECT, INSERT, UPDATE ON recurring_expense_templates TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON recurring_expense_occurrences FROM app_user;
GRANT SELECT, INSERT ON recurring_expense_occurrences TO app_user;

COMMENT ON TABLE recurring_expense_templates IS
  'Branch recurring-expense promises; due dates are computed on read and never post automatically.';
COMMENT ON TABLE recurring_expense_occurrences IS
  'Human paid/skipped decisions for generated due dates; a paid row links exactly one ordinary expense.';
