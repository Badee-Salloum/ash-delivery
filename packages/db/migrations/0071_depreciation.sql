-- 0071 — depreciation reserve transfers, FIFO allocations and releases (finance redesign C5)
--
-- Depreciation is a cash reserve movement, not an expense and not a profit term. At commit the
-- database proves that a transfer equals min(all due through the selected month, cash available
-- immediately before the transfer), and that its immutable allocations exhaust that amount in
-- oldest-period-first order. A shortfall therefore stays due instead of manufacturing cash.

CREATE TABLE depreciation_transfers (
  id                    uuid PRIMARY KEY,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency              text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  expected_amount_minor bigint NOT NULL CHECK (expected_amount_minor > 0),
  syp_minor_per_usd     bigint CHECK (syp_minor_per_usd > 0),
  as_of_month           date NOT NULL CHECK (extract(day FROM as_of_month) = 1),
  business_date         date NOT NULL,
  reason                text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  journal_entry_id      bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT depreciation_transfers_expected_ck CHECK (amount_minor = expected_amount_minor),
  CONSTRAINT depreciation_transfers_month_ck CHECK (
    as_of_month <= date_trunc('month', business_date::timestamp)::date
  ),
  CONSTRAINT depreciation_transfers_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL))
);
CREATE INDEX depreciation_transfers_branch_month_idx
  ON depreciation_transfers (branch_id, currency, as_of_month, created_at);

CREATE TABLE depreciation_allocations (
  transfer_id    uuid NOT NULL REFERENCES depreciation_transfers(id) ON DELETE RESTRICT,
  asset_id       uuid NOT NULL,
  period         integer NOT NULL,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (transfer_id, asset_id, period),
  FOREIGN KEY (asset_id, period) REFERENCES asset_depreciation_schedule(asset_id, period) ON DELETE RESTRICT
);
CREATE INDEX depreciation_allocations_asset_idx ON depreciation_allocations (asset_id, period);

CREATE TABLE depreciation_releases (
  id                    uuid PRIMARY KEY,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency              text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  syp_minor_per_usd     bigint CHECK (syp_minor_per_usd > 0),
  occurred_on           date NOT NULL,
  business_date         date NOT NULL,
  reason                text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  journal_entry_id      bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT depreciation_releases_dates_ck CHECK (
    occurred_on >= DATE '2000-01-01' AND occurred_on <= business_date
  ),
  CONSTRAINT depreciation_releases_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL))
);
CREATE INDEX depreciation_releases_branch_date_idx ON depreciation_releases (branch_id, business_date, created_at);

CREATE TRIGGER depreciation_transfers_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON depreciation_transfers
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER depreciation_releases_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON depreciation_releases
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');

REVOKE UPDATE, DELETE, TRUNCATE ON depreciation_transfers FROM app_user;
GRANT SELECT, INSERT ON depreciation_transfers TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON depreciation_allocations FROM app_user;
GRANT SELECT, INSERT ON depreciation_allocations TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON depreciation_releases FROM app_user;
GRANT SELECT, INSERT ON depreciation_releases TO app_user;
CREATE TRIGGER depreciation_transfers_immutable BEFORE UPDATE OR DELETE ON depreciation_transfers
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER depreciation_allocations_immutable BEFORE UPDATE OR DELETE ON depreciation_allocations
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER depreciation_releases_immutable BEFORE UPDATE OR DELETE ON depreciation_releases
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_depreciation_transfers AFTER INSERT OR UPDATE OR DELETE ON depreciation_transfers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_depreciation_releases AFTER INSERT OR UPDATE OR DELETE ON depreciation_releases
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE UNIQUE INDEX je_depreciation_transfer_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'depreciation_transfer';
CREATE UNIQUE INDEX je_depreciation_release_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'depreciation_release';

CREATE FUNCTION guard_depreciation_transfer_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_actor uuid := public.ash_current_actor();
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'depreciation transfer requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfers_actor_guard';
  END IF;
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'depreciation_transfer', NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'depreciation transfer identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfers_journal_guard';
  END IF;
  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line('depreciation_reserve:' || NEW.currency, 'depreciation_reserve', NEW.currency,
           'D', NEW.amount_minor, 'depreciation_reserved'),
         public.ash_company_line('company_cash:' || NEW.currency, 'company_cash', NEW.currency,
           'C', NEW.amount_minor, 'depreciation_funded')))
  THEN
    RAISE EXCEPTION 'depreciation transfer amount/currency differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfers_lines_guard';
  END IF;
  -- Serialize the deferred min(due, available) proof on the pocket itself.
  PERFORM 1 FROM public.funds f
   WHERE f.branch_id = NEW.branch_id AND f.code = 'company_cash:' || NEW.currency
   FOR UPDATE;
  RETURN NEW;
