-- ── 0041: a deferred close collection funds the NEXT shift, it is not an ordinary debt ──────────
--
-- WHAT WAS WRONG. At close a manager may defer part of the collection. The driver physically keeps
-- that cash and/or that Yallago wallet balance. `cashSettledReturnPostings` booked it to
-- `driver_receivable_cash` / `driver_receivable_wallet` — the ORDINARY receivable, which 0036
-- documents as «an office asset owed by the driver until an explicit later collection … never
-- auto-consumed by opening a shift».
--
-- But the money is not waiting for a collection. It is in the driver's pocket and in his app, and
-- he spends it on the next shift's per-order Yallago cuts. `postingsForOpen` reads only
-- `driver_shift_funding_*`, so no carry tranche was created, `floatTotal`/`topupTotal` omitted it,
-- and BR1 at the NEXT close read money the driver already owed as a SURPLUS. Decision 13 assigns
-- the scalar variance to the employee — so the system paid the driver his own debt, once, in full.
-- The receivable still counted toward the capital target, so الترميم read whole and nothing rang.
--
-- This was a rename regression, not a design. `shifts.kept_as_receivable_minor` still carries its
-- 0025 comment: «Cleared when he opens his next shift.» 0036 moved that carry behaviour to the new
-- `driver_shift_funding_*` names and this one posting was left behind on the old name.
--
-- WHY NO ROLLOUT GATE. 0037's expected-line set is filtered by `WHERE expected.movement <> 0`, so a
-- settlement with a zero deferral never emits the row at all and is completely unaffected by the
-- fund name. Only a settlement with a NON-ZERO deferral could disagree with the new matcher, and
-- the guard below proves there are none. A gate that accepts both shapes would be permanent
-- ambiguity bought to solve a problem that does not exist — so this fails loudly instead.
-- Measured on production 2026-08-25: 4 settlements, 0 deferrals in either channel, and no
-- `driver_receivable_*` or `driver_shift_funding_*` fund had yet been created.

DO $$
DECLARE
  v_wallet bigint;
  v_cash   bigint;
BEGIN
  SELECT count(*) FILTER (WHERE wallet_receivable_deferred_minor > 0),
         count(*) FILTER (WHERE cash_receivable_deferred_minor   > 0)
    INTO v_wallet, v_cash
    FROM public.shift_settlements;

  IF v_wallet > 0 OR v_cash > 0 THEN
    RAISE EXCEPTION
      'refusing to replace the close matcher: % wallet and % cash deferral(s) are booked to the ordinary receivable funds',
      v_wallet, v_cash
      USING HINT = 'Move each balance to driver_shift_funding_* with a visible, dated correction entry (BR7) before applying 0041.';
  END IF;
END
$$;

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
  'Proves a terminal shift has EXACTLY the canonical close entries and lines. Since 0041 a deferred collection lands in driver_shift_funding_* so the driver''s next open consumes it as a carried tranche.';

COMMENT ON COLUMN shifts.kept_as_receivable_minor IS
  'يبقى ذمة على السائق — cash left with the driver at close. Booked to driver_shift_funding_cash since 0041, so it is genuinely cleared when he opens his next shift, as this column has claimed since 0025.';
