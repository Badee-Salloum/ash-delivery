import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { NewShiftSettlementRecord, ReceivableEventRecord } from '@ash/contracts'
import {
  floatCarry,
  floatOut,
  floatReturn,
  minor,
  receivableAdjustment,
  reverse,
  walletCarry,
  walletReturn,
  walletTopup,
} from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { bindPoolToTransaction, createPool } from '../src/pool.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'
import { PgReceivableEventRepo } from '../src/repos-receivable.ts'
import { PgShiftSettlementRepo } from '../src/repos-settlement.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL receivable release guards', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL receivable release guards', () => {
    it('rejects invalid v2 money, preserves immutability, and binds direct events to their journals', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const client = await pool.connect()
      const branchId = randomUUID()
      const otherBranchId = randomUUID()
      const managerId = randomUUID()
      const accountantId = randomUUID()
      const driverId = randomUUID()
      const otherDriverId = randomUUID()
      const vehicleId = randomUUID()
      const shiftId = randomUUID()
      const suffix = branchId.replaceAll('-', '').slice(0, 12)

      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO roles (key, name_ar, name_en)
           VALUES
             ('branch_manager', 'مدير فرع', 'Branch manager'),
             ('accountant', 'محاسب', 'Accountant')
           ON CONFLICT (key) DO NOTHING`,
        )
        await client.query(
          `INSERT INTO permissions (key, name_ar, name_en)
           VALUES ('journal.manual.write', 'قيد يدوي', 'Manual journal write')
           ON CONFLICT (key) DO NOTHING`,
        )
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('branch_manager', 'journal.manual.write', 'branch')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await client.query(
          `INSERT INTO branches
             (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
           SELECT $1, $2, 'فرع اختبار الذمم', 'Receivable guard test', 'Asia/Damascus', g.id, n.branch_no
             FROM governorates g
             CROSS JOIN LATERAL (
               SELECT candidate AS branch_no
                 FROM generate_series(1, 99) AS candidate
                WHERE NOT EXISTS (
                  SELECT 1 FROM branches b
                   WHERE b.governorate_id = g.id AND b.branch_no = candidate
                )
                ORDER BY candidate
                LIMIT 1
             ) n
            WHERE g.no = 1`,
          [branchId, `RECEIVABLE-GUARD-${suffix}`],
        )
        await client.query(
          `INSERT INTO branches
             (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
           SELECT $1, $2, 'فرع اختبار صلاحيات الذمم', 'Receivable RBAC test',
                  'Asia/Damascus', b.governorate_id, n.branch_no
             FROM branches b
             CROSS JOIN LATERAL (
               SELECT candidate AS branch_no
                 FROM generate_series(1, 99) AS candidate
                WHERE NOT EXISTS (
                  SELECT 1 FROM branches occupied
                   WHERE occupied.governorate_id = b.governorate_id
                     AND occupied.branch_no = candidate
                )
                ORDER BY candidate
                LIMIT 1
             ) n
            WHERE b.id = $3`,
          [otherBranchId, `RECEIVABLE-RBAC-${suffix}`, branchId],
        )
        await client.query(
          `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
           VALUES
             ($1, $2, 'branch_manager', $3, 'مدير اختبار الذمم', 'x'),
             ($4, $2, 'accountant', $5, 'محاسب اختبار الذمم', 'x')`,
          [
            managerId,
            branchId,
            `receivable-guard-${suffix}`,
            accountantId,
            `receivable-accountant-${suffix}`,
          ],
        )
        await client.query(
          `INSERT INTO drivers (id, branch_id, code, full_name_ar)
           VALUES
             ($1, $2, $3, 'سائق اختبار الذمم'),
             ($4, $5, $6, 'سائق اختبار فرع آخر')`,
          [
            driverId,
            branchId,
            `RECEIVABLE-DRV-${suffix}`,
            otherDriverId,
            otherBranchId,
            `RECEIVABLE-OTHER-DRV-${suffix}`,
          ],
        )
        await client.query(
          `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
           SELECT $1, $2, t.id, $3, 1
             FROM vehicle_types t
            WHERE t.code = 'e_motorbike'`,
          [vehicleId, branchId, `RECEIVABLE-VEH-${suffix}`],
        )
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at, kept_as_receivable_minor)
           VALUES ($1, $2, $3, $4, 1, DATE '2026-08-23', DATE '2026-08-23',
                   'pending_review', TIMESTAMPTZ '2026-08-23 09:00:00+00', 600)`,
          [shiftId, branchId, driverId, vehicleId],
        )
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
        await client.query('SELECT set_config($1, $2, true)', ['app.request_id', 'receivable-guard-test'])
        const fx = await client.query<{ id: bigint }>(
          `INSERT INTO fx_days (business_date, syp_minor_per_usd)
           VALUES (DATE '2026-08-23', 13000)
           ON CONFLICT (business_date) DO UPDATE
             SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
           RETURNING id`,
        )
        const fxDayId = Number(fx.rows[0]!.id)

        await client.query(
          `INSERT INTO office_capital_targets
             (branch_id, fund_code, target_minor, effective_from, created_by, note)
           VALUES
             ($1, 'office_cash', 5000000, DATE '2026-08-23', $2, 'SYP 50,000 target'),
             ($1, 'office_wallet', 1000000, DATE '2026-08-23', $2, 'SYP 10,000 target')`,
          [branchId, managerId],
        )
        const capitalTargets = await client.query<{ fund_code: string; target_minor: string }>(
          `SELECT fund_code, target_minor::text
             FROM office_capital_targets
            WHERE branch_id = $1 AND effective_from = DATE '2026-08-23'
            ORDER BY fund_code`,
          [branchId],
        )
        expect(capitalTargets.rows).toEqual([
          { fund_code: 'office_cash', target_minor: '5000000' },
          { fund_code: 'office_wallet', target_minor: '1000000' },
        ])
        await client.query(
          `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
           VALUES
             ($1, 'office_cash', 'none', NULL, 'office_cash', 'office cash'),
             ($1, 'office_wallet', 'none', NULL, 'office_wallet', 'office wallet'),
             ($1, 'company_box', 'none', NULL, 'company_box', 'company box')`,
          [branchId],
        )
        await client.query(
          `WITH entry AS (
             INSERT INTO journal_entries
               (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                week_start_date, fx_day_id, reason, created_by)
             VALUES ($1, 'manual', NULL, $2, DATE '2026-08-23', DATE '2026-08-23',
                     DATE '2026-08-23', $3, 'opening restoration-test balances', $4)
             RETURNING id
           ), lines(code, side, amount_minor) AS (
             VALUES
               ('office_cash', 'D'::char(1), 5000000::bigint),
               ('office_wallet', 'D'::char(1), 1000000::bigint),
               ('company_box', 'C'::char(1), 6000000::bigint)
           )
           INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role)
           SELECT entry.id, f.id, lines.side, lines.amount_minor, 'test_opening'
             FROM entry
             CROSS JOIN lines
             JOIN funds f ON f.branch_id = $1 AND f.code = lines.code`,
          [branchId, `restoration-target-opening-${suffix}`, fxDayId, managerId],
        )
        const count = await client.query<{ id: string }>(
          `INSERT INTO cash_counts
             (branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at, notes)
           VALUES ($1, DATE '2026-08-23', $2, TIMESTAMPTZ '2026-08-23 09:00:00+00', $3,
                   TIMESTAMPTZ '2026-08-23 09:00:00+00', 'target history guard')
           RETURNING id::text AS id`,
          [branchId, managerId, 'c'.repeat(64)],
        )
        await client.query(
          `INSERT INTO cash_count_lines
             (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor, resolution)
           SELECT $2, f.id,
                  CASE f.code WHEN 'office_cash' THEN 5000000 ELSE 1000000 END,
                  CASE f.code WHEN 'office_cash' THEN 5000000 ELSE 1000000 END,
                  0, NULL
             FROM funds f
            WHERE f.branch_id = $1 AND f.code IN ('office_cash', 'office_wallet')`,
          [branchId, count.rows[0]!.id],
        )
        const restorationPlan = {
          schemaVersion: 2,
          cashCountProofSha256: 'c'.repeat(64),
          cashCountSealedAt: '2026-08-23T09:00:00.000Z',
          countReconciliation: [
            { fundCode: 'office_cash', variance: '0.00', resolution: null },
            { fundCode: 'office_wallet', variance: '0.00', resolution: null },
          ],
          reconciliationJournalEntryIds: [],
          restorationJournalEntryIds: [],
          legs: [
            {
              fundCode: 'office_cash', counted: '50000.00', receivables: '0.00',
              position: '50000.00', capitalTarget: '50000.00', delta: '0.00',
              direction: null, amount: '0.00', feasible: true, refusals: [],
            },
            {
              fundCode: 'office_wallet', counted: '10000.00', receivables: '0.00',
              position: '10000.00', capitalTarget: '10000.00', delta: '0.00',
              direction: null, amount: '0.00', feasible: true, refusals: [],
            },
          ],
        }
        await client.query(
          `INSERT INTO restorations
             (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by)
           VALUES ($1, DATE '2026-08-23', $2, $3::jsonb, 0,
                   'freeze the effective capital target', $4)`,
          [branchId, count.rows[0]!.id, JSON.stringify(restorationPlan), managerId],
        )
        await client.query('SAVEPOINT frozen_capital_target')
        await expect(
          client.query(
            `UPDATE office_capital_targets
                SET target_minor = target_minor + 1
              WHERE branch_id = $1 AND fund_code = 'office_cash'
                AND effective_from = DATE '2026-08-23'`,
            [branchId],
          ),
        ).rejects.toMatchObject({
          code: '55000',
          constraint: 'office_capital_targets_history_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT frozen_capital_target')

        const boundPool = bindPoolToTransaction(pool, client, {
          actorId: managerId,
          requestId: 'receivable-guard-test',
        })
        const accountantPool = bindPoolToTransaction(pool, client, {
          actorId: accountantId,
          requestId: 'receivable-rbac-test',
        })
        const settlements = new PgShiftSettlementRepo(boundPool)
        const ledger = new PgLedgerRepo(boundPool)
        const zero = minor(0n)

        const writeTinyReceivable = async (
          actorPool: typeof boundPool,
          actorId: string,
          targetBranchId: string,
          targetDriverId: string,
          key: string,
        ): Promise<ReceivableEventRecord> => {
          const [journal] = await new PgLedgerRepo(actorPool).post(
            targetBranchId,
            [receivableAdjustment(targetDriverId, 'ordinary', 'cash', 'create', minor(1n), key)],
            {
              shiftId: null,
              businessDate: '2026-08-23',
              postingDate: '2026-08-23',
              weekStartDate: '2026-08-23',
              fxDayId,
              createdBy: actorId,
              reason: `RBAC probe ${key}`,
            },
          )
          const event: ReceivableEventRecord = {
            id: randomUUID(),
            branchId: targetBranchId,
            driverId: targetDriverId,
            receivableKind: 'ordinary',
            channel: 'cash',
            direction: 'create',
            amount: minor(1n),
            businessDate: '2026-08-23',
            reason: `RBAC probe ${key}`,
            idempotencyKey: key,
            journalEntryId: journal!.id,
            createdBy: actorId,
            createdAtMs: Date.UTC(2026, 7, 23, 9, 0),
          }
          await new PgReceivableEventRepo(actorPool).create(event)
          return event
        }

        // Database authorization follows the same live editable matrix as the API. Accountant has
        // no compiled-in privilege; a branch grant permits the local command immediately.
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('accountant', 'journal.manual.write', 'branch')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await client.query('SAVEPOINT custom_role_grant')
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', accountantId])
        const customGranted = await writeTinyReceivable(
          accountantPool,
          accountantId,
          branchId,
          driverId,
          `receivable-rbac-custom-${suffix}`,
        )
        await expect(
          client.query('SELECT id FROM receivable_events WHERE id = $1', [customGranted.id]),
        ).resolves.toMatchObject({ rowCount: 1 })
        await client.query('ROLLBACK TO SAVEPOINT custom_role_grant')

        // A formerly hardcoded branch-manager role loses access as soon as its live grant is
        // revoked. Roll the probe back so the rest of this accounting fixture keeps its baseline.
        await client.query('SAVEPOINT revoked_hardcoded_role')
        await client.query(
          `DELETE FROM role_permissions
            WHERE role_key = 'branch_manager' AND permission_key = 'journal.manual.write'`,
        )
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
        await expect(
          writeTinyReceivable(
            boundPool,
            managerId,
            branchId,
            driverId,
            `receivable-rbac-revoked-${suffix}`,
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'receivable_events_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT revoked_hardcoded_role')

        // A branch grant cannot cross branches. Changing that same live cell to `all` permits the
        // organisation-wide command, proving scope semantics rather than role-name semantics.
        await client.query('SAVEPOINT wrong_branch_scope')
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', accountantId])
        await expect(
          writeTinyReceivable(
            accountantPool,
            accountantId,
            otherBranchId,
            otherDriverId,
            `receivable-rbac-wrong-branch-${suffix}`,
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'receivable_events_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT wrong_branch_scope')

        await client.query('SAVEPOINT global_scope')
        await client.query(
          `UPDATE role_permissions SET scope = 'all'
            WHERE role_key = 'accountant' AND permission_key = 'journal.manual.write'`,
        )
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', accountantId])
        const globalGranted = await writeTinyReceivable(
          accountantPool,
          accountantId,
          otherBranchId,
          otherDriverId,
          `receivable-rbac-global-${suffix}`,
        )
        await expect(
          client.query('SELECT id FROM receivable_events WHERE id = $1', [globalGranted.id]),
        ).resolves.toMatchObject({ rowCount: 1 })
        await client.query('ROLLBACK TO SAVEPOINT global_scope')

        await client.query('SAVEPOINT missing_actor')
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', ''])
        await expect(
          writeTinyReceivable(
            accountantPool,
            accountantId,
            branchId,
            driverId,
            `receivable-rbac-missing-actor-${suffix}`,
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'receivable_events_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT missing_actor')
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])

        const base: NewShiftSettlementRecord = {
          shiftId,
          branchId,
          driverId,
          businessDate: '2026-08-23',
          policyCode: 'fixed_40_cash_close_v2_receivable',
          driverRateBps: 4_000,
          deliveryFeeTotal: minor(1_000n),
          fixedDriverShare: minor(400n),
          manualDriverShare: zero,
          grossDriverShare: minor(400n),
          cashDeductionTotal: zero,
          baseDriverShare: minor(400n),
          expectedTotal: minor(10_000n),
          actualCash: minor(8_000n),
          actualWallet: minor(2_000n),
          actualTotal: minor(10_000n),
          variance: zero,
          varianceDirection: 'balanced',
          finalEmployeeCash: minor(400n),
          cashClaimToOffice: minor(7_600n),
          walletClaimToOffice: minor(2_000n),
          cashReceivableDeferred: minor(600n),
          walletReceivableDeferred: minor(500n),
          cashToOffice: minor(7_000n),
          walletToOffice: minor(1_500n),
          cashAction: 'collect',
          cashAmount: minor(7_000n),
          walletAction: 'collect',
          walletAmount: minor(1_500n),
          reviewedOrdersHash: 'receivable-guard-orders',
          settlementHash: 'a'.repeat(64),
          walletTransferConfirmed: true,
          cashSettlementConfirmed: true,
          confirmedBy: managerId,
          confirmedAtMs: Date.UTC(2026, 7, 23, 9, 1),
          varianceReason: null,
        }

        const rejectSettlement = async (
          savepoint: string,
          patch: Partial<NewShiftSettlementRecord>,
          constraint: string,
        ): Promise<void> => {
          await client.query(`SAVEPOINT ${savepoint}`)
          await expect(settlements.create({ ...base, ...patch })).rejects.toMatchObject({
            code: '23514',
            constraint,
          })
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }

        await rejectSettlement(
          'cash_bound',
          {
            cashReceivableDeferred: minor(7_601n),
            cashToOffice: minor(-1n),
            cashAction: 'pay',
            cashAmount: minor(1n),
          },
          'shift_settlements_receivable_bounds_ck',
        )
        await rejectSettlement(
          'wallet_bound',
          {
            walletReceivableDeferred: minor(2_001n),
            walletToOffice: minor(-1n),
            walletAction: 'fund',
            walletAmount: minor(1n),
          },
          'shift_settlements_receivable_bounds_ck',
        )
        await rejectSettlement(
          'claim_formula',
          {
            cashClaimToOffice: minor(7_601n),
            cashToOffice: minor(7_001n),
            cashAmount: minor(7_001n),
          },
          'shift_settlements_claims_ck',
        )
        await rejectSettlement(
          'physical_formula',
          { cashToOffice: minor(7_001n), cashAmount: minor(7_001n) },
          'shift_settlements_physical_movements_ck',
        )
        await rejectSettlement(
          'legacy_deferral',
          { policyCode: 'fixed_40_cash_close_v1' },
          'shift_settlements_fixed_policy_ck',
        )
        await rejectSettlement(
          'null_reason',
          {
            actualCash: minor(8_001n),
            actualTotal: minor(10_001n),
            variance: minor(1n),
            varianceDirection: 'surplus',
            finalEmployeeCash: minor(401n),
            varianceReason: null,
          },
          'shift_settlements_variance_reason_ck',
        )
        await rejectSettlement(
          'blank_reason',
          {
            actualCash: minor(8_001n),
            actualTotal: minor(10_001n),
            variance: minor(1n),
            varianceDirection: 'surplus',
            finalEmployeeCash: minor(401n),
            varianceReason: ' \t\n\u200B',
          },
          'shift_settlements_variance_reason_ck',
        )
        const max = minor(9_223_372_036_854_775_807n)
        await rejectSettlement(
          'near_bigint_aggregate',
          {
            deliveryFeeTotal: zero,
            fixedDriverShare: zero,
            grossDriverShare: zero,
            baseDriverShare: zero,
            expectedTotal: max,
            actualCash: max,
            actualWallet: minor(1n),
            actualTotal: max,
            variance: zero,
            finalEmployeeCash: zero,
            cashClaimToOffice: max,
            walletClaimToOffice: minor(1n),
            cashReceivableDeferred: zero,
            walletReceivableDeferred: zero,
            cashToOffice: max,
            walletToOffice: minor(1n),
            cashAction: 'collect',
            cashAmount: max,
            walletAction: 'collect',
            walletAmount: minor(1n),
          },
          'shift_settlements_actual_total_ck',
        )

        // A return that merely looks like the later close recipe must not be allowed to reserve
        // occurrence key `1` while the shift is still pending. Otherwise PgLedgerRepo's
        // idempotent ON CONFLICT path would skip the real close and could bless attacker-selected
        // metadata/lines after the terminal transition.
        await client.query('SAVEPOINT preposted_close_poison')
        await ledger.post(
          branchId,
          [{
            eventType: 'wallet_return',
            occurrenceKey: '1',
            lines: [
              { fund: { kind: 'driver_wallet', driverId }, side: 'C', amount: minor(2_000n), role: 'wallet_cleared' },
              { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(1_500n), role: 'wallet_settlement' },
              {
                fund: { kind: 'driver_receivable_wallet', driverId },
                side: 'D',
                amount: minor(500n),
                role: 'wallet_settlement_deferred',
              },
            ],
          }],
          {
            shiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'preposted close poison',
          },
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_entry IMMEDIATE'),
        ).rejects.toMatchObject({ code: '23514', constraint: 'shift_return_state_guard' })
        await client.query('ROLLBACK TO SAVEPOINT preposted_close_poison')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        await client.query('SAVEPOINT standalone_pending_settlement')
        await settlements.create(base)
        await expect(
          client.query('SET CONSTRAINTS shift_receivable_projection_from_settlement IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_receivable_projection_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT standalone_pending_settlement')

        const stored = await settlements.create(base)
        expect(stored).toMatchObject({
          policyCode: 'fixed_40_cash_close_v2_receivable',
          cashClaimToOffice: minor(7_600n),
          walletClaimToOffice: minor(2_000n),
          cashReceivableDeferred: minor(600n),
          walletReceivableDeferred: minor(500n),
        })
        expect(await settlements.create(base)).toEqual(stored)
        await expect(
          settlements.create({ ...base, settlementHash: 'b'.repeat(64) }),
        ).rejects.toMatchObject({ code: 'SHIFT_SETTLEMENT_IMMUTABLE' })

        for (const [savepoint, sql] of [
          ['settlement_update', 'UPDATE shift_settlements SET variance_reason = \'rewritten\' WHERE shift_id = $1'],
          ['settlement_delete', 'DELETE FROM shift_settlements WHERE shift_id = $1'],
        ] as const) {
          await client.query(`SAVEPOINT ${savepoint}`)
          await expect(client.query(sql, [shiftId])).rejects.toMatchObject({ code: '55000' })
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }

        await client.query('SAVEPOINT projection_mismatch')
        await client.query(
          `UPDATE shifts
              SET state = 'approved', kept_as_receivable_minor = 599, approved_by = $2
            WHERE id = $1`,
          [shiftId, managerId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_receivable_projection_from_shift IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_receivable_projection_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT projection_mismatch')

        // A settlement and terminal state are not sufficient by themselves: direct SQL must not
        // be able to commit the claim without the exact immutable close journals.
        await client.query('SAVEPOINT terminal_without_close_journals')
        await client.query(
          `UPDATE shifts
              SET state = 'approved', kept_as_receivable_minor = 600,
                  wallet_diff_minor = 0, approved_by = $2
            WHERE id = $1`,
          [shiftId, managerId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_shift IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_close_journal_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT terminal_without_close_journals')

        // Merely balanced is not canonical. This fake return uses the close event type but moves
        // money between unrelated office funds with invented roles.
        await client.query('SAVEPOINT forged_balanced_close_journal')
        await ledger.post(
          branchId,
          [{
            eventType: 'wallet_return',
            occurrenceKey: '1',
            lines: [
              { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(2_000n), role: 'forged_return' },
              { fund: { kind: 'office_cash' }, side: 'C', amount: minor(2_000n), role: 'forged_return' },
            ],
          }],
          {
            shiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
          },
        )
        await client.query(
          `UPDATE shifts
              SET state = 'approved', kept_as_receivable_minor = 600,
                  wallet_diff_minor = 0, approved_by = $2
            WHERE id = $1`,
          [shiftId, managerId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_shift IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_close_journal_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT forged_balanced_close_journal')

        // The normal runtime order is journals, immutable snapshot, then terminal shift. This
        // fixture already inserted the snapshot above, so finish with the two exact v2 return
        // entries and prove that the non-zero approval passes both deferred guards.
        await ledger.post(
          branchId,
          [
            {
              eventType: 'wallet_return',
              occurrenceKey: '1',
              lines: [
                { fund: { kind: 'driver_wallet', driverId }, side: 'C', amount: minor(2_000n), role: 'wallet_cleared' },
                { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(1_500n), role: 'wallet_settlement' },
                {
                  fund: { kind: 'driver_receivable_wallet', driverId },
                  side: 'D',
                  amount: minor(500n),
                  role: 'wallet_settlement_deferred',
                },
              ],
            },
            {
              eventType: 'float_return',
              occurrenceKey: '1',
              lines: [
                { fund: { kind: 'driver_cash', driverId }, side: 'C', amount: minor(8_000n), role: 'cash_cleared' },
                {
                  fund: { kind: 'driver_share_payable', driverId },
                  side: 'D',
                  amount: minor(400n),
                  role: 'driver_share_settled',
                },
                {
                  fund: { kind: 'driver_receivable_cash', driverId },
                  side: 'D',
                  amount: minor(600n),
                  role: 'cash_settlement_deferred',
                },
                { fund: { kind: 'office_cash' }, side: 'D', amount: minor(7_000n), role: 'cash_settlement' },
              ],
            },
          ],
          {
            shiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
          },
        )

        // A valid approval couples the immutable snapshot, exact journals and terminal transition
        // in one transaction. Conversely, a fresh terminal shift cannot commit without a snapshot.
        await client.query(
          `UPDATE shifts
              SET state = 'approved', kept_as_receivable_minor = 600,
                  wallet_diff_minor = 0, approved_by = $2
            WHERE id = $1`,
          [shiftId, managerId],
        )
        await client.query('SET CONSTRAINTS shift_receivable_projection_from_shift IMMEDIATE')
        await client.query('SET CONSTRAINTS shift_close_journals_from_shift IMMEDIATE')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        // Append-only does not mean insert-safe by itself. A later close occurrence must re-open
        // the exact terminal invariant and fail even though its own two lines are balanced.
        await client.query('SAVEPOINT post_terminal_extra_close_entry')
        await ledger.post(
          branchId,
          [{
            eventType: 'wallet_return',
            occurrenceKey: 'late-extra',
            lines: [
              { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(1n), role: 'forged_late_return' },
              { fund: { kind: 'office_cash' }, side: 'C', amount: minor(1n), role: 'forged_late_return' },
            ],
          }],
          {
            shiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
          },
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_entry IMMEDIATE'),
        ).rejects.toMatchObject({ code: '23514', constraint: 'shift_close_journal_guard' })
        await client.query('ROLLBACK TO SAVEPOINT post_terminal_extra_close_entry')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        // The same invariant is rechecked when balanced extra lines are appended to the canonical
        // occurrence, without inserting a new journal entry at all.
        await client.query('SAVEPOINT post_terminal_extra_close_lines')
        await client.query(
          `WITH close_entry AS (
             SELECT id FROM journal_entries
              WHERE shift_id = $1 AND event_type = 'wallet_return' AND occurrence_key = '1'
           ), forged(code, side) AS (
             VALUES ('office_wallet', 'D'::char(1)),
                    ('driver_wallet:' || $2::text, 'C'::char(1))
           )
           INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role)
           SELECT close_entry.id, f.id, forged.side, 1, 'forged_late_line'
             FROM close_entry
             CROSS JOIN forged
             JOIN funds f ON f.branch_id = $3 AND f.code = forged.code`,
          [shiftId, driverId, branchId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_line IMMEDIATE'),
        ).rejects.toMatchObject({ code: '23514', constraint: 'shift_close_journal_guard' })
        await client.query('ROLLBACK TO SAVEPOINT post_terminal_extra_close_lines')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        await client.query('SAVEPOINT terminal_without_settlement')
        const uncoupledShiftId = randomUUID()
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at, kept_as_receivable_minor)
           VALUES ($1, $2, $3, $4, 2, DATE '2026-08-23', DATE '2026-08-23',
                   'pending_review', TIMESTAMPTZ '2026-08-23 10:00:00+00', 0)`,
          [uncoupledShiftId, branchId, driverId, vehicleId],
        )
        await client.query(
          `UPDATE shifts SET state = 'approved', approved_by = $2 WHERE id = $1`,
          [uncoupledShiftId, managerId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_receivable_projection_from_shift IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_receivable_projection_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT terminal_without_settlement')

        // Force-cancel is a different terminal recipe from settlement close. Exercise the real
        // domain recipes, including both carried funding channels, and prove the deferred database
        // matcher accepts the complete runtime write order (opening, void journals, state, then
        // decision) with no special-case bypass.
        const cancelledShiftId = randomUUID()
        const cancelReason = 'valid forced cancellation'
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at)
           VALUES ($1, $2, $3, $4, 2, DATE '2026-08-23', DATE '2026-08-23',
                   'pending_review', TIMESTAMPTZ '2026-08-23 10:15:00+00')`,
          [cancelledShiftId, branchId, driverId, vehicleId],
        )
        await client.query(
          `INSERT INTO float_tranches (shift_id, kind, seq_no, amount_minor, handed_by)
           VALUES
             ($1, 'cash_float', 1, 100, $2),
             ($1, 'wallet_topup', 1, 200, $2),
             ($1, 'carried_receivable', 1, 300, $2),
             ($1, 'carried_wallet_receivable', 1, 400, $2)`,
          [cancelledShiftId, managerId],
        )
        await ledger.post(
          branchId,
          [
            floatOut(driverId, minor(100n)),
            walletTopup(driverId, minor(200n)),
            floatCarry(driverId, minor(300n)),
            walletCarry(driverId, minor(400n)),
          ],
          {
            shiftId: cancelledShiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
          },
        )
        await ledger.post(
          branchId,
          [
            floatReturn(driverId, minor(100n)),
            reverse(floatCarry(driverId, minor(300n)), `void-carry-${cancelledShiftId}`),
            reverse(walletCarry(driverId, minor(400n)), `void-wallet-carry-${cancelledShiftId}`),
            walletReturn(driverId, minor(200n)),
          ],
          {
            shiftId: cancelledShiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: cancelReason,
          },
        )
        await client.query(`UPDATE shifts SET state = 'cancelled' WHERE id = $1`, [cancelledShiftId])
        await client.query(
          `INSERT INTO shift_decisions (shift_id, gate, decision, notes, decided_by)
           VALUES ($1, 'close', 'force_cancelled', $2, $3)`,
          [cancelledShiftId, cancelReason, managerId],
        )
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        // Correct amounts are not enough: attacker-selected metadata cannot later become the
        // explanation of a cancelled shift. The journal reason/actor are part of the exact void
        // recipe and must match the one force_cancelled decision.
        await client.query('SAVEPOINT forged_cancelled_void')
        const forgedCancelledShiftId = randomUUID()
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at)
           VALUES ($1, $2, $3, $4, 3, DATE '2026-08-23', DATE '2026-08-23',
                   'pending_review', TIMESTAMPTZ '2026-08-23 10:30:00+00')`,
          [forgedCancelledShiftId, branchId, driverId, vehicleId],
        )
        await client.query(
          `INSERT INTO float_tranches (shift_id, kind, seq_no, amount_minor, handed_by)
           VALUES ($1, 'cash_float', 1, 100, $2)`,
          [forgedCancelledShiftId, managerId],
        )
        await ledger.post(
          branchId,
          [floatOut(driverId, minor(100n)), floatReturn(driverId, minor(100n))],
          {
            shiftId: forgedCancelledShiftId,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'attacker-selected reason',
          },
        )
        await client.query(`UPDATE shifts SET state = 'cancelled' WHERE id = $1`, [forgedCancelledShiftId])
        await client.query(
          `INSERT INTO shift_decisions (shift_id, gate, decision, notes, decided_by)
           VALUES ($1, 'close', 'force_cancelled', 'manager-approved reason', $2)`,
          [forgedCancelledShiftId, managerId],
        )
        await expect(
          client.query('SET CONSTRAINTS shift_close_journals_from_shift IMMEDIATE'),
        ).rejects.toMatchObject({ code: '23514', constraint: 'shift_void_journal_guard' })
        await client.query('ROLLBACK TO SAVEPOINT forged_cancelled_void')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        const financial = new PgFinancialUnitOfWork(boundPool)
        const receivableRepo = new PgReceivableEventRepo(boundPool)
        const createKey = 'receivable-create-1'
        const createdEvent = await financial.run(
          {
            lockKey: `receivables:${branchId}`,
            actorId: managerId,
            requestId: 'receivable-guard-test',
          },
          async (tx) => {
            const [entry] = await tx.ledger.post(
              branchId,
              [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(250n), createKey)],
              {
                shiftId: null,
                businessDate: '2026-08-23',
                postingDate: '2026-08-23',
                weekStartDate: '2026-08-23',
                fxDayId,
                createdBy: managerId,
                reason: 'driver cash debt',
              },
            )
            const event: ReceivableEventRecord = {
              id: randomUUID(),
              branchId,
              driverId,
              receivableKind: 'ordinary',
              channel: 'cash',
              direction: 'create',
              amount: minor(250n),
              businessDate: '2026-08-23',
              reason: 'driver cash debt',
              idempotencyKey: createKey,
              journalEntryId: entry!.id,
              createdBy: managerId,
              createdAtMs: Date.UTC(2026, 7, 23, 9, 2),
            }
            await tx.receivableEvents.create(event)
            return event
          },
        )
        expect(await receivableRepo.findByIdempotencyKey(branchId, createKey)).toEqual(createdEvent)
        expect(await receivableRepo.listByBranchAndDriver(branchId, driverId)).toEqual([createdEvent])
        expect(
          await client.query(
            "SELECT count(*)::int AS count FROM audit_log WHERE table_name = 'receivable_events' AND record_id = $1",
            [createdEvent.id],
          ),
        ).toMatchObject({ rows: [{ count: 1 }] })

        await client.query('SAVEPOINT post_commit_extra_receivable_lines')
        await client.query(
          `WITH forged(code, side) AS (
             VALUES ('office_cash', 'D'::char(1)),
                    ('driver_receivable_cash:' || $2::text, 'C'::char(1))
           )
           INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role)
           SELECT $1, f.id, forged.side, 1, 'forged_late_receivable_line'
             FROM forged
             JOIN funds f ON f.branch_id = $3 AND f.code = forged.code`,
          [createdEvent.journalEntryId, driverId, branchId],
        )
        await expect(
          client.query('SET CONSTRAINTS receivable_journal_lines_from_line IMMEDIATE'),
        ).rejects.toMatchObject({ code: '23514', constraint: 'receivable_events_lines_guard' })
        await client.query('ROLLBACK TO SAVEPOINT post_commit_extra_receivable_lines')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        await client.query('SAVEPOINT wrong_receivable_journal_date')
        const wrongDateKey = 'receivable-wrong-date-1'
        const [wrongDateJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(1n), wrongDateKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-24',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'wrong receivable posting date',
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            amount: minor(1n),
            reason: 'wrong receivable posting date',
            idempotencyKey: wrongDateKey,
            journalEntryId: wrongDateJournal!.id,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_journal_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT wrong_receivable_journal_date')

        await client.query('SAVEPOINT orphan_receivable_journal')
        const orphanKey = 'receivable-orphan-journal-1'
        await new PgLedgerRepo(boundPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(1n), orphanKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'orphan receivable journal',
          },
        )
        await expect(
          client.query('SET CONSTRAINTS receivable_journal_event_from_entry IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_journal_event_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT orphan_receivable_journal')

        // Deactivation must not make a real debt uncollectable, but it must prevent a new advance.
        await client.query('UPDATE drivers SET active = false WHERE id = $1', [driverId])
        await client.query('SAVEPOINT inactive_driver_create')
        const inactiveCreateKey = 'receivable-inactive-create-1'
        const [inactiveCreateJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(1n), inactiveCreateKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'inactive driver cannot receive a new advance',
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            amount: minor(1n),
            reason: 'inactive driver cannot receive a new advance',
            idempotencyKey: inactiveCreateKey,
            journalEntryId: inactiveCreateJournal!.id,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_driver_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT inactive_driver_create')

        const inactiveCollectKey = 'receivable-inactive-collect-1'
        const [inactiveCollectJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'collect', minor(1n), inactiveCollectKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'inactive driver debt collection',
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            direction: 'collect',
            amount: minor(1n),
            reason: 'inactive driver debt collection',
            idempotencyKey: inactiveCollectKey,
            journalEntryId: inactiveCollectJournal!.id,
          }),
        ).resolves.toBeUndefined()
        await expect(
          receivableRepo.findByIdempotencyKey(branchId, inactiveCollectKey),
        ).resolves.toMatchObject({
          direction: 'collect',
          amount: minor(1n),
        })
        await client.query('UPDATE drivers SET active = true WHERE id = $1', [driverId])

        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        await client.query('SAVEPOINT invisible_event_reason')
        const invisibleReasonKey = 'receivable-invisible-reason-1'
        const invisibleReason = ' \t\n\u200B'
        const [invisibleReasonJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [
            receivableAdjustment(
              driverId,
              'ordinary',
              'cash',
              'create',
              minor(1n),
              invisibleReasonKey,
            ),
          ],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: invisibleReason,
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            amount: minor(1n),
            reason: invisibleReason,
            idempotencyKey: invisibleReasonKey,
            journalEntryId: invisibleReasonJournal!.id,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_reason_check',
        })
        await client.query('ROLLBACK TO SAVEPOINT invisible_event_reason')

        await client.query('SAVEPOINT forged_event_fund')
        const forgedFundKey = 'receivable-forged-fund-1'
        const forgedFundDriverId = randomUUID()
        await client.query(
          `INSERT INTO drivers (id, branch_id, code, full_name_ar)
           VALUES ($1, $2, $3, 'forged fund driver')`,
          [forgedFundDriverId, branchId, `RECEIVABLE-FORGED-DRV-${suffix}`],
        )
        await client.query(
          `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
           VALUES ($1, 'cost_center', 'driver', $2::uuid,
                   'driver_shift_funding_wallet:' || $2::text, 'forged receivable fund')`,
          [branchId, forgedFundDriverId],
        )
        const [forgedFundJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [
            receivableAdjustment(
              forgedFundDriverId,
              'shift_funding',
              'wallet',
              'create',
              minor(1n),
              forgedFundKey,
            ),
          ],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'forged fund identity',
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            driverId: forgedFundDriverId,
            receivableKind: 'shift_funding',
            channel: 'wallet',
            amount: minor(1n),
            reason: 'forged fund identity',
            idempotencyKey: forgedFundKey,
            journalEntryId: forgedFundJournal!.id,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_lines_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT forged_event_fund')

        await client.query('SAVEPOINT mismatched_event_lines')
        const mismatchedLinesKey = 'receivable-mismatched-lines-1'
        const [mismatchedLinesJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(1n), mismatchedLinesKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'mismatched line recipe',
          },
        )
        await expect(
          receivableRepo.create({
            ...createdEvent,
            id: randomUUID(),
            channel: 'wallet',
            amount: minor(1n),
            reason: 'mismatched line recipe',
            idempotencyKey: mismatchedLinesKey,
            journalEntryId: mismatchedLinesJournal!.id,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_lines_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT mismatched_event_lines')

        await client.query('SAVEPOINT duplicate_event')
        await expect(receivableRepo.create(createdEvent)).rejects.toMatchObject({
          code: 'DUPLICATE_IDEMPOTENCY_KEY',
        })
        await client.query('ROLLBACK TO SAVEPOINT duplicate_event')

        for (const [savepoint, sql] of [
          ['event_update', 'UPDATE receivable_events SET reason = \'rewritten\' WHERE id = $1'],
          ['event_delete', 'DELETE FROM receivable_events WHERE id = $1'],
        ] as const) {
          await client.query(`SAVEPOINT ${savepoint}`)
          await expect(client.query(sql, [createdEvent.id])).rejects.toMatchObject({ code: '55000' })
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }

        await client.query('SAVEPOINT duplicate_journal_key')
        await expect(
          client.query(
            `INSERT INTO journal_entries
               (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                week_start_date, fx_day_id, reason, created_by)
             VALUES ($1, 'receivable_adjustment', NULL, $2, DATE '2026-08-23', DATE '2026-08-23',
                     DATE '2026-08-23', $3, 'duplicate', $4)`,
            [branchId, createKey, fxDayId, managerId],
          ),
        ).rejects.toMatchObject({ code: '23505' })
        await client.query('ROLLBACK TO SAVEPOINT duplicate_journal_key')

        await client.query('SAVEPOINT overcollection')
        const overKey = 'receivable-overcollection-1'
        const [overJournal] = await new PgLedgerRepo(boundPool).post(
          branchId,
          // 600 from the exact close deferral above + 250 from the direct command = 850 owed.
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'collect', minor(851n), overKey)],
          {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId,
            createdBy: managerId,
            reason: 'too much collection',
          },
        )
        await expect(
          receivableRepo.create({
            id: randomUUID(),
            branchId,
            driverId,
            receivableKind: 'ordinary',
            channel: 'cash',
            direction: 'collect',
            amount: minor(851n),
            businessDate: '2026-08-23',
            reason: 'too much collection',
            idempotencyKey: overKey,
            journalEntryId: overJournal!.id,
            createdBy: managerId,
            createdAtMs: Date.UTC(2026, 7, 23, 9, 3),
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'receivable_events_overcollection_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT overcollection')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('serializes concurrent collections so the committed receivable cannot go negative', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const setup = await pool.connect()
      const branchId = randomUUID()
      const managerId = randomUUID()
      const driverId = randomUUID()
      const suffix = branchId.replaceAll('-', '').slice(0, 12)
      const businessDate = '2026-08-23' as const
      const baselineKey = `receivable-race-baseline-${suffix}`

      try {
        await setup.query('BEGIN')
        await setup.query(
          `INSERT INTO roles (key, name_ar, name_en)
           VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
           ON CONFLICT (key) DO NOTHING`,
        )
        await setup.query(
          `INSERT INTO permissions (key, name_ar, name_en)
           VALUES ('journal.manual.write', 'قيد يدوي', 'Manual journal write')
           ON CONFLICT (key) DO NOTHING`,
        )
        await setup.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('branch_manager', 'journal.manual.write', 'branch')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await setup.query(
          `INSERT INTO branches
             (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
           SELECT $1, $2, 'فرع اختبار تزامن الذمم', 'Receivable race test',
                  'Asia/Damascus', g.id, n.branch_no
             FROM governorates g
             CROSS JOIN LATERAL (
               SELECT candidate AS branch_no
                 FROM generate_series(1, 99) AS candidate
                WHERE NOT EXISTS (
                  SELECT 1 FROM branches b
                   WHERE b.governorate_id = g.id AND b.branch_no = candidate
                )
                ORDER BY candidate
                LIMIT 1
             ) n
            WHERE g.no = 1`,
          [branchId, `RECEIVABLE-RACE-${suffix}`],
        )
        await setup.query(
          `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
           VALUES ($1, $2, 'branch_manager', $3, 'مدير اختبار تزامن الذمم', 'x')`,
          [managerId, branchId, `receivable-race-${suffix}`],
        )
        await setup.query(
          `INSERT INTO drivers (id, branch_id, code, full_name_ar)
           VALUES ($1, $2, $3, 'سائق اختبار تزامن الذمم')`,
          [driverId, branchId, `RECEIVABLE-RACE-DRV-${suffix}`],
        )
        await setup.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
        await setup.query('SELECT set_config($1, $2, true)', ['app.request_id', 'receivable-race-setup'])
        const fx = await setup.query<{ id: bigint }>(
          `INSERT INTO fx_days (business_date, syp_minor_per_usd)
           VALUES ($1::date, 13000)
           ON CONFLICT (business_date) DO UPDATE
             SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
           RETURNING id`,
          [businessDate],
        )
        const fxDayId = Number(fx.rows[0]!.id)
        const setupPool = bindPoolToTransaction(pool, setup, {
          actorId: managerId,
          requestId: 'receivable-race-setup',
        })
        const [baselineJournal] = await new PgLedgerRepo(setupPool).post(
          branchId,
          [receivableAdjustment(driverId, 'ordinary', 'cash', 'create', minor(100n), baselineKey)],
          {
            shiftId: null,
            businessDate,
            postingDate: businessDate,
            weekStartDate: businessDate,
            fxDayId,
            createdBy: managerId,
            reason: 'concurrency baseline',
          },
        )
        await new PgReceivableEventRepo(setupPool).create({
          id: randomUUID(),
          branchId,
          driverId,
          receivableKind: 'ordinary',
          channel: 'cash',
          direction: 'create',
          amount: minor(100n),
          businessDate,
          reason: 'concurrency baseline',
          idempotencyKey: baselineKey,
          journalEntryId: baselineJournal!.id,
          createdBy: managerId,
          createdAtMs: Date.UTC(2026, 7, 23, 10),
        })
        await setup.query('COMMIT')

        const first = await pool.connect()
        const second = await pool.connect()
        try {
          await first.query('BEGIN')
          await second.query('BEGIN')
          await first.query("SET LOCAL statement_timeout = '5s'")
          await second.query("SET LOCAL statement_timeout = '5s'")
          await first.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
          await second.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
          await first.query('SELECT set_config($1, $2, true)', ['app.request_id', 'receivable-race-first'])
          await second.query('SELECT set_config($1, $2, true)', ['app.request_id', 'receivable-race-second'])

          const firstPool = bindPoolToTransaction(pool, first, {
            actorId: managerId,
            requestId: 'receivable-race-first',
          })
          const secondPool = bindPoolToTransaction(pool, second, {
            actorId: managerId,
            requestId: 'receivable-race-second',
          })
          const firstKey = `receivable-race-first-${suffix}`
          const secondKey = `receivable-race-second-${suffix}`
          const [firstJournal] = await new PgLedgerRepo(firstPool).post(
            branchId,
            [receivableAdjustment(driverId, 'ordinary', 'cash', 'collect', minor(60n), firstKey)],
            {
              shiftId: null,
              businessDate,
              postingDate: businessDate,
              weekStartDate: businessDate,
              fxDayId,
              createdBy: managerId,
              reason: 'first concurrent collection',
            },
          )
          const firstRepo = new PgReceivableEventRepo(firstPool)
          const secondRepo = new PgReceivableEventRepo(secondPool)
          await firstRepo.create({
            id: randomUUID(),
            branchId,
            driverId,
            receivableKind: 'ordinary',
            channel: 'cash',
            direction: 'collect',
            amount: minor(60n),
            businessDate,
            reason: 'first concurrent collection',
            idempotencyKey: firstKey,
            journalEntryId: firstJournal!.id,
            createdBy: managerId,
            createdAtMs: Date.UTC(2026, 7, 23, 10, 1),
          })

          // Every ledger writer now takes the same branch-money advisory lock. Start the second
          // posting while the first transaction owns it, then commit the first collection so the
          // waiter observes the new balance. Awaiting the second post before that commit would be
          // a test-created deadlock, not a production race.
          const secondJournalPromise = new PgLedgerRepo(secondPool).post(
            branchId,
            [receivableAdjustment(driverId, 'ordinary', 'cash', 'collect', minor(60n), secondKey)],
            {
              shiftId: null,
              businessDate,
              postingDate: businessDate,
              weekStartDate: businessDate,
              fxDayId,
              createdBy: managerId,
              reason: 'second concurrent collection',
            },
          )
          await first.query('COMMIT')
          const [secondJournal] = await secondJournalPromise

          const secondAttempt = secondRepo.create({
            id: randomUUID(),
            branchId,
            driverId,
            receivableKind: 'ordinary',
            channel: 'cash',
            direction: 'collect',
            amount: minor(60n),
            businessDate,
            reason: 'second concurrent collection',
            idempotencyKey: secondKey,
            journalEntryId: secondJournal!.id,
            createdBy: managerId,
            createdAtMs: Date.UTC(2026, 7, 23, 10, 2),
          })
          const secondRejection = expect(secondAttempt).rejects.toMatchObject({
            code: '23514',
            constraint: 'receivable_events_overcollection_guard',
          })
          await secondRejection
          await second.query('ROLLBACK')

          expect(
            await new PgLedgerRepo(pool).fundBalance(
              branchId,
              `driver_receivable_cash:${driverId}`,
            ),
          ).toBe(minor(40n))
          expect(
            await pool.query(
              `SELECT count(*)::int AS count
                 FROM receivable_events
                WHERE branch_id = $1 AND direction = 'collect'`,
              [branchId],
            ),
          ).toMatchObject({ rows: [{ count: 1 }] })
        } finally {
          await first.query('ROLLBACK').catch(() => undefined)
          await second.query('ROLLBACK').catch(() => undefined)
          first.release()
          second.release()
        }
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        setup.release()
      }
    })

    it('serializes a terminal close against a concurrent return append', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const setup = await pool.connect()
      const branchId = randomUUID()
      const managerId = randomUUID()
      const driverId = randomUUID()
      const vehicleId = randomUUID()
      const shiftId = randomUUID()
      const suffix = branchId.replaceAll('-', '').slice(0, 12)
      const businessDate = '2026-08-23' as const

      try {
        await setup.query('BEGIN')
        await setup.query(
          `INSERT INTO roles (key, name_ar, name_en)
           VALUES ('branch_manager', 'branch manager', 'Branch manager')
           ON CONFLICT (key) DO NOTHING`,
        )
        await setup.query(
          `INSERT INTO branches
             (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
           SELECT $1, $2, 'close race branch', 'Close race branch', 'Asia/Damascus', g.id, n.branch_no
             FROM governorates g
             CROSS JOIN LATERAL (
               SELECT candidate AS branch_no
                 FROM generate_series(1, 99) AS candidate
                WHERE NOT EXISTS (
                  SELECT 1 FROM branches b
                   WHERE b.governorate_id = g.id AND b.branch_no = candidate
                )
                ORDER BY candidate
                LIMIT 1
             ) n
            WHERE g.no = 1`,
          [branchId, `SHIFT-CLOSE-RACE-${suffix}`],
        )
        await setup.query(
          `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
           VALUES ($1, $2, 'branch_manager', $3, 'close race manager', 'x')`,
          [managerId, branchId, `shift-close-race-${suffix}`],
        )
        await setup.query(
          `INSERT INTO drivers (id, branch_id, code, full_name_ar)
           VALUES ($1, $2, $3, 'close race driver')`,
          [driverId, branchId, `SHIFT-CLOSE-RACE-DRV-${suffix}`],
        )
        await setup.query(
          `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
           SELECT $1, $2, t.id, $3, 1
             FROM vehicle_types t
            WHERE t.code = 'e_motorbike'`,
          [vehicleId, branchId, `SHIFT-CLOSE-RACE-VEH-${suffix}`],
        )
        const fx = await setup.query<{ id: bigint }>(
          `INSERT INTO fx_days (business_date, syp_minor_per_usd)
           VALUES ($1::date, 13000)
           ON CONFLICT (business_date) DO UPDATE
             SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
           RETURNING id`,
          [businessDate],
        )
        const fxDayId = Number(fx.rows[0]!.id)
        await setup.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at, kept_as_receivable_minor)
           VALUES ($1, $2, $3, $4, 1, $5::date, $5::date,
                   'pending_review', TIMESTAMPTZ '2026-08-23 11:00:00+00', 600)`,
          [shiftId, branchId, driverId, vehicleId, businessDate],
        )
        await setup.query(
          `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
           VALUES
             ($1, 'office_cash', 'none', NULL, 'office_cash', 'office cash'),
             ($1, 'office_wallet', 'none', NULL, 'office_wallet', 'office wallet'),
             ($1, 'driver_cash', 'driver', $2::uuid,
                  'driver_cash:' || ($2::uuid)::text, 'driver cash'),
             ($1, 'driver_wallet', 'driver', $2::uuid,
                  'driver_wallet:' || ($2::uuid)::text, 'driver wallet'),
             ($1, 'driver_share_payable', 'driver', $2::uuid,
                  'driver_share_payable:' || ($2::uuid)::text, 'driver share'),
             ($1, 'driver_receivable_cash', 'driver', $2::uuid,
                  'driver_receivable_cash:' || ($2::uuid)::text, 'driver cash receivable'),
             ($1, 'driver_receivable_wallet', 'driver', $2::uuid,
                  'driver_receivable_wallet:' || ($2::uuid)::text, 'driver wallet receivable')`,
          [branchId, driverId],
        )
        await setup.query('COMMIT')

        const closer = await pool.connect()
        const attacker = await pool.connect()
        try {
          await closer.query('BEGIN')
          await attacker.query('BEGIN')
          await closer.query("SET LOCAL statement_timeout = '5s'")
          await attacker.query("SET LOCAL statement_timeout = '5s'")
          await closer.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
          await attacker.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
          await closer.query('SELECT set_config($1, $2, true)', ['app.request_id', 'shift-close-race-close'])
          await attacker.query('SELECT set_config($1, $2, true)', ['app.request_id', 'shift-close-race-append'])

          // Stage an append while the row still appears pending in this transaction. It is
          // balanced and uses a non-conflicting occurrence, so only the exact shift guard can
          // reject it.
          await attacker.query(
            `WITH entry AS (
               INSERT INTO journal_entries
                 (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                  week_start_date, fx_day_id, reason, created_by)
               VALUES ($1, 'wallet_return', $2, 'concurrent-poison', $3::date, $3::date,
                       $3::date, $4, 'concurrent return poison', $5)
               RETURNING id
             ), forged(code, side) AS (
               VALUES ('office_wallet', 'D'::char(1)),
                      ('driver_wallet:' || $6::text, 'C'::char(1))
             )
             INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role)
             SELECT entry.id, f.id, forged.side, 1, 'concurrent_poison'
               FROM entry
               CROSS JOIN forged
               JOIN funds f ON f.branch_id = $1 AND f.code = forged.code`,
            [branchId, shiftId, businessDate, fxDayId, managerId, driverId],
          )

          const closePool = bindPoolToTransaction(pool, closer, {
            actorId: managerId,
            requestId: 'shift-close-race-close',
          })
          await new PgLedgerRepo(closePool).post(
            branchId,
            [
              {
                eventType: 'wallet_return',
                occurrenceKey: '1',
                lines: [
                  { fund: { kind: 'driver_wallet', driverId }, side: 'C', amount: minor(2_000n), role: 'wallet_cleared' },
                  { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(1_500n), role: 'wallet_settlement' },
                  {
                    fund: { kind: 'driver_receivable_wallet', driverId },
                    side: 'D',
                    amount: minor(500n),
                    role: 'wallet_settlement_deferred',
                  },
                ],
              },
              {
                eventType: 'float_return',
                occurrenceKey: '1',
                lines: [
                  { fund: { kind: 'driver_cash', driverId }, side: 'C', amount: minor(8_000n), role: 'cash_cleared' },
                  {
                    fund: { kind: 'driver_share_payable', driverId },
                    side: 'D',
                    amount: minor(400n),
                    role: 'driver_share_settled',
                  },
                  {
                    fund: { kind: 'driver_receivable_cash', driverId },
                    side: 'D',
                    amount: minor(600n),
                    role: 'cash_settlement_deferred',
                  },
                  { fund: { kind: 'office_cash' }, side: 'D', amount: minor(7_000n), role: 'cash_settlement' },
                ],
              },
            ],
            {
              shiftId,
              businessDate,
              postingDate: businessDate,
              weekStartDate: businessDate,
              fxDayId,
              createdBy: managerId,
            },
          )
          await new PgShiftSettlementRepo(closePool).create({
            shiftId,
            branchId,
            driverId,
            businessDate,
            policyCode: 'fixed_40_cash_close_v2_receivable',
            driverRateBps: 4_000,
            deliveryFeeTotal: minor(1_000n),
            fixedDriverShare: minor(400n),
            manualDriverShare: minor(0n),
            grossDriverShare: minor(400n),
            cashDeductionTotal: minor(0n),
            baseDriverShare: minor(400n),
            expectedTotal: minor(10_000n),
            actualCash: minor(8_000n),
            actualWallet: minor(2_000n),
            actualTotal: minor(10_000n),
            variance: minor(0n),
            varianceDirection: 'balanced',
            finalEmployeeCash: minor(400n),
            cashClaimToOffice: minor(7_600n),
            walletClaimToOffice: minor(2_000n),
            cashReceivableDeferred: minor(600n),
            walletReceivableDeferred: minor(500n),
            cashToOffice: minor(7_000n),
            walletToOffice: minor(1_500n),
            cashAction: 'collect',
            cashAmount: minor(7_000n),
            walletAction: 'collect',
            walletAmount: minor(1_500n),
            reviewedOrdersHash: 'close-race-orders',
            settlementHash: 'd'.repeat(64),
            walletTransferConfirmed: true,
            cashSettlementConfirmed: true,
            confirmedBy: managerId,
            confirmedAtMs: Date.UTC(2026, 7, 23, 11, 1),
            varianceReason: null,
          })
          await closer.query(
            `UPDATE shifts
                SET state = 'approved', kept_as_receivable_minor = 600,
                    wallet_diff_minor = 0, approved_by = $2
              WHERE id = $1`,
            [shiftId, managerId],
          )

          const closerPid = await closer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          const attackerPid = await attacker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          let appendSettled = false
          const appendOutcomePromise = attacker.query('COMMIT').then(
            () => {
              appendSettled = true
              return { ok: true as const }
            },
            (error: unknown) => {
              appendSettled = true
              return { ok: false as const, error }
            },
          )

          // The close UPDATE already owns the shift row. The return constraint must wait on that
          // exact transaction rather than validate its stale pending snapshot.
          await new Promise((resolve) => setTimeout(resolve, 75))
          expect(appendSettled).toBe(false)
          const waiter = await pool.query<{
            wait_event_type: string | null
            wait_event: string | null
            blockers: number[]
          }>(
            `SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
               FROM pg_stat_activity
              WHERE pid = $1`,
            [attackerPid.rows[0]!.pid],
          )
          expect(waiter.rows[0]).toMatchObject({
            wait_event_type: 'Lock',
            wait_event: 'transactionid',
          })
          expect(waiter.rows[0]!.blockers).toContain(closerPid.rows[0]!.pid)

          await closer.query('COMMIT')
          const appendOutcome = await appendOutcomePromise
          expect(appendOutcome.ok).toBe(false)
          if (appendOutcome.ok) throw new Error('concurrent poison unexpectedly committed')
          expect(appendOutcome.error).toMatchObject({
            code: '23514',
            constraint: 'shift_close_journal_guard',
          })

          expect(
            await pool.query(
              `SELECT s.state::text AS state,
                      (count(je.id) FILTER (
                        WHERE je.event_type IN ('wallet_return', 'float_return')
                      ))::int AS return_entries,
                      (count(je.id) FILTER (
                        WHERE je.occurrence_key = 'concurrent-poison'
                      ))::int AS poison_entries
                 FROM shifts s
                 LEFT JOIN journal_entries je ON je.shift_id = s.id
                WHERE s.id = $1
                GROUP BY s.id`,
              [shiftId],
            ),
          ).toMatchObject({
            rows: [{ state: 'approved', return_entries: 2, poison_entries: 0 }],
          })
        } finally {
          await closer.query('ROLLBACK').catch(() => undefined)
          await attacker.query('ROLLBACK').catch(() => undefined)
          closer.release()
          attacker.release()
        }
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        setup.release()
      }
    })
  })
}
