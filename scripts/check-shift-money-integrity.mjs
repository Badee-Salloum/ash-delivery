#!/usr/bin/env node
/**
 * Read-only, point-in-time audit of shift money and close evidence.
 *
 * This command deliberately has no repair mode. Every database query runs inside a PostgreSQL
 * REPEATABLE READ, READ ONLY transaction; a violation exits 2 so rollout automation can block.
 * Connection/execution failures exit 1. A clean audit exits 0.
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createPool } from '../packages/db/src/pool.ts'

const signed = (sideExpression, amountExpression) =>
  `(CASE WHEN ${sideExpression} = 'D' THEN ${amountExpression}::numeric ELSE -${amountExpression}::numeric END)`

// Keep the pre-migration audit runnable on schema 0034. Migration 0035 installs the equivalent
// `ash_has_visible_text` database function for permanent CHECK constraints, but a release blocker
// must be able to inspect production *before* that migration exists and without creating anything.
const hasVisibleText = (valueExpression) => String.raw`(
  ${valueExpression} IS NOT NULL AND regexp_replace(
    ${valueExpression},
    U&'[[:space:]\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]',
    '',
    'g'
  ) <> ''
)`

/**
 * Checks which use only the schema available through migration 0035.
 *
 * Keep these executable: rollout runs the integrity audit before 0036/0037 as well as after it,
 * and PostgreSQL resolves every referenced column while planning a query even when a CASE branch
 * would never execute. The v2 replacements below are selected only after 0037 is recorded.
 */