END
$$;

CREATE TRIGGER depreciation_transfers_insert_guard
  BEFORE INSERT ON depreciation_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_depreciation_transfer_insert();

CREATE FUNCTION guard_depreciation_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_transfer public.depreciation_transfers%ROWTYPE;
  v_asset public.fixed_assets%ROWTYPE;
  v_schedule public.asset_depreciation_schedule%ROWTYPE;
  v_funded numeric;
  v_earlier_due boolean;
BEGIN
  SELECT * INTO v_transfer FROM public.depreciation_transfers t WHERE t.id = NEW.transfer_id;
  SELECT * INTO v_asset FROM public.fixed_assets a WHERE a.id = NEW.asset_id;
  SELECT * INTO v_schedule FROM public.asset_depreciation_schedule s
   WHERE s.asset_id = NEW.asset_id AND s.period = NEW.period
   FOR UPDATE;
  IF v_transfer.id IS NULL OR v_asset.id IS NULL OR v_schedule.asset_id IS NULL THEN RETURN NEW; END IF;
  IF v_asset.branch_id IS DISTINCT FROM v_transfer.branch_id
     OR v_asset.currency IS DISTINCT FROM v_transfer.currency
     OR v_schedule.period_month > v_transfer.as_of_month
  THEN
    RAISE EXCEPTION 'depreciation allocation is outside the transfer ledger, currency or due month'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_allocations_scope_guard';
  END IF;

  SELECT COALESCE(sum(a.amount_minor), 0) INTO v_funded
    FROM public.depreciation_allocations a
   WHERE a.asset_id = NEW.asset_id AND a.period = NEW.period;
  IF v_funded + NEW.amount_minor > v_schedule.amount_minor THEN
    RAISE EXCEPTION 'depreciation allocation exceeds the scheduled period amount'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_allocations_overfund_guard';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.asset_depreciation_schedule s
      JOIN public.fixed_assets fa ON fa.id = s.asset_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(a.amount_minor), 0) AS funded
          FROM public.depreciation_allocations a
         WHERE a.asset_id = s.asset_id AND a.period = s.period
      ) paid ON true
     WHERE fa.branch_id = v_transfer.branch_id
       AND fa.currency = v_transfer.currency
       AND s.period_month <= v_transfer.as_of_month
       AND (s.period_month, s.asset_id, s.period) < (v_schedule.period_month, NEW.asset_id, NEW.period)
       AND s.amount_minor > paid.funded
  ) INTO v_earlier_due;
  IF v_earlier_due THEN
    RAISE EXCEPTION 'depreciation allocations must fund the oldest due period first'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_allocations_fifo_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER depreciation_allocations_insert_guard
  BEFORE INSERT ON depreciation_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_depreciation_allocation_insert();

CREATE FUNCTION assert_depreciation_transfer_exact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- Shared by transfer and allocation rows; use JSON so PL/pgSQL does not resolve a field that
  -- only exists on the other trigger table.
  v_transfer_id uuid := CASE WHEN TG_TABLE_NAME = 'depreciation_transfers'
    THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'transfer_id')::uuid END;
  v_transfer public.depreciation_transfers%ROWTYPE;
  v_allocated numeric;
  v_scheduled numeric;
  v_funded_all numeric;
  v_remaining_after numeric;
  v_due_before numeric;
  v_cash_before numeric;
  v_expected numeric;
