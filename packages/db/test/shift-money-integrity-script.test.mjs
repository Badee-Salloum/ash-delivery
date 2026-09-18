import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'
import { fixedSettlementHash } from '../../../apps/api/src/fixed-settlement.ts'
import {
  INTEGRITY_CHECKS,
  LEGACY_INTEGRITY_CHECKS,
  SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS,
  WRITEOFF_RECEIVABLE_INTEGRITY_CHECKS,
  canonicalSettlementHash,
  canonicalJson,
  closeDraftHash,
  collectShiftMoneyIntegrity,
  runShiftMoneyIntegrity,
  settlementHashFailures,
} from '../../../scripts/check-shift-money-integrity.mjs'

const script = readFileSync(
  new URL('../../../scripts/check-shift-money-integrity.mjs', import.meta.url),
  'utf8',
)

describe('read-only shift-money integrity checker', () => {
  it('covers every permanent release-blocking invariant', () => {
    expect(INTEGRITY_CHECKS.map((check) => check.id)).toEqual([
      'settlement_formulas',
      'settlement_state_coupling',
      'br1_settlement_snapshot',
      'journal_metadata_alignment',
      'double_entry',
      'tranche_journal_totals',
      'expected_close_events',
      'close_journal_alignment',
      'force_cancel_integrity',
      'unresolved_operations',
      'close_draft_boundaries',
      'receivable_event_journals',
      'receivable_fund_balances',
      'shift_funding_open_carry',
      'residual_driver_balances',
    ])
    expect(script).toContain("id: 'settlement_hashes'")
    expect(script).toContain("id: 'close_draft_hashes'")
  })

  it('grandfathers only terminal shifts approved before the settlement rollout boundary', () => {
    const coupling = INTEGRITY_CHECKS.find((check) => check.id === 'settlement_state_coupling').sql
    expect(coupling).toContain('schema_migrations')
    expect(coupling).toContain("filename = '0031_shift_settlements.sql'")
    expect(coupling).toContain("al.after ->> 'state' = 'approved'")
    expect(coupling).toContain('al.occurred_at >= rollout.applied_at')
    expect(coupling).toContain('s.created_at >= rollout.applied_at')
  })

  it('converts decimal close-draft money to exact minor units before comparing it', () => {
    const boundaries = INTEGRITY_CHECKS.find((check) => check.id === 'close_draft_boundaries').sql
    expect(boundaries).toContain("{figures,cashDeclared}')::numeric * 100")
    expect(boundaries).toContain("{figures,walletDeclared}')::numeric * 100")
    expect(boundaries).toContain("~ '^-?[0-9]+(\\.[0-9]{1,2})?$'")
  })

  it('accepts a retained submitted draft only for an audited force-cancel', () => {
    const boundaries = INTEGRITY_CHECKS.find((check) => check.id === 'close_draft_boundaries').sql
    expect(boundaries).toContain("s.state NOT IN ('pending_review', 'approved', 'week_locked', 'cancelled')")
    expect(boundaries).toContain('FROM shift_decisions cancel_decision')
    expect(boundaries).toContain("cancel_decision.gate = 'close'")
    expect(boundaries).toContain("cancel_decision.decision = 'force_cancelled'")
    expect(boundaries).toContain('regexp_replace')
    expect(boundaries).toContain('cancel_decision.notes IS NOT NULL')
    expect(boundaries).toContain('cancel_decision.decided_at >= d.submitted_at')
    expect(boundaries).not.toContain('void_audit')
    expect(boundaries).not.toContain("after ->> 'voided'")
  })

  it('recognizes the real manager close-figure revision audit shape', () => {
    const boundaries = INTEGRITY_CHECKS.find((check) => check.id === 'close_draft_boundaries').sql
    expect(boundaries).toContain("al.after ->> 'revisedByManager' = 'true'")
    expect(boundaries).toContain("al.actor_kind = 'user' AND al.actor_id IS NOT NULL")
    expect(boundaries).toContain('al.branch_id = s.branch_id')
    expect(boundaries).toContain("al.before ->> 'cashDeclared' IS DISTINCT FROM al.after ->> 'cashDeclared'")
    expect(boundaries).toContain("al.before ->> 'walletDeclared' IS DISTINCT FROM al.after ->> 'walletDeclared'")
    expect(boundaries).toContain("al.before ->> 'odometerKm' IS DISTINCT FROM al.after ->> 'odometerKm'")
    expect(boundaries).toContain("(al.after ->> 'cashDeclared')::numeric * 100")
    expect(boundaries).toContain("(al.after ->> 'walletDeclared')::numeric * 100")
    expect(boundaries).toContain('IS NOT DISTINCT FROM s.end_cash_declared_minor::numeric')
    expect(boundaries).toContain('IS NOT DISTINCT FROM s.end_wallet_declared_minor::numeric')
    expect(boundaries).toContain('IS NOT DISTINCT FROM s.odo_end::numeric')
    expect(boundaries).not.toContain("al.before ->> 'state' = 'pending_review'")
    expect(boundaries).not.toContain("al.before ->> 'end_cash_declared_minor'")
  })

  it('checks each settled contribution across ordinary and shift-funding cash/wallet funds', () => {
    const residuals = INTEGRITY_CHECKS.find((check) => check.id === 'residual_driver_balances').sql
    expect(residuals).toContain('je.shift_id = ss.shift_id')
    expect(residuals).toContain("ft.kind = 'carried_receivable'")
    expect(residuals).toContain("ft.kind = 'carried_wallet_receivable'")
    // Since 0041 a deferred collection is SHIFT FUNDING, so a settled shift's ordinary funds must
    // move only by the legacy pre-0037 carry, and the deferral belongs on the funding side.
    expect(residuals).toContain('sb.ordinary_cash <> - CASE')
    expect(residuals).toContain('sb.ordinary_wallet <> 0')
    expect(residuals).toContain('sb.funding_cash <> ss.cash_receivable_deferred_minor::numeric - CASE')
    expect(residuals).toContain('s.open_approved_at < rollout.applied_at')
    expect(residuals).toContain('s.open_approved_at >= rollout.applied_at')
    expect(residuals).toContain('sb.funding_wallet <> ss.wallet_receivable_deferred_minor::numeric')
    expect(residuals).toContain('- COALESCE(c.carried_wallet, 0)')
    expect(residuals).toContain("f.type::text = 'driver_receivable_wallet'")
    expect(residuals).toContain("f.type::text = 'driver_shift_funding_wallet'")
  })

  it('audits a close-owned shortage as ordinary debt without confusing it with shift funding', () => {
    const formulas = SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS
      .find((check) => check.id === 'settlement_formulas').sql
    expect(formulas).toContain('maximum_cash_shortage_receivable_minor::numeric <>')
    expect(formulas).toContain('GREATEST(-ss.final_employee_cash_minor::numeric, 0::numeric)')
    expect(formulas).toContain('ss.cash_shortage_receivable_minor::numeric >')
    expect(formulas).toContain('- ss.cash_shortage_receivable_minor::numeric')

    const alignment = SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS
      .find((check) => check.id === 'close_journal_alignment').sql
    expect(alignment).toContain("'cash_shortage_receivable', 'driver_receivable_cash'")

    const residuals = SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS
      .find((check) => check.id === 'residual_driver_balances').sql
    expect(residuals).toContain('sb.ordinary_cash <> ss.cash_shortage_receivable_minor::numeric - CASE')
    expect(residuals).toContain('sb.funding_cash <> ss.cash_receivable_deferred_minor::numeric - CASE')
  })

  it('validates v2 claims, bounded deferrals, physical transfers, and office conservation', () => {
    const formulas = INTEGRITY_CHECKS.find((check) => check.id === 'settlement_formulas').sql
    expect(formulas).toContain("'fixed_40_cash_close_v1'")
    expect(formulas).toContain("'fixed_40_cash_close_v2_receivable'")
    expect(formulas).toContain('cash_claim_to_office_minor::numeric <>')
    expect(formulas).toContain('actual_cash_minor::numeric - ss.final_employee_cash_minor::numeric')
    expect(formulas).toContain('wallet_claim_to_office_minor::numeric <> ss.actual_wallet_minor::numeric')
    expect(formulas).toContain('GREATEST(ss.cash_claim_to_office_minor::numeric, 0::numeric)')
    expect(formulas).toContain('GREATEST(ss.wallet_claim_to_office_minor::numeric, 0::numeric)')
    expect(formulas).toContain('ss.cash_claim_to_office_minor::numeric - ss.cash_receivable_deferred_minor::numeric')
    expect(formulas).toContain('ss.wallet_claim_to_office_minor::numeric - ss.wallet_receivable_deferred_minor::numeric')
    expect(formulas).toContain('ss.expected_total_minor::numeric - ss.base_driver_share_minor::numeric')
  })

  it('keeps cash and wallet carries distinct and changes counterpart funds only after 0037', () => {
    const tranches = INTEGRITY_CHECKS.find((check) => check.id === 'tranche_journal_totals').sql
    expect(tranches).toContain("filename = '0037_receivable_settlement_and_events.sql'")
    expect(tranches).toContain("ft.kind = 'carried_receivable'")
    expect(tranches).toContain("ft.kind = 'carried_wallet_receivable'")
    expect(tranches).toContain("f.type::text = 'driver_receivable_cash'")
    expect(tranches).toContain("f.type::text = 'driver_shift_funding_cash'")
    expect(tranches).toContain("f.type::text = 'driver_shift_funding_wallet'")
    expect(tranches).toContain('s.open_approved_at >= rollout.applied_at AS uses_shift_funding')
    expect(tranches).toContain('COALESCE(jt.carried_wallet, 0)')
  })

  it('nets only exact wallet top-up correction journals against the opening total', () => {
    for (const checks of [LEGACY_INTEGRITY_CHECKS, INTEGRITY_CHECKS]) {
      const tranches = checks.find((check) => check.id === 'tranche_journal_totals').sql
      expect(tranches).toContain("je.event_type = 'correction'")
      expect(tranches).toContain("je.occurrence_key LIKE 'wallet-topup-adjustment:%'")
      expect(tranches).toContain("f.type::text = 'office_wallet'")
      expect(tranches).toContain("f.type::text = 'driver_wallet'")
      expect(tranches).toContain('es.driver_wallet_credit = es.office_wallet_debit')
      expect(tranches).toContain('es.line_count = 2')
    }

    const tranches = INTEGRITY_CHECKS.find((check) => check.id === 'tranche_journal_totals').sql
    expect(tranches).toContain('AS is_wallet_topup_adjustment')
    expect(tranches).toContain('WHERE c.is_wallet_topup_adjustment')
    expect(tranches).toContain('OR c.is_wallet_topup_adjustment')
  })

  it('nets only exact cash-float correction journals against the opening total', () => {
    for (const checks of [LEGACY_INTEGRITY_CHECKS, INTEGRITY_CHECKS]) {
      const tranches = checks.find((check) => check.id === 'tranche_journal_totals').sql
      expect(tranches).toContain("je.event_type = 'correction'")
      expect(tranches).toContain("je.occurrence_key LIKE 'cash-float-adjustment:%'")
      expect(tranches).toContain("f.type::text = 'office_cash'")
      expect(tranches).toContain("f.type::text = 'driver_cash'")
      expect(tranches).toContain('es.driver_cash_credit = es.office_cash_debit')
      expect(tranches).toContain('es.line_count = 2')
    }

    const tranches = INTEGRITY_CHECKS.find((check) => check.id === 'tranche_journal_totals').sql
    expect(tranches).toContain('AS is_cash_float_adjustment')
    expect(tranches).toContain('WHERE c.is_cash_float_adjustment')
    expect(tranches).toContain('OR c.is_cash_float_adjustment')
  })

  it('grandfathers only cancelled shifts that predate the 0035 integrity boundary', () => {
    for (const checks of [LEGACY_INTEGRITY_CHECKS, INTEGRITY_CHECKS]) {
      const tranches = checks.find((check) => check.id === 'tranche_journal_totals').sql
      expect(tranches).toContain("filename = '0035_shift_money_integrity.sql'")
      expect(tranches).toContain("s.state <> 'cancelled'")
      expect(tranches).toContain('s.created_at >= rollout.applied_at')
      expect(tranches).toContain("al.after ->> 'state' = 'cancelled'")
      expect(tranches).toContain("sd.decision = 'force_cancelled'")
      expect(tranches).toContain('FROM eligible_shifts s')
      expect(tranches).toContain('JOIN eligible_shifts s ON s.id = je.shift_id')
    }
  })

  it('matches every direct receivable command to its exact idempotent journal', () => {
    const events = INTEGRITY_CHECKS.find((check) => check.id === 'receivable_event_journals').sql
    expect(events).toContain('FROM receivable_events re')
    expect(events).toContain("je.event_type::text IS DISTINCT FROM 'receivable_adjustment'")
    expect(events).toContain('je.occurrence_key IS DISTINCT FROM re.idempotency_key')
    expect(events).not.toContain('je.journal_entry_id')
    expect(events).toContain('je.reason IS DISTINCT FROM re.reason')
    expect(events).toContain("'driver_receivable_cash'")
    expect(events).toContain("'driver_shift_funding_wallet'")
    expect(events).toContain("'orphan_receivable_adjustment_journal'")
    expect(events).toContain("'duplicate_receivable_idempotency_key'")
    expect(events).toContain('actual.line_shape IS DISTINCT FROM expected.line_shape')
  })

  it('matches write-offs only to the dedicated loss code and never to an office fund', () => {
    const events = WRITEOFF_RECEIVABLE_INTEGRITY_CHECKS
      .find((check) => check.id === 'receivable_event_journals').sql

    expect(events).toContain("re.intent NOT IN ('command', 'correction', 'writeoff')")
    expect(events).toContain("re.intent = 'writeoff'")
    expect(events).toContain("re.receivable_kind <> 'ordinary' OR re.direction <> 'collect'")
    expect(events).toContain("'receivable_written_off'")
    expect(events).toContain("'receivable_writeoff_loss'")
    expect(events).toContain("'cost_center:receivable_writeoff_loss'")
    expect(events).toContain('el.fund_code')
    expect(events).toContain('f.code')
    expect(events).toContain('actual.line_shape IS DISTINCT FROM expected.line_shape')
  })

  it('requires nonnegative named balances and complete automatic shift-funding consumption', () => {
    const balances = INTEGRITY_CHECKS.find((check) => check.id === 'receivable_fund_balances').sql
    expect(balances).toContain("f.owner_kind <> 'driver'")
    expect(balances).toContain("f.code <> f.type::text || ':' || f.owner_id::text")
    expect(balances).toContain("'driver_receivable_cash', 'driver_receivable_wallet'")
    expect(balances).toContain("'driver_shift_funding_cash', 'driver_shift_funding_wallet'")
    expect(balances).toContain("< 0")

    const carry = INTEGRITY_CHECKS.find((check) => check.id === 'shift_funding_open_carry').sql
    expect(carry).toContain("filename = '0037_receivable_settlement_and_events.sql'")
    expect(carry).toContain('je.shift_id IS DISTINCT FROM c.shift_id')
    expect(carry).toContain('ob.carried_cash IS DISTINCT FROM ob.cash_before_open')
    expect(carry).toContain('ob.carried_wallet IS DISTINCT FROM ob.wallet_before_open')
  })

  it('compares the complete close-line multiset so extra balanced lines cannot hide', () => {
    const alignment = INTEGRITY_CHECKS.find((check) => check.id === 'close_journal_alignment').sql
    expect(alignment).toContain('expected_lines AS')
    expect(alignment).toContain('actual_shapes AS')
    expect(alignment).toContain("FILTER (WHERE jl.id IS NOT NULL)")
    expect(alignment).toContain('actual.line_shape IS DISTINCT FROM expected.line_shape')
    expect(alignment).toContain('actual.wallet_entries <> expected.wallet_entries')
    expect(alignment).toContain('actual.cash_entries <> expected.cash_entries')

    // This is balanced and therefore passes the general double-entry check, but both unexpected
    // roles remain in the actual multiset and make it differ from the canonical empty set.
    const extraBalancedLines = [
      ['float_return', '1', 'unexpected_debit', 'office_cash', null, 'branch', 'D', '25'],
      ['float_return', '1', 'unexpected_credit', 'office_wallet', null, 'branch', 'C', '25'],
    ]
    const signedTotal = extraBalancedLines.reduce(
      (total, line) => total + (line[6] === 'D' ? BigInt(line[7]) : -BigInt(line[7])),
      0n,
    )
    expect(signedTotal).toBe(0n)
    expect(JSON.stringify(extraBalancedLines)).not.toBe(JSON.stringify([]))
  })

  it('ties every shift journal and line fund to the shift branch and accounting dates', () => {
    const alignment = INTEGRITY_CHECKS.find((check) => check.id === 'journal_metadata_alignment').sql
    expect(alignment).toContain('je.branch_id IS DISTINCT FROM s.branch_id')
    expect(alignment).toContain('je.business_date IS DISTINCT FROM s.business_date')
    expect(alignment).toContain('je.week_start_date IS DISTINCT FROM s.week_start_date')
    expect(alignment).toContain('f.branch_id IS DISTINCT FROM je.branch_id')
    expect(alignment).toContain('jl.entry_id = je.id')
  })

  it('recomputes stored BR1 and settlement sources from canonical included operations', () => {
    const snapshot = INTEGRITY_CHECKS.find((check) => check.id === 'br1_settlement_snapshot').sql
    expect(snapshot).toContain('included_orders AS')
    expect(snapshot).toContain('included_deductions AS')
    expect(snapshot).toContain('jsonb_array_length(o.close_draft_review_reasons)')
    expect(snapshot).toContain("o.window_status <> 'unknown'")
    expect(snapshot).toContain("CASE WHEN io.pay_mode = 'cash' THEN 0 ELSE io.fee_minor::numeric END")
    expect(snapshot).toContain("WHEN io.kind = 'manual' THEN 0")
    expect(snapshot).toContain('floor(io.fee_minor::numeric * 2000 / 10000)')
    expect(snapshot).toContain("FILTER (WHERE ft.kind = 'carried_receivable')")
    expect(snapshot).toContain('r.equation_diff_minor::numeric IS DISTINCT FROM r.scalar_diff')
    expect(snapshot).toContain('ss.delivery_fee_total_minor::numeric IS DISTINCT FROM r.delivery_fee_total')
    expect(snapshot).toContain('ss.cash_deduction_total_minor::numeric IS DISTINCT FROM r.cash_deductions')
    expect(snapshot).toContain('ss.variance_minor::numeric IS DISTINCT FROM r.scalar_diff')
  })

  it('audits post-rollout force-cancels without relying on a close draft or settlement', () => {
    const forceCancel = INTEGRITY_CHECKS.find((check) => check.id === 'force_cancel_integrity').sql
    expect(forceCancel).toContain("filename = '0035_shift_money_integrity.sql'")
    expect(forceCancel).toContain("sd.decision = 'force_cancelled'")
    expect(forceCancel).toContain('(fd.notes)[1] IS NOT NULL')
    expect(forceCancel).toContain('regexp_replace')
    expect(forceCancel).toContain("'void-carry-' || vc.id::text")
    expect(forceCancel).toContain("'void-wallet-carry-' || vc.id::text")
    expect(forceCancel).toContain("'driver_shift_funding_cash'")
    expect(forceCancel).toContain("'driver_shift_funding_wallet'")
    expect(forceCancel).toContain("'float_return'::text, '1'::text")
    expect(forceCancel).toContain("'wallet_return', '1'")
    expect(forceCancel).toContain('actual.line_shape IS DISTINCT FROM expected.line_shape')
    expect(forceCancel).toContain('balances.driver_cash <> 0')
    expect(forceCancel).toContain('balances.driver_wallet <> 0')
    expect(forceCancel).toContain('balances.driver_share <> 0')
    expect(forceCancel).toContain('vc.cancel_decided_at < vc.receivable_rollout_at')
    expect(forceCancel).toContain('vc.open_approved_at < vc.receivable_rollout_at')
    expect(forceCancel).toContain('balances.driver_receivable_cash <> (')
    expect(forceCancel).toContain('balances.driver_shift_funding_cash <> (')
    expect(forceCancel).not.toContain('shift_close_drafts')
    expect(forceCancel).not.toContain('shift_settlements')
  })

  /**
   * The void recipe describes the carry reversals and nothing else, so only THOSE corrections may
   * count as its actual lines. A cancelled shift may legitimately also carry an unrelated audited
   * correction; in production that is a wallet top-up adjustment
   * («تصحيح القيمة الفعلية لشحن المحفظة حسب توجيه الإدارة»), recorded before the cancel.
   *
   * Scoping every `correction` into the actual set made that adjustment an unexpected line and
   * failed a shift whose driver cash, driver wallet, office cash and office wallet all net to
   * zero — while the database's own `shift_void_journals_match` returned true for the same shift.
   * The release blocker exited 2 on a correct ledger, which is how a release blocker stops being
   * read. `tranche_journal_totals` already nets exactly these adjustments.
   */
  it('counts only the void carry reversals as corrections, not every correction on the shift', () => {
    for (const check of [
      LEGACY_INTEGRITY_CHECKS.find((c) => c.id === 'force_cancel_integrity').sql,
      INTEGRITY_CHECKS.find((c) => c.id === 'force_cancel_integrity').sql,
    ]) {
      expect(check).toContain("je.occurrence_key LIKE 'void-carry-%'")
      expect(check).toContain("je.occurrence_key LIKE 'void-wallet-carry-%'")
      // The unscoped form is what swept in the unrelated adjustment.
      expect(check).not.toContain("je.event_type IN ('float_return', 'wallet_return', 'correction')")
    }
  })

  it('contains only SELECT/CTE audit queries and enforces a read-only snapshot', () => {
    const mutation = /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|CALL|COPY)\b/i
    for (const check of [
      ...LEGACY_INTEGRITY_CHECKS,
      ...INTEGRITY_CHECKS,
      ...SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS,
    ]) {
      expect(check.sql.trim()).toMatch(/^(?:SELECT|WITH)\b/i)
      const executableSql = check.sql.replace(/'(?:''|[^'])*'/g, "''")
      expect(executableSql).not.toMatch(mutation)
    }
    expect(script).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(script).toContain("await client.query('ROLLBACK')")
    expect(script).not.toContain("await client.query('COMMIT')")
  })

  it('does not require migration 0035 helpers during the pre-migration production audit', () => {
    for (const check of LEGACY_INTEGRITY_CHECKS) {
      expect(check.sql).not.toContain('ash_has_visible_text')
    }
    expect(script).toContain('Keep the pre-migration audit runnable on schema 0034')
    expect(script).toContain('shortageReceivableV4')
    expect(script).toContain('? SHORTAGE_RECEIVABLE_INTEGRITY_CHECKS')
    expect(script).toContain('? INTEGRITY_CHECKS')
    expect(script).toContain(': LEGACY_INTEGRITY_CHECKS')
  })

  it('opens and rolls back the read-only snapshot without ever committing', async () => {
    const calls = []
    let released = false
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('current_database()')) {
          return {
            rows: [{
              database: 'disposable',
              database_user: 'auditor',
              server_version: '17-test',
              as_of: '2026-08-23 00:00:00+00',
            }],
          }
        }
        return { rows: [] }
      },
      release() { released = true },
    }
    const pool = { async connect() { return client } }

    const result = await runShiftMoneyIntegrity(pool, { sampleLimit: 5 })

    expect(result.violations).toBe(0)
    expect(calls[0].sql).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(calls.at(-1).sql).toBe('ROLLBACK')
    expect(calls.some(({ sql }) => /\bCOMMIT\b/.test(sql))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('FROM receivable_events re'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes("'0'::text AS cash_receivable_deferred_minor"))).toBe(true)
    expect(released).toBe(true)
  })

  it('selects the receivable-aware checks only after migration 0037', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('current_database()')) {
          return {
            rows: [{
              database: 'disposable-v2',
              database_user: 'auditor',
              server_version: '17-test',
              as_of: '2026-08-23 00:00:00+00',
            }],
          }
        }
        if (sql.includes('AS receivable_v2')) return { rows: [{ receivable_v2: true }] }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { async connect() { return client } }

    const result = await runShiftMoneyIntegrity(pool, { sampleLimit: 5 })

    expect(result.violations).toBe(0)
    expect(calls.some(({ sql }) => sql.includes('FROM receivable_events re'))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes('ss.cash_claim_to_office_minor::text'))).toBe(true)
    expect(calls.at(-1).sql).toBe('ROLLBACK')
  })

  it('selects the write-off recipe only after migration 0051', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('current_database()')) {
          return {
            rows: [{
              database: 'disposable-v3',
              database_user: 'auditor',
              server_version: '17-test',
              as_of: '2026-08-30 00:00:00+00',
            }],
          }
        }
        if (sql.includes('AS receivable_v2')) {
          return {
            rows: [{
              receivable_v2: true,
              writeoff_receivable_v3: true,
              shortage_receivable_v4: false,
            }],
          }
        }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { async connect() { return client } }

    const result = await runShiftMoneyIntegrity(pool, { sampleLimit: 5 })

    expect(result.violations).toBe(0)
    expect(calls.some(({ sql }) => sql.includes("re.intent = 'writeoff'"))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes("'cost_center:receivable_writeoff_loss'"))).toBe(true)
    expect(calls.at(-1).sql).toBe('ROLLBACK')
  })

  it('selects close-shortage-aware checks only after migration 0052', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('current_database()')) {
          return {
            rows: [{
              database: 'disposable-v4',
              database_user: 'auditor',
              server_version: '17-test',
              as_of: '2026-08-30 00:00:00+00',
            }],
          }
        }
        if (sql.includes('AS receivable_v2')) {
          return { rows: [{ receivable_v2: true, shortage_receivable_v4: true }] }
        }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { async connect() { return client } }

    const result = await runShiftMoneyIntegrity(pool, { sampleLimit: 5 })

    expect(result.violations).toBe(0)
    expect(calls.some(({ sql }) => sql.includes('ss.cash_shortage_receivable_minor::text'))).toBe(true)
    expect(calls.some(({ sql }) => sql.includes("'cash_shortage_receivable'"))).toBe(true)
    expect(calls.at(-1).sql).toBe('ROLLBACK')
  })

  it('uses the same recursively canonical SHA-256 shape as close-draft storage', () => {
    const payload = {
      z: [{ b: 2, a: 1 }],
      a: { d: null, c: 'minor-units' },
    }
    const canonical = '{"a":{"c":"minor-units","d":null},"z":[{"a":1,"b":2}]}'
    expect(canonicalJson(payload)).toBe(canonical)
    expect(closeDraftHash(payload)).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(closeDraftHash({ a: 1, b: 2 })).toBe(closeDraftHash({ b: 2, a: 1 }))
  })

  it('recomputes settlement hashes and rejects a wrong but well-formed 64-hex value', () => {
    const row = {
      shift_id: '00000000-0000-4000-8000-000000000001',
      branch_id: '00000000-0000-4000-8000-000000000002',
      driver_id: '00000000-0000-4000-8000-000000000003',
      business_date: '2026-08-22',
      delivery_fee_total_minor: '10000',
      fixed_driver_share_minor: '4000',
      manual_driver_share_minor: '0',
      gross_driver_share_minor: '4000',
      cash_deduction_total_minor: '0',
      base_driver_share_minor: '4000',
      expected_total_minor: '10000',
      actual_cash_minor: '10000',
      actual_wallet_minor: '0',
      actual_total_minor: '10000',
      variance_minor: '0',
      final_employee_cash_minor: '4000',
      wallet_to_office_minor: '0',
      cash_to_office_minor: '6000',
      wallet_action: 'none',
      wallet_amount_minor: '0',
      cash_action: 'collect',
      cash_amount_minor: '6000',
      reviewed_orders_hash: 'orders-hash',
      cash_diff_minor: '0',
      wallet_diff_minor: '0',
      close_draft_revision: '3',
      close_draft_hash: 'b'.repeat(64),
      close_draft_submitted_at: '2026-08-22T12:00:00.000Z',
      confirmed_at: '2026-08-22T12:01:00.000Z',
      close_draft_rollout_at: '2026-08-22T11:00:00.000Z',
      shortage_receivable_rollout_at: '2026-08-23T11:00:00.000Z',
      maximum_cash_shortage_receivable_minor: '0',
      cash_shortage_receivable_minor: '0',
      settlement_hash: 'f'.repeat(64),
    }

    const computed = canonicalSettlementHash(row)
    expect(computed).toMatch(/^[0-9a-f]{64}$/)
    expect(computed).not.toBe(row.settlement_hash)
    expect(settlementHashFailures([row])).toEqual([{
      shift_id: row.shift_id,
      stored_hash: row.settlement_hash,
      computed_hash: computed,
    }])

    expect(settlementHashFailures([{ ...row, settlement_hash: computed }])).toEqual([])
  })

  it('hash-binds both v2 claims, both deferrals, and their physical movements', () => {
    const row = {
      shift_id: '00000000-0000-4000-8000-000000000011',
      branch_id: '00000000-0000-4000-8000-000000000012',
      driver_id: '00000000-0000-4000-8000-000000000013',
      business_date: '2026-08-23',
      policy_code: 'fixed_40_cash_close_v2_receivable',
      delivery_fee_total_minor: '10000',
      fixed_driver_share_minor: '4000',
      manual_driver_share_minor: '0',
      gross_driver_share_minor: '4000',
      cash_deduction_total_minor: '0',
      base_driver_share_minor: '4000',
      expected_total_minor: '12000',
      actual_cash_minor: '10000',
      actual_wallet_minor: '2000',
      actual_total_minor: '12000',
      variance_minor: '0',
      final_employee_cash_minor: '4000',
      cash_claim_to_office_minor: '6000',
      wallet_claim_to_office_minor: '2000',
      cash_receivable_deferred_minor: '1000',
      wallet_receivable_deferred_minor: '500',
      wallet_to_office_minor: '1500',
      cash_to_office_minor: '5000',
      wallet_action: 'collect',
      wallet_amount_minor: '1500',
      cash_action: 'collect',
      cash_amount_minor: '5000',
      reviewed_orders_hash: 'orders-hash-v2',
      cash_diff_minor: '0',
      wallet_diff_minor: '0',
      close_draft_revision: '4',
      close_draft_hash: 'c'.repeat(64),
      close_draft_submitted_at: '2026-08-23T12:00:00.000Z',
      confirmed_at: '2026-08-23T12:01:00.000Z',
      close_draft_rollout_at: '2026-08-22T11:00:00.000Z',
      shortage_receivable_rollout_at: '2026-08-23T11:00:00.000Z',
      manager_charge_rollout_at: '2026-08-23T11:30:00.000Z',
      maximum_cash_shortage_receivable_minor: '0',
      cash_shortage_receivable_minor: '0',
      settlement_hash: 'f'.repeat(64),
    }

    const canonical = canonicalSettlementHash(row)
    expect(canonical).toMatch(/^[0-9a-f]{64}$/)
    expect(canonical).toBe(fixedSettlementHash(
      {
        shiftId: row.shift_id,
        branchId: row.branch_id,
        driverId: row.driver_id,
        businessDate: row.business_date,
        reviewedOrdersHash: row.reviewed_orders_hash,
        closeDraftRevision: 4,
        closeDraftHash: row.close_draft_hash,
        closeDraftSubmittedAt: row.close_draft_submitted_at,
      },
      {
        deliveryFeeTotal: 10_000n,
        fixedDriverShare: 4_000n,
        manualDriverShare: 0n,
        grossDriverShare: 4_000n,
        cashDeductionTotal: 0n,
        baseDriverShare: 4_000n,
        // Explicit: this file is .mjs, so nothing typechecks the hand-built plan and an omitted
        // field would stringify to "undefined" and silently diverge from the real hash.
        managerChargeTotal: 0n,
        expectedCash: 10_000n,
        expectedWallet: 2_000n,
        expectedTotal: 12_000n,
        actualCash: 10_000n,
        actualWallet: 2_000n,
        actualTotal: 12_000n,
        variance: 0n,
        finalEmployeeCash: 4_000n,
        officeEntitlement: 8_000n,
        cashClaimToOffice: 6_000n,
        walletClaimToOffice: 2_000n,
        cashReceivableDeferred: 1_000n,
        walletReceivableDeferred: 500n,
        maximumCashShortageReceivable: 0n,
        cashShortageReceivable: 0n,
        cashToOffice: 5_000n,
        walletToOffice: 1_500n,
        wallet: { action: 'collect', amount: 1_500n },
        cash: { action: 'collect', amount: 5_000n },
      },
    ))
    expect(canonicalSettlementHash({
      ...row,
      cash_receivable_deferred_minor: '1001',
    })).not.toBe(canonical)
    expect(canonicalSettlementHash({
      ...row,
      wallet_receivable_deferred_minor: '501',
    })).not.toBe(canonical)
    expect(canonicalSettlementHash({
      ...row,
      cash_claim_to_office_minor: '6001',
    })).not.toBe(canonical)
    expect(canonicalSettlementHash({
      ...row,
      wallet_to_office_minor: '1499',
    })).not.toBe(canonical)
    expect(canonicalSettlementHash({
      ...row,
      cash_shortage_receivable_minor: '1',
    })).not.toBe(canonical)
    expect(settlementHashFailures([{ ...row, settlement_hash: canonical }])).toEqual([])

    const historicalV4 = canonicalSettlementHash({
      ...row,
      manager_charge_rollout_at: '2026-08-24T11:00:00.000Z',
    })
    expect(historicalV4).toMatch(/^[0-9a-f]{64}$/)
    expect(historicalV4).not.toBe(canonical)
    expect(settlementHashFailures([{
      ...row,
      manager_charge_rollout_at: '2026-08-24T11:00:00.000Z',
      settlement_hash: historicalV4,
    }])).toEqual([])
  })
})

