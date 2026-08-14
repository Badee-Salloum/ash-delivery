-- 0031 - immutable, manager-confirmed cash/wallet settlement snapshot
--
-- A close approval moves real money twice: the whole app-wallet balance is collected/funded back
-- to zero, then the employee's final entitlement is settled through one signed cash action.  The
-- preview used to be recomputed on every GET and the approval stored only fragments on `shifts`, so
-- a later policy/configuration change could make the screen tell a different story from the journal
-- that was actually signed.  This table freezes that complete story once per shift.
--
-- The migration runner is forward-only. Before any 0031 data is accepted, an operational rollback
-- is: DROP TABLE shift_settlements; DROP FUNCTION guard_shift_settlement_insert();
-- DROP FUNCTION reject_shift_settlement_mutation(); DROP TRIGGER shift_decisions_append_only ON
-- shift_decisions; DROP FUNCTION reject_shift_decision_mutation(); restore the old decision CHECK
-- and app grants, then remove 0031 from schema_migrations. After settlements
-- exist they are financial records and rollback is a forward compensating migration/export, never
-- a destructive down migration.

-- A force-close is deliberately two-phase: first freeze its boundary/actuals, then show and confirm
-- the final settlement. Keep that preparation durable in the existing append-only decision log so
-- another manager/device can safely resume it after a refresh.
ALTER TABLE shift_decisions
  DROP CONSTRAINT shift_decisions_decision_check;
ALTER TABLE shift_decisions
  ADD CONSTRAINT shift_decisions_decision_check
  CHECK (decision IN ('approved', 'rejected', 'rephoto_requested', 'force_close_prepared'));

-- This log now authorises phase two of a force-close, so direct mutation must be a database fact,
-- not merely an application convention. The sole deletion exception is the existing parent-shift
-- cascade used to discard a never-opened draft/awaiting shift as one aggregate. The row trigger also
-- protects deployments accidentally running with an owner credential, where grants alone provide
-- no defence.
REVOKE UPDATE, DELETE, TRUNCATE ON shift_decisions FROM app_user;
GRANT SELECT, INSERT ON shift_decisions TO app_user;

CREATE FUNCTION reject_shift_decision_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- `shifts -> shift_decisions` has intentionally used ON DELETE CASCADE since 0005. Its AFTER
  -- referential action runs after the parent row is no longer visible, which distinguishes deleting
  -- the whole never-opened aggregate from an attempt to erase one decision while its shift remains.
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = OLD.shift_id)
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'shift decisions are append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER shift_decisions_append_only
  BEFORE UPDATE OR DELETE ON shift_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_shift_decision_mutation();