BEGIN
  SELECT * INTO v_transfer FROM public.depreciation_transfers t WHERE t.id = v_transfer_id;
  IF v_transfer.id IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(a.amount_minor), 0) INTO v_allocated
    FROM public.depreciation_allocations a WHERE a.transfer_id = v_transfer.id;
  IF v_allocated <> v_transfer.amount_minor THEN
    RAISE EXCEPTION 'depreciation transfer % allocations total % instead of %',
      v_transfer.id, v_allocated, v_transfer.amount_minor
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfer_allocation_total_guard';
  END IF;

  SELECT COALESCE(sum(s.amount_minor), 0) INTO v_scheduled
    FROM public.asset_depreciation_schedule s
    JOIN public.fixed_assets fa ON fa.id = s.asset_id
   WHERE fa.branch_id = v_transfer.branch_id
     AND fa.currency = v_transfer.currency
     AND s.period_month <= v_transfer.as_of_month;
  SELECT COALESCE(sum(a.amount_minor), 0) INTO v_funded_all
    FROM public.depreciation_allocations a
    JOIN public.depreciation_transfers t ON t.id = a.transfer_id
   WHERE t.branch_id = v_transfer.branch_id AND t.currency = v_transfer.currency
     AND EXISTS (
       SELECT 1 FROM public.asset_depreciation_schedule s
        WHERE s.asset_id = a.asset_id AND s.period = a.period
          AND s.period_month <= v_transfer.as_of_month
     );
  v_remaining_after := v_scheduled - v_funded_all;
  IF v_remaining_after < 0 THEN
    RAISE EXCEPTION 'depreciation allocations exceed the due schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfer_due_guard';
  END IF;
  v_due_before := v_remaining_after + v_transfer.amount_minor;
  v_cash_before := public.ash_fund_balance(
    v_transfer.branch_id, 'company_cash:' || v_transfer.currency) + v_transfer.amount_minor;
  v_expected := least(v_due_before, greatest(v_cash_before, 0));
  IF v_transfer.amount_minor <> v_expected THEN
    RAISE EXCEPTION 'depreciation transfer % is %, but min(due %, available %) is %',
      v_transfer.id, v_transfer.amount_minor, v_due_before, v_cash_before, v_expected
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_transfer_expected_guard';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER depreciation_transfers_exact
  AFTER INSERT ON depreciation_transfers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_depreciation_transfer_exact();
CREATE CONSTRAINT TRIGGER depreciation_allocations_exact
  AFTER INSERT ON depreciation_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_depreciation_transfer_exact();

CREATE FUNCTION guard_depreciation_release_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_actor uuid := public.ash_current_actor();
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'depreciation release requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_releases_actor_guard';
  END IF;
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'depreciation_release', NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, NEW.syp_minor_per_usd)
     OR NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line('company_cash:' || NEW.currency, 'company_cash', NEW.currency,
           'D', NEW.amount_minor, 'depreciation_returned'),
         public.ash_company_line('depreciation_reserve:' || NEW.currency, 'depreciation_reserve', NEW.currency,
           'C', NEW.amount_minor, 'depreciation_released')))
  THEN
    RAISE EXCEPTION 'depreciation release differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'depreciation_releases_journal_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER depreciation_releases_insert_guard
  BEFORE INSERT ON depreciation_releases
  FOR EACH ROW EXECUTE FUNCTION guard_depreciation_release_insert();

CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN RETURN NULL; END IF;
  v_ok := NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'deposit')
    WHEN 'company_withdrawal' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'withdrawal')
    WHEN 'company_expense' THEN EXISTS (SELECT 1 FROM public.company_expenses e WHERE e.journal_entry_id = NEW.id)
    WHEN 'company_income' THEN EXISTS (SELECT 1 FROM public.company_incomes i WHERE i.journal_entry_id = NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS (SELECT 1 FROM public.company_fx_exchanges x WHERE x.journal_entry_id = NEW.id)
    WHEN 'company_correction' THEN EXISTS (SELECT 1 FROM public.company_reversals r WHERE r.journal_entry_id = NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS (SELECT 1 FROM public.company_ledger_cutovers c WHERE c.opening_entry_id = NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS (SELECT 1 FROM public.company_restoration_mirrors m WHERE m.mirror_entry_id = NEW.id)
    WHEN 'company_debt_open' THEN EXISTS (SELECT 1 FROM public.company_debts d WHERE d.journal_entry_id = NEW.id)
    WHEN 'company_debt_payment' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id = NEW.id AND e.kind = 'payment')
    WHEN 'company_debt_writeoff' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id = NEW.id AND e.kind = 'writeoff')
    WHEN 'asset_purchase' THEN EXISTS (SELECT 1 FROM public.fixed_assets a WHERE a.journal_entry_id = NEW.id)
    WHEN 'depreciation_transfer' THEN EXISTS (SELECT 1 FROM public.depreciation_transfers t WHERE t.journal_entry_id = NEW.id)
    WHEN 'depreciation_release' THEN EXISTS (SELECT 1 FROM public.depreciation_releases r WHERE r.journal_entry_id = NEW.id)
    ELSE false
  END;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'company journal entry % (%) requires its immutable command row in the same transaction', NEW.id, NEW.event_type
      USING ERRCODE = '23514', CONSTRAINT = 'company_journal_fact_guard';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON TABLE depreciation_transfers IS
  'Cash moved into the depreciation reserve. Amount is min(due through as_of_month, available company cash); no P&L line exists.';
COMMENT ON TABLE depreciation_allocations IS
  'Immutable FIFO allocation of one reserve transfer to scheduled asset periods; derived and fully guarded.';
COMMENT ON TABLE depreciation_releases IS
  'Reasoned release from the depreciation reserve back to the same-currency company pocket; funded periods never reopen.';