const DATABASE_URL = process.env.SHIFT_MONEY_TEST_DATABASE_URL ?? process.env.DATABASE_URL
// Positively identify the database as disposable BOTH by its URL and, once connected, by the
// server actually on the other end — the pattern every other real-Postgres test here follows.
// This file previously checked only the URL and never called `migrate`, which is why it was the
// only Postgres-touching test running against hand-built stand-ins instead of the real schema.
const disposable = DATABASE_URL ? assertDisposableDatabaseUrl(DATABASE_URL) : null

if (!DATABASE_URL) {
  describe('close journal multiset on PostgreSQL', () => {
    it.skip('skipped: set SHIFT_MONEY_TEST_DATABASE_URL for the real-PostgreSQL query test', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  /**
   * Every check, executed by a real query planner against the real schema.
   *
   * This is the gap this file used to have. Ten of the fifteen checks were asserted only with
   * `expect(sql).toContain(...)`, and the five that ran did so against hand-built `ON COMMIT DROP`
   * TEMP tables typed `state text` / `event_type text` / no `amount_minor > 0`. So a check could
   * name a column that does not exist, compare a value against the wrong enum, or fail to parse at
   * all, and every test here would still be green.
   *
   * That is not hypothetical: running these against production for the first time immediately
   * surfaced `force_cancel_integrity` failing a shift whose funds all net to zero, because it swept
   * an unrelated audited wallet-top-up correction into a void recipe that never described it.
   *
   * `migrate(pool)` gives the genuine enums, CHECK constraints, triggers and foreign keys. An empty
   * database is deliberately enough here: the assertion is that all fifteen PARSE AND RUN, which is
   * what no test previously established. The behavioural cases follow below.
   */
  describe('every integrity check runs against the real migrated schema', () => {
    it('parses and executes all fifteen, plus both hash checks', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const result = await runShiftMoneyIntegrity(pool, { sampleLimit: 5 })

      // Every selected check reported a real, numeric result — i.e. Postgres accepted the query.
      expect(result.checks.length).toBe(INTEGRITY_CHECKS.length + 2)
      for (const check of result.checks) {
        expect(Number.isInteger(check.violations), `${check.id} did not return a count`).toBe(true)
      }
      expect(result.checks.map((check) => check.id)).toEqual([
        ...INTEGRITY_CHECKS.map((check) => check.id),
        'settlement_hashes',
        'close_draft_hashes',
      ])
    })

    it('reports a clean database as clean rather than merely running', async () => {
      await migrate(pool)
      const client = await pool.connect()
      try {
        // Isolate from whatever another serial test file left behind, then assert on an empty
        // ledger. `collectShiftMoneyIntegrity` takes the client directly and only ever SELECTs, so
        // it composes inside this transaction — `runShiftMoneyIntegrity` would open a READ ONLY
        // transaction of its own and its ROLLBACK would discard the fixture around it.
        await client.query('BEGIN')
        await client.query(`
          TRUNCATE shift_settlements, shift_close_drafts, journal_lines, journal_entries,
                   cash_deductions, shift_orders, shift_decisions, float_tranches, shifts
                   RESTART IDENTITY CASCADE`)
        const result = await collectShiftMoneyIntegrity(client, { sampleLimit: 5 })
        const dirty = result.checks.filter((check) => check.violations > 0)
        expect(dirty.map((check) => check.id), JSON.stringify(dirty)).toEqual([])
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })

  describe('receivable write-off journal on PostgreSQL', () => {
    it('accepts the exact loss recipe and rejects an office-fund forgery', async () => {
      const client = await pool.connect()
      const eventId = randomUUID()
      const branchId = randomUUID()
      const driverId = randomUUID()
      const managerId = randomUUID()
      const receivableFundId = randomUUID()
      const lossFundId = randomUUID()
      const officeCashFundId = randomUUID()
      const events = WRITEOFF_RECEIVABLE_INTEGRITY_CHECKS
        .find((check) => check.id === 'receivable_event_journals').sql
      const violationCount = async () => {
        const { rows } = await client.query(`SELECT count(*)::text AS count FROM (${events}) violation`)
        return Number(rows[0].count)
      }

      try {
        await client.query('BEGIN')
        await client.query(`
          CREATE TEMP TABLE receivable_events (
            id uuid PRIMARY KEY,
            journal_entry_id bigint NOT NULL,
            branch_id uuid NOT NULL,
            driver_id uuid NOT NULL,
            receivable_kind text NOT NULL,
            channel text NOT NULL,
            direction text NOT NULL,
            amount_minor bigint NOT NULL,
            business_date date NOT NULL,
            reason text NOT NULL,
            intent text NOT NULL,
            idempotency_key text NOT NULL,
            created_by uuid NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_entries (
            id bigint PRIMARY KEY,
            shift_id uuid,
            branch_id uuid NOT NULL,
            event_type text NOT NULL,
            occurrence_key text NOT NULL,
            business_date date NOT NULL,
            posting_date date NOT NULL,
            week_start_date date NOT NULL,
            reason text,
            created_by uuid NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE funds (
            id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            code text NOT NULL,
            type text NOT NULL,
            owner_id uuid
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_lines (
            id bigint PRIMARY KEY,
            entry_id bigint NOT NULL,
            fund_id uuid NOT NULL,
            side char(1) NOT NULL,
            amount_minor bigint NOT NULL,
            line_role text
          ) ON COMMIT DROP
        `)
        await client.query(
          `INSERT INTO journal_entries
             (id, shift_id, branch_id, event_type, occurrence_key, business_date,
              posting_date, week_start_date, reason, created_by)
           VALUES (1, NULL, $1, 'receivable_adjustment', 'writeoff-audit-1',
                   DATE '2026-08-30', DATE '2026-08-30', DATE '2026-08-30',
                   'approved bad-debt loss', $2)`,
          [branchId, managerId],
        )
        await client.query(
          `INSERT INTO funds (id, branch_id, code, type, owner_id) VALUES
             ($1, $4, $5, 'driver_receivable_cash', $6),
             ($2, $4, 'cost_center:receivable_writeoff_loss', 'cost_center', NULL),
             ($3, $4, 'office_cash', 'office_cash', NULL)`,
          [
            receivableFundId,
            lossFundId,
            officeCashFundId,
            branchId,
            `driver_receivable_cash:${driverId}`,
            driverId,
          ],
        )
        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor, line_role) VALUES
             (1, 1, $1, 'D', 500, 'receivable_writeoff_loss'),
             (2, 1, $2, 'C', 500, 'receivable_written_off')`,
          [lossFundId, receivableFundId],
        )
        await client.query(
          `INSERT INTO receivable_events
             (id, journal_entry_id, branch_id, driver_id, receivable_kind, channel, direction,
              amount_minor, business_date, reason, intent, idempotency_key, created_by)
           VALUES ($1, 1, $2, $3, 'ordinary', 'cash', 'collect', 500,
                   DATE '2026-08-30', 'approved bad-debt loss', 'writeoff',
                   'writeoff-audit-1', $4)`,
          [eventId, branchId, driverId, managerId],
        )

        expect(await violationCount()).toBe(0)

        // A cost-centre-looking role on office cash is still an office movement and must fail.
        await client.query('UPDATE journal_lines SET fund_id = $1 WHERE id = 1', [officeCashFundId])
        expect(await violationCount()).toBe(1)

        await client.query('UPDATE journal_lines SET fund_id = $1 WHERE id = 1', [lossFundId])
        await client.query("UPDATE receivable_events SET receivable_kind = 'shift_funding'")
        expect(await violationCount()).toBe(1)

        await client.query("UPDATE receivable_events SET receivable_kind = 'ordinary', intent = 'forged'")
        expect(await violationCount()).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })

  describe('close journal multiset on PostgreSQL', () => {
    it('accepts a canonical close and rejects extra balanced lines', async () => {
      const client = await pool.connect()
      const shiftId = randomUUID()
      const branchId = randomUUID()
      const driverId = randomUUID()
      const funds = {
        driverWallet: randomUUID(),
        driverCash: randomUUID(),
        sharePayable: randomUUID(),
        fundingCash: randomUUID(),
        fundingWallet: randomUUID(),
        officeWallet: randomUUID(),
        officeCash: randomUUID(),
      }
      const alignment = INTEGRITY_CHECKS.find((check) => check.id === 'close_journal_alignment').sql
      const doubleEntry = INTEGRITY_CHECKS.find((check) => check.id === 'double_entry').sql
      const metadata = INTEGRITY_CHECKS.find((check) => check.id === 'journal_metadata_alignment').sql
      const violationCount = async (sql) => {
        const { rows } = await client.query(`SELECT count(*)::text AS count FROM (${sql}) violation`)
        return Number(rows[0].count)
      }

      try {
        await client.query('BEGIN')
        // Session-local tables execute the production checker SQL on PostgreSQL without touching
        // any durable application row, even when the supplied test database is already migrated.
        await client.query(`
          CREATE TEMP TABLE shifts (
            id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            driver_id uuid NOT NULL,
            business_date date NOT NULL,
            week_start_date date NOT NULL,
            state text NOT NULL,
            created_at timestamptz NOT NULL,
            wallet_diff_minor bigint
          ) ON COMMIT DROP;
          CREATE TEMP TABLE shift_settlements (
            shift_id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            driver_id uuid NOT NULL,
            policy_code text NOT NULL,
            actual_wallet_minor bigint NOT NULL,
            expected_total_minor bigint NOT NULL,
            base_driver_share_minor bigint NOT NULL,
            cash_to_office_minor bigint NOT NULL,
            wallet_to_office_minor bigint NOT NULL,
            cash_receivable_deferred_minor bigint NOT NULL,
            wallet_receivable_deferred_minor bigint NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_entries (
            id bigint PRIMARY KEY,
            shift_id uuid,
            branch_id uuid NOT NULL,
            event_type text NOT NULL,
            occurrence_key text NOT NULL,
            business_date date NOT NULL,
            week_start_date date NOT NULL,
            reason text,
            created_by uuid NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE funds (
            id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            type text NOT NULL,
            owner_id uuid
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_lines (
            id bigint PRIMARY KEY,
            entry_id bigint NOT NULL,
            fund_id uuid NOT NULL,
            side char(1) NOT NULL,
            amount_minor bigint NOT NULL,
            line_role text
          ) ON COMMIT DROP
        `)
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, business_date, week_start_date, state, created_at, wallet_diff_minor)
           VALUES ($1, $2, $3, DATE '2026-08-22', DATE '2026-08-16', 'approved',
                   TIMESTAMPTZ '2026-08-22 11:00:00+00', 200)`,
          [shiftId, branchId, driverId],
        )
        await client.query(
          `INSERT INTO shift_settlements
             (shift_id, branch_id, driver_id, policy_code, actual_wallet_minor, expected_total_minor,
              base_driver_share_minor, cash_to_office_minor, wallet_to_office_minor,
              cash_receivable_deferred_minor, wallet_receivable_deferred_minor)
           VALUES ($1, $2, $3, 'fixed_40_cash_close_v2_receivable', 300, 1000, 400,
                   250, 200, 50, 100)`,
          [shiftId, branchId, driverId],
        )
        await client.query(
          `INSERT INTO funds (id, branch_id, type, owner_id) VALUES
             ($1, $8, 'driver_wallet', $9),
             ($2, $8, 'driver_cash', $9),
             ($3, $8, 'driver_share_payable', $9),
             ($4, $8, 'driver_shift_funding_cash', $9),
             ($5, $8, 'driver_shift_funding_wallet', $9),
             ($6, $8, 'office_wallet', NULL),
             ($7, $8, 'office_cash', NULL)`,
          [
            funds.driverWallet,
            funds.driverCash,
            funds.sharePayable,
            funds.fundingCash,
            funds.fundingWallet,
            funds.officeWallet,
            funds.officeCash,
            branchId,
            driverId,
          ],
        )
        await client.query(
          `INSERT INTO journal_entries
             (id, shift_id, branch_id, event_type, occurrence_key, business_date,
              week_start_date, reason, created_by)
           VALUES
             (1, $1, $2, 'wallet_return', '1', DATE '2026-08-22', DATE '2026-08-16', NULL, $3),
             (2, $1, $2, 'float_return', '1', DATE '2026-08-22', DATE '2026-08-16', NULL, $3)`,
          [shiftId, branchId, randomUUID()],
        )
        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor, line_role) VALUES
             (1, 1, $1, 'D', 200, 'wallet_reclassification'),
             (2, 1, $2, 'C', 200, 'wallet_reclassification'),
             (3, 1, $1, 'C', 300, 'wallet_cleared'),
             (4, 1, $4, 'D', 200, 'wallet_settlement'),
             (5, 1, $3, 'D', 100, 'wallet_settlement_deferred'),
             (6, 2, $2, 'C', 700, 'cash_cleared'),
             (7, 2, $5, 'D', 400, 'driver_share_settled'),
             (8, 2, $6, 'D', 50, 'cash_settlement_deferred'),
             (9, 2, $7, 'D', 250, 'cash_settlement')`,
          [
            funds.driverWallet,
            funds.driverCash,
            funds.fundingWallet,
            funds.officeWallet,
            funds.sharePayable,
            funds.fundingCash,
            funds.officeCash,
          ],
        )

        expect(await violationCount(alignment)).toBe(0)
        expect(await violationCount(doubleEntry)).toBe(0)
        expect(await violationCount(metadata)).toBe(0)

        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor, line_role) VALUES
             (10, 2, $1, 'D', 25, 'unexpected_debit'),
             (11, 2, $2, 'C', 25, 'unexpected_credit')`,
          [funds.officeCash, funds.officeWallet],
        )

        expect(await violationCount(doubleEntry)).toBe(0)
        expect(await violationCount(alignment)).toBe(1)

        await client.query("UPDATE journal_entries SET business_date = DATE '2026-08-23' WHERE id = 2")
        expect(await violationCount(metadata)).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('nets exact wallet/cash opening corrections and rejects malformed prefixed corrections', async () => {
      const client = await pool.connect()
      const shiftId = randomUUID()
      const driverId = randomUUID()
      const driverWalletId = randomUUID()
      const driverCashId = randomUUID()
      const officeWalletId = randomUUID()
      const officeCashId = randomUUID()
      const tranches = INTEGRITY_CHECKS.find((check) => check.id === 'tranche_journal_totals').sql
      const violationCount = async () => {
        const { rows } = await client.query(`SELECT count(*)::text AS count FROM (${tranches}) violation`)
        return Number(rows[0].count)
      }

      try {
        await client.query('BEGIN')
        await client.query(`
          CREATE TEMP TABLE schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE shifts (
            id uuid PRIMARY KEY,
            driver_id uuid NOT NULL,
            state text NOT NULL,
            created_at timestamptz NOT NULL,
            open_approved_at timestamptz,
            start_cash_float_minor bigint NOT NULL,
            start_wallet_topup_minor bigint NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE audit_log (
            table_name text NOT NULL,
            record_id text NOT NULL,
            action text NOT NULL,
            before jsonb,
            after jsonb,
            occurred_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE shift_decisions (
            shift_id uuid NOT NULL,
            decision text NOT NULL,
            decided_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE float_tranches (
            shift_id uuid NOT NULL,
            kind text NOT NULL,
            amount_minor bigint NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_entries (
            id bigint PRIMARY KEY,
            shift_id uuid,
            event_type text NOT NULL,
            occurrence_key text NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE funds (
            id uuid PRIMARY KEY,
            type text NOT NULL,
            owner_id uuid
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_lines (
            id bigint PRIMARY KEY,
            entry_id bigint NOT NULL,
            fund_id uuid NOT NULL,
            side char(1) NOT NULL,
            amount_minor bigint NOT NULL
          ) ON COMMIT DROP
        `)
        await client.query(
          `INSERT INTO schema_migrations (filename, applied_at) VALUES
             ('0035_shift_money_integrity.sql', TIMESTAMPTZ '2026-08-23 08:00:00+00'),
             ('0037_receivable_settlement_and_events.sql', TIMESTAMPTZ '2026-08-23 10:00:00+00')`,
        )
        await client.query(
          `INSERT INTO shifts
             (id, driver_id, state, created_at, open_approved_at,
              start_cash_float_minor, start_wallet_topup_minor)
           VALUES ($1, $2, 'open', TIMESTAMPTZ '2026-08-24 07:00:00+00',
                    TIMESTAMPTZ '2026-08-24 07:30:00+00', 500, 500)`,
          [shiftId, driverId],
        )
        await client.query(
          `INSERT INTO float_tranches (shift_id, kind, amount_minor)
           VALUES ($1, 'wallet_topup', 500), ($1, 'cash_float', 500)`,
          [shiftId],
        )
        await client.query(
          `INSERT INTO funds (id, type, owner_id) VALUES
             ($1, 'driver_wallet', $5),
             ($2, 'office_wallet', NULL),
             ($3, 'office_cash', NULL),
             ($4, 'driver_cash', $5)`,
          [driverWalletId, officeWalletId, officeCashId, driverCashId, driverId],
        )
        await client.query(
          `INSERT INTO journal_entries (id, shift_id, event_type, occurrence_key) VALUES
             (1, $1, 'wallet_topup', '1'),
             (2, $1, 'correction', 'wallet-topup-adjustment:manager-fix'),
             (3, $1, 'float_out', '1'),
             (4, $1, 'correction', 'cash-float-adjustment:manager-fix')`,
          [shiftId],
        )
        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor) VALUES
             (1, 1, $1, 'D', 600),
             (2, 1, $2, 'C', 600),
             (3, 2, $2, 'D', 100),
             (4, 2, $1, 'C', 100),
             (5, 3, $3, 'D', 600),
             (6, 3, $4, 'C', 600),
             (7, 4, $4, 'D', 100),
             (8, 4, $3, 'C', 100)`,
          [driverWalletId, officeWalletId, driverCashId, officeCashId],
        )

        expect(await violationCount()).toBe(0)

        // The prefix alone is not enough: only D office_wallet / C this driver's wallet is netted.
        await client.query('UPDATE journal_lines SET fund_id = $1 WHERE id = 4', [officeCashId])
        expect(await violationCount()).toBe(1)

        await client.query('UPDATE journal_lines SET fund_id = $1 WHERE id = 4', [driverWalletId])
        expect(await violationCount()).toBe(0)

        // The cash correction is similarly exact: D office_cash / C this driver's cash.
        await client.query('UPDATE journal_lines SET fund_id = $1 WHERE id = 8', [officeWalletId])
        expect(await violationCount()).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('accepts a cross-rollout force-cancel reclassified to shift funding and rejects extra balanced void lines', async () => {
      const client = await pool.connect()
      const shiftId = randomUUID()
      const branchId = randomUUID()
      const driverId = randomUUID()
      const managerId = randomUUID()
      const fundIds = {
        driverCash: randomUUID(),
        driverWallet: randomUUID(),
        fundingCash: randomUUID(),
        receivableCash: randomUUID(),
        receivableWallet: randomUUID(),
        officeCash: randomUUID(),
        officeWallet: randomUUID(),
      }
      const forceCancel = INTEGRITY_CHECKS.find((check) => check.id === 'force_cancel_integrity').sql
      const doubleEntry = INTEGRITY_CHECKS.find((check) => check.id === 'double_entry').sql
      const violationCount = async (sql) => {
        const { rows } = await client.query(`SELECT count(*)::text AS count FROM (${sql}) violation`)
        return Number(rows[0].count)
      }

      try {
        await client.query('BEGIN')
        await client.query(`
          CREATE TEMP TABLE schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE shifts (
            id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            driver_id uuid NOT NULL,
            business_date date NOT NULL,
            week_start_date date NOT NULL,
            state text NOT NULL,
            created_at timestamptz NOT NULL,
            open_approved_at timestamptz
          ) ON COMMIT DROP;
          CREATE TEMP TABLE shift_decisions (
            id bigint PRIMARY KEY,
            shift_id uuid NOT NULL,
            gate text NOT NULL,
            decision text NOT NULL,
            notes text,
            decided_by uuid NOT NULL,
            decided_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE audit_log (
            table_name text NOT NULL,
            record_id text NOT NULL,
            action text NOT NULL,
            before jsonb,
            after jsonb,
            occurred_at timestamptz NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE float_tranches (
            shift_id uuid NOT NULL,
            kind text NOT NULL,
            amount_minor bigint NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_entries (
            id bigint PRIMARY KEY,
            shift_id uuid,
            branch_id uuid NOT NULL,
            event_type text NOT NULL,
            occurrence_key text NOT NULL,
            business_date date NOT NULL,
            week_start_date date NOT NULL,
            reason text,
            created_by uuid NOT NULL
          ) ON COMMIT DROP;
          CREATE TEMP TABLE funds (
            id uuid PRIMARY KEY,
            branch_id uuid NOT NULL,
            type text NOT NULL,
            owner_id uuid
          ) ON COMMIT DROP;
          CREATE TEMP TABLE journal_lines (
            id bigint PRIMARY KEY,
            entry_id bigint NOT NULL,
            fund_id uuid NOT NULL,
            side char(1) NOT NULL,
            amount_minor bigint NOT NULL,
            line_role text
          ) ON COMMIT DROP
        `)
        await client.query(
          `INSERT INTO schema_migrations (filename, applied_at) VALUES
             ('0035_shift_money_integrity.sql', TIMESTAMPTZ '2026-08-23 08:00:00+00'),
             ('0037_receivable_settlement_and_events.sql', TIMESTAMPTZ '2026-08-23 10:00:00+00')`,
        )
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, business_date, week_start_date, state, created_at, open_approved_at)
           VALUES ($1, $2, $3, DATE '2026-08-23', DATE '2026-08-23', 'cancelled',
                   TIMESTAMPTZ '2026-08-23 08:05:00+00', TIMESTAMPTZ '2026-08-23 08:30:00+00')`,
          [shiftId, branchId, driverId],
        )
        await client.query(
          `INSERT INTO shift_decisions
             (id, shift_id, gate, decision, notes, decided_by, decided_at)
           VALUES (1, $1, 'close', 'force_cancelled', 'vehicle failure', $2,
                   TIMESTAMPTZ '2026-08-23 11:00:00+00')`,
          [shiftId, managerId],
        )
        await client.query(
          `INSERT INTO float_tranches (shift_id, kind, amount_minor) VALUES
             ($1, 'cash_float', 100),
             ($1, 'wallet_topup', 200),
             ($1, 'carried_receivable', 50)`,
          [shiftId],
        )
        await client.query(
          `INSERT INTO funds (id, branch_id, type, owner_id) VALUES
             ($1, $8, 'driver_cash', $9),
             ($2, $8, 'driver_wallet', $9),
             ($3, $8, 'driver_shift_funding_cash', $9),
             ($4, $8, 'driver_receivable_cash', $9),
             ($5, $8, 'driver_receivable_wallet', $9),
             ($6, $8, 'office_cash', NULL),
             ($7, $8, 'office_wallet', NULL)`,
          [
            fundIds.driverCash,
            fundIds.driverWallet,
            fundIds.fundingCash,
            fundIds.receivableCash,
            fundIds.receivableWallet,
            fundIds.officeCash,
            fundIds.officeWallet,
            branchId,
            driverId,
          ],
        )
        await client.query(
          `INSERT INTO journal_entries
             (id, shift_id, branch_id, event_type, occurrence_key, business_date,
              week_start_date, reason, created_by)
           VALUES
             (1, $1, $2, 'float_out', '1', DATE '2026-08-23', DATE '2026-08-23', NULL, $3),
             (2, $1, $2, 'float_out', 'carry-1', DATE '2026-08-23', DATE '2026-08-23', NULL, $3),
             (3, $1, $2, 'wallet_topup', '1', DATE '2026-08-23', DATE '2026-08-23', NULL, $3),
             (4, $1, $2, 'float_return', '1', DATE '2026-08-23', DATE '2026-08-23',
              'vehicle failure', $3),
             (5, $1, $2, 'wallet_return', '1', DATE '2026-08-23', DATE '2026-08-23',
              'vehicle failure', $3),
             (6, $1, $2, 'correction', $4, DATE '2026-08-23', DATE '2026-08-23',
              'vehicle failure', $3)`,
          [shiftId, branchId, managerId, `void-carry-${shiftId}`],
        )
        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor, line_role) VALUES
             (1, 1, $1, 'D', 100, NULL),
             (2, 1, $4, 'C', 100, NULL),
             (3, 2, $1, 'D', 50, NULL),
             (4, 2, $3, 'C', 50, NULL),
             (5, 3, $2, 'D', 200, NULL),
             (6, 3, $5, 'C', 200, NULL),
             (7, 4, $4, 'D', 100, NULL),
             (8, 4, $1, 'C', 100, NULL),
             (9, 5, $5, 'D', 200, NULL),
             (10, 5, $2, 'C', 200, NULL),
             (11, 6, $1, 'C', 50, NULL),
             (12, 6, $6, 'D', 50, NULL)`,
          [
            fundIds.driverCash,
            fundIds.driverWallet,
            fundIds.receivableCash,
            fundIds.officeCash,
            fundIds.officeWallet,
            fundIds.fundingCash,
          ],
        )

        expect(await violationCount(forceCancel)).toBe(0)
        expect(await violationCount(doubleEntry)).toBe(0)

        await client.query(
          `INSERT INTO journal_lines (id, entry_id, fund_id, side, amount_minor, line_role) VALUES
             (13, 4, $1, 'D', 7, 'unexpected_debit'),
             (14, 4, $2, 'C', 7, 'unexpected_credit')`,
          [fundIds.officeCash, fundIds.officeWallet],
        )
        expect(await violationCount(doubleEntry)).toBe(0)
        expect(await violationCount(forceCancel)).toBe(1)
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })
}