export const LEGACY_INTEGRITY_CHECKS = Object.freeze([
  {
    id: 'settlement_formulas',
    description: 'immutable settlement formulas, confirmations, directions, hashes, and variance reasons',
    sql: `
      SELECT ss.shift_id::text AS shift_id,
             ss.variance_minor::text AS variance_minor,
             ss.base_driver_share_minor::text AS base_driver_share_minor,
             ss.actual_total_minor::text AS actual_total_minor,
             'settlement formula or confirmation mismatch' AS issue
        FROM shift_settlements ss
       WHERE ss.policy_code <> 'fixed_40_cash_close_v1'
          OR ss.driver_rate_bps <> 4000
          OR ss.delivery_fee_total_minor < 0
          OR ss.fixed_driver_share_minor < 0
          OR ss.manual_driver_share_minor < 0
          OR ss.gross_driver_share_minor < 0
          OR ss.cash_deduction_total_minor < 0
          OR ss.actual_cash_minor < 0
          OR ss.wallet_amount_minor < 0
          OR ss.cash_amount_minor < 0
          OR ss.fixed_driver_share_minor::numeric <>
             floor(ss.delivery_fee_total_minor::numeric * ss.driver_rate_bps::numeric / 10000)
          OR ss.gross_driver_share_minor::numeric <>
             ss.fixed_driver_share_minor::numeric + ss.manual_driver_share_minor::numeric
          OR ss.base_driver_share_minor::numeric <>
             ss.gross_driver_share_minor::numeric - ss.cash_deduction_total_minor::numeric
          OR ss.actual_total_minor::numeric <>
             ss.actual_cash_minor::numeric + ss.actual_wallet_minor::numeric
          OR ss.variance_minor::numeric <>
             ss.actual_total_minor::numeric - ss.expected_total_minor::numeric
          OR NOT (
               (ss.variance_minor > 0 AND ss.variance_direction = 'surplus')
            OR (ss.variance_minor < 0 AND ss.variance_direction = 'shortage')
            OR (ss.variance_minor = 0 AND ss.variance_direction = 'balanced')
          )
          OR ss.final_employee_cash_minor::numeric <>
             ss.base_driver_share_minor::numeric + ss.variance_minor::numeric
          OR ss.wallet_to_office_minor <> ss.actual_wallet_minor
          OR NOT (
               (ss.wallet_to_office_minor > 0 AND ss.wallet_action = 'collect'
                 AND ss.wallet_amount_minor::numeric = ss.wallet_to_office_minor::numeric)
            OR (ss.wallet_to_office_minor < 0 AND ss.wallet_action = 'fund'
                 AND ss.wallet_amount_minor::numeric = -ss.wallet_to_office_minor::numeric)
            OR (ss.wallet_to_office_minor = 0 AND ss.wallet_action = 'none'
                 AND ss.wallet_amount_minor = 0)
          )
          OR ss.cash_to_office_minor::numeric <>
             ss.actual_cash_minor::numeric - ss.final_employee_cash_minor::numeric
          OR NOT (
               (ss.cash_to_office_minor > 0 AND ss.cash_action = 'collect'
                 AND ss.cash_amount_minor::numeric = ss.cash_to_office_minor::numeric)
            OR (ss.cash_to_office_minor < 0 AND ss.cash_action = 'pay'
                 AND ss.cash_amount_minor::numeric = -ss.cash_to_office_minor::numeric)
            OR (ss.cash_to_office_minor = 0 AND ss.cash_action = 'none'
                 AND ss.cash_amount_minor = 0)
          )
          OR NOT ss.wallet_transfer_confirmed
          OR NOT ss.cash_settlement_confirmed
          OR char_length(ss.reviewed_orders_hash) NOT BETWEEN 1 AND 128
          OR ss.settlement_hash !~ '^[0-9a-f]{64}$'
          OR char_length(COALESCE(ss.variance_reason, '')) > 500
          OR (ss.variance_minor <> 0
              AND NOT ${hasVisibleText('ss.variance_reason')})
    `,
  },
  {
    id: 'settlement_state_coupling',
    description: 'one settlement per terminal shift with matching identity and reviewed figures',
    sql: `
      WITH settlement_rollout AS (
        SELECT applied_at
          FROM schema_migrations
         WHERE filename = '0031_shift_settlements.sql'
      )
      SELECT s.id::text AS shift_id, s.branch_id::text AS branch_id,
             'terminal_shift_missing_settlement' AS issue
        FROM shifts s
        CROSS JOIN settlement_rollout rollout
        LEFT JOIN shift_settlements ss ON ss.shift_id = s.id
       WHERE s.state IN ('approved', 'week_locked')
         AND ss.shift_id IS NULL
         AND (
           s.created_at >= rollout.applied_at
           OR s.approved_at >= rollout.applied_at
           OR EXISTS (
             SELECT 1
               FROM audit_log al
              WHERE al.table_name = 'shifts'
                AND al.record_id = s.id::text
                AND al.action = 'UPDATE'
                AND al.after ->> 'state' = 'approved'
                AND COALESCE(al.before ->> 'state', '') NOT IN ('approved', 'week_locked')
                AND al.occurred_at >= rollout.applied_at
           )
         )
      UNION ALL
      SELECT ss.shift_id::text, ss.branch_id::text, 'settlement_shift_not_terminal'
        FROM shift_settlements ss
        JOIN shifts s ON s.id = ss.shift_id
       WHERE s.state NOT IN ('approved', 'week_locked')
      UNION ALL
      SELECT ss.shift_id::text, ss.branch_id::text, 'settlement_identity_or_review_snapshot_mismatch'
        FROM shift_settlements ss
        JOIN shifts s ON s.id = ss.shift_id
       WHERE ss.branch_id IS DISTINCT FROM s.branch_id
          OR ss.driver_id IS DISTINCT FROM s.driver_id
          OR ss.business_date IS DISTINCT FROM s.business_date
          OR ss.confirmed_by IS DISTINCT FROM s.approved_by
          OR s.submitted_at IS NULL
          OR s.end_cash_declared_minor IS DISTINCT FROM ss.actual_cash_minor
          OR s.end_wallet_declared_minor IS DISTINCT FROM ss.actual_wallet_minor
          OR s.orders_hash IS DISTINCT FROM ss.reviewed_orders_hash
          OR s.cash_diff_minor IS NULL
          OR s.wallet_diff_minor IS NULL
          OR ss.expected_total_minor::numeric <>
             (ss.actual_cash_minor::numeric - COALESCE(s.cash_diff_minor::numeric, 0))
             + (ss.actual_wallet_minor::numeric - COALESCE(s.wallet_diff_minor::numeric, 0))
    `,
  },
  {
    id: 'br1_settlement_snapshot',
    description: 'stored BR1 components and settlement source figures match canonical shift inputs',
    sql: `
      WITH included_orders AS (
        SELECT o.*
          FROM shift_orders o
          JOIN shift_settlements ss ON ss.shift_id = o.shift_id
         WHERE o.included
           AND COALESCE(jsonb_array_length(o.close_draft_review_reasons), 0) = 0
           AND (
             o.window_status <> 'unknown'
             OR (
               o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL
               AND ${hasVisibleText('o.decision_reason')}
             )
           )
      ), included_deductions AS (
        SELECT d.*
          FROM cash_deductions d
          JOIN shift_settlements ss ON ss.shift_id = d.shift_id
         WHERE d.included
           AND COALESCE(jsonb_array_length(d.close_draft_review_reasons), 0) = 0
           AND (
             d.window_status <> 'unknown'
             OR (
               d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL
               AND ${hasVisibleText('d.decision_reason')}
             )
           )
      ), order_totals AS (
        SELECT ss.shift_id,
               COALESCE(sum(io.fee_minor::numeric) FILTER (WHERE io.kind <> 'manual'), 0) AS delivery_fee_total,
               COALESCE(sum(io.driver_share_minor::numeric) FILTER (WHERE io.kind = 'manual'), 0) AS manual_driver_share,
               COALESCE(sum(
                 io.fee_minor::numeric - COALESCE(
                   io.wallet_amount_minor::numeric,
                   CASE WHEN io.pay_mode = 'cash' THEN 0 ELSE io.fee_minor::numeric END
                 )
               ), 0) AS cash_from_orders,
               COALESCE(sum(
                 COALESCE(
                   io.wallet_amount_minor::numeric,
                   CASE WHEN io.pay_mode = 'cash' THEN 0 ELSE io.fee_minor::numeric END
                 ) - CASE
                   WHEN io.kind = 'manual' THEN 0
                   ELSE floor(io.fee_minor::numeric * 2000 / 10000)
                 END
               ), 0) AS wallet_from_orders
          FROM shift_settlements ss
          LEFT JOIN included_orders io ON io.shift_id = ss.shift_id
         GROUP BY ss.shift_id
      ), tranche_totals AS (
        SELECT ss.shift_id,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'cash_float'), 0) AS cash_float,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup
          FROM shift_settlements ss
          LEFT JOIN float_tranches ft ON ft.shift_id = ss.shift_id
         GROUP BY ss.shift_id
      ), deduction_totals AS (
        SELECT ss.shift_id,
               COALESCE(sum(d.amount_minor::numeric), 0) AS cash_deductions
          FROM shift_settlements ss
          LEFT JOIN included_deductions d ON d.shift_id = ss.shift_id
         GROUP BY ss.shift_id
      ), canonical_inputs AS (
        SELECT ss.shift_id, s.equation_diff_minor, s.cash_diff_minor, s.wallet_diff_minor,
               s.end_cash_declared_minor, s.end_wallet_declared_minor,
               ot.delivery_fee_total, ot.manual_driver_share, dt.cash_deductions,
               tt.cash_float + tt.carried + ot.cash_from_orders - dt.cash_deductions AS expected_cash,
               tt.wallet_topup + ot.wallet_from_orders AS expected_wallet
          FROM shift_settlements ss
          JOIN shifts s ON s.id = ss.shift_id
          JOIN order_totals ot ON ot.shift_id = ss.shift_id
          JOIN tranche_totals tt ON tt.shift_id = ss.shift_id
          JOIN deduction_totals dt ON dt.shift_id = ss.shift_id
      ), recomputed AS (
        SELECT ci.*,
               ci.expected_cash + ci.expected_wallet AS expected_total,
               ci.end_cash_declared_minor::numeric + ci.end_wallet_declared_minor::numeric
                 - ci.expected_cash - ci.expected_wallet AS scalar_diff,
               ci.end_cash_declared_minor::numeric - ci.expected_cash AS cash_diff,
               ci.end_wallet_declared_minor::numeric - ci.expected_wallet AS wallet_diff
          FROM canonical_inputs ci
      )
      SELECT ss.shift_id::text AS shift_id,
             ss.delivery_fee_total_minor::text AS stored_delivery_fee_total,
             r.delivery_fee_total::text AS canonical_delivery_fee_total,
             ss.manual_driver_share_minor::text AS stored_manual_driver_share,
             r.manual_driver_share::text AS canonical_manual_driver_share,
             ss.cash_deduction_total_minor::text AS stored_cash_deductions,
             r.cash_deductions::text AS canonical_cash_deductions,
             ss.expected_total_minor::text AS stored_expected_total,
             r.expected_total::text AS canonical_expected_total,
             r.equation_diff_minor::text AS stored_scalar_diff,
             r.scalar_diff::text AS canonical_scalar_diff,
             r.cash_diff_minor::text AS stored_cash_diff,
             r.cash_diff::text AS canonical_cash_diff,
             r.wallet_diff_minor::text AS stored_wallet_diff,
             r.wallet_diff::text AS canonical_wallet_diff
        FROM shift_settlements ss
        JOIN recomputed r ON r.shift_id = ss.shift_id
       WHERE r.equation_diff_minor::numeric IS DISTINCT FROM r.scalar_diff
          OR r.cash_diff_minor::numeric IS DISTINCT FROM r.cash_diff
          OR r.wallet_diff_minor::numeric IS DISTINCT FROM r.wallet_diff
          OR ss.delivery_fee_total_minor::numeric IS DISTINCT FROM r.delivery_fee_total
          OR ss.manual_driver_share_minor::numeric IS DISTINCT FROM r.manual_driver_share
          OR ss.cash_deduction_total_minor::numeric IS DISTINCT FROM r.cash_deductions
          OR ss.expected_total_minor::numeric IS DISTINCT FROM r.expected_total
          OR ss.actual_cash_minor IS DISTINCT FROM r.end_cash_declared_minor
          OR ss.actual_wallet_minor IS DISTINCT FROM r.end_wallet_declared_minor
          OR ss.variance_minor::numeric IS DISTINCT FROM r.scalar_diff
    `,
  },
  {
    id: 'journal_metadata_alignment',
    description: 'shift journals and every referenced fund stay in the shift branch and accounting period',
    sql: `
      SELECT je.id::text AS journal_entry_id,
             je.shift_id::text AS shift_id,
             je.branch_id::text AS journal_branch_id,
             s.branch_id::text AS shift_branch_id,
             je.business_date::text AS journal_business_date,
             s.business_date::text AS shift_business_date,
             je.week_start_date::text AS journal_week_start_date,
             s.week_start_date::text AS shift_week_start_date,
             CASE
               WHEN je.branch_id IS DISTINCT FROM s.branch_id THEN 'journal_shift_branch_mismatch'
               WHEN je.business_date IS DISTINCT FROM s.business_date THEN 'journal_shift_business_date_mismatch'
               WHEN je.week_start_date IS DISTINCT FROM s.week_start_date THEN 'journal_shift_week_mismatch'
               ELSE 'journal_fund_branch_mismatch'
             END AS issue
        FROM journal_entries je
        JOIN shifts s ON s.id = je.shift_id
       WHERE je.branch_id IS DISTINCT FROM s.branch_id
          OR je.business_date IS DISTINCT FROM s.business_date
          OR je.week_start_date IS DISTINCT FROM s.week_start_date
          OR EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN funds f ON f.id = jl.fund_id
             WHERE jl.entry_id = je.id
               AND f.branch_id IS DISTINCT FROM je.branch_id
          )
    `,
  },
  {
    id: 'double_entry',
    description: 'every journal entry has positive lines with equal debit and credit totals',
    sql: `
      SELECT je.id::text AS journal_entry_id,
             je.shift_id::text AS shift_id,
             je.event_type::text AS event_type,
             COALESCE(sum(jl.amount_minor::numeric) FILTER (WHERE jl.side = 'D'), 0)::text AS debits,
             COALESCE(sum(jl.amount_minor::numeric) FILTER (WHERE jl.side = 'C'), 0)::text AS credits,
             count(jl.id)::text AS line_count
        FROM journal_entries je
        LEFT JOIN journal_lines jl ON jl.entry_id = je.id
       GROUP BY je.id, je.shift_id, je.event_type
      HAVING count(jl.id) < 2
          OR COALESCE(bool_or(jl.amount_minor <= 0), false)
          OR COALESCE(sum(jl.amount_minor::numeric) FILTER (WHERE jl.side = 'D'), 0)
             <> COALESCE(sum(jl.amount_minor::numeric) FILTER (WHERE jl.side = 'C'), 0)
    `,
  },
  {
    id: 'tranche_journal_totals',
    description: 'cash, carried receivable, and wallet tranche totals agree with their journals (excluding pre-integrity cancelled history)',
    sql: `
      WITH integrity_rollout AS (
        SELECT COALESCE(
          (SELECT applied_at FROM schema_migrations
            WHERE filename = '0035_shift_money_integrity.sql'),
          '-infinity'::timestamptz
        ) AS applied_at
      ), eligible_shifts AS (
        SELECT s.*
          FROM shifts s
          CROSS JOIN integrity_rollout rollout
         WHERE s.state <> 'cancelled'
            OR s.created_at >= rollout.applied_at
            OR EXISTS (
              SELECT 1 FROM audit_log al
               WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                 AND al.action = 'UPDATE'
                 AND al.after ->> 'state' = 'cancelled'
                 AND COALESCE(al.before ->> 'state', '') <> 'cancelled'
                 AND al.occurred_at >= rollout.applied_at
            )
            OR EXISTS (
              SELECT 1 FROM shift_decisions sd
               WHERE sd.shift_id = s.id AND sd.decision = 'force_cancelled'
                 AND sd.decided_at >= rollout.applied_at
            )
      ), tranche_totals AS (
        SELECT ft.shift_id,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'cash_float'), 0) AS cash_float,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup
          FROM float_tranches ft
         GROUP BY ft.shift_id
      ), entry_shapes AS (
        SELECT je.id, je.shift_id, je.event_type::text AS event_type,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'D' AND f.type::text = 'driver_cash'
                   AND f.owner_id = s.driver_id
               ), 0) AS driver_cash_debit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'D' AND f.type::text = 'driver_wallet'
                   AND f.owner_id = s.driver_id
               ), 0) AS driver_wallet_debit,
               COALESCE(bool_or(jl.side = 'C' AND f.type::text = 'office_cash'), false) AS office_cash_credit,
               COALESCE(bool_or(jl.side = 'C' AND f.type::text = 'driver_receivable_cash'), false) AS receivable_credit,
               COALESCE(bool_or(jl.side = 'C' AND f.type::text = 'office_wallet'), false) AS office_wallet_credit,
               count(jl.id) AS line_count
          FROM journal_entries je
          JOIN eligible_shifts s ON s.id = je.shift_id
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         WHERE je.shift_id IS NOT NULL AND je.event_type IN ('float_out', 'wallet_topup')
         GROUP BY je.id, je.shift_id, je.event_type, s.driver_id
      ), journal_totals AS (
        SELECT es.shift_id,
               COALESCE(sum(es.driver_cash_debit) FILTER (
                 WHERE es.event_type = 'float_out' AND es.office_cash_credit AND NOT es.receivable_credit
               ), 0) AS cash_float,
               COALESCE(sum(es.driver_cash_debit) FILTER (
                 WHERE es.event_type = 'float_out' AND es.receivable_credit AND NOT es.office_cash_credit
               ), 0) AS carried,
               COALESCE(sum(es.driver_wallet_debit) FILTER (
                 WHERE es.event_type = 'wallet_topup' AND es.office_wallet_credit
               ), 0) AS wallet_topup,
               count(*) FILTER (
                 WHERE (es.event_type = 'float_out'
                        AND es.office_cash_credit = es.receivable_credit)
                    OR (es.event_type = 'wallet_topup' AND NOT es.office_wallet_credit)
                    OR es.line_count <> 2
               ) AS malformed_entries
          FROM entry_shapes es
         GROUP BY es.shift_id
      )
      SELECT s.id::text AS shift_id,
             s.start_cash_float_minor::text AS shift_cash_float,
             COALESCE(tt.cash_float, 0)::text AS tranche_cash_float,
             COALESCE(jt.cash_float, 0)::text AS journal_cash_float,
             COALESCE(tt.carried, 0)::text AS tranche_carried,
             COALESCE(jt.carried, 0)::text AS journal_carried,
             s.start_wallet_topup_minor::text AS shift_wallet_topup,
             COALESCE(tt.wallet_topup, 0)::text AS tranche_wallet_topup,
             COALESCE(jt.wallet_topup, 0)::text AS journal_wallet_topup,
             COALESCE(jt.malformed_entries, 0)::text AS malformed_entries
        FROM eligible_shifts s
        LEFT JOIN tranche_totals tt ON tt.shift_id = s.id
        LEFT JOIN journal_totals jt ON jt.shift_id = s.id
       WHERE s.start_cash_float_minor::numeric <> COALESCE(tt.cash_float, 0)
          OR COALESCE(tt.cash_float, 0) <> COALESCE(jt.cash_float, 0)
          OR COALESCE(tt.carried, 0) <> COALESCE(jt.carried, 0)
          OR s.start_wallet_topup_minor::numeric <> COALESCE(tt.wallet_topup, 0)
          OR COALESCE(tt.wallet_topup, 0) <> COALESCE(jt.wallet_topup, 0)
          OR COALESCE(jt.malformed_entries, 0) <> 0
    `,
  },
  {
    id: 'expected_close_events',
    description: 'settled shifts have exactly the needed cash/wallet close events and one approval decision',
    sql: `
      WITH journal_counts AS (
        SELECT je.shift_id,
               count(*) FILTER (WHERE je.event_type = 'wallet_return') AS wallet_returns,
               count(*) FILTER (WHERE je.event_type = 'float_return') AS cash_returns,
               count(*) FILTER (
                 WHERE je.event_type IN ('wallet_return', 'float_return') AND je.occurrence_key <> '1'
               ) AS noncanonical_keys
          FROM journal_entries je
         WHERE je.shift_id IS NOT NULL
         GROUP BY je.shift_id
      ), decisions AS (
        SELECT sd.shift_id,
               count(*) FILTER (WHERE sd.gate = 'close' AND sd.decision = 'approved') AS approvals,
               count(*) FILTER (
                 WHERE sd.gate = 'close' AND sd.decision = 'approved'
                   AND sd.decided_by IS DISTINCT FROM ss.confirmed_by
               ) AS wrong_actor
          FROM shift_decisions sd
          JOIN shift_settlements ss ON ss.shift_id = sd.shift_id
         GROUP BY sd.shift_id
      )
      SELECT ss.shift_id::text AS shift_id,
             COALESCE(jc.wallet_returns, 0)::text AS wallet_returns,
             COALESCE(jc.cash_returns, 0)::text AS cash_returns,
             COALESCE(d.approvals, 0)::text AS approval_decisions,
             COALESCE(d.wrong_actor, 0)::text AS wrong_approval_actor,
             CASE WHEN ss.actual_wallet_minor <> 0 OR COALESCE(s.wallet_diff_minor, 0) <> 0
                  THEN '1' ELSE '0' END AS expected_wallet_returns,
             CASE WHEN ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric <> 0
                         OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0
                  THEN '1' ELSE '0' END AS expected_cash_returns
        FROM shift_settlements ss
        JOIN shifts s ON s.id = ss.shift_id
        LEFT JOIN journal_counts jc ON jc.shift_id = ss.shift_id
        LEFT JOIN decisions d ON d.shift_id = ss.shift_id
       WHERE s.wallet_diff_minor IS NULL
          OR COALESCE(jc.wallet_returns, 0) <>
             CASE WHEN ss.actual_wallet_minor <> 0 OR COALESCE(s.wallet_diff_minor, 0) <> 0 THEN 1 ELSE 0 END
          OR COALESCE(jc.cash_returns, 0) <>
             CASE WHEN ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric <> 0
                            OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0
                  THEN 1 ELSE 0 END
          OR COALESCE(jc.noncanonical_keys, 0) <> 0
          OR COALESCE(d.approvals, 0) <> 1
          OR COALESCE(d.wrong_actor, 0) <> 0
    `,
  },
  {
    id: 'close_journal_alignment',
    description: 'settled close journals contain exactly the canonical event and line multiset',
    sql: `
      WITH expected_lines AS (
        SELECT ss.shift_id, expected.event_type, '1'::text AS occurrence_key,
               expected.line_role, expected.fund_type, expected.owner_id,
               ss.branch_id::text AS fund_branch_id,
               CASE WHEN expected.movement > 0 THEN 'D' ELSE 'C' END AS side,
               abs(expected.movement)::text AS amount_minor
          FROM shift_settlements ss
          JOIN shifts s ON s.id = ss.shift_id
          CROSS JOIN LATERAL (VALUES
            ('wallet_return', 'wallet_reclassification', 'driver_wallet',
             ss.driver_id::text, COALESCE(s.wallet_diff_minor::numeric, 0)),
            ('wallet_return', 'wallet_reclassification', 'driver_cash',
             ss.driver_id::text, -COALESCE(s.wallet_diff_minor::numeric, 0)),
            ('wallet_return', 'wallet_cleared', 'driver_wallet',
             ss.driver_id::text, -ss.actual_wallet_minor::numeric),
            ('wallet_return', 'wallet_full_return', 'office_wallet',
             NULL::text, ss.actual_wallet_minor::numeric),
            ('float_return', 'cash_cleared', 'driver_cash',
             ss.driver_id::text, -(ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric)),
            ('float_return', 'driver_share_settled', 'driver_share_payable',
             ss.driver_id::text, GREATEST(ss.base_driver_share_minor::numeric, 0)),
            ('float_return', 'driver_receivable_settled', 'driver_receivable_cash',
             ss.driver_id::text, LEAST(ss.base_driver_share_minor::numeric, 0)),
            ('float_return', 'cash_settlement', 'office_cash',
             NULL::text, ss.cash_to_office_minor::numeric)
          ) AS expected(event_type, line_role, fund_type, owner_id, movement)
         WHERE expected.movement <> 0
      ), expected_shapes AS (
        SELECT ss.shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 el.event_type, el.occurrence_key, el.line_role, el.fund_type, el.owner_id,
                 el.fund_branch_id, el.side, el.amount_minor
               ) ORDER BY el.event_type, el.occurrence_key, el.line_role, el.fund_type,
                          el.owner_id, el.fund_branch_id, el.side, el.amount_minor
               ) FILTER (WHERE el.event_type IS NOT NULL), '[]'::jsonb) AS line_shape,
               CASE WHEN ss.actual_wallet_minor <> 0 OR COALESCE(s.wallet_diff_minor, 0) <> 0
                    THEN 1 ELSE 0 END AS wallet_entries,
               CASE WHEN ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric <> 0
                          OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0
                    THEN 1 ELSE 0 END AS cash_entries
          FROM shift_settlements ss
          JOIN shifts s ON s.id = ss.shift_id
          LEFT JOIN expected_lines el ON el.shift_id = ss.shift_id
         GROUP BY ss.shift_id, ss.actual_wallet_minor, s.wallet_diff_minor,
                  ss.expected_total_minor, ss.base_driver_share_minor, ss.cash_to_office_minor
      ), actual_shapes AS (
        SELECT ss.shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                 f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text
               ) ORDER BY je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                          f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text
               ) FILTER (WHERE jl.id IS NOT NULL), '[]'::jsonb) AS line_shape,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'wallet_return') AS wallet_entries,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'float_return') AS cash_entries
          FROM shift_settlements ss
          LEFT JOIN journal_entries je ON je.shift_id = ss.shift_id
            AND je.event_type IN ('wallet_return', 'float_return')
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY ss.shift_id
      )
      SELECT expected.shift_id::text AS shift_id,
             expected.wallet_entries::text AS expected_wallet_entries,
             actual.wallet_entries::text AS actual_wallet_entries,
             expected.cash_entries::text AS expected_cash_entries,
             actual.cash_entries::text AS actual_cash_entries,
             expected.line_shape AS expected_lines,
             actual.line_shape AS actual_lines
        FROM expected_shapes expected
        JOIN actual_shapes actual ON actual.shift_id = expected.shift_id
        JOIN shifts s ON s.id = expected.shift_id
       WHERE s.wallet_diff_minor IS NULL
          OR actual.wallet_entries <> expected.wallet_entries
          OR actual.cash_entries <> expected.cash_entries
          OR actual.line_shape IS DISTINCT FROM expected.line_shape
    `,
  },
  {
    id: 'force_cancel_integrity',
    description: 'post-rollout force-cancels have one reasoned decision, exact void journals, and no shift residual',
    sql: `
      WITH force_cancel_rollout AS (
        SELECT applied_at
          FROM schema_migrations
         WHERE filename = '0035_shift_money_integrity.sql'
      ), force_decisions AS (
        SELECT sd.shift_id, count(*) AS decision_count,
               array_agg(sd.gate ORDER BY sd.id) AS gates,
               array_agg(sd.notes ORDER BY sd.id) AS notes,
               array_agg(sd.decided_by ORDER BY sd.id) AS actors,
               array_agg(sd.decided_at ORDER BY sd.id) AS decided_at
          FROM shift_decisions sd
         WHERE sd.decision = 'force_cancelled'
         GROUP BY sd.shift_id
      ), cancel_candidates AS (
        SELECT s.*, rollout.applied_at AS rollout_at
          FROM shifts s
          CROSS JOIN force_cancel_rollout rollout
         WHERE s.state = 'cancelled'
           AND (
             s.created_at >= rollout.applied_at
             OR EXISTS (
               SELECT 1 FROM audit_log al
                WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                  AND al.action = 'UPDATE'
                  AND al.after ->> 'state' = 'cancelled'
                  AND COALESCE(al.before ->> 'state', '') <> 'cancelled'
                  AND al.occurred_at >= rollout.applied_at
             )
             OR EXISTS (
               SELECT 1 FROM shift_decisions sd
                WHERE sd.shift_id = s.id AND sd.decision = 'force_cancelled'
                  AND sd.decided_at >= rollout.applied_at
             )
           )
      ), valid_cancelled AS (
        SELECT cc.*, (fd.actors)[1] AS cancel_actor, (fd.notes)[1] AS cancel_reason
          FROM cancel_candidates cc
          JOIN force_decisions fd ON fd.shift_id = cc.id
         WHERE fd.decision_count = 1
           AND (fd.gates)[1] = 'close'
           AND ${hasVisibleText('(fd.notes)[1]')}
           AND (fd.decided_at)[1] >= cc.rollout_at
      ), tranche_totals AS (
        SELECT vc.id AS shift_id,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'cash_float'), 0) AS cash_float,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried
          FROM valid_cancelled vc
          LEFT JOIN float_tranches ft ON ft.shift_id = vc.id
         GROUP BY vc.id
      ), expected_lines AS (
        SELECT vc.id AS shift_id, expected.event_type, expected.occurrence_key,
               expected.line_role, expected.fund_type, expected.owner_id,
               vc.branch_id::text AS fund_branch_id, expected.side,
               expected.amount::text AS amount_minor,
               vc.cancel_reason AS reason, vc.cancel_actor::text AS created_by
          FROM valid_cancelled vc
          JOIN tranche_totals tt ON tt.shift_id = vc.id
          CROSS JOIN LATERAL (VALUES
            ('float_return'::text, '1'::text, NULL::text, 'office_cash'::text,
             NULL::text, 'D'::text, tt.cash_float),
            ('float_return', '1', NULL, 'driver_cash',
             vc.driver_id::text, 'C', tt.cash_float),
            ('wallet_return', '1', NULL, 'office_wallet',
             NULL::text, 'D', tt.wallet_topup),
            ('wallet_return', '1', NULL, 'driver_wallet',
             vc.driver_id::text, 'C', tt.wallet_topup),
            ('correction', 'void-carry-' || vc.id::text, NULL, 'driver_cash',
             vc.driver_id::text, 'C', tt.carried),
            ('correction', 'void-carry-' || vc.id::text, NULL, 'driver_receivable_cash',
             vc.driver_id::text, 'D', tt.carried)
          ) AS expected(event_type, occurrence_key, line_role, fund_type, owner_id, side, amount)
         WHERE expected.amount <> 0
      ), expected_shapes AS (
        SELECT vc.id AS shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 el.event_type, el.occurrence_key, el.line_role, el.fund_type, el.owner_id,
                 el.fund_branch_id, el.side, el.amount_minor, el.reason, el.created_by
               ) ORDER BY el.event_type, el.occurrence_key, el.line_role, el.fund_type,
                          el.owner_id, el.fund_branch_id, el.side, el.amount_minor,
                          el.reason, el.created_by
               ) FILTER (WHERE el.event_type IS NOT NULL), '[]'::jsonb) AS line_shape,
               CASE WHEN tt.cash_float <> 0 THEN 1 ELSE 0 END AS cash_entries,
               CASE WHEN tt.wallet_topup <> 0 THEN 1 ELSE 0 END AS wallet_entries,
               CASE WHEN tt.carried <> 0 THEN 1 ELSE 0 END AS correction_entries
          FROM valid_cancelled vc
          JOIN tranche_totals tt ON tt.shift_id = vc.id
          LEFT JOIN expected_lines el ON el.shift_id = vc.id
         GROUP BY vc.id, tt.cash_float, tt.wallet_topup, tt.carried
      ), actual_shapes AS (
        SELECT vc.id AS shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                 f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text,
                 je.reason, je.created_by::text
               ) ORDER BY je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                          f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text,
                          je.reason, je.created_by::text
               ) FILTER (WHERE jl.id IS NOT NULL), '[]'::jsonb) AS line_shape,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'float_return') AS cash_entries,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'wallet_return') AS wallet_entries,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'correction') AS correction_entries
          FROM valid_cancelled vc
          LEFT JOIN journal_entries je ON je.shift_id = vc.id
            AND je.event_type IN ('float_return', 'wallet_return', 'correction')
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY vc.id
      ), driver_balances AS (
        SELECT vc.id AS shift_id,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_cash' AND f.owner_id = vc.driver_id
               ), 0) AS driver_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_wallet' AND f.owner_id = vc.driver_id
               ), 0) AS driver_wallet,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_share_payable' AND f.owner_id = vc.driver_id
               ), 0) AS driver_share,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_cash' AND f.owner_id = vc.driver_id
               ), 0) AS driver_receivable_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_wallet' AND f.owner_id = vc.driver_id
               ), 0) AS driver_receivable_wallet
          FROM valid_cancelled vc
          LEFT JOIN journal_entries je ON je.shift_id = vc.id
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY vc.id
      )
      SELECT cc.id::text AS shift_id, cc.state::text AS state,
             'force_cancel_decision_missing_or_invalid' AS issue,
             NULL::jsonb AS expected_lines,
             jsonb_build_object(
               'decisionCount', COALESCE(fd.decision_count, 0),
               'gate', (fd.gates)[1], 'notes', (fd.notes)[1],
               'decidedAt', (fd.decided_at)[1]
             ) AS actual_lines,
             NULL::jsonb AS balances
        FROM cancel_candidates cc
        LEFT JOIN force_decisions fd ON fd.shift_id = cc.id
       WHERE COALESCE(fd.decision_count, 0) <> 1
          OR (fd.gates)[1] IS DISTINCT FROM 'close'
          OR NOT ${hasVisibleText('(fd.notes)[1]')}
          OR (fd.decided_at)[1] IS NULL OR (fd.decided_at)[1] < cc.rollout_at
      UNION ALL
      SELECT s.id::text, s.state::text, 'force_cancel_decision_state_mismatch',
             NULL::jsonb, NULL::jsonb, NULL::jsonb
        FROM force_decisions fd
        JOIN shifts s ON s.id = fd.shift_id
       WHERE s.state <> 'cancelled'
      UNION ALL
      SELECT vc.id::text, vc.state::text, 'force_cancel_void_journal_or_residual_mismatch',
             expected.line_shape, actual.line_shape,
             jsonb_build_object(
               'driverCash', balances.driver_cash::text,
               'driverWallet', balances.driver_wallet::text,
               'driverShare', balances.driver_share::text,
               'driverReceivableCash', balances.driver_receivable_cash::text,
               'driverReceivableWallet', balances.driver_receivable_wallet::text
             )
        FROM valid_cancelled vc
        JOIN expected_shapes expected ON expected.shift_id = vc.id
        JOIN actual_shapes actual ON actual.shift_id = vc.id
        JOIN driver_balances balances ON balances.shift_id = vc.id
       WHERE actual.cash_entries <> expected.cash_entries
          OR actual.wallet_entries <> expected.wallet_entries
          OR actual.correction_entries <> expected.correction_entries
          OR actual.line_shape IS DISTINCT FROM expected.line_shape
          OR balances.driver_cash <> 0
          OR balances.driver_wallet <> 0
          OR balances.driver_share <> 0
          OR balances.driver_receivable_cash <> 0
          OR balances.driver_receivable_wallet <> 0
    `,
  },
  {
    id: 'unresolved_operations',
    description: 'submitted and terminal shifts contain no unresolved/flagged money operations',
    sql: `
      SELECT o.shift_id::text AS shift_id, 'order' AS operation_type,
             o.provider_order_no AS operation_key, o.window_status::text AS window_status,
             o.included::text AS included
        FROM shift_orders o
        JOIN shifts s ON s.id = o.shift_id
       WHERE s.state IN ('pending_review', 'approved', 'week_locked')
         AND o.kind <> 'manual'
         AND (
           COALESCE(jsonb_array_length(o.close_draft_review_reasons), 0) > 0
           OR (o.window_status = 'unknown' AND NOT (
             o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL
             AND NULLIF(btrim(o.decision_reason), '') IS NOT NULL
           ))
         )
      UNION ALL
      SELECT d.shift_id::text, 'cash_deduction', d.operation_key,
             d.window_status::text, d.included::text
        FROM cash_deductions d
        JOIN shifts s ON s.id = d.shift_id
       WHERE s.state IN ('pending_review', 'approved', 'week_locked')
         AND (
           COALESCE(jsonb_array_length(d.close_draft_review_reasons), 0) > 0
           OR (d.window_status = 'unknown' AND NOT (
             d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL
             AND NULLIF(btrim(d.decision_reason), '') IS NOT NULL
           ))
         )
    `,
  },
  {
    id: 'close_draft_boundaries',
    description: 'submitted draft boundary, canonical figures, and evidence generation match the shift',
    sql: `
      SELECT d.shift_id::text AS shift_id, s.state::text AS state,
             d.revision::text AS revision, 'draft_boundary_or_figures_mismatch' AS issue
        FROM shift_close_drafts d
        JOIN shifts s ON s.id = d.shift_id
       WHERE jsonb_typeof(d.payload -> 'figures') IS DISTINCT FROM 'object'
          OR jsonb_typeof(d.payload -> 'evidence') IS DISTINCT FROM 'object'
          OR (d.submitted_at IS NULL) IS DISTINCT FROM (s.submitted_at IS NULL)
          OR (d.submitted_at IS NOT NULL AND d.submitted_at IS DISTINCT FROM s.submitted_at)
          OR (d.submitted_at IS NOT NULL AND d.updated_at IS DISTINCT FROM d.submitted_at)
          OR (d.submitted_at IS NOT NULL AND (
               s.state NOT IN ('pending_review', 'approved', 'week_locked', 'cancelled')
               OR (s.state = 'cancelled' AND NOT EXISTS (
                 SELECT 1 FROM shift_decisions cancel_decision
                  WHERE cancel_decision.shift_id = s.id
                    AND cancel_decision.gate = 'close'
                    AND cancel_decision.decision = 'force_cancelled'
                    AND ${hasVisibleText('cancel_decision.notes')}
                    AND cancel_decision.decided_at >= d.submitted_at
               ))
          ))
          OR (d.submitted_at IS NOT NULL AND (
               d.payload #>> '{figures,cashDeclared}' IS NULL
            OR d.payload #>> '{figures,walletDeclared}' IS NULL
            OR d.payload #>> '{figures,odometerKm}' IS NULL
            OR s.end_cash_declared_minor IS NULL
            OR s.end_wallet_declared_minor IS NULL
            OR s.odo_end IS NULL
            OR (
               CASE
                 WHEN d.payload #>> '{figures,cashDeclared}' ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
                   THEN (d.payload #>> '{figures,cashDeclared}')::numeric * 100
                 ELSE NULL
               END IS DISTINCT FROM s.end_cash_declared_minor::numeric
               AND NOT EXISTS (
                 SELECT 1 FROM audit_log al
                  WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                    AND al.action = 'UPDATE' AND al.occurred_at >= d.submitted_at
                    AND al.actor_kind = 'user' AND al.actor_id IS NOT NULL
                    AND al.branch_id = s.branch_id
                    AND al.after ->> 'revisedByManager' = 'true'
                    AND al.before ->> 'cashDeclared' IS DISTINCT FROM al.after ->> 'cashDeclared'
                    AND CASE
                          WHEN al.after ->> 'cashDeclared' ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
                            THEN (al.after ->> 'cashDeclared')::numeric * 100
                          ELSE NULL
                        END IS NOT DISTINCT FROM s.end_cash_declared_minor::numeric
               )
            OR CASE
                 WHEN d.payload #>> '{figures,walletDeclared}' ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
                   THEN (d.payload #>> '{figures,walletDeclared}')::numeric * 100
                 ELSE NULL
               END IS DISTINCT FROM s.end_wallet_declared_minor::numeric
               AND NOT EXISTS (
                 SELECT 1 FROM audit_log al
                  WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                    AND al.action = 'UPDATE' AND al.occurred_at >= d.submitted_at
                    AND al.actor_kind = 'user' AND al.actor_id IS NOT NULL
                    AND al.branch_id = s.branch_id
                    AND al.after ->> 'revisedByManager' = 'true'
                    AND al.before ->> 'walletDeclared' IS DISTINCT FROM al.after ->> 'walletDeclared'
                    AND CASE
                          WHEN al.after ->> 'walletDeclared' ~ '^-?[0-9]+(\\.[0-9]{1,2})?$'
                            THEN (al.after ->> 'walletDeclared')::numeric * 100
                          ELSE NULL
                        END IS NOT DISTINCT FROM s.end_wallet_declared_minor::numeric
               )
            OR CASE
                 WHEN d.payload #>> '{figures,odometerKm}' ~ '^[0-9]+$'
                   THEN (d.payload #>> '{figures,odometerKm}')::numeric
                 ELSE NULL
               END IS DISTINCT FROM s.odo_end::numeric
               AND NOT EXISTS (
                 SELECT 1 FROM audit_log al
                  WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                    AND al.action = 'UPDATE' AND al.occurred_at >= d.submitted_at
                    AND al.actor_kind = 'user' AND al.actor_id IS NOT NULL
                    AND al.branch_id = s.branch_id
                    AND al.after ->> 'revisedByManager' = 'true'
                    AND al.before ->> 'odometerKm' IS DISTINCT FROM al.after ->> 'odometerKm'
                    AND CASE
                          WHEN al.after ->> 'odometerKm' ~ '^[0-9]+$'
                            THEN (al.after ->> 'odometerKm')::numeric
                          ELSE NULL
                        END IS NOT DISTINCT FROM s.odo_end::numeric
               )
            OR CASE
                 WHEN d.payload #>> '{figures,batteryPercent}' IS NULL THEN NULL
                 WHEN d.payload #>> '{figures,batteryPercent}' ~ '^[0-9]+$'
                   THEN (d.payload #>> '{figures,batteryPercent}')::numeric
                 ELSE NULL
               END IS DISTINCT FROM s.battery_end::numeric
            )
          ))
      UNION ALL
      SELECT d.shift_id::text, s.state::text, d.revision::text,
             'draft_evidence_generation_mismatch'
        FROM shift_close_drafts d
        JOIN shifts s ON s.id = d.shift_id
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(d.payload -> 'evidence') = 'object'
               THEN d.payload -> 'evidence' ELSE '{}'::jsonb END
        ) evidence(slot, generation)
        LEFT JOIN shift_media sm ON sm.shift_id = d.shift_id
          AND sm.package = 'end' AND sm.slot = evidence.slot
       WHERE d.submitted_at IS NOT NULL
         AND (
           sm.id IS NULL
           OR sm.media_id::text IS DISTINCT FROM evidence.generation ->> 'mediaId'
           OR sm.attachment_token::text IS DISTINCT FROM evidence.generation ->> 'attachmentToken'
         )
      UNION ALL
      SELECT d.shift_id::text, s.state::text, d.revision::text,
             'submitted_end_attachment_missing_from_draft'
        FROM shift_close_drafts d
        JOIN shifts s ON s.id = d.shift_id
        JOIN shift_media sm ON sm.shift_id = d.shift_id AND sm.package = 'end'
       WHERE d.submitted_at IS NOT NULL
         AND NOT (COALESCE(d.payload -> 'evidence', '{}'::jsonb) ? sm.slot)
    `,
  },
  {
    id: 'residual_driver_balances',
    description: 'each settled shift clears its own driver cash, wallet, share, and close-time receivable movements',
    sql: `
      WITH carried AS (
        SELECT ft.shift_id, COALESCE(sum(ft.amount_minor::numeric), 0) AS carried
          FROM float_tranches ft
         WHERE ft.kind = 'carried_receivable'
         GROUP BY ft.shift_id
      ), shift_balances AS (
        SELECT ss.shift_id, ss.driver_id,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_cash' AND f.owner_id = ss.driver_id
               ), 0) AS driver_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_wallet' AND f.owner_id = ss.driver_id
               ), 0) AS driver_wallet,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_share_payable' AND f.owner_id = ss.driver_id
               ), 0) AS driver_share,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_cash' AND f.owner_id = ss.driver_id
               ), 0) AS driver_receivable_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_wallet' AND f.owner_id = ss.driver_id
               ), 0) AS driver_receivable_wallet
          FROM shift_settlements ss
          LEFT JOIN journal_entries je ON je.shift_id = ss.shift_id
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY ss.shift_id, ss.driver_id
      )
      SELECT sb.shift_id::text AS shift_id, sb.driver_id::text AS driver_id,
             sb.driver_cash::text AS driver_cash_minor,
             sb.driver_wallet::text AS driver_wallet_minor,
             sb.driver_share::text AS driver_share_minor,
             sb.driver_receivable_cash::text AS driver_receivable_cash_minor,
             sb.driver_receivable_wallet::text AS driver_receivable_wallet_minor,
             (-COALESCE(c.carried, 0))::text AS expected_driver_receivable_cash_minor
        FROM shift_balances sb
        LEFT JOIN carried c ON c.shift_id = sb.shift_id
       WHERE sb.driver_cash <> 0
          OR sb.driver_wallet <> 0
          OR sb.driver_share <> 0
          OR sb.driver_receivable_cash <> -COALESCE(c.carried, 0)
          OR sb.driver_receivable_wallet <> 0
    `,
  },
])

