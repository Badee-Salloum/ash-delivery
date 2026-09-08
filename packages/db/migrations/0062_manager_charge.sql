-- 0062 - «الحسم»: a charge the manager makes against the employee at close
--
-- WHY THIS IS NOT A CASH DEDUCTION. On 2026-09-08 a manager-created CASH DEDUCTION shipped and
-- charged nobody anything. A cash deduction is subtracted from the expected total AND from the
-- share, because it asserts that money physically left the driver during the shift -- which is
-- exactly right for a negative row on the provider's screen, where his declared cash is already
-- lower by it. A charge invented AFTER the count has no such outflow, so the deduction raised the
-- variance by its own amount and decision 13 handed the money back to the employee as a surplus:
--
--     employee = (gross - D) + (V0 + D) = gross + V0        -- D cancels
--
-- This column touches ONE side. `expected_total_minor` is untouched, so the variance still measures
-- only what the physical count disagreed about; `final_employee_cash_minor` falls by the charge and
-- `cash_claim_to_office_minor` rises by it. `base_driver_share_minor` is deliberately NOT reduced:
-- the driver EARNED his share and paid the charge out of it, so the journal credits `other_income`
-- rather than quietly swelling office_cash with money the books cannot explain.
--
-- The pending value lives on `shifts` because it is set during review, before any snapshot exists.
-- It is frozen into `shift_settlements` at approval like every other figure in the close.

ALTER TABLE shifts
  ADD COLUMN manager_charge_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN manager_charge_reason text;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_manager_charge_ck CHECK (
    manager_charge_minor >= 0
    -- A charge without an audited reason is an unexplained deduction from a person's pay. The
    -- reason is the instrument's only evidence: nothing was scanned and nothing was counted.
    AND (manager_charge_minor = 0 OR btrim(COALESCE(manager_charge_reason, '')) <> '')
  );

COMMENT ON COLUMN shifts.manager_charge_minor IS
  'Pending «حسم»: a positive charge against the employee''s close settlement, set during review.';
COMMENT ON COLUMN shifts.manager_charge_reason IS
  'Audited reason for the pending «حسم». Required whenever the amount is non-zero.';

ALTER TABLE shift_settlements
  ADD COLUMN manager_charge_minor bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN shift_settlements.manager_charge_minor IS
  'Frozen «حسم»: charged to the employee and credited to other_income. Reduces final_employee_cash and raises cash_claim_to_office; never reduces base_driver_share.';

-- Every historical row predates the instrument, so the DEFAULT 0 backfill is the whole truth and no
-- immutability trigger needs disabling for it.

ALTER TABLE shift_settlements
  DROP CONSTRAINT shift_settlements_nonnegative_ck;

ALTER TABLE shift_settlements
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
    AND maximum_cash_shortage_receivable_minor >= 0
    AND cash_shortage_receivable_minor >= 0
    AND manager_charge_minor >= 0
  );

-- The office claim must now account for the charge, or a charged close cannot satisfy its own
-- arithmetic guard. This is the identity `cashClaimToOffice = expectedTotal - baseShare + charge
-- - actualWallet` that `planFixedShareSettlement` computes, restated where the database can enforce
-- it against any writer.
ALTER TABLE shift_settlements
  ADD CONSTRAINT shift_settlements_manager_charge_claim_ck CHECK (
    cash_claim_to_office_minor::numeric =
      expected_total_minor::numeric
      - base_driver_share_minor::numeric
      + manager_charge_minor::numeric
      - actual_wallet_minor::numeric
    AND final_employee_cash_minor::numeric =
      base_driver_share_minor::numeric
      + (actual_cash_minor::numeric + actual_wallet_minor::numeric - expected_total_minor::numeric)
      - manager_charge_minor::numeric
  );

-- The close matcher learns the one new line. Everything else is 0052's definition, unchanged.
CREATE OR REPLACE FUNCTION shift_close_journals_match(p_shift_id uuid) RETURNS boolean
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
           ss.cash_shortage_receivable_minor,
           ss.manager_charge_minor,
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
        ('wallet_return', 'wallet_settlement_deferred', 'driver_shift_funding_wallet',
         'driver_shift_funding_wallet:' || st.driver_id::text, 'driver', st.driver_id::text,
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
        ('float_return', 'cash_settlement_deferred', 'driver_shift_funding_cash',
         'driver_shift_funding_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         st.cash_receivable_deferred_minor::numeric),
        ('float_return', 'cash_shortage_receivable', 'driver_receivable_cash',
         'driver_receivable_cash:' || st.driver_id::text, 'driver', st.driver_id::text,
         st.cash_shortage_receivable_minor::numeric),
        -- «الحسم» as income. A CREDIT, so the movement is negative; `WHERE movement <> 0` below
        -- omits the row entirely when no charge was made, matching `cashSettledReturnPostings`.
        -- fund_type is 'cost_center' because `other_income` is a profit-and-loss account and the
        -- fund_type enum deliberately has no value of its own for it (see 0046).
        ('float_return', 'manager_charge', 'cost_center',
         'other_income', 'none', NULL::text, -st.manager_charge_minor::numeric),
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

COMMENT ON FUNCTION shift_close_journals_match(uuid) IS
  'Exact shift-close journal matcher, including next-shift funding, the current-shift ordinary cash shortage receivable, and the manager charge credited to other_income.';
