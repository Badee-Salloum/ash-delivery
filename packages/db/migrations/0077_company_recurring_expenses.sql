-- 0077 — company recurring expenses (finance redesign C6)
--
-- Extends the human-triggered P4 schedule. A company occurrence still never posts automatically;
-- its paid decision points at one guarded company_expenses command instead of a branch expense.

ALTER TABLE recurring_expense_templates
  ADD COLUMN template_kind text NOT NULL DEFAULT 'branch'
    CHECK (template_kind IN ('branch', 'company')),
  ADD COLUMN currency text NOT NULL DEFAULT 'SYP_NEW'
    CHECK (currency IN ('SYP_NEW', 'USD')),
  ADD COLUMN paid_from text
    CHECK (paid_from IN ('pocket', 'reserve', 'owner_outside')),
  ADD COLUMN asset_id uuid REFERENCES fixed_assets(id) ON DELETE RESTRICT;

ALTER TABLE recurring_expense_templates ALTER COLUMN channel DROP NOT NULL;
ALTER TABLE recurring_expense_templates
  DROP CONSTRAINT recurring_expense_templates_cost_center_kind_check,
  DROP CONSTRAINT recurring_expense_templates_vehicle_ck;
ALTER TABLE recurring_expense_templates
  ADD CONSTRAINT recurring_expense_templates_scope_shape_ck CHECK (
    (
      template_kind = 'branch'
      AND currency = 'SYP_NEW'
      AND paid_from IS NULL
      AND asset_id IS NULL
      AND channel IN ('office_cash', 'office_wallet')
      AND cost_center_kind IN ('vehicle', 'branch', 'general')
      AND ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL))
    )
    OR
    (
      template_kind = 'company'
      AND channel IS NULL
      AND paid_from IN ('pocket', 'reserve', 'owner_outside')
      AND cost_center_kind IN ('vehicle', 'asset', 'general')
      AND ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL))
      AND ((cost_center_kind = 'asset') = (asset_id IS NOT NULL))
    )
  );

ALTER TABLE recurring_expense_occurrences
  ADD COLUMN company_expense_id uuid UNIQUE REFERENCES company_expenses(id) ON DELETE RESTRICT;
ALTER TABLE recurring_expense_occurrences
  DROP CONSTRAINT recurring_expense_occurrences_shape_ck;
ALTER TABLE recurring_expense_occurrences
  ADD CONSTRAINT recurring_expense_occurrences_shape_ck CHECK (
    (
      status = 'paid'
      AND ((expense_id IS NOT NULL)::integer + (company_expense_id IS NOT NULL)::integer) = 1
      AND (reason IS NULL OR (ash_has_visible_text(reason) AND char_length(reason) <= 500))
    )
    OR
    (
      status = 'skipped'
      AND expense_id IS NULL
      AND company_expense_id IS NULL
      AND ash_has_visible_text(reason)
      AND char_length(reason) <= 500
    )
  );

DROP TRIGGER recurring_expense_templates_00_branch_kind_guard ON recurring_expense_templates;
DROP TRIGGER recurring_expense_occurrences_00_branch_kind_guard ON recurring_expense_occurrences;

CREATE FUNCTION guard_recurring_expense_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_branch_kind text;
BEGIN
  SELECT b.kind INTO v_branch_kind FROM public.branches b WHERE b.id = NEW.branch_id;
  IF v_branch_kind IS DISTINCT FROM NEW.template_kind THEN
    RAISE EXCEPTION 'recurring template ledger differs from its scope'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_template_scope_guard';
  END IF;

  IF NEW.template_kind = 'company' THEN
    IF NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage') THEN
      RAISE EXCEPTION 'company recurring template requires company-fund management'
        USING ERRCODE = '23514', CONSTRAINT = 'company_recurring_expense_actor_guard';
    END IF;
    IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id AND v.active
    ) THEN
      RAISE EXCEPTION 'company recurring template names an inactive vehicle'
        USING ERRCODE = '23514', CONSTRAINT = 'company_recurring_expense_vehicle_guard';
    END IF;
    IF NEW.asset_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.fixed_assets a WHERE a.id = NEW.asset_id AND a.branch_id = NEW.branch_id
    ) THEN
      RAISE EXCEPTION 'company recurring template names an unknown asset'
        USING ERRCODE = '23514', CONSTRAINT = 'company_recurring_expense_asset_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER recurring_expense_templates_00_scope_guard
  BEFORE INSERT OR UPDATE ON recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION guard_recurring_expense_scope();

CREATE OR REPLACE FUNCTION guard_recurring_expense_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_template public.recurring_expense_templates%ROWTYPE;
BEGIN
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
      JOIN public.role_permissions rp ON rp.role_key = u.role_key
     WHERE u.id = v_actor AND u.active
       AND rp.permission_key = CASE WHEN v_template.template_kind = 'company'
                                    THEN 'company_fund.manage' ELSE 'expense.write' END
       AND (rp.scope = 'all' OR (
         v_template.template_kind = 'branch' AND rp.scope = 'branch' AND u.branch_id = NEW.branch_id
       ))
  ) THEN
    RAISE EXCEPTION 'recurring occurrence requires its active scoped writer'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_actor_guard';
  END IF;

  IF NEW.status = 'paid' AND v_template.template_kind = 'branch' AND NOT EXISTS (
    SELECT 1 FROM public.expenses e
     WHERE e.id = NEW.expense_id
       AND NEW.company_expense_id IS NULL
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

  IF NEW.status = 'paid' AND v_template.template_kind = 'company' AND NOT EXISTS (
    SELECT 1 FROM public.company_expenses e
     WHERE e.id = NEW.company_expense_id
       AND NEW.expense_id IS NULL
       AND e.branch_id = NEW.branch_id
       AND e.category_id = v_template.category_id
       AND e.cost_center_kind = v_template.cost_center_kind
       AND e.vehicle_id IS NOT DISTINCT FROM v_template.vehicle_id
       AND e.asset_id IS NOT DISTINCT FROM v_template.asset_id
       AND e.currency = v_template.currency
       AND e.paid_from = v_template.paid_from
       AND e.created_by = NEW.acted_by
       AND e.business_date >= NEW.due_date
       AND (e.amount_minor = v_template.amount_minor OR ash_has_visible_text(NEW.reason))
  ) THEN
    RAISE EXCEPTION 'paid company recurring occurrence differs from its company expense'
      USING ERRCODE = '23514', CONSTRAINT = 'recurring_expense_occurrence_company_expense_guard';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON COLUMN recurring_expense_templates.template_kind IS
  'branch posts an ordinary expense; company posts an HQ company-expense command.';
COMMENT ON COLUMN recurring_expense_occurrences.company_expense_id IS
  'The guarded HQ company expense created by a human pay action.';