const legacyCheck = (id) => {
  const check = LEGACY_INTEGRITY_CHECKS.find((candidate) => candidate.id === id)
  if (!check) throw new Error(`missing legacy integrity check ${id}`)
  return check
}

const RECEIVABLE_V2_CHECKS = Object.freeze({
  settlement_formulas: {
    id: 'settlement_formulas',
    description: 'immutable v1/v2 settlement claims, deferrals, physical movements, confirmations, and reasons',
    sql: `
      SELECT ss.shift_id::text AS shift_id,
             ss.policy_code,
             ss.variance_minor::text AS variance_minor,
             ss.cash_claim_to_office_minor::text AS cash_claim_to_office_minor,
             ss.wallet_claim_to_office_minor::text AS wallet_claim_to_office_minor,
             ss.cash_receivable_deferred_minor::text AS cash_receivable_deferred_minor,
             ss.wallet_receivable_deferred_minor::text AS wallet_receivable_deferred_minor,
             'settlement formula or confirmation mismatch' AS issue
        FROM shift_settlements ss
       WHERE ss.policy_code NOT IN (
               'fixed_40_cash_close_v1',
               'fixed_40_cash_close_v2_receivable'
             )
          OR ss.driver_rate_bps <> 4000
          OR ss.delivery_fee_total_minor < 0
          OR ss.fixed_driver_share_minor < 0
          OR ss.manual_driver_share_minor < 0
          OR ss.gross_driver_share_minor < 0
          OR ss.cash_deduction_total_minor < 0
          OR ss.actual_cash_minor < 0
          OR ss.wallet_amount_minor < 0
          OR ss.cash_amount_minor < 0
          OR ss.cash_receivable_deferred_minor < 0
          OR ss.wallet_receivable_deferred_minor < 0
          OR (ss.policy_code = 'fixed_40_cash_close_v1' AND (
               ss.cash_receivable_deferred_minor <> 0
               OR ss.wallet_receivable_deferred_minor <> 0
             ))
          OR ss.fixed_driver_share_minor::numeric <>
             floor(ss.delivery_fee_total_minor::numeric * ss.driver_rate_bps::numeric / 10000)
          OR ss.gross_driver_share_minor::numeric <>
             ss.fixed_driver_share_minor::numeric + ss.manual_driver_share_minor::numeric
          OR ss.base_driver_share_minor::numeric <>
             ss.gross_driver_share_minor::numeric - ss.cash_deduction_total_minor::numeric
          OR ss.actual_total_minor::numeric <>
             ss.actual_cash_minor::numeric + ss.actual_wallet_minor::numeric
          OR ss.variance_minor::numeric <>
             ss.actual_total_minor::numeric - ss.expected_total_minor::numeric
          OR NOT (
               (ss.variance_minor > 0 AND ss.variance_direction = 'surplus')
            OR (ss.variance_minor < 0 AND ss.variance_direction = 'shortage')
            OR (ss.variance_minor = 0 AND ss.variance_direction = 'balanced')
          )
          OR ss.final_employee_cash_minor::numeric <>
             ss.base_driver_share_minor::numeric + ss.variance_minor::numeric
          OR ss.cash_claim_to_office_minor::numeric <>
             ss.actual_cash_minor::numeric - ss.final_employee_cash_minor::numeric
          OR ss.wallet_claim_to_office_minor::numeric <> ss.actual_wallet_minor::numeric
          OR ss.cash_receivable_deferred_minor::numeric >
             GREATEST(ss.cash_claim_to_office_minor::numeric, 0::numeric)
          OR ss.wallet_receivable_deferred_minor::numeric >
             GREATEST(ss.wallet_claim_to_office_minor::numeric, 0::numeric)
          OR ss.cash_to_office_minor::numeric <>
             ss.cash_claim_to_office_minor::numeric - ss.cash_receivable_deferred_minor::numeric
          OR ss.wallet_to_office_minor::numeric <>
             ss.wallet_claim_to_office_minor::numeric - ss.wallet_receivable_deferred_minor::numeric
          OR ss.cash_to_office_minor::numeric
             + ss.wallet_to_office_minor::numeric
             + ss.cash_receivable_deferred_minor::numeric
             + ss.wallet_receivable_deferred_minor::numeric <>
             ss.expected_total_minor::numeric - ss.base_driver_share_minor::numeric
          OR NOT (
               (ss.wallet_to_office_minor > 0 AND ss.wallet_action = 'collect'
                 AND ss.wallet_amount_minor::numeric = ss.wallet_to_office_minor::numeric)
            OR (ss.wallet_to_office_minor < 0 AND ss.wallet_action = 'fund'
                 AND ss.wallet_amount_minor::numeric = -ss.wallet_to_office_minor::numeric)
            OR (ss.wallet_to_office_minor = 0 AND ss.wallet_action = 'none'
                 AND ss.wallet_amount_minor = 0)
          )
          OR NOT (
               (ss.cash_to_office_minor > 0 AND ss.cash_action = 'collect'
                 AND ss.cash_amount_minor::numeric = ss.cash_to_office_minor::numeric)
            OR (ss.cash_to_office_minor < 0 AND ss.cash_action = 'pay'
                 AND ss.cash_amount_minor::numeric = -ss.cash_to_office_minor::numeric)
            OR (ss.cash_to_office_minor = 0 AND ss.cash_action = 'none'
                 AND ss.cash_amount_minor = 0)
          )
          OR NOT ss.wallet_transfer_confirmed
          OR NOT ss.cash_settlement_confirmed
          OR char_length(ss.reviewed_orders_hash) NOT BETWEEN 1 AND 128
          OR ss.settlement_hash !~ '^[0-9a-f]{64}$'
          OR char_length(COALESCE(ss.variance_reason, '')) > 500
          OR (ss.variance_minor <> 0 AND NOT ${hasVisibleText('ss.variance_reason')})
    `,
  },
  settlement_state_coupling: {
    ...legacyCheck('settlement_state_coupling'),
    description: 'one settlement per terminal shift with matching identity, review, and cash projection',
    sql: legacyCheck('settlement_state_coupling').sql.replace(
      'OR s.orders_hash IS DISTINCT FROM ss.reviewed_orders_hash',
      `OR s.orders_hash IS DISTINCT FROM ss.reviewed_orders_hash
          OR s.kept_as_receivable_minor IS DISTINCT FROM ss.cash_receivable_deferred_minor`,
    ),
  },
  br1_settlement_snapshot: {
    ...legacyCheck('br1_settlement_snapshot'),
    description: 'stored BR1 components include both cash and wallet carried shift-funding tranches',
    sql: legacyCheck('br1_settlement_snapshot').sql
      .replace(
        "COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup",
        `COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (
                 WHERE ft.kind = 'carried_wallet_receivable'
               ), 0) AS carried_wallet`,
      )
      .replace(
        'tt.wallet_topup + ot.wallet_from_orders AS expected_wallet',
        'tt.wallet_topup + tt.carried_wallet + ot.wallet_from_orders AS expected_wallet',
      ),
  },
  tranche_journal_totals: {
    id: 'tranche_journal_totals',
    description: 'cash/wallet tranches and legacy/new carried shift-funding agree with exact opening journals (excluding pre-integrity cancelled history)',
    sql: `
      WITH integrity_rollout AS (
        SELECT COALESCE(
          (SELECT applied_at FROM schema_migrations
            WHERE filename = '0035_shift_money_integrity.sql'),
          '-infinity'::timestamptz
        ) AS applied_at
      ), eligible_shifts AS (
        SELECT s.*
          FROM shifts s
          CROSS JOIN integrity_rollout rollout
         WHERE s.state <> 'cancelled'
            OR s.created_at >= rollout.applied_at
            OR EXISTS (
              SELECT 1 FROM audit_log al
               WHERE al.table_name = 'shifts' AND al.record_id = s.id::text
                 AND al.action = 'UPDATE'
                 AND al.after ->> 'state' = 'cancelled'
                 AND COALESCE(al.before ->> 'state', '') <> 'cancelled'
                 AND al.occurred_at >= rollout.applied_at
            )
            OR EXISTS (
              SELECT 1 FROM shift_decisions sd
               WHERE sd.shift_id = s.id AND sd.decision = 'force_cancelled'
                 AND sd.decided_at >= rollout.applied_at
            )
      ), receivable_rollout AS (
        SELECT applied_at
          FROM schema_migrations
         WHERE filename = '0037_receivable_settlement_and_events.sql'
      ), tranche_totals AS (
        SELECT ft.shift_id,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'cash_float'), 0) AS cash_float,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried_cash,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'wallet_topup'), 0) AS wallet_topup,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (
                 WHERE ft.kind = 'carried_wallet_receivable'
               ), 0) AS carried_wallet
          FROM float_tranches ft
         GROUP BY ft.shift_id
      ), entry_shapes AS (
        SELECT je.id, je.shift_id, je.event_type::text AS event_type,
               s.open_approved_at >= rollout.applied_at AS uses_shift_funding,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'D' AND f.type::text = 'driver_cash'
                   AND f.owner_id = s.driver_id
               ), 0) AS driver_cash_debit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'D' AND f.type::text = 'driver_wallet'
                   AND f.owner_id = s.driver_id
               ), 0) AS driver_wallet_debit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'C' AND f.type::text = 'office_cash'
               ), 0) AS office_cash_credit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'C' AND f.type::text = 'office_wallet'
               ), 0) AS office_wallet_credit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'C' AND f.type::text = 'driver_receivable_cash'
                   AND f.owner_id = s.driver_id
               ), 0) AS legacy_receivable_cash_credit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'C' AND f.type::text = 'driver_shift_funding_cash'
                   AND f.owner_id = s.driver_id
               ), 0) AS funding_cash_credit,
               COALESCE(sum(jl.amount_minor::numeric) FILTER (
                 WHERE jl.side = 'C' AND f.type::text = 'driver_shift_funding_wallet'
                   AND f.owner_id = s.driver_id
               ), 0) AS funding_wallet_credit,
               count(jl.id) AS line_count
          FROM journal_entries je
          JOIN eligible_shifts s ON s.id = je.shift_id
          CROSS JOIN receivable_rollout rollout
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         WHERE je.shift_id IS NOT NULL AND je.event_type IN ('float_out', 'wallet_topup')
         GROUP BY je.id, je.shift_id, je.event_type, s.open_approved_at, rollout.applied_at
      ), classified AS (
        SELECT es.*,
               es.event_type = 'float_out'
                 AND es.driver_cash_debit > 0
                 AND es.office_cash_credit = es.driver_cash_debit
                 AND es.legacy_receivable_cash_credit = 0
                 AND es.funding_cash_credit = 0
                 AND es.funding_wallet_credit = 0
                 AND es.driver_wallet_debit = 0
                 AND es.office_wallet_credit = 0
                 AND es.line_count = 2 AS is_cash_float,
               es.event_type = 'float_out'
                 AND es.driver_cash_debit > 0
                 AND es.office_cash_credit = 0
                 AND es.driver_wallet_debit = 0
                 AND es.office_wallet_credit = 0
                 AND es.funding_wallet_credit = 0
                 AND es.line_count = 2
                 AND (
                   (es.uses_shift_funding
                     AND es.funding_cash_credit = es.driver_cash_debit
                     AND es.legacy_receivable_cash_credit = 0)
                   OR
                   (NOT es.uses_shift_funding
                     AND es.legacy_receivable_cash_credit = es.driver_cash_debit
                     AND es.funding_cash_credit = 0)
                 ) AS is_cash_carry,
               es.event_type = 'wallet_topup'
                 AND es.driver_wallet_debit > 0
                 AND es.office_wallet_credit = es.driver_wallet_debit
                 AND es.driver_cash_debit = 0
                 AND es.office_cash_credit = 0
                 AND es.legacy_receivable_cash_credit = 0
                 AND es.funding_cash_credit = 0
                 AND es.funding_wallet_credit = 0
                 AND es.line_count = 2 AS is_wallet_topup,
               es.event_type = 'wallet_topup'
                 AND es.driver_wallet_debit > 0
                 AND es.funding_wallet_credit = es.driver_wallet_debit
                 AND es.driver_cash_debit = 0
                 AND es.office_cash_credit = 0
                 AND es.office_wallet_credit = 0
                 AND es.legacy_receivable_cash_credit = 0
                 AND es.funding_cash_credit = 0
                 AND es.line_count = 2 AS is_wallet_carry
          FROM entry_shapes es
      ), journal_totals AS (
        SELECT c.shift_id,
               COALESCE(sum(c.driver_cash_debit) FILTER (WHERE c.is_cash_float), 0) AS cash_float,
               COALESCE(sum(c.driver_cash_debit) FILTER (WHERE c.is_cash_carry), 0) AS carried_cash,
               COALESCE(sum(c.driver_wallet_debit) FILTER (WHERE c.is_wallet_topup), 0) AS wallet_topup,
               COALESCE(sum(c.driver_wallet_debit) FILTER (WHERE c.is_wallet_carry), 0) AS carried_wallet,
               count(*) FILTER (WHERE NOT (
                 c.is_cash_float OR c.is_cash_carry OR c.is_wallet_topup OR c.is_wallet_carry
               )) AS malformed_entries
          FROM classified c
         GROUP BY c.shift_id
      )
      SELECT s.id::text AS shift_id,
             s.start_cash_float_minor::text AS shift_cash_float,
             COALESCE(tt.cash_float, 0)::text AS tranche_cash_float,
             COALESCE(jt.cash_float, 0)::text AS journal_cash_float,
             COALESCE(tt.carried_cash, 0)::text AS tranche_carried_cash,
             COALESCE(jt.carried_cash, 0)::text AS journal_carried_cash,
             s.start_wallet_topup_minor::text AS shift_wallet_topup,
             COALESCE(tt.wallet_topup, 0)::text AS tranche_wallet_topup,
             COALESCE(jt.wallet_topup, 0)::text AS journal_wallet_topup,
             COALESCE(tt.carried_wallet, 0)::text AS tranche_carried_wallet,
             COALESCE(jt.carried_wallet, 0)::text AS journal_carried_wallet,
             COALESCE(jt.malformed_entries, 0)::text AS malformed_entries
        FROM eligible_shifts s
        LEFT JOIN tranche_totals tt ON tt.shift_id = s.id
        LEFT JOIN journal_totals jt ON jt.shift_id = s.id
       WHERE s.start_cash_float_minor::numeric <> COALESCE(tt.cash_float, 0)
          OR COALESCE(tt.cash_float, 0) <> COALESCE(jt.cash_float, 0)
          OR COALESCE(tt.carried_cash, 0) <> COALESCE(jt.carried_cash, 0)
          OR s.start_wallet_topup_minor::numeric <> COALESCE(tt.wallet_topup, 0)
          OR COALESCE(tt.wallet_topup, 0) <> COALESCE(jt.wallet_topup, 0)
          OR COALESCE(tt.carried_wallet, 0) <> COALESCE(jt.carried_wallet, 0)
          OR COALESCE(jt.malformed_entries, 0) <> 0
    `,
  },
  expected_close_events: {
    ...legacyCheck('expected_close_events'),
    sql: legacyCheck('expected_close_events').sql
      .replaceAll(
        "OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0",
        `OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0
                            OR ss.cash_receivable_deferred_minor <> 0`,
      ),
  },
  close_journal_alignment: {
    id: 'close_journal_alignment',
    description: 'v1/v2 close journals contain exactly the canonical claim, deferral, and physical line multiset',
    sql: `
      WITH expected_lines AS (
        SELECT ss.shift_id, expected.event_type, '1'::text AS occurrence_key,
               expected.line_role, expected.fund_type, expected.owner_id,
               ss.branch_id::text AS fund_branch_id,
               CASE WHEN expected.movement > 0 THEN 'D' ELSE 'C' END AS side,
               abs(expected.movement)::text AS amount_minor
          FROM shift_settlements ss
          JOIN shifts s ON s.id = ss.shift_id
          CROSS JOIN LATERAL (VALUES
            ('wallet_return', 'wallet_reclassification', 'driver_wallet',
             ss.driver_id::text, COALESCE(s.wallet_diff_minor::numeric, 0)),
            ('wallet_return', 'wallet_reclassification', 'driver_cash',
             ss.driver_id::text, -COALESCE(s.wallet_diff_minor::numeric, 0)),
            ('wallet_return', 'wallet_cleared', 'driver_wallet',
             ss.driver_id::text, -ss.actual_wallet_minor::numeric),
            ('wallet_return',
             CASE WHEN ss.policy_code = 'fixed_40_cash_close_v1'
                  THEN 'wallet_full_return' ELSE 'wallet_settlement' END,
             'office_wallet', NULL::text, ss.wallet_to_office_minor::numeric),
            ('wallet_return', 'wallet_settlement_deferred', 'driver_receivable_wallet',
             ss.driver_id::text, ss.wallet_receivable_deferred_minor::numeric),
            ('float_return', 'cash_cleared', 'driver_cash',
             ss.driver_id::text, -(ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric)),
            ('float_return', 'driver_share_settled', 'driver_share_payable',
             ss.driver_id::text, GREATEST(ss.base_driver_share_minor::numeric, 0)),
            ('float_return', 'driver_receivable_settled', 'driver_receivable_cash',
             ss.driver_id::text, LEAST(ss.base_driver_share_minor::numeric, 0)),
            ('float_return', 'cash_settlement_deferred', 'driver_receivable_cash',
             ss.driver_id::text, ss.cash_receivable_deferred_minor::numeric),
            ('float_return', 'cash_settlement', 'office_cash',
             NULL::text, ss.cash_to_office_minor::numeric)
          ) AS expected(event_type, line_role, fund_type, owner_id, movement)
         WHERE expected.movement <> 0
      ), expected_shapes AS (
        SELECT ss.shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 el.event_type, el.occurrence_key, el.line_role, el.fund_type, el.owner_id,
                 el.fund_branch_id, el.side, el.amount_minor
               ) ORDER BY el.event_type, el.occurrence_key, el.line_role, el.fund_type,
                          el.owner_id, el.fund_branch_id, el.side, el.amount_minor
               ) FILTER (WHERE el.event_type IS NOT NULL), '[]'::jsonb) AS line_shape,
               CASE WHEN ss.actual_wallet_minor <> 0 OR COALESCE(s.wallet_diff_minor, 0) <> 0
                          OR ss.wallet_receivable_deferred_minor <> 0
                    THEN 1 ELSE 0 END AS wallet_entries,
               CASE WHEN ss.expected_total_minor::numeric - ss.actual_wallet_minor::numeric <> 0
                          OR ss.base_driver_share_minor <> 0 OR ss.cash_to_office_minor <> 0
                          OR ss.cash_receivable_deferred_minor <> 0
                    THEN 1 ELSE 0 END AS cash_entries
          FROM shift_settlements ss
          JOIN shifts s ON s.id = ss.shift_id
          LEFT JOIN expected_lines el ON el.shift_id = ss.shift_id
         GROUP BY ss.shift_id, ss.actual_wallet_minor, s.wallet_diff_minor,
                  ss.expected_total_minor, ss.base_driver_share_minor, ss.cash_to_office_minor,
                  ss.cash_receivable_deferred_minor, ss.wallet_receivable_deferred_minor
      ), actual_shapes AS (
        SELECT ss.shift_id,
               COALESCE(jsonb_agg(jsonb_build_array(
                 je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                 f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text
               ) ORDER BY je.event_type::text, je.occurrence_key, jl.line_role, f.type::text,
                          f.owner_id::text, f.branch_id::text, jl.side, jl.amount_minor::text
               ) FILTER (WHERE jl.id IS NOT NULL), '[]'::jsonb) AS line_shape,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'wallet_return') AS wallet_entries,
               count(DISTINCT je.id) FILTER (WHERE je.event_type = 'float_return') AS cash_entries
          FROM shift_settlements ss
          LEFT JOIN journal_entries je ON je.shift_id = ss.shift_id
            AND je.event_type IN ('wallet_return', 'float_return')
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY ss.shift_id
      )
      SELECT expected.shift_id::text AS shift_id,
             expected.wallet_entries::text AS expected_wallet_entries,
             actual.wallet_entries::text AS actual_wallet_entries,
             expected.cash_entries::text AS expected_cash_entries,
             actual.cash_entries::text AS actual_cash_entries,
             expected.line_shape AS expected_lines,
             actual.line_shape AS actual_lines
        FROM expected_shapes expected
        JOIN actual_shapes actual ON actual.shift_id = expected.shift_id
        JOIN shifts s ON s.id = expected.shift_id
       WHERE s.wallet_diff_minor IS NULL
          OR actual.wallet_entries <> expected.wallet_entries
          OR actual.cash_entries <> expected.cash_entries
          OR actual.line_shape IS DISTINCT FROM expected.line_shape
    `,
  },
  force_cancel_integrity: {
    ...legacyCheck('force_cancel_integrity'),
    description: 'post-rollout force-cancels exactly reverse cash and wallet shift-funding carries',
    sql: legacyCheck('force_cancel_integrity').sql
      .replace(
        '), force_decisions AS (',
        `), receivable_rollout AS (
        SELECT applied_at
          FROM schema_migrations
         WHERE filename = '0037_receivable_settlement_and_events.sql'
      ), force_decisions AS (`,
      )
      .replace(
        'SELECT s.*, rollout.applied_at AS rollout_at',
        `SELECT s.*, rollout.applied_at AS rollout_at,
               receivable_rollout.applied_at AS receivable_rollout_at`,
      )
      .replace(
        'CROSS JOIN force_cancel_rollout rollout',
        `CROSS JOIN force_cancel_rollout rollout
          CROSS JOIN receivable_rollout`,
      )
      .replace(
        `SELECT cc.*, (fd.actors)[1] AS cancel_actor, (fd.notes)[1] AS cancel_reason`,
        `SELECT cc.*, (fd.actors)[1] AS cancel_actor, (fd.notes)[1] AS cancel_reason,
               (fd.decided_at)[1] AS cancel_decided_at`,
      )
      .replace(
        "COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried",
        `COALESCE(sum(ft.amount_minor::numeric) FILTER (WHERE ft.kind = 'carried_receivable'), 0) AS carried,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (
                 WHERE ft.kind = 'carried_wallet_receivable'
               ), 0) AS carried_wallet`,
      )
      .replace(
        `('correction', 'void-carry-' || vc.id::text, NULL, 'driver_receivable_cash',
             vc.driver_id::text, 'D', tt.carried)`,
        `('correction', 'void-carry-' || vc.id::text, NULL,
             CASE WHEN vc.cancel_decided_at >= vc.receivable_rollout_at
                  THEN 'driver_shift_funding_cash' ELSE 'driver_receivable_cash' END,
             vc.driver_id::text, 'D', tt.carried),
            ('correction', 'void-wallet-carry-' || vc.id::text, NULL, 'driver_wallet',
             vc.driver_id::text, 'C', tt.carried_wallet),
            ('correction', 'void-wallet-carry-' || vc.id::text, NULL,
             CASE WHEN vc.cancel_decided_at >= vc.receivable_rollout_at
                  THEN 'driver_shift_funding_wallet' ELSE 'driver_receivable_wallet' END,
             vc.driver_id::text, 'D', tt.carried_wallet)`,
      )
      .replace(
        'CASE WHEN tt.carried <> 0 THEN 1 ELSE 0 END AS correction_entries',
        `CASE WHEN tt.carried <> 0 THEN 1 ELSE 0 END
                 + CASE WHEN tt.carried_wallet <> 0 THEN 1 ELSE 0 END AS correction_entries`,
      )
      .replace(
        'GROUP BY vc.id, tt.cash_float, tt.wallet_topup, tt.carried',
        'GROUP BY vc.id, tt.cash_float, tt.wallet_topup, tt.carried, tt.carried_wallet',
      )
      .replace(
        `COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_wallet' AND f.owner_id = vc.driver_id
               ), 0) AS driver_receivable_wallet`,
        `COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_wallet' AND f.owner_id = vc.driver_id
               ), 0) AS driver_receivable_wallet,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_shift_funding_cash' AND f.owner_id = vc.driver_id
               ), 0) AS driver_shift_funding_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_shift_funding_wallet' AND f.owner_id = vc.driver_id
               ), 0) AS driver_shift_funding_wallet`,
      )
      .replace(
        `'driverReceivableWallet', balances.driver_receivable_wallet::text`,
        `'driverReceivableWallet', balances.driver_receivable_wallet::text,
               'driverShiftFundingCash', balances.driver_shift_funding_cash::text,
               'driverShiftFundingWallet', balances.driver_shift_funding_wallet::text`,
      )
      .replace(
        'JOIN driver_balances balances ON balances.shift_id = vc.id',
        `JOIN driver_balances balances ON balances.shift_id = vc.id
        JOIN tranche_totals tt ON tt.shift_id = vc.id`,
      )
      .replace(
        'OR balances.driver_receivable_cash <> 0',
        `OR balances.driver_receivable_cash <> (
               CASE WHEN vc.cancel_decided_at < vc.receivable_rollout_at THEN tt.carried ELSE 0 END
               - CASE WHEN vc.open_approved_at < vc.receivable_rollout_at THEN tt.carried ELSE 0 END
             )`,
      )
      .replace(
        'OR balances.driver_receivable_wallet <> 0',
        `OR balances.driver_receivable_wallet <> (
               CASE WHEN vc.cancel_decided_at < vc.receivable_rollout_at THEN tt.carried_wallet ELSE 0 END
               - CASE WHEN vc.open_approved_at < vc.receivable_rollout_at THEN tt.carried_wallet ELSE 0 END
             )
          OR balances.driver_shift_funding_cash <> (
               CASE WHEN vc.cancel_decided_at >= vc.receivable_rollout_at THEN tt.carried ELSE 0 END
               - CASE WHEN vc.open_approved_at >= vc.receivable_rollout_at THEN tt.carried ELSE 0 END
             )
          OR balances.driver_shift_funding_wallet <> (
               CASE WHEN vc.cancel_decided_at >= vc.receivable_rollout_at THEN tt.carried_wallet ELSE 0 END
               - CASE WHEN vc.open_approved_at >= vc.receivable_rollout_at THEN tt.carried_wallet ELSE 0 END
             )`,
      ),
  },
  residual_driver_balances: {
    id: 'residual_driver_balances',
    description: 'settled shifts clear operational balances and contribute only their explicit ordinary/funding receivables',
    sql: `
      WITH receivable_rollout AS (
        SELECT applied_at
          FROM schema_migrations
         WHERE filename = '0037_receivable_settlement_and_events.sql'
      ), carried AS (
        SELECT ft.shift_id,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (
                 WHERE ft.kind = 'carried_receivable'
               ), 0) AS carried_cash,
               COALESCE(sum(ft.amount_minor::numeric) FILTER (
                 WHERE ft.kind = 'carried_wallet_receivable'
               ), 0) AS carried_wallet
          FROM float_tranches ft
         GROUP BY ft.shift_id
      ), shift_balances AS (
        SELECT ss.shift_id, ss.driver_id,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_cash' AND f.owner_id = ss.driver_id
               ), 0) AS driver_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_wallet' AND f.owner_id = ss.driver_id
               ), 0) AS driver_wallet,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_share_payable' AND f.owner_id = ss.driver_id
               ), 0) AS driver_share,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_cash' AND f.owner_id = ss.driver_id
               ), 0) AS ordinary_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_receivable_wallet' AND f.owner_id = ss.driver_id
               ), 0) AS ordinary_wallet,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_shift_funding_cash' AND f.owner_id = ss.driver_id
               ), 0) AS funding_cash,
               COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
                 WHERE f.type::text = 'driver_shift_funding_wallet' AND f.owner_id = ss.driver_id
               ), 0) AS funding_wallet
          FROM shift_settlements ss
          LEFT JOIN journal_entries je ON je.shift_id = ss.shift_id
          LEFT JOIN journal_lines jl ON jl.entry_id = je.id
          LEFT JOIN funds f ON f.id = jl.fund_id
         GROUP BY ss.shift_id, ss.driver_id
      )
      SELECT sb.shift_id::text AS shift_id, sb.driver_id::text AS driver_id,
             sb.driver_cash::text AS driver_cash_minor,
             sb.driver_wallet::text AS driver_wallet_minor,
             sb.driver_share::text AS driver_share_minor,
             sb.ordinary_cash::text AS ordinary_cash_minor,
             (ss.cash_receivable_deferred_minor::numeric - CASE
                WHEN s.open_approved_at IS NULL OR s.open_approved_at < rollout.applied_at
                  THEN COALESCE(c.carried_cash, 0)
                ELSE 0
              END)::text AS expected_ordinary_cash_minor,
             sb.ordinary_wallet::text AS ordinary_wallet_minor,
             ss.wallet_receivable_deferred_minor::text AS expected_ordinary_wallet_minor,
             sb.funding_cash::text AS shift_funding_cash_minor,
             (-CASE
                WHEN s.open_approved_at >= rollout.applied_at THEN COALESCE(c.carried_cash, 0)
                ELSE 0
              END)::text AS expected_shift_funding_cash_minor,
             sb.funding_wallet::text AS shift_funding_wallet_minor,
             (-COALESCE(c.carried_wallet, 0))::text AS expected_shift_funding_wallet_minor
        FROM shift_balances sb
        JOIN shift_settlements ss ON ss.shift_id = sb.shift_id
        JOIN shifts s ON s.id = sb.shift_id
        CROSS JOIN receivable_rollout rollout
        LEFT JOIN carried c ON c.shift_id = sb.shift_id
       WHERE sb.driver_cash <> 0
          OR sb.driver_wallet <> 0
          OR sb.driver_share <> 0
          OR sb.ordinary_cash <> ss.cash_receivable_deferred_minor::numeric - CASE
               WHEN s.open_approved_at IS NULL OR s.open_approved_at < rollout.applied_at
                 THEN COALESCE(c.carried_cash, 0)
               ELSE 0
             END
          OR sb.ordinary_wallet <> ss.wallet_receivable_deferred_minor::numeric
          OR sb.funding_cash <> -CASE
               WHEN s.open_approved_at >= rollout.applied_at THEN COALESCE(c.carried_cash, 0)
               ELSE 0
             END
          OR sb.funding_wallet <> -COALESCE(c.carried_wallet, 0)
    `,
  },
})