CREATE TABLE shift_settlements (
  id                              bigserial PRIMARY KEY,
  shift_id                        uuid NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE RESTRICT,
  branch_id                       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  driver_id                       uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  business_date                   date NOT NULL,

  policy_code                     text NOT NULL,
  driver_rate_bps                 integer NOT NULL,
  delivery_fee_total_minor        bigint NOT NULL,
  fixed_driver_share_minor        bigint NOT NULL,
  manual_driver_share_minor       bigint NOT NULL,
  gross_driver_share_minor        bigint NOT NULL,
  cash_deduction_total_minor      bigint NOT NULL,
  base_driver_share_minor         bigint NOT NULL,

  expected_total_minor            bigint NOT NULL,
  actual_cash_minor               bigint NOT NULL,
  actual_wallet_minor             bigint NOT NULL,
  actual_total_minor              bigint NOT NULL,
  variance_minor                  bigint NOT NULL,
  variance_direction              text NOT NULL,
  final_employee_cash_minor       bigint NOT NULL,

  -- Signed office directions. Positive = office receives; negative = office supplies.
  wallet_to_office_minor          bigint NOT NULL,
  cash_to_office_minor            bigint NOT NULL,
  wallet_action                   text NOT NULL,
  wallet_amount_minor             bigint NOT NULL,
  cash_action                     text NOT NULL,
  cash_amount_minor               bigint NOT NULL,

  reviewed_orders_hash            text NOT NULL,
  settlement_hash                 text NOT NULL UNIQUE,
  wallet_transfer_confirmed       boolean NOT NULL,
  cash_settlement_confirmed       boolean NOT NULL,
  confirmed_by                    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at                    timestamptz NOT NULL,
  variance_reason                 text,

  CONSTRAINT shift_settlements_fixed_policy_ck CHECK (
    policy_code = 'fixed_40_cash_close_v1' AND driver_rate_bps = 4000
  ),
  CONSTRAINT shift_settlements_nonnegative_ck CHECK (
    delivery_fee_total_minor >= 0
    AND fixed_driver_share_minor >= 0
    AND manual_driver_share_minor >= 0
    AND gross_driver_share_minor >= 0
    AND cash_deduction_total_minor >= 0
    AND actual_cash_minor >= 0
    AND wallet_amount_minor >= 0
    AND cash_amount_minor >= 0
  ),
  -- Overflow-safe floor(delivery fees * 40%). Both multiplicands in the remainder term are small.
  CONSTRAINT shift_settlements_fixed_share_ck CHECK (
    fixed_driver_share_minor =
      (delivery_fee_total_minor / 10000) * driver_rate_bps
      + ((delivery_fee_total_minor % 10000) * driver_rate_bps) / 10000
  ),
  CONSTRAINT shift_settlements_gross_share_ck CHECK (
    gross_driver_share_minor = fixed_driver_share_minor + manual_driver_share_minor
  ),
  CONSTRAINT shift_settlements_base_share_ck CHECK (
    base_driver_share_minor = gross_driver_share_minor - cash_deduction_total_minor
  ),
  CONSTRAINT shift_settlements_actual_total_ck CHECK (
    actual_total_minor = actual_cash_minor + actual_wallet_minor
  ),
  CONSTRAINT shift_settlements_variance_ck CHECK (
    variance_minor = actual_total_minor - expected_total_minor
  ),
  CONSTRAINT shift_settlements_variance_direction_ck CHECK (
       (variance_minor > 0 AND variance_direction = 'surplus')
    OR (variance_minor < 0 AND variance_direction = 'shortage')
    OR (variance_minor = 0 AND variance_direction = 'balanced')
  ),
  CONSTRAINT shift_settlements_final_cash_ck CHECK (
    final_employee_cash_minor = base_driver_share_minor + variance_minor
  ),
  -- The wallet action always clears the complete reviewed balance, including a negative balance.
  CONSTRAINT shift_settlements_wallet_full_return_ck CHECK (
    wallet_to_office_minor = actual_wallet_minor
  ),
  CONSTRAINT shift_settlements_wallet_action_ck CHECK (
       (wallet_to_office_minor > 0 AND wallet_action = 'collect' AND wallet_amount_minor = wallet_to_office_minor)
    OR (wallet_to_office_minor < 0 AND wallet_action = 'fund' AND wallet_amount_minor = -wallet_to_office_minor)
    OR (wallet_to_office_minor = 0 AND wallet_action = 'none' AND wallet_amount_minor = 0)
  ),
  -- Every other obligation is closed through cash. A negative result is an explicit office payout.
  CONSTRAINT shift_settlements_cash_close_ck CHECK (
    cash_to_office_minor = actual_cash_minor - final_employee_cash_minor
  ),
  CONSTRAINT shift_settlements_cash_action_ck CHECK (
       (cash_to_office_minor > 0 AND cash_action = 'collect' AND cash_amount_minor = cash_to_office_minor)
    OR (cash_to_office_minor < 0 AND cash_action = 'pay' AND cash_amount_minor = -cash_to_office_minor)
    OR (cash_to_office_minor = 0 AND cash_action = 'none' AND cash_amount_minor = 0)
  ),
  CONSTRAINT shift_settlements_hash_ck CHECK (
    char_length(reviewed_orders_hash) BETWEEN 1 AND 128
    AND settlement_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT shift_settlements_confirmed_ck CHECK (
    wallet_transfer_confirmed AND cash_settlement_confirmed
  ),
  CONSTRAINT shift_settlements_variance_reason_ck CHECK (
    char_length(variance_reason) <= 500
    AND (variance_minor = 0 OR NULLIF(btrim(variance_reason), '') IS NOT NULL)
  )
);

COMMENT ON TABLE shift_settlements IS
  'Append-only close settlement: fixed policy inputs, reviewed actuals, wallet/cash actions and manager confirmations.';
COMMENT ON COLUMN shift_settlements.wallet_to_office_minor IS
  'Signed full-wallet action: positive is collected by the office; negative is funded by the office.';
COMMENT ON COLUMN shift_settlements.cash_to_office_minor IS
  'Signed cash close after employee entitlement: positive collect, negative pay.';
COMMENT ON COLUMN shift_settlements.settlement_hash IS
  'sha256 of the canonical decision-complete snapshot shown to the approving manager.';

-- Application code can append and read, but never revise/delete/truncate a signed settlement.
REVOKE UPDATE, DELETE, TRUNCATE ON shift_settlements FROM app_user;
GRANT SELECT, INSERT ON shift_settlements TO app_user;
GRANT USAGE, SELECT ON SEQUENCE shift_settlements_id_seq TO app_user;

CREATE FUNCTION guard_shift_settlement_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor         uuid;
  v_branch        uuid;
  v_driver        uuid;
  v_business_date date;
  v_state         text;
  v_submitted_at  timestamptz;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  SELECT s.branch_id, s.driver_id, s.business_date, s.state, s.submitted_at
    INTO v_branch, v_driver, v_business_date, v_state, v_submitted_at
    FROM public.shifts s
   WHERE s.id = NEW.shift_id;

  IF v_branch IS NULL
     OR NEW.branch_id IS DISTINCT FROM v_branch
     OR NEW.driver_id IS DISTINCT FROM v_driver
     OR NEW.business_date IS DISTINCT FROM v_business_date
  THEN
    RAISE EXCEPTION 'settlement identity must match its shift'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_settlements_identity_guard';
  END IF;

  IF v_state <> 'pending_review' OR v_submitted_at IS NULL THEN
    RAISE EXCEPTION 'settlement may be signed only for a submitted shift under review'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_settlements_shift_state_guard';
  END IF;

  IF v_actor IS NULL
     OR NEW.confirmed_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
        WHERE u.id = v_actor
          AND u.active
          AND (
            u.role_key IN ('general_manager', 'system_admin')
            OR (u.role_key = 'branch_manager' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'settlement confirmation requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_settlements_confirmation_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER shift_settlements_insert_guard
  BEFORE INSERT ON shift_settlements
  FOR EACH ROW EXECUTE FUNCTION guard_shift_settlement_insert();

CREATE FUNCTION reject_shift_settlement_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'shift settlements are immutable; post a compensating journal event'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER shift_settlements_immutable
  BEFORE UPDATE OR DELETE ON shift_settlements
  FOR EACH ROW EXECUTE FUNCTION reject_shift_settlement_mutation();

-- The immutable row is already its own evidence, but its creation must still carry actor/request
-- context in the common audit stream alongside the shift and journal rows it accompanies.
CREATE TRIGGER audit_shift_settlements
  AFTER INSERT OR UPDATE OR DELETE ON shift_settlements
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
