-- 0037 - receivable-aware fixed settlement and immutable direct receivable commands

-- Preserve the economic claim separately from the amount physically transferred. Historical v1
-- rows are backfilled with zero deferral, so their stored meaning and hashes do not change.
ALTER TABLE shift_settlements
  ADD COLUMN cash_claim_to_office_minor bigint,
  ADD COLUMN wallet_claim_to_office_minor bigint,
  ADD COLUMN cash_receivable_deferred_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN wallet_receivable_deferred_minor bigint NOT NULL DEFAULT 0;

-- Historical settlements are append-only to every runtime role. Temporarily suspend only that
-- owner-level mutation trigger for this deterministic backfill; the migration transaction restores
-- it before commit, and any failure rolls the entire schema/data change back.
ALTER TABLE shift_settlements DISABLE TRIGGER shift_settlements_immutable;

UPDATE shift_settlements
   SET cash_claim_to_office_minor = cash_to_office_minor,
       wallet_claim_to_office_minor = wallet_to_office_minor;

ALTER TABLE shift_settlements ENABLE TRIGGER shift_settlements_immutable;

ALTER TABLE shift_settlements
  ALTER COLUMN cash_claim_to_office_minor SET NOT NULL,
  ALTER COLUMN wallet_claim_to_office_minor SET NOT NULL;

ALTER TABLE shift_settlements
  DROP CONSTRAINT shift_settlements_fixed_policy_ck,
  DROP CONSTRAINT shift_settlements_nonnegative_ck,
  DROP CONSTRAINT shift_settlements_gross_share_ck,
  DROP CONSTRAINT shift_settlements_base_share_ck,
  DROP CONSTRAINT shift_settlements_actual_total_ck,
  DROP CONSTRAINT shift_settlements_variance_ck,
  DROP CONSTRAINT shift_settlements_final_cash_ck,
  DROP CONSTRAINT shift_settlements_wallet_full_return_ck,
  DROP CONSTRAINT shift_settlements_wallet_action_ck,
  DROP CONSTRAINT shift_settlements_cash_close_ck,
  DROP CONSTRAINT shift_settlements_cash_action_ck;