const RECEIVABLE_EVENT_JOURNALS = Object.freeze({
  id: 'receivable_event_journals',
  description: 'every immutable receivable command has one exact idempotent balanced journal and no journal is orphaned',
  sql: `
    WITH expected_lines AS (
      SELECT re.id AS event_id, re.journal_entry_id,
             expected.line_role, expected.fund_type, expected.owner_id,
             re.branch_id::text AS fund_branch_id, expected.side,
             re.amount_minor::text AS amount_minor
        FROM receivable_events re
        CROSS JOIN LATERAL (VALUES
          (
            CASE WHEN re.direction = 'create' THEN 'receivable_created' ELSE 'receivable_cleared' END,
            CASE
              WHEN re.receivable_kind = 'ordinary' AND re.channel = 'cash' THEN 'driver_receivable_cash'
              WHEN re.receivable_kind = 'ordinary' AND re.channel = 'wallet' THEN 'driver_receivable_wallet'
              WHEN re.receivable_kind = 'shift_funding' AND re.channel = 'cash' THEN 'driver_shift_funding_cash'
              ELSE 'driver_shift_funding_wallet'
            END,
            re.driver_id::text,
            CASE WHEN re.direction = 'create' THEN 'D' ELSE 'C' END
          ),
          (
            CASE WHEN re.direction = 'create' THEN 'office_value_reclassified' ELSE 'receivable_collected' END,
            CASE WHEN re.channel = 'cash' THEN 'office_cash' ELSE 'office_wallet' END,
            NULL::text,
            CASE WHEN re.direction = 'create' THEN 'C' ELSE 'D' END
          )
        ) AS expected(line_role, fund_type, owner_id, side)
    ), expected_shapes AS (
      SELECT re.id AS event_id,
             jsonb_agg(jsonb_build_array(
               el.line_role, el.fund_type, el.owner_id, el.fund_branch_id, el.side, el.amount_minor
             ) ORDER BY el.line_role, el.fund_type, el.owner_id, el.fund_branch_id, el.side, el.amount_minor) AS line_shape
        FROM receivable_events re
        JOIN expected_lines el ON el.event_id = re.id
       GROUP BY re.id
    ), actual_shapes AS (
      SELECT re.id AS event_id, count(DISTINCT je.id) AS entry_count,
             COALESCE(jsonb_agg(jsonb_build_array(
               jl.line_role, f.type::text, f.owner_id::text, f.branch_id::text,
               jl.side, jl.amount_minor::text
             ) ORDER BY jl.line_role, f.type::text, f.owner_id::text, f.branch_id::text,
                        jl.side, jl.amount_minor::text
             ) FILTER (WHERE jl.id IS NOT NULL), '[]'::jsonb) AS line_shape
        FROM receivable_events re
        LEFT JOIN journal_entries je ON je.id = re.journal_entry_id
        LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        LEFT JOIN funds f ON f.id = jl.fund_id
       GROUP BY re.id
    )
    SELECT re.id::text AS event_id, re.journal_entry_id::text AS journal_entry_id,
           'receivable_event_journal_mismatch' AS issue,
           expected.line_shape AS expected_lines,
           actual.line_shape AS actual_lines
      FROM receivable_events re
      JOIN expected_shapes expected ON expected.event_id = re.id
      JOIN actual_shapes actual ON actual.event_id = re.id
      LEFT JOIN journal_entries je ON je.id = re.journal_entry_id
     WHERE actual.entry_count <> 1
        OR re.receivable_kind NOT IN ('ordinary', 'shift_funding')
        OR re.channel NOT IN ('cash', 'wallet')
        OR re.direction NOT IN ('create', 'collect')
        OR re.amount_minor <= 0
        OR NOT ${hasVisibleText('re.reason')}
        OR char_length(re.reason) > 500
        OR char_length(btrim(re.idempotency_key)) NOT BETWEEN 1 AND 64
        OR je.shift_id IS NOT NULL
        OR je.branch_id IS DISTINCT FROM re.branch_id
        OR je.event_type::text IS DISTINCT FROM 'receivable_adjustment'
        OR je.occurrence_key IS DISTINCT FROM re.idempotency_key
        OR je.business_date IS DISTINCT FROM re.business_date
        OR je.posting_date IS DISTINCT FROM re.business_date
        OR je.week_start_date IS DISTINCT FROM
           (re.business_date - extract(dow FROM re.business_date)::integer)
        OR je.reason IS DISTINCT FROM re.reason
        OR je.created_by IS DISTINCT FROM re.created_by
        OR actual.line_shape IS DISTINCT FROM expected.line_shape
    UNION ALL
    SELECT NULL::text, je.id::text, 'orphan_receivable_adjustment_journal',
           NULL::jsonb, NULL::jsonb
      FROM journal_entries je
      LEFT JOIN receivable_events re ON re.journal_entry_id = je.id
     WHERE je.shift_id IS NULL
       AND je.event_type::text = 'receivable_adjustment'
       AND re.id IS NULL
    UNION ALL
    SELECT min(re.id::text), NULL::text, 'duplicate_receivable_idempotency_key',
           NULL::jsonb, NULL::jsonb
      FROM receivable_events re
     GROUP BY re.branch_id, re.idempotency_key
    HAVING count(*) <> 1
  `,
})

