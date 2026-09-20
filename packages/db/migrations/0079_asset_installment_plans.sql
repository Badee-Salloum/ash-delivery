-- 0079 — human-confirmed asset-installment plans
--
-- A financed fixed asset already owns exactly one payable. This migration adds a reminder plan
-- around that existing debt; it never creates an expense and it never creates money by itself.
-- A resolved paid occurrence points at the ordinary immutable company_debt_events payment fact.

CREATE TABLE asset_installment_plans (
  id                    uuid PRIMARY KEY,
  asset_id              uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  debt_id               uuid NOT NULL REFERENCES company_debts(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency              text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  paid_from             text NOT NULL CHECK (paid_from IN ('pocket', 'reserve', 'owner_outside')),
  schedule_kind         text NOT NULL CHECK (schedule_kind IN ('weekly', 'monthly_first', 'every_n_days')),
  weekday               smallint,
  interval_days         smallint,
  starts_on             date NOT NULL CHECK (starts_on >= DATE '2000-01-01'),
  active                boolean NOT NULL DEFAULT true,
  -- A deactivation stops generation beginning on this date. Earlier unresolved dues stay
  -- payable/skippable so replacing bad future terms cannot erase history.
  deactivated_on        date,
  deactivated_at        timestamptz,
  deactivated_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_reason   text,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_installment_plans_schedule_ck CHECK (
    (schedule_kind = 'weekly' AND weekday BETWEEN 0 AND 6 AND interval_days IS NULL)
    OR (schedule_kind = 'monthly_first' AND weekday IS NULL AND interval_days IS NULL)
    OR (schedule_kind = 'every_n_days' AND weekday IS NULL AND interval_days BETWEEN 1 AND 366)
  ),
  CONSTRAINT asset_installment_plans_deactivation_ck CHECK (
    (active AND deactivated_on IS NULL AND deactivated_at IS NULL
            AND deactivated_by IS NULL AND deactivation_reason IS NULL)
    OR
    (NOT active AND deactivated_on IS NOT NULL AND deactivated_at IS NOT NULL
                AND deactivated_by IS NOT NULL
                AND ash_has_visible_text(deactivation_reason)
                AND char_length(deactivation_reason) <= 500)
  )
);

-- Replacement plans are created only after the prior plan is reasonedly deactivated.
CREATE UNIQUE INDEX asset_installment_plans_one_active_asset_uq
  ON asset_installment_plans (asset_id) WHERE active;
CREATE INDEX asset_installment_plans_branch_active_idx
  ON asset_installment_plans (branch_id, active, starts_on, id);
CREATE INDEX asset_installment_plans_debt_idx ON asset_installment_plans (debt_id, id);

CREATE TABLE asset_installment_occurrences (
  id                    uuid PRIMARY KEY,
  plan_id               uuid NOT NULL REFERENCES asset_installment_plans(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  due_date              date NOT NULL,
  status                text NOT NULL CHECK (status IN ('paid', 'skipped')),
  -- A paid occurrence is evidence about this exact existing debt payment, not a second posting.
  debt_event_id         uuid UNIQUE REFERENCES company_debt_events(id) ON DELETE RESTRICT,
  reason                text,
  acted_by              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acted_at              timestamptz NOT NULL,
  UNIQUE (plan_id, due_date),
  CONSTRAINT asset_installment_occurrences_shape_ck CHECK (
    (status = 'paid' AND debt_event_id IS NOT NULL AND reason IS NULL)
    OR
    (status = 'skipped' AND debt_event_id IS NULL
       AND ash_has_visible_text(reason) AND char_length(reason) <= 500)
  )
);
CREATE INDEX asset_installment_occurrences_branch_due_idx
  ON asset_installment_occurrences (branch_id, due_date, plan_id);

CREATE TRIGGER asset_installment_plans_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON asset_installment_plans
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER asset_installment_occurrences_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON asset_installment_occurrences
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');

-- The terms are facts once created. To correct a schedule, deactivate it with a reason and create
-- a replacement; this makes every historical due date independently explainable.
CREATE FUNCTION guard_asset_installment_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_asset public.fixed_assets%ROWTYPE;
  v_debt public.company_debts%ROWTYPE;
  v_debt_code text;
BEGIN
  IF v_actor IS NULL OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage') THEN
    RAISE EXCEPTION 'asset installment plan requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_actor_guard';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_actor OR NOT NEW.active THEN
      RAISE EXCEPTION 'asset installment plan creation attribution or state is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_creation_guard';
    END IF;
    SELECT * INTO v_asset FROM public.fixed_assets a WHERE a.id = NEW.asset_id;
    SELECT * INTO v_debt FROM public.company_debts d WHERE d.id = NEW.debt_id;
    IF v_asset.id IS NULL OR v_debt.id IS NULL
       OR v_asset.branch_id IS DISTINCT FROM NEW.branch_id
       OR v_debt.branch_id IS DISTINCT FROM NEW.branch_id
       OR v_asset.currency IS DISTINCT FROM NEW.currency
       OR v_debt.currency IS DISTINCT FROM NEW.currency
       OR v_asset.debt_id IS DISTINCT FROM NEW.debt_id
       OR v_debt.asset_id IS DISTINCT FROM NEW.asset_id
       OR v_debt.direction <> 'payable'
       OR v_debt.origin <> 'asset_purchase'
    THEN
      RAISE EXCEPTION 'asset installment plan must name its financed asset payable in the same company ledger'
        USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_asset_debt_guard';
    END IF;
    IF NEW.starts_on < v_asset.purchased_on THEN
      RAISE EXCEPTION 'asset installment plan cannot begin before the asset was purchased'
        USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_start_guard';
    END IF;
    v_debt_code := 'company_payable:' || NEW.currency || ':' || NEW.debt_id::text;
    IF public.ash_fund_balance(NEW.branch_id, v_debt_code) >= 0 THEN
      RAISE EXCEPTION 'asset installment plan requires an outstanding payable'
        USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_outstanding_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.debt_id IS DISTINCT FROM OLD.debt_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.paid_from IS DISTINCT FROM OLD.paid_from
     OR NEW.schedule_kind IS DISTINCT FROM OLD.schedule_kind
     OR NEW.weekday IS DISTINCT FROM OLD.weekday
     OR NEW.interval_days IS DISTINCT FROM OLD.interval_days
     OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'asset installment plan terms are immutable; deactivate and replace the plan'
      USING ERRCODE = '55000', CONSTRAINT = 'asset_installment_plans_terms_immutable';
  END IF;
  IF NOT OLD.active THEN
    RAISE EXCEPTION 'a deactivated asset installment plan is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'asset_installment_plans_inactive_immutable';
  END IF;
  IF NEW.active OR NEW.deactivated_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'asset installment plan deactivation requires its acting manager'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_plans_deactivation_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER asset_installment_plans_guard
  BEFORE INSERT OR UPDATE ON asset_installment_plans
  FOR EACH ROW EXECUTE FUNCTION guard_asset_installment_plan();

CREATE FUNCTION guard_asset_installment_occurrence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_plan public.asset_installment_plans%ROWTYPE;
  v_event public.company_debt_events%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM public.asset_installment_plans p WHERE p.id = NEW.plan_id;
  IF v_plan.id IS NULL OR NEW.branch_id IS DISTINCT FROM v_plan.branch_id THEN
    RAISE EXCEPTION 'asset installment occurrence branch differs from its plan'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_occurrences_plan_guard';
  END IF;
  IF NOT public.ash_recurrence_matches(
       v_plan.schedule_kind, v_plan.starts_on, v_plan.weekday, v_plan.interval_days, NEW.due_date
     )
     OR (v_plan.deactivated_on IS NOT NULL AND NEW.due_date >= v_plan.deactivated_on)
  THEN
    RAISE EXCEPTION 'date is not produced by the asset installment schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_occurrences_schedule_guard';
  END IF;
  IF v_actor IS NULL OR NEW.acted_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'asset installment occurrence requires its active company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_occurrences_actor_guard';
  END IF;
  IF NEW.status = 'paid' THEN
    SELECT * INTO v_event FROM public.company_debt_events e WHERE e.id = NEW.debt_event_id;
    IF v_event.id IS NULL OR v_event.debt_id IS DISTINCT FROM v_plan.debt_id
       OR v_event.branch_id IS DISTINCT FROM NEW.branch_id
       OR v_event.kind <> 'payment'
       OR v_event.source IS NULL
       OR v_event.created_by IS DISTINCT FROM NEW.acted_by
       OR v_event.business_date < NEW.due_date
       OR v_event.amount_minor > v_plan.amount_minor
    THEN
      RAISE EXCEPTION 'paid asset installment occurrence differs from its payable debt event'
        USING ERRCODE = '23514', CONSTRAINT = 'asset_installment_occurrences_debt_event_guard';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER asset_installment_occurrences_guard
  BEFORE INSERT ON asset_installment_occurrences
  FOR EACH ROW EXECUTE FUNCTION guard_asset_installment_occurrence();

CREATE TRIGGER audit_asset_installment_plans
  AFTER INSERT OR UPDATE OR DELETE ON asset_installment_plans
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_asset_installment_occurrences
  AFTER INSERT OR UPDATE OR DELETE ON asset_installment_occurrences
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

REVOKE DELETE, TRUNCATE ON asset_installment_plans FROM app_user;
GRANT SELECT, INSERT, UPDATE ON asset_installment_plans TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON asset_installment_occurrences FROM app_user;
GRANT SELECT, INSERT ON asset_installment_occurrences TO app_user;

COMMENT ON TABLE asset_installment_plans IS
  'Human-confirmed recurring payment reminders for the one payable linked to a financed fixed asset.';
COMMENT ON TABLE asset_installment_occurrences IS
  'Paid or skipped asset-installment due dates. Paid rows link an existing immutable company debt payment; they never create an expense.';
