-- 0052 - leave an unpaid close-time shortage as an ordinary driver receivable
--
-- The shift already moved the opening float and every top-up out of the office. When the driver
-- cannot contribute the negative final employee cash at close, booking a later direct `create`
-- command would credit office_cash a second time. This settlement-owned amount instead replaces
-- only the missing physical close receipt: operational custody is cleared once, office_cash gets
-- only what physically arrived, and driver_receivable_cash preserves the unpaid office asset.

ALTER TABLE shift_settlements
  ADD COLUMN maximum_cash_shortage_receivable_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN cash_shortage_receivable_minor bigint NOT NULL DEFAULT 0;

-- The maximum is derived evidence, not a new historical decision. Backfill it so old immutable
-- rows remain readable through the current record contract while their selected amount stays zero.
ALTER TABLE shift_settlements DISABLE TRIGGER shift_settlements_immutable;

UPDATE shift_settlements
   SET maximum_cash_shortage_receivable_minor =
         GREATEST(-final_employee_cash_minor::numeric, 0::numeric)::bigint;

ALTER TABLE shift_settlements ENABLE TRIGGER shift_settlements_immutable;

ALTER TABLE shift_settlements
  DROP CONSTRAINT shift_settlements_fixed_policy_ck,
  DROP CONSTRAINT shift_settlements_nonnegative_ck,
  DROP CONSTRAINT shift_settlements_receivable_bounds_ck,
  DROP CONSTRAINT shift_settlements_physical_movements_ck;

ALTER TABLE shift_settlements
  ADD CONSTRAINT shift_settlements_fixed_policy_ck CHECK (
    driver_rate_bps = 4000
    AND policy_code IN ('fixed_40_cash_close_v1', 'fixed_40_cash_close_v2_receivable')
    AND (
      policy_code <> 'fixed_40_cash_close_v1'
      OR (
        cash_receivable_deferred_minor = 0
        AND wallet_receivable_deferred_minor = 0
        AND cash_shortage_receivable_minor = 0
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
    AND maximum_cash_shortage_receivable_minor >= 0
    AND cash_shortage_receivable_minor >= 0
  ),
  ADD CONSTRAINT shift_settlements_receivable_bounds_ck CHECK (
    cash_receivable_deferred_minor::numeric <=
      GREATEST(cash_claim_to_office_minor::numeric, 0::numeric)
    AND wallet_receivable_deferred_minor::numeric <=
      GREATEST(wallet_claim_to_office_minor::numeric, 0::numeric)
    AND maximum_cash_shortage_receivable_minor::numeric =
      GREATEST(-final_employee_cash_minor::numeric, 0::numeric)
    AND cash_shortage_receivable_minor::numeric <=
      maximum_cash_shortage_receivable_minor::numeric
  ),
  ADD CONSTRAINT shift_settlements_physical_movements_ck CHECK (
    cash_to_office_minor::numeric =
      cash_claim_to_office_minor::numeric
      - cash_receivable_deferred_minor::numeric
      - cash_shortage_receivable_minor::numeric
    AND wallet_to_office_minor::numeric =
      wallet_claim_to_office_minor::numeric - wallet_receivable_deferred_minor::numeric
  );

COMMENT ON COLUMN shift_settlements.maximum_cash_shortage_receivable_minor IS
  'Frozen reviewed maximum for an unpaid current-shift shortage: max(-final_employee_cash_minor, 0).';
COMMENT ON COLUMN shift_settlements.cash_shortage_receivable_minor IS
  'Current-shift shortage left unpaid at close and posted to ordinary driver_receivable_cash without a second office credit.';

-- Keep the deferred close guard authoritative for the new journal line. This exact matcher is also
-- the database-level idempotency proof: one settlement can own only the one expected float_return
-- entry, and the selected receivable must be tied to this shift and this immutable snapshot.
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
  'Exact shift-close journal matcher, including next-shift funding and the current-shift ordinary cash shortage receivable.';