const RECEIVABLE_FUND_BALANCES = Object.freeze({
  id: 'receivable_fund_balances',
  description: 'ordinary and shift-funding receivable balances are nonnegative and owned by their named driver',
  sql: `
    SELECT f.id::text AS fund_id, f.code, f.type::text AS fund_type,
           f.owner_id::text AS driver_id,
           COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}), 0)::text AS balance_minor,
           CASE
             WHEN f.owner_kind <> 'driver' OR f.owner_id IS NULL THEN 'receivable_owner_invalid'
             WHEN f.code <> f.type::text || ':' || f.owner_id::text THEN 'receivable_code_invalid'
             ELSE 'receivable_balance_negative'
           END AS issue
      FROM funds f
      LEFT JOIN journal_lines jl ON jl.fund_id = f.id
     WHERE f.type::text IN (
       'driver_receivable_cash', 'driver_receivable_wallet',
       'driver_shift_funding_cash', 'driver_shift_funding_wallet'
     )
     GROUP BY f.id, f.code, f.type, f.owner_kind, f.owner_id
    HAVING f.owner_kind <> 'driver'
        OR f.owner_id IS NULL
        OR f.code <> f.type::text || ':' || f.owner_id::text
        OR COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}), 0) < 0
  `,
})

const SHIFT_FUNDING_OPEN_CARRY = Object.freeze({
  id: 'shift_funding_open_carry',
  description: 'every post-0037 open consumes the complete pre-existing cash and wallet shift-funding balances',
  sql: `
    WITH receivable_rollout AS (
      SELECT applied_at
        FROM schema_migrations
       WHERE filename = '0037_receivable_settlement_and_events.sql'
    ), candidates AS (
      SELECT s.id AS shift_id, s.branch_id, s.driver_id, s.open_approved_at,
             COALESCE(sum(ft.amount_minor::numeric) FILTER (
               WHERE ft.kind = 'carried_receivable'
             ), 0) AS carried_cash,
             COALESCE(sum(ft.amount_minor::numeric) FILTER (
               WHERE ft.kind = 'carried_wallet_receivable'
             ), 0) AS carried_wallet
        FROM shifts s
        CROSS JOIN receivable_rollout rollout
        LEFT JOIN float_tranches ft ON ft.shift_id = s.id
       WHERE s.open_approved_at >= rollout.applied_at
       GROUP BY s.id, s.branch_id, s.driver_id, s.open_approved_at
    ), opening_balances AS (
      SELECT c.*,
             COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
               WHERE f.type::text = 'driver_shift_funding_cash'
                 AND f.owner_id = c.driver_id
                 AND je.id IS NOT NULL
             ), 0) AS cash_before_open,
             COALESCE(sum(${signed('jl.side', 'jl.amount_minor')}) FILTER (
               WHERE f.type::text = 'driver_shift_funding_wallet'
                 AND f.owner_id = c.driver_id
                 AND je.id IS NOT NULL
             ), 0) AS wallet_before_open
        FROM candidates c
        LEFT JOIN funds f ON f.branch_id = c.branch_id
          AND f.owner_id = c.driver_id
          AND f.type::text IN ('driver_shift_funding_cash', 'driver_shift_funding_wallet')
        LEFT JOIN journal_lines jl ON jl.fund_id = f.id
        LEFT JOIN journal_entries je ON je.id = jl.entry_id
          AND je.created_at <= c.open_approved_at
          AND je.shift_id IS DISTINCT FROM c.shift_id
       GROUP BY c.shift_id, c.branch_id, c.driver_id, c.open_approved_at,
                c.carried_cash, c.carried_wallet
    )
    SELECT ob.shift_id::text AS shift_id, ob.driver_id::text AS driver_id,
           ob.cash_before_open::text AS cash_before_open,
           ob.carried_cash::text AS carried_cash,
           ob.wallet_before_open::text AS wallet_before_open,
           ob.carried_wallet::text AS carried_wallet,
           'shift_funding_not_fully_consumed_at_open' AS issue
      FROM opening_balances ob
     WHERE ob.cash_before_open < 0
        OR ob.wallet_before_open < 0
        OR ob.carried_cash IS DISTINCT FROM ob.cash_before_open
        OR ob.carried_wallet IS DISTINCT FROM ob.wallet_before_open
  `,
})