ALTER TABLE shift_settlements
  ADD CONSTRAINT shift_settlements_fixed_policy_ck CHECK (
    driver_rate_bps = 4000
    AND policy_code IN ('fixed_40_cash_close_v1', 'fixed_40_cash_close_v2_receivable')
    AND (
      policy_code <> 'fixed_40_cash_close_v1'
      OR (
        cash_receivable_deferred_minor = 0
        AND wallet_receivable_deferred_minor = 0
      )
    )
  ),
  ADD CONSTRAINT shift_settlements_nonnegative_ck CHECK (
    delivery_fee_total_minor >= 0
    AND fixed_driver_share_minor >= 0
    AND manual_driver_share_minor >= 0
    AND gross_driver_share_minor >= 0
    AND cash_deduction_total_minor >= 0
    AND actual_cash_minor >= 0
    AND wallet_amount_minor >= 0
    AND cash_amount_minor >= 0
    AND cash_receivable_deferred_minor >= 0
    AND wallet_receivable_deferred_minor >= 0
  ),
  -- Cast before every aggregate. A set of individually valid bigint inputs may overflow a bigint
  -- intermediate; a CHECK must reject it as a formula mismatch, not abort with numeric overflow.
  ADD CONSTRAINT shift_settlements_gross_share_ck CHECK (
    gross_driver_share_minor::numeric =
      fixed_driver_share_minor::numeric + manual_driver_share_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_base_share_ck CHECK (
    base_driver_share_minor::numeric =
      gross_driver_share_minor::numeric - cash_deduction_total_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_actual_total_ck CHECK (
    actual_total_minor::numeric = actual_cash_minor::numeric + actual_wallet_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_variance_ck CHECK (
    variance_minor::numeric = actual_total_minor::numeric - expected_total_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_final_cash_ck CHECK (
    final_employee_cash_minor::numeric = base_driver_share_minor::numeric + variance_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_claims_ck CHECK (
    cash_claim_to_office_minor::numeric =
      actual_cash_minor::numeric - final_employee_cash_minor::numeric
    AND wallet_claim_to_office_minor = actual_wallet_minor
  ),
  ADD CONSTRAINT shift_settlements_receivable_bounds_ck CHECK (
    cash_receivable_deferred_minor::numeric <=
      GREATEST(cash_claim_to_office_minor::numeric, 0::numeric)
    AND wallet_receivable_deferred_minor::numeric <=
      GREATEST(wallet_claim_to_office_minor::numeric, 0::numeric)
  ),
  ADD CONSTRAINT shift_settlements_physical_movements_ck CHECK (
    cash_to_office_minor::numeric =
      cash_claim_to_office_minor::numeric - cash_receivable_deferred_minor::numeric
    AND wallet_to_office_minor::numeric =
      wallet_claim_to_office_minor::numeric - wallet_receivable_deferred_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_wallet_action_ck CHECK (
       (wallet_to_office_minor > 0 AND wallet_action = 'collect'
         AND wallet_amount_minor = wallet_to_office_minor)
    OR (wallet_to_office_minor < 0 AND wallet_action = 'fund'
         AND wallet_amount_minor::numeric = -wallet_to_office_minor::numeric)
    OR (wallet_to_office_minor = 0 AND wallet_action = 'none' AND wallet_amount_minor = 0)
  ),
  ADD CONSTRAINT shift_settlements_cash_action_ck CHECK (
       (cash_to_office_minor > 0 AND cash_action = 'collect'
         AND cash_amount_minor = cash_to_office_minor)
    OR (cash_to_office_minor < 0 AND cash_action = 'pay'
         AND cash_amount_minor::numeric = -cash_to_office_minor::numeric)
    OR (cash_to_office_minor = 0 AND cash_action = 'none' AND cash_amount_minor = 0)
  );

COMMENT ON COLUMN shift_settlements.cash_claim_to_office_minor IS
  'Signed cash claim before a manager-confirmed receivable deferral.';
COMMENT ON COLUMN shift_settlements.wallet_claim_to_office_minor IS
  'Signed wallet claim before a manager-confirmed receivable deferral.';
COMMENT ON COLUMN shift_settlements.cash_receivable_deferred_minor IS
  'Positive cash claim left outstanding against the driver.';
COMMENT ON COLUMN shift_settlements.wallet_receivable_deferred_minor IS
  'Positive wallet claim left outstanding against the driver.';
COMMENT ON COLUMN shift_settlements.cash_to_office_minor IS
  'Signed physical cash movement after receivable deferral.';
COMMENT ON COLUMN shift_settlements.wallet_to_office_minor IS
  'Signed physical wallet movement after receivable deferral.';

-- Historical v1 settlements mean every reviewed claim was physically closed, hence the zero
-- deferral backfill above. A terminal shift created before settlement snapshots existed may have no
-- row and remains explicit legacy history; it cannot be fabricated retrospectively. Refuse the
-- release if an existing settlement is detached from a terminal shift or projects differently.
-- Settlement preparation belongs in the close draft; a signed immutable settlement and its
-- terminal shift transition must commit together. The deferred trigger below permits the real
-- insert-then-update order inside one close transaction, while allowing an already-terminal legacy
-- shift with no historical snapshot to proceed to week lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM shifts s
      JOIN shift_settlements ss ON ss.shift_id = s.id
     WHERE s.state NOT IN ('approved', 'week_locked')
        OR s.kept_as_receivable_minor IS DISTINCT FROM ss.cash_receivable_deferred_minor
  ) THEN
    RAISE EXCEPTION 'shift terminal state, immutable settlement, and receivable projection are not coupled'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_receivable_projection_guard';
  END IF;
END
$$;

-- `shifts.kept_as_receivable_minor` remains the fast cash projection. Check it at transaction end:
-- settlement insertion happens before the shift row is advanced to approved inside one unit of work.
CREATE FUNCTION check_shift_receivable_projection() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_shift_id uuid;
  v_state text;
  v_projected bigint;
  v_settled bigint;
  v_has_settlement boolean;
  v_require_settlement boolean;
BEGIN
  -- `NEW` is a trigger record whose shape depends on the invoking table. A SQL CASE expression
  -- still resolves both record-field references, so `NEW.shift_id` crashes on `shifts` even when
  -- the other branch is selected. PL/pgSQL control flow evaluates only the matching table shape.
  IF TG_TABLE_NAME = 'shifts' THEN
    v_shift_id := NEW.id;
    -- Existing approved shifts from before 0031 legitimately have no frozen snapshot. A fresh
    -- transition into a terminal state (or a terminal insert) is never legacy and must be coupled.
    v_require_settlement := TG_OP = 'INSERT'
      OR OLD.state NOT IN ('approved', 'week_locked');
  ELSE
    v_shift_id := NEW.shift_id;
    v_require_settlement := true;
  END IF;

  SELECT s.state,
         s.kept_as_receivable_minor,
         ss.cash_receivable_deferred_minor,
         ss.shift_id IS NOT NULL
    INTO v_state, v_projected, v_settled, v_has_settlement
    FROM public.shifts s
    LEFT JOIN public.shift_settlements ss ON ss.shift_id = s.id
   WHERE s.id = v_shift_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_has_settlement AND v_state NOT IN ('approved', 'week_locked') THEN
    RAISE EXCEPTION 'immutable settlement and terminal shift must commit together'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_receivable_projection_guard';
  END IF;

  IF v_state IN ('approved', 'week_locked')
     AND (
       (v_require_settlement AND NOT v_has_settlement)
       OR (v_has_settlement AND v_projected IS DISTINCT FROM v_settled)
     )
  THEN
    RAISE EXCEPTION 'terminal shift requires one matching immutable settlement'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_receivable_projection_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER shift_receivable_projection_from_shift
  AFTER INSERT OR UPDATE ON shifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_receivable_projection();

CREATE CONSTRAINT TRIGGER shift_receivable_projection_from_settlement
  AFTER INSERT ON shift_settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_receivable_projection();

-- A settlement row is only a claim about what was closed. The immutable ledger is the accounting
-- fact, so reaching a terminal state must also prove the exact canonical close entries and lines.
-- Keep this as a set comparison rather than balance-only arithmetic: an unrelated balanced entry,
-- a second occurrence, a look-alike fund code, or a line with the right amount but the wrong role
-- must not satisfy a shift close. EXCEPT ALL also preserves multiplicity, preventing duplicated
-- lines from cancelling one another in an aggregate.
--
-- Zero-money closes legitimately produce no wallet_return/float_return entry. expected_entries is
-- derived from non-zero expected_lines, making absence the exact canonical shape in that case.
CREATE FUNCTION shift_close_journals_match(p_shift_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH settlement AS (
    SELECT ss.shift_id,
           ss.branch_id,
           ss.driver_id,
           ss.business_date,
           ss.policy_code,
           ss.expected_total_minor,
           ss.actual_wallet_minor,
           ss.base_driver_share_minor,
           ss.cash_to_office_minor,
           ss.wallet_to_office_minor,
           ss.cash_receivable_deferred_minor,
           ss.wallet_receivable_deferred_minor,
           s.week_start_date,
           s.wallet_diff_minor
      FROM public.shift_settlements ss
      JOIN public.shifts s ON s.id = ss.shift_id
     WHERE ss.shift_id = p_shift_id
  ), expected_lines AS (
    SELECT st.shift_id,
           expected.event_type,
           '1'::text AS occurrence_key,
           expected.line_role,
           expected.fund_type,
           expected.fund_code,
           expected.owner_kind,
           expected.owner_id,
           st.branch_id::text AS fund_branch_id,
           CASE WHEN expected.movement > 0 THEN 'D' ELSE 'C' END AS side,
           abs(expected.movement)::text AS amount_minor
      FROM settlement st
      CROSS JOIN LATERAL (VALUES
        ('wallet_return', 'wallet_reclassification', 'driver_wallet',
         'driver_wallet:' || st.driver_id::text, 'driver', st.driver_id::text,
         COALESCE(st.wallet_diff_minor::numeric, 0::numeric)),
        ('wallet_return', 'wallet_reclassification', 'driver_cash',
         'driver_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         -COALESCE(st.wallet_diff_minor::numeric, 0::numeric)),
        ('wallet_return', 'wallet_cleared', 'driver_wallet',
         'driver_wallet:' || st.driver_id::text, 'driver', st.driver_id::text,
         -st.actual_wallet_minor::numeric),
        ('wallet_return',
         CASE WHEN st.policy_code = 'fixed_40_cash_close_v1'
              THEN 'wallet_full_return' ELSE 'wallet_settlement' END,
         'office_wallet', 'office_wallet', 'none', NULL::text,
         st.wallet_to_office_minor::numeric),
        ('wallet_return', 'wallet_settlement_deferred', 'driver_receivable_wallet',
         'driver_receivable_wallet:' || st.driver_id::text, 'driver', st.driver_id::text,
         st.wallet_receivable_deferred_minor::numeric),
        ('float_return', 'cash_cleared', 'driver_cash',
         'driver_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         -(st.expected_total_minor::numeric - st.actual_wallet_minor::numeric)),
        ('float_return', 'driver_share_settled', 'driver_share_payable',
         'driver_share_payable:' || st.driver_id::text, 'driver', st.driver_id::text,
         GREATEST(st.base_driver_share_minor::numeric, 0::numeric)),
        ('float_return', 'driver_receivable_settled', 'driver_receivable_cash',
         'driver_receivable_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         LEAST(st.base_driver_share_minor::numeric, 0::numeric)),
        ('float_return', 'cash_settlement_deferred', 'driver_receivable_cash',
         'driver_receivable_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         st.cash_receivable_deferred_minor::numeric),
        ('float_return', 'cash_settlement', 'office_cash',
         'office_cash', 'none', NULL::text, st.cash_to_office_minor::numeric)
      ) AS expected(
        event_type, line_role, fund_type, fund_code, owner_kind, owner_id, movement
      )
     WHERE expected.movement <> 0
  ), expected_entries AS (
    SELECT DISTINCT st.shift_id,
           el.event_type,
           el.occurrence_key,
           st.branch_id::text AS branch_id,
           st.business_date::text AS business_date,
           st.week_start_date::text AS week_start_date,
           NULL::text AS reversal_of_id
      FROM settlement st
      JOIN expected_lines el ON el.shift_id = st.shift_id
  ), actual_entries AS (
    SELECT je.shift_id,
           je.event_type::text AS event_type,
           je.occurrence_key,
           je.branch_id::text AS branch_id,
           je.business_date::text AS business_date,
           je.week_start_date::text AS week_start_date,
           je.reversal_of_id::text AS reversal_of_id
      FROM public.journal_entries je
     WHERE je.shift_id = p_shift_id
       AND je.event_type IN ('wallet_return', 'float_return')
  ), actual_lines AS (
    SELECT je.shift_id,
           je.event_type::text AS event_type,
           je.occurrence_key,
           jl.line_role,
           f.type::text AS fund_type,
           f.code AS fund_code,
           f.owner_kind,
           f.owner_id::text AS owner_id,
           f.branch_id::text AS fund_branch_id,
           jl.side::text AS side,
           jl.amount_minor::text AS amount_minor
      FROM public.journal_entries je
      JOIN public.journal_lines jl ON jl.entry_id = je.id
      JOIN public.funds f ON f.id = jl.fund_id
     WHERE je.shift_id = p_shift_id
       AND je.event_type IN ('wallet_return', 'float_return')
  ), entry_mismatches AS (
    (SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id
       FROM expected_entries
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id
       FROM actual_entries)
    UNION ALL
    (SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id
       FROM actual_entries
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id
       FROM expected_entries)
  ), line_mismatches AS (
    (SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM expected_lines
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM actual_lines)
    UNION ALL
    (SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM actual_lines
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM expected_lines)
  )
  SELECT EXISTS (
           SELECT 1 FROM settlement st WHERE st.wallet_diff_minor IS NOT NULL
         )
     AND NOT EXISTS (SELECT 1 FROM entry_mismatches)
     AND NOT EXISTS (SELECT 1 FROM line_mismatches)
$$;

-- A force-cancel is not a settlement, but it is still a terminal money operation. Its return
-- journals must be the exact inverse of the opening tranches, use the same actor/reason as the
-- single immutable force_cancelled decision, and restore carried funding to the funding
-- receivable rather than inventing office cash. This is deliberately a second matcher: settlement
-- returns and void returns have different canonical recipes and must never be able to impersonate
-- one another.
CREATE FUNCTION shift_void_journals_match(p_shift_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH decision_count AS (
    SELECT count(*) AS force_cancelled_count
      FROM public.shift_decisions sd
     WHERE sd.shift_id = p_shift_id
       AND sd.decision = 'force_cancelled'
  ), cancellation AS (
    SELECT s.id AS shift_id,
           s.branch_id,
           s.driver_id,
           s.business_date,
           s.week_start_date,
           sd.decided_by,
           sd.notes
      FROM public.shifts s
      JOIN public.shift_decisions sd
        ON sd.shift_id = s.id
       AND sd.decision = 'force_cancelled'
      CROSS JOIN decision_count dc
     WHERE s.id = p_shift_id
       AND s.state = 'cancelled'
       AND dc.force_cancelled_count = 1
       AND sd.gate = 'close'
       AND public.ash_has_visible_text(sd.notes)
  ), tranche_totals AS (
    SELECT c.shift_id,
           COALESCE(sum(ft.amount_minor::numeric) FILTER (
             WHERE ft.kind = 'cash_float'
           ), 0::numeric) AS cash_float,
           COALESCE(sum(ft.amount_minor::numeric) FILTER (
             WHERE ft.kind = 'wallet_topup'
           ), 0::numeric) AS wallet_topup,
           COALESCE(sum(ft.amount_minor::numeric) FILTER (
             WHERE ft.kind = 'carried_receivable'
           ), 0::numeric) AS carried_cash,
           COALESCE(sum(ft.amount_minor::numeric) FILTER (
             WHERE ft.kind = 'carried_wallet_receivable'
           ), 0::numeric) AS carried_wallet
      FROM cancellation c
      LEFT JOIN public.float_tranches ft ON ft.shift_id = c.shift_id
     GROUP BY c.shift_id
  ), expected_lines AS (
    SELECT c.shift_id,
           expected.event_type,
           expected.occurrence_key,
           expected.line_role,
           expected.fund_type,
           expected.fund_code,
           expected.owner_kind,
           expected.owner_id,
           c.branch_id::text AS fund_branch_id,
           expected.side,
           expected.amount_minor::text AS amount_minor
      FROM cancellation c
      JOIN tranche_totals tt ON tt.shift_id = c.shift_id
      CROSS JOIN LATERAL (VALUES
        ('float_return'::text, '1'::text, NULL::text, 'office_cash'::text,
         'office_cash'::text, 'none'::text, NULL::text, 'D'::text, tt.cash_float),
        ('float_return', '1', NULL, 'driver_cash',
         'driver_cash:' || c.driver_id::text, 'driver', c.driver_id::text, 'C', tt.cash_float),
        ('wallet_return', '1', NULL, 'office_wallet',
         'office_wallet', 'none', NULL, 'D', tt.wallet_topup),
        ('wallet_return', '1', NULL, 'driver_wallet',
         'driver_wallet:' || c.driver_id::text, 'driver', c.driver_id::text, 'C', tt.wallet_topup),
        ('correction', 'void-carry-' || c.shift_id::text, NULL, 'driver_cash',
         'driver_cash:' || c.driver_id::text, 'driver', c.driver_id::text, 'C', tt.carried_cash),
        ('correction', 'void-carry-' || c.shift_id::text, NULL, 'driver_shift_funding_cash',
         'driver_shift_funding_cash:' || c.driver_id::text, 'driver', c.driver_id::text,
         'D', tt.carried_cash),
        ('correction', 'void-wallet-carry-' || c.shift_id::text, NULL, 'driver_wallet',
         'driver_wallet:' || c.driver_id::text, 'driver', c.driver_id::text,
         'C', tt.carried_wallet),
        ('correction', 'void-wallet-carry-' || c.shift_id::text, NULL,
         'driver_shift_funding_wallet',
         'driver_shift_funding_wallet:' || c.driver_id::text, 'driver', c.driver_id::text,
         'D', tt.carried_wallet)
      ) AS expected(
        event_type, occurrence_key, line_role, fund_type, fund_code, owner_kind, owner_id,
        side, amount_minor
      )
     WHERE expected.amount_minor <> 0
  ), expected_entries AS (
    SELECT DISTINCT c.shift_id,
           el.event_type,
           el.occurrence_key,
           c.branch_id::text AS branch_id,
           c.business_date::text AS business_date,
           c.week_start_date::text AS week_start_date,
           NULL::text AS reversal_of_id,
           c.notes AS reason,
           c.decided_by::text AS created_by
      FROM cancellation c
      JOIN expected_lines el ON el.shift_id = c.shift_id
  ), actual_entries AS (
    SELECT je.shift_id,
           je.event_type::text AS event_type,
           je.occurrence_key,
           je.branch_id::text AS branch_id,
           je.business_date::text AS business_date,
           je.week_start_date::text AS week_start_date,
           je.reversal_of_id::text AS reversal_of_id,
           je.reason,
           je.created_by::text AS created_by
      FROM public.journal_entries je
     WHERE je.shift_id = p_shift_id
       AND (
         je.event_type IN ('wallet_return', 'float_return')
         OR (
           je.event_type = 'correction'
           AND (
             je.occurrence_key LIKE 'void-carry-%'
             OR je.occurrence_key LIKE 'void-wallet-carry-%'
           )
         )
       )
  ), actual_lines AS (
    SELECT je.shift_id,
           je.event_type::text AS event_type,
           je.occurrence_key,
           jl.line_role,
           f.type::text AS fund_type,
           f.code AS fund_code,
           f.owner_kind,
           f.owner_id::text AS owner_id,
           f.branch_id::text AS fund_branch_id,
           jl.side::text AS side,
           jl.amount_minor::text AS amount_minor
      FROM public.journal_entries je
      JOIN public.journal_lines jl ON jl.entry_id = je.id
      JOIN public.funds f ON f.id = jl.fund_id
     WHERE je.shift_id = p_shift_id
       AND (
         je.event_type IN ('wallet_return', 'float_return')
         OR (
           je.event_type = 'correction'
           AND (
             je.occurrence_key LIKE 'void-carry-%'
             OR je.occurrence_key LIKE 'void-wallet-carry-%'
           )
         )
       )
  ), entry_mismatches AS (
    (SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id, reason, created_by
       FROM expected_entries
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id, reason, created_by
       FROM actual_entries)
    UNION ALL
    (SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id, reason, created_by
       FROM actual_entries
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, branch_id, business_date,
            week_start_date, reversal_of_id, reason, created_by
       FROM expected_entries)
  ), line_mismatches AS (
    (SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM expected_lines
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM actual_lines)
    UNION ALL
    (SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM actual_lines
     EXCEPT ALL
     SELECT shift_id, event_type, occurrence_key, line_role, fund_type, fund_code,
            owner_kind, owner_id, fund_branch_id, side, amount_minor
       FROM expected_lines)
  )
  SELECT EXISTS (SELECT 1 FROM cancellation)
     AND NOT EXISTS (SELECT 1 FROM entry_mismatches)
     AND NOT EXISTS (SELECT 1 FROM line_mismatches)
$$;

-- Refuse to install a future-enforcing guard over unexplained historical drift. The coordinated
-- preflight checker reports the offending shifts in detail; this migration never repairs money.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.shifts s
      JOIN public.shift_settlements ss ON ss.shift_id = s.id
     WHERE s.state IN ('approved', 'week_locked')
       AND NOT public.shift_close_journals_match(s.id)
  ) THEN
    RAISE EXCEPTION 'terminal settlement is missing its exact close journals'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_journal_guard';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
      JOIN public.shifts s ON s.id = je.shift_id
     WHERE s.state NOT IN ('approved', 'week_locked', 'cancelled')
       AND (
         je.event_type IN ('wallet_return', 'float_return')
         OR (
           je.event_type = 'correction'
           AND (
             je.occurrence_key LIKE 'void-carry-%'
             OR je.occurrence_key LIKE 'void-wallet-carry-%'
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'nonterminal shift already contains a return/void journal'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_return_state_guard';
  END IF;
END
$$;

CREATE FUNCTION check_shift_close_journals() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_shift_id uuid;
  v_event_type text;
  v_occurrence_key text;
  v_state text;
  v_has_settlement boolean;
  v_from_journal boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'shifts' THEN
    v_shift_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'shift_decisions' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.decision <> 'force_cancelled' THEN
        RETURN OLD;
      END IF;
      v_shift_id := OLD.shift_id;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.decision <> 'force_cancelled' AND NEW.decision <> 'force_cancelled' THEN
        RETURN NEW;
      END IF;
      v_shift_id := NEW.shift_id;
    ELSE
      IF NEW.decision <> 'force_cancelled' THEN
        RETURN NEW;
      END IF;
      v_shift_id := NEW.shift_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'float_tranches' THEN
    IF TG_OP = 'DELETE' THEN
      v_shift_id := OLD.shift_id;
    ELSE
      IF TG_OP = 'UPDATE' AND OLD.shift_id IS DISTINCT FROM NEW.shift_id THEN
        RAISE EXCEPTION 'a float tranche cannot be reassigned to another shift'
          USING ERRCODE = '23514', CONSTRAINT = 'shift_void_journal_guard';
      END IF;
      v_shift_id := NEW.shift_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'journal_lines' THEN
    SELECT je.shift_id, je.event_type::text, je.occurrence_key
      INTO v_shift_id, v_event_type, v_occurrence_key
      FROM public.journal_entries je
     WHERE je.id = NEW.entry_id;
    IF NOT FOUND OR NOT (
      v_event_type IN ('wallet_return', 'float_return')
      OR (
        v_event_type = 'correction'
        AND (
          v_occurrence_key LIKE 'void-carry-%'
          OR v_occurrence_key LIKE 'void-wallet-carry-%'
        )
      )
    ) THEN
      RETURN NEW;
    END IF;
    v_from_journal := true;
  ELSIF TG_TABLE_NAME = 'journal_entries' THEN
    IF NOT (
      NEW.event_type IN ('wallet_return', 'float_return')
      OR (
        NEW.event_type = 'correction'
        AND (
          NEW.occurrence_key LIKE 'void-carry-%'
          OR NEW.occurrence_key LIKE 'void-wallet-carry-%'
        )
      )
    ) THEN
      RETURN NEW;
    END IF;
    v_shift_id := NEW.shift_id;
    v_from_journal := true;
  ELSE
    v_shift_id := NEW.shift_id;
  END IF;

  IF v_shift_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Every close/void transition and every append to its protected journal takes the same row
  -- lock before reading state or line shape. Besides being collision-free, this closes the
  -- write-skew in which a return append and a terminal transition could each validate an old
  -- snapshot and then both commit. A waiter re-reads the row after the winner commits. NO KEY
  -- UPDATE is intentional: it conflicts with another writer but remains compatible with the
  -- journal entry foreign-key check's KEY SHARE lock. FOR UPDATE would turn the close/append race
  -- into a lock-upgrade deadlock.
  PERFORM 1
    FROM public.shifts s
   WHERE s.id = v_shift_id
   FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT s.state, ss.shift_id IS NOT NULL
    INTO v_state, v_has_settlement
    FROM public.shifts s
    LEFT JOIN public.shift_settlements ss ON ss.shift_id = s.id
   WHERE s.id = v_shift_id;

  IF v_state IN ('approved', 'week_locked')
     AND (NOT v_has_settlement OR NOT public.shift_close_journals_match(v_shift_id)) THEN
    RAISE EXCEPTION 'terminal settlement requires the exact canonical close journals'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_journal_guard';
  ELSIF v_state = 'cancelled'
     AND NOT public.shift_void_journals_match(v_shift_id) THEN
    RAISE EXCEPTION 'cancelled shift requires the exact canonical void journals and decision'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_void_journal_guard';
  ELSIF v_from_journal
     AND v_state NOT IN ('approved', 'week_locked', 'cancelled') THEN
    RAISE EXCEPTION 'shift return journals cannot commit before a terminal shift state'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_return_state_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER shift_close_journals_from_shift
  AFTER INSERT OR UPDATE ON shifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_close_journals();

CREATE CONSTRAINT TRIGGER shift_close_journals_from_settlement
  AFTER INSERT ON shift_settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_close_journals();

-- Re-check append-only ledger growth as well as the original close transaction. Without these two
-- inverse triggers, app_user could commit a valid close and later append either another occurrence
-- or balanced extra lines without touching shifts/shift_settlements, leaving the frozen settlement
-- apparently valid while changing its accounting fact.
CREATE CONSTRAINT TRIGGER shift_close_journals_from_entry
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    NEW.shift_id IS NOT NULL
    AND (
      NEW.event_type IN ('wallet_return', 'float_return')
      OR (
        NEW.event_type = 'correction'
        AND (
          NEW.occurrence_key LIKE 'void-carry-%'
          OR NEW.occurrence_key LIKE 'void-wallet-carry-%'
        )
      )
    )
  )
  EXECUTE FUNCTION check_shift_close_journals();

CREATE CONSTRAINT TRIGGER shift_close_journals_from_line
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_close_journals();

CREATE CONSTRAINT TRIGGER shift_void_journals_from_decision
  AFTER INSERT OR UPDATE OR DELETE ON shift_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_close_journals();

-- Wallet funding carried into a shift is distinct from an actual wallet top-up: it raises the
-- driver's opening wallet while clearing a prior shift-funding asset, and does not charge the
-- office wallet a second time.
ALTER TABLE float_tranches DROP CONSTRAINT float_tranches_kind_check;
ALTER TABLE float_tranches ADD CONSTRAINT float_tranches_kind_check
  CHECK (kind IN (
    'cash_float',
    'wallet_topup',
    'carried_receivable',
    'carried_wallet_receivable'
  ));

CREATE CONSTRAINT TRIGGER shift_void_journals_from_tranche
  AFTER INSERT OR UPDATE OR DELETE ON float_tranches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_shift_close_journals();

-- A direct debt or collection is a command in its own right, even without a shift. The immutable
-- row supplies exact replay/conflict semantics and connects the human reason to one balanced entry.
CREATE TABLE receivable_events (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  driver_id         uuid NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  receivable_kind   text NOT NULL CHECK (receivable_kind IN ('ordinary', 'shift_funding')),
  channel           text NOT NULL CHECK (channel IN ('cash', 'wallet')),
  direction         text NOT NULL CHECK (direction IN ('create', 'collect')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  business_date     date NOT NULL,
  reason            text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  idempotency_key   text NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 64),
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, idempotency_key)
);

CREATE INDEX receivable_events_driver_date_idx
  ON receivable_events (branch_id, driver_id, business_date, created_at);

-- Defence in depth for non-shift journal commands; the immutable command table is the primary key.
CREATE UNIQUE INDEX je_receivable_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'receivable_adjustment';

REVOKE UPDATE, DELETE, TRUNCATE ON receivable_events FROM app_user;
GRANT SELECT, INSERT ON receivable_events TO app_user;

-- The command row and journal are one accounting fact. Verify their identity, the exact two-line
-- recipe, the attributed manager, and that a collection cannot drive its named asset negative.
CREATE FUNCTION guard_receivable_event_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor             uuid;
  v_receivable_code   text;
  v_office_code       text;
  v_receivable_type   text;
  v_office_type       text;
  v_receivable_side   char(1);
  v_office_side       char(1);
  v_receivable_role   text;
  v_office_role       text;
  v_receivable_fund_id uuid;
  v_lines_match       boolean;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  -- Match the API's live, editable RBAC matrix. There is deliberately no compiled-role fallback:
  -- an empty/missing grant fails closed, and revoking a formerly privileged role takes effect on
  -- direct SQL immediately. This route's subject is the target branch only, so `own` cannot apply;
  -- `branch` requires the actor's branch to match while `all` is organisation-wide.
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

  v_receivable_code := CASE NEW.receivable_kind
    WHEN 'shift_funding' THEN 'driver_shift_funding_' || NEW.channel || ':' || NEW.driver_id::text
    ELSE 'driver_receivable_' || NEW.channel || ':' || NEW.driver_id::text
  END;
  v_office_code := 'office_' || NEW.channel;
  v_receivable_type := CASE NEW.receivable_kind
    WHEN 'shift_funding' THEN 'driver_shift_funding_' || NEW.channel
    ELSE 'driver_receivable_' || NEW.channel
  END;
  v_office_type := 'office_' || NEW.channel;
  v_receivable_side := CASE NEW.direction WHEN 'create' THEN 'D' ELSE 'C' END;
  v_office_side := CASE NEW.direction WHEN 'create' THEN 'C' ELSE 'D' END;
  v_receivable_role := CASE NEW.direction WHEN 'create' THEN 'receivable_created' ELSE 'receivable_cleared' END;
  v_office_role := CASE NEW.direction WHEN 'create' THEN 'office_value_reclassified' ELSE 'receivable_collected' END;

  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_receivable_code
         AND f.type::text = v_receivable_type
         AND f.owner_kind = 'driver'
         AND f.owner_id = NEW.driver_id
         AND jl.side = v_receivable_side
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = v_receivable_role
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_office_code
         AND f.type::text = v_office_type
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = v_office_side
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = v_office_role
     ) = 1
    INTO v_lines_match
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.journal_entry_id;

  IF NOT COALESCE(v_lines_match, false) THEN
    RAISE EXCEPTION 'receivable command amount/direction differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_lines_guard';
  END IF;

  IF NEW.direction = 'collect' THEN
    -- Serialize the fresh balance read on the named asset itself. Application advisory locks make
    -- normal requests orderly, but this row lock also closes the two-connection write-skew where
    -- concurrent collections could each observe enough pre-existing balance and jointly go below
    -- zero. The second transaction re-reads after the first commits.
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
      RAISE EXCEPTION 'receivable collection exceeds the outstanding balance'
        USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_overcollection_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER receivable_events_insert_guard
  BEFORE INSERT ON receivable_events
  FOR EACH ROW EXECUTE FUNCTION guard_receivable_event_insert();

-- The normal FinancialUOW writes the balanced journal first and its immutable command second.
-- Check the inverse at transaction end so that ordering remains valid but an orphan journal can
-- never commit and bypass event attribution, over-collection protection, or idempotent history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM journal_entries je
      LEFT JOIN receivable_events re ON re.journal_entry_id = je.id
     WHERE je.event_type = 'receivable_adjustment'
       AND (je.shift_id IS NOT NULL OR re.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'receivable adjustment journal is missing its immutable command'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_journal_event_guard';
  END IF;
END
$$;

CREATE FUNCTION check_receivable_journal_event() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.event_type = 'receivable_adjustment'
     AND (
       NEW.shift_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.receivable_events re
          WHERE re.journal_entry_id = NEW.id
       )
     )
  THEN
    RAISE EXCEPTION 'receivable adjustment journal requires one immutable command in the same transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_journal_event_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER receivable_journal_event_from_entry
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_receivable_journal_event();

-- The immutable event validates the journal's two-line recipe when it is first inserted. Re-run
-- that exact check on later line insertion too: journal_lines is append-only to app_user, but
-- INSERT alone was enough to add a balanced pair after commit and silently restate the debt.
CREATE FUNCTION check_receivable_journal_lines() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event              public.receivable_events%ROWTYPE;
  v_event_type         text;
  v_receivable_code    text;
  v_office_code        text;
  v_receivable_type    text;
  v_office_type        text;
  v_receivable_side    char(1);
  v_office_side        char(1);
  v_receivable_role    text;
  v_office_role        text;
  v_lines_match        boolean;
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

  v_receivable_code := CASE v_event.receivable_kind
    WHEN 'shift_funding' THEN
      'driver_shift_funding_' || v_event.channel || ':' || v_event.driver_id::text
    ELSE 'driver_receivable_' || v_event.channel || ':' || v_event.driver_id::text
  END;
  v_office_code := 'office_' || v_event.channel;
  v_receivable_type := CASE v_event.receivable_kind
    WHEN 'shift_funding' THEN 'driver_shift_funding_' || v_event.channel
    ELSE 'driver_receivable_' || v_event.channel
  END;
  v_office_type := 'office_' || v_event.channel;
  v_receivable_side := CASE v_event.direction WHEN 'create' THEN 'D' ELSE 'C' END;
  v_office_side := CASE v_event.direction WHEN 'create' THEN 'C' ELSE 'D' END;
  v_receivable_role := CASE v_event.direction
    WHEN 'create' THEN 'receivable_created' ELSE 'receivable_cleared' END;
  v_office_role := CASE v_event.direction
    WHEN 'create' THEN 'office_value_reclassified' ELSE 'receivable_collected' END;

  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = v_event.branch_id
         AND f.code = v_receivable_code
         AND f.type::text = v_receivable_type
         AND f.owner_kind = 'driver'
         AND f.owner_id = v_event.driver_id
         AND jl.side = v_receivable_side
         AND jl.amount_minor = v_event.amount_minor
         AND jl.line_role = v_receivable_role
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = v_event.branch_id
         AND f.code = v_office_code
         AND f.type::text = v_office_type
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = v_office_side
         AND jl.amount_minor = v_event.amount_minor
         AND jl.line_role = v_office_role
     ) = 1
    INTO v_lines_match
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.entry_id;

  IF NOT COALESCE(v_lines_match, false) THEN
    RAISE EXCEPTION 'immutable receivable journal requires its exact two-line recipe'
      USING ERRCODE = '23514', CONSTRAINT = 'receivable_events_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER receivable_journal_lines_from_line
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_receivable_journal_lines();

CREATE FUNCTION reject_receivable_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'receivable events are immutable; append a collection or correction'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER receivable_events_immutable
  BEFORE UPDATE OR DELETE ON receivable_events
  FOR EACH ROW EXECUTE FUNCTION reject_receivable_event_mutation();

CREATE TRIGGER audit_receivable_events
  AFTER INSERT OR UPDATE OR DELETE ON receivable_events
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