/** Checks selected once migration 0037 is present. Unchanged evidence/BR1 checks are reused. */
export const INTEGRITY_CHECKS = Object.freeze(
  LEGACY_INTEGRITY_CHECKS.flatMap((check) => {
    if (check.id === 'residual_driver_balances') {
      return [
        RECEIVABLE_EVENT_JOURNALS,
        RECEIVABLE_FUND_BALANCES,
        SHIFT_FUNDING_OPEN_CARRY,
        RECEIVABLE_V2_CHECKS.residual_driver_balances,
      ]
    }
    return [RECEIVABLE_V2_CHECKS[check.id] ?? check]
  }),
)

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`
}

export function closeDraftHash(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

const bigintField = (row, name) => BigInt(String(row[name]))

function fixedSettlementHashV1(context, plan) {
  const canonical = {
    version: 1,
    policyCode: 'fixed_40_cash_close_v1',
    driverRateBps: 4_000,
    shiftId: context.shiftId,
    branchId: context.branchId,
    driverId: context.driverId,
    businessDate: context.businessDate,
    reviewedOrdersHash: context.reviewedOrdersHash,
    deliveryFeeTotal: String(plan.deliveryFeeTotal),
    fixedDriverShare: String(plan.fixedDriverShare),
    manualDriverShare: String(plan.manualDriverShare),
    grossDriverShare: String(plan.grossDriverShare),
    cashDeductionTotal: String(plan.cashDeductionTotal),
    baseDriverShare: String(plan.baseDriverShare),
    expectedCash: String(plan.expectedCash),
    expectedWallet: String(plan.expectedWallet),
    expectedTotal: String(plan.expectedTotal),
    actualCash: String(plan.actualCash),
    actualWallet: String(plan.actualWallet),
    actualTotal: String(plan.actualTotal),
    variance: String(plan.variance),
    finalEmployeeCash: String(plan.finalEmployeeCash),
    officeEntitlement: String(plan.officeEntitlement),
    walletToOffice: String(plan.walletToOffice),
    cashToOffice: String(plan.cashToOffice),
    walletAction: plan.wallet.action,
    walletAmount: String(plan.wallet.amount),
    cashAction: plan.cash.action,
    cashAmount: String(plan.cash.amount),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Hash used by v1 policy rows confirmed after durable close drafts launched. */
function fixedSettlementHashV2(context, plan) {
  const canonical = {
    version: 2,
    policyCode: 'fixed_40_cash_close_v1',
    driverRateBps: 4_000,
    ...context,
    deliveryFeeTotal: String(plan.deliveryFeeTotal),
    fixedDriverShare: String(plan.fixedDriverShare),
    manualDriverShare: String(plan.manualDriverShare),
    grossDriverShare: String(plan.grossDriverShare),
    cashDeductionTotal: String(plan.cashDeductionTotal),
    baseDriverShare: String(plan.baseDriverShare),
    expectedCash: String(plan.expectedCash),
    expectedWallet: String(plan.expectedWallet),
    expectedTotal: String(plan.expectedTotal),
    actualCash: String(plan.actualCash),
    actualWallet: String(plan.actualWallet),
    actualTotal: String(plan.actualTotal),
    variance: String(plan.variance),
    finalEmployeeCash: String(plan.finalEmployeeCash),
    officeEntitlement: String(plan.officeEntitlement),
    walletToOffice: String(plan.walletToOffice),
    cashToOffice: String(plan.cashToOffice),
    walletAction: plan.wallet.action,
    walletAmount: String(plan.wallet.amount),
    cashAction: plan.cash.action,
    cashAmount: String(plan.cash.amount),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Hash used by receivable-aware v2 policy rows. Kept local so historical checks never drift. */
function fixedSettlementHashV3(context, plan) {
  const canonical = {
    version: 3,
    policyCode: 'fixed_40_cash_close_v2_receivable',
    driverRateBps: 4_000,
    ...context,
    deliveryFeeTotal: String(plan.deliveryFeeTotal),
    fixedDriverShare: String(plan.fixedDriverShare),
    manualDriverShare: String(plan.manualDriverShare),
    grossDriverShare: String(plan.grossDriverShare),
    cashDeductionTotal: String(plan.cashDeductionTotal),
    baseDriverShare: String(plan.baseDriverShare),
    expectedCash: String(plan.expectedCash),
    expectedWallet: String(plan.expectedWallet),
    expectedTotal: String(plan.expectedTotal),
    actualCash: String(plan.actualCash),
    actualWallet: String(plan.actualWallet),
    actualTotal: String(plan.actualTotal),
    variance: String(plan.variance),
    finalEmployeeCash: String(plan.finalEmployeeCash),
    officeEntitlement: String(plan.officeEntitlement),
    cashClaimToOffice: String(plan.cashClaimToOffice),
    walletClaimToOffice: String(plan.walletClaimToOffice),
    cashReceivableDeferred: String(plan.cashReceivableDeferred),
    walletReceivableDeferred: String(plan.walletReceivableDeferred),
    walletToOffice: String(plan.walletToOffice),
    cashToOffice: String(plan.cashToOffice),
    walletAction: plan.wallet.action,
    walletAmount: String(plan.wallet.amount),
    cashAction: plan.cash.action,
    cashAmount: String(plan.cash.amount),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Rebuild the exact v2 hash input used when the manager signed the immutable settlement. */
export function canonicalSettlementHash(row) {
  const actualCash = bigintField(row, 'actual_cash_minor')
  const actualWallet = bigintField(row, 'actual_wallet_minor')
  const expectedTotal = bigintField(row, 'expected_total_minor')
  const baseDriverShare = bigintField(row, 'base_driver_share_minor')
  const cashDiff = bigintField(row, 'cash_diff_minor')
  const walletDiff = bigintField(row, 'wallet_diff_minor')
  const expectedCash = actualCash - cashDiff
  const expectedWallet = actualWallet - walletDiff
  const submittedDraft = row.close_draft_submitted_at === null
    || row.close_draft_submitted_at === undefined
    ? null
    : {
        revision: Number(row.close_draft_revision),
        hash: String(row.close_draft_hash),
        submittedAt: new Date(row.close_draft_submitted_at).toISOString(),
      }
  if (submittedDraft !== null && !Number.isSafeInteger(submittedDraft.revision)) {
    throw new RangeError(`unsafe close-draft revision ${String(row.close_draft_revision)}`)
  }
  const context = {
    shiftId: String(row.shift_id),
    branchId: String(row.branch_id),
    driverId: String(row.driver_id),
    businessDate: String(row.business_date),
    reviewedOrdersHash: String(row.reviewed_orders_hash),
  }
  const policyCode = String(row.policy_code ?? 'fixed_40_cash_close_v1')
  const plan = {
    deliveryFeeTotal: bigintField(row, 'delivery_fee_total_minor'),
    fixedDriverShare: bigintField(row, 'fixed_driver_share_minor'),
    manualDriverShare: bigintField(row, 'manual_driver_share_minor'),
    grossDriverShare: bigintField(row, 'gross_driver_share_minor'),
    cashDeductionTotal: bigintField(row, 'cash_deduction_total_minor'),
    baseDriverShare,
    expectedCash,
    expectedWallet,
    expectedTotal,
    actualCash,
    actualWallet,
    actualTotal: bigintField(row, 'actual_total_minor'),
    variance: bigintField(row, 'variance_minor'),
    finalEmployeeCash: bigintField(row, 'final_employee_cash_minor'),
    officeEntitlement: expectedTotal - baseDriverShare,
    cashClaimToOffice: row.cash_claim_to_office_minor == null
      ? bigintField(row, 'cash_to_office_minor')
      : bigintField(row, 'cash_claim_to_office_minor'),
    walletClaimToOffice: row.wallet_claim_to_office_minor == null
      ? bigintField(row, 'wallet_to_office_minor')
      : bigintField(row, 'wallet_claim_to_office_minor'),
    cashReceivableDeferred: row.cash_receivable_deferred_minor == null
      ? 0n
      : bigintField(row, 'cash_receivable_deferred_minor'),
    walletReceivableDeferred: row.wallet_receivable_deferred_minor == null
      ? 0n
      : bigintField(row, 'wallet_receivable_deferred_minor'),
    walletToOffice: bigintField(row, 'wallet_to_office_minor'),
    cashToOffice: bigintField(row, 'cash_to_office_minor'),
    wallet: {
      action: String(row.wallet_action),
      amount: bigintField(row, 'wallet_amount_minor'),
    },
    cash: {
      action: String(row.cash_action),
      amount: bigintField(row, 'cash_amount_minor'),
    },
  }
  const rolloutMs = row.close_draft_rollout_at == null
    ? Number.POSITIVE_INFINITY
    : new Date(row.close_draft_rollout_at).getTime()
  const confirmedMs = new Date(row.confirmed_at).getTime()
  if (!Number.isFinite(confirmedMs) || Number.isNaN(rolloutMs)) {
    throw new RangeError('invalid settlement hash-version timestamp')
  }
  if (policyCode === 'fixed_40_cash_close_v1') {
    if (confirmedMs < rolloutMs) return fixedSettlementHashV1(context, plan)
    return fixedSettlementHashV2(
      {
        ...context,
        closeDraftRevision: submittedDraft?.revision ?? null,
        closeDraftHash: submittedDraft?.hash ?? null,
        closeDraftSubmittedAt: submittedDraft?.submittedAt ?? null,
      },
      plan,
    )
  }
  if (policyCode === 'fixed_40_cash_close_v2_receivable') {
    return fixedSettlementHashV3(
      {
        ...context,
        closeDraftRevision: submittedDraft?.revision ?? null,
        closeDraftHash: submittedDraft?.hash ?? null,
        closeDraftSubmittedAt: submittedDraft?.submittedAt ?? null,
      },
      plan,
    )
  }
  throw new RangeError(`unsupported settlement policy ${policyCode}`)
}

const sampledCheckSql = (sql) => `
  SELECT row_to_json(violation)::text AS detail,
         count(*) OVER ()::text AS violation_count
    FROM (${sql}) AS violation
   LIMIT $1
`

async function runSqlCheck(client, check, sampleLimit) {
  const { rows } = await client.query(sampledCheckSql(check.sql), [sampleLimit])
  return {
    id: check.id,
    description: check.description,
    violations: rows.length === 0 ? 0 : Number(rows[0].violation_count),
    samples: rows.map((row) => JSON.parse(row.detail)),
  }
}

async function runDraftHashCheck(client, sampleLimit) {
  const { rows } = await client.query(
    `SELECT shift_id::text AS shift_id, revision::text AS revision, draft_hash, payload
       FROM shift_close_drafts
      ORDER BY shift_id`,
  )
  const failures = []
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    const computed = closeDraftHash(payload)
    if (computed !== row.draft_hash) {
      failures.push({
        shift_id: row.shift_id,
        revision: row.revision,
        stored_hash: row.draft_hash,
        computed_hash: computed,
      })
    }
  }
  return {
    id: 'close_draft_hashes',
    description: 'stored close-draft hashes equal canonical payload SHA-256 values',
    violations: failures.length,
    samples: failures.slice(0, sampleLimit),
  }
}

async function runSettlementHashCheck(client, sampleLimit, receivableV2) {
  const receivableColumns = receivableV2
    ? `ss.cash_claim_to_office_minor::text AS cash_claim_to_office_minor,
           ss.wallet_claim_to_office_minor::text AS wallet_claim_to_office_minor,
           ss.cash_receivable_deferred_minor::text AS cash_receivable_deferred_minor,
           ss.wallet_receivable_deferred_minor::text AS wallet_receivable_deferred_minor,`
    : `ss.cash_to_office_minor::text AS cash_claim_to_office_minor,
           ss.wallet_to_office_minor::text AS wallet_claim_to_office_minor,
           '0'::text AS cash_receivable_deferred_minor,
           '0'::text AS wallet_receivable_deferred_minor,`
  const { rows } = await client.query(`
    SELECT ss.shift_id::text AS shift_id,
           ss.branch_id::text AS branch_id,
           ss.driver_id::text AS driver_id,
           to_char(ss.business_date, 'YYYY-MM-DD') AS business_date,
           ss.policy_code,
           ss.delivery_fee_total_minor::text AS delivery_fee_total_minor,
           ss.fixed_driver_share_minor::text AS fixed_driver_share_minor,
           ss.manual_driver_share_minor::text AS manual_driver_share_minor,
           ss.gross_driver_share_minor::text AS gross_driver_share_minor,
           ss.cash_deduction_total_minor::text AS cash_deduction_total_minor,
           ss.base_driver_share_minor::text AS base_driver_share_minor,
           ss.expected_total_minor::text AS expected_total_minor,
           ss.actual_cash_minor::text AS actual_cash_minor,
           ss.actual_wallet_minor::text AS actual_wallet_minor,
           ss.actual_total_minor::text AS actual_total_minor,
           ss.variance_minor::text AS variance_minor,
           ss.final_employee_cash_minor::text AS final_employee_cash_minor,
           ${receivableColumns}
           ss.wallet_to_office_minor::text AS wallet_to_office_minor,
           ss.cash_to_office_minor::text AS cash_to_office_minor,
           ss.wallet_action,
           ss.wallet_amount_minor::text AS wallet_amount_minor,
           ss.cash_action,
           ss.cash_amount_minor::text AS cash_amount_minor,
           ss.reviewed_orders_hash,
           ss.settlement_hash,
           ss.confirmed_at AS confirmed_at,
           s.cash_diff_minor::text AS cash_diff_minor,
           s.wallet_diff_minor::text AS wallet_diff_minor,
           d.revision::text AS close_draft_revision,
           d.draft_hash AS close_draft_hash,
           d.submitted_at AS close_draft_submitted_at,
           rollout.close_draft_rollout_at
      FROM shift_settlements ss
      JOIN shifts s ON s.id = ss.shift_id
      LEFT JOIN shift_close_drafts d ON d.shift_id = ss.shift_id AND d.submitted_at IS NOT NULL
      LEFT JOIN (
        SELECT applied_at AS close_draft_rollout_at
          FROM schema_migrations
         WHERE filename = '0034_durable_shift_close_drafts.sql'
      ) rollout ON true
     ORDER BY ss.shift_id
  `)
  const failures = settlementHashFailures(rows)
  return {
    id: 'settlement_hashes',
    description: 'stored settlement hashes equal their canonical rollout-aware v1/v2/v3 SHA-256 values',
    violations: failures.length,
    samples: failures.slice(0, sampleLimit),
  }
}

/** Return every stored settlement whose complete canonical decision fingerprint does not match. */
export function settlementHashFailures(rows) {
  const failures = []
  for (const row of rows) {
    try {
      const computed = canonicalSettlementHash(row)
      if (computed !== row.settlement_hash) {
        failures.push({
          shift_id: row.shift_id,
          stored_hash: row.settlement_hash,
          computed_hash: computed,
        })
      }
    } catch (error) {
      failures.push({
        shift_id: row.shift_id,
        stored_hash: row.settlement_hash,
        issue: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return failures
}

export async function collectShiftMoneyIntegrity(client, { sampleLimit = 20 } = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100) {
    throw new RangeError('sampleLimit must be an integer from 1 through 100')
  }
  const metadata = await client.query(
    `SELECT current_database() AS database,
            current_user AS database_user,
            current_setting('server_version') AS server_version,
            clock_timestamp()::text AS as_of`,
  )
  const schema = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM schema_migrations
        WHERE filename = '0037_receivable_settlement_and_events.sql'
     ) AS receivable_v2`,
  )
  const receivableV2 = schema.rows[0]?.receivable_v2 === true
  const selectedChecks = receivableV2 ? INTEGRITY_CHECKS : LEGACY_INTEGRITY_CHECKS
  const checks = []
  for (const check of selectedChecks) checks.push(await runSqlCheck(client, check, sampleLimit))
  checks.push(await runSettlementHashCheck(client, sampleLimit, receivableV2))
  checks.push(await runDraftHashCheck(client, sampleLimit))
  return {
    ...metadata.rows[0],
    checks,
    violations: checks.reduce((total, check) => total + check.violations, 0),
  }
}

export async function runShiftMoneyIntegrity(pool, options = {}) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    const result = await collectShiftMoneyIntegrity(client, options)
    await client.query('ROLLBACK')
    transactionOpen = false
    return result
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

function parseArguments(argv) {
  let json = false
  let sampleLimit = 20
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg.startsWith('--sample-limit=')) sampleLimit = Number(arg.slice('--sample-limit='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { json, sampleLimit }
}

function printHuman(result) {
  console.log(
    `shift-money integrity: database ${result.database} as ${result.database_user} at ${result.as_of}`,
  )
  for (const check of result.checks) {
    const marker = check.violations === 0 ? 'OK' : 'FAIL'
    console.log(`${marker.padEnd(4)} ${check.id}: ${check.violations} violation(s)`)
    for (const sample of check.samples) console.log(`     ${JSON.stringify(sample)}`)
  }
  console.log(`shift-money integrity: ${result.violations === 0 ? 'PASS' : 'BLOCK'} (${result.violations} total)`)
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMain) {
  let pool
  try {
    const options = parseArguments(process.argv.slice(2))
    const databaseUrl = process.env.SHIFT_MONEY_DATABASE_URL ?? process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('set SHIFT_MONEY_DATABASE_URL or DATABASE_URL')
    pool = createPool(databaseUrl, 1)
    const result = await runShiftMoneyIntegrity(pool, { sampleLimit: options.sampleLimit })
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else printHuman(result)
    if (result.violations > 0) process.exitCode = 2
  } catch (error) {
    console.error(`shift-money integrity checker failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    await pool?.end().catch(() => undefined)
  }
}
