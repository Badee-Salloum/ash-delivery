import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { formatMinor, minor, sweepToCompany, type Posting } from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import {
  bindPoolToTransaction,
  createPool,
  type Pool,
  type PoolClient,
} from '../src/pool.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
const DATE = '2026-08-23'
const WEEK = '2026-08-23'
const CASH_TARGET = 5_000_000n
const WALLET_TARGET = 1_000_000n

type Fixture = {
  branchId: string
  managerId: string
  accountantId: string
  suffix: string
}

const setActor = async (client: PoolClient, actorId: string | null): Promise<void> => {
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId ?? ''])
}

const createFixture = async (client: PoolClient, label: string): Promise<Fixture> => {
  const branchId = randomUUID()
  const managerId = randomUUID()
  const accountantId = randomUUID()
  const suffix = branchId.replaceAll('-', '').slice(0, 12)

  await client.query(
    `INSERT INTO roles (key, name_ar, name_en)
     VALUES
       ('branch_manager', 'Branch manager', 'Branch manager'),
       ('accountant', 'Accountant', 'Accountant')
     ON CONFLICT (key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO permissions (key, name_ar, name_en)
     VALUES ('journal.manual.write', 'Manual journal', 'Manual journal')
     ON CONFLICT (key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO role_permissions (role_key, permission_key, scope)
     VALUES ('branch_manager', 'journal.manual.write', 'branch')
     ON CONFLICT (role_key, permission_key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO branches
       (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
     SELECT $1, $2, $3, $3, 'Asia/Damascus', g.id, n.branch_no
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
    [branchId, `RESTORE-${label}-${suffix}`, `Restoration ${label}`],
  )
  await client.query(
    `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
     VALUES
       ($1, $3, 'branch_manager', $4, 'Restoration manager', 'x'),
       ($2, $3, 'accountant', $5, 'Restoration accountant', 'x')`,
    [managerId, accountantId, branchId, `restore-manager-${suffix}`, `restore-accountant-${suffix}`],
  )
  return { branchId, managerId, accountantId, suffix }
}

const putTargets = async (
  client: PoolClient,
  fixture: Fixture,
  actorId = fixture.managerId,
  effectiveFrom = DATE,
): Promise<void> => {
  await setActor(client, actorId)
  await client.query(
    `INSERT INTO office_capital_targets
       (branch_id, fund_code, target_minor, effective_from, created_by, note)
     VALUES
       ($1, 'office_cash', $2, $5, $4, 'guard cash target'),
       ($1, 'office_wallet', $3, $5, $4, 'guard wallet target')`,
    [fixture.branchId, CASH_TARGET, WALLET_TARGET, actorId, effectiveFrom],
  )
}

const post = async (
  client: PoolClient,
  pool: Pool,
  fixture: Fixture,
  postings: readonly Posting[],
  reason: string,
) => {
  await setActor(client, fixture.managerId)
  const fx = await client.query<{ id: bigint }>(
    `INSERT INTO fx_days (business_date, syp_minor_per_usd)
     VALUES ($1, 13000)
     ON CONFLICT (business_date) DO UPDATE SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd
     RETURNING id`,
    [DATE],
  )
  const bound = bindPoolToTransaction(pool, client, {
    actorId: fixture.managerId,
    requestId: `restoration-guard-${fixture.suffix}`,
  })
  return new PgLedgerRepo(bound).post(fixture.branchId, postings, {
    shiftId: null,
    businessDate: DATE,
    postingDate: DATE,
    weekStartDate: WEEK,
    fxDayId: Number(fx.rows[0]!.id),
    createdBy: fixture.managerId,
    reason,
  })
}

const makeLeg = (
  fundCode: 'office_cash' | 'office_wallet',
  counted: bigint,
  receivables: bigint,
  target: bigint,
) => {
  const position = counted + receivables
  const delta = position - target
  const amount = delta < 0n ? -delta : delta
  return {
    fundCode,
    counted: formatMinor(minor(counted)),
    receivables: formatMinor(minor(receivables)),
    position: formatMinor(minor(position)),
    capitalTarget: formatMinor(minor(target)),
    delta: formatMinor(minor(delta)),
    direction: delta === 0n ? null : delta > 0n ? 'to_company' : 'from_company',
    amount: formatMinor(minor(amount)),
    feasible: true,
    refusals: [],
  }
}

const makeEvidence = async (
  client: PoolClient,
  pool: Pool,
  fixture: Fixture,
  options: { opening?: boolean; proof?: string; journal?: boolean } = {},
) => {
  const cashCounted = CASH_TARGET + 100n
  const proof = options.proof ?? 'd'.repeat(64)
  const reason = 'daily restoration guard'

  if (options.opening !== false) {
    await post(client, pool, fixture, [{
      eventType: 'manual',
      occurrenceKey: `restoration-opening-${fixture.suffix}`,
      lines: [
        { fund: { kind: 'office_cash' }, side: 'D', amount: minor(cashCounted) },
        { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(WALLET_TARGET) },
        {
          fund: { kind: 'company_box' },
          side: 'C',
          amount: minor(cashCounted + WALLET_TARGET),
        },
      ],
    }], 'opening guard balances')
  } else {
    await client.query(
      `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
       VALUES
         ($1, 'office_cash', 'none', NULL, 'office_cash', 'office cash'),
         ($1, 'office_wallet', 'none', NULL, 'office_wallet', 'office wallet'),
         ($1, 'company_box', 'none', NULL, 'company_box', 'company box')
       ON CONFLICT (branch_id, code) DO NOTHING`,
      [fixture.branchId],
    )
  }

  const count = await client.query<{ id: bigint }>(
    `INSERT INTO cash_counts
       (branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at, notes)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-08-23 09:00:00+00', $4,
             TIMESTAMPTZ '2026-08-23 09:00:00+00', 'restoration guard evidence')
     RETURNING id`,
    [fixture.branchId, DATE, fixture.managerId, proof],
  )
  const countId = count.rows[0]!.id
  await client.query(
    `INSERT INTO cash_count_lines
       (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor, resolution)
     SELECT $2, f.id,
            CASE f.code WHEN 'office_cash' THEN $3::bigint ELSE $4::bigint END,
            CASE f.code WHEN 'office_cash' THEN $3::bigint ELSE $4::bigint END,
            0, NULL
       FROM funds f
      WHERE f.branch_id = $1 AND f.code IN ('office_cash', 'office_wallet')`,
    [fixture.branchId, countId, cashCounted, WALLET_TARGET],
  )

  const journal = options.journal === false
    ? null
    : (await post(
      client,
      pool,
      fixture,
      [sweepToCompany('office_cash', minor(100n), `${DATE}:office_cash`)],
      reason,
    ))[0]!
  const plan = {
    schemaVersion: 2,
    cashCountProofSha256: proof,
    cashCountSealedAt: '2026-08-23T09:00:00.000Z',
    countReconciliation: [
      { fundCode: 'office_cash', variance: '0.00', resolution: null },
      { fundCode: 'office_wallet', variance: '0.00', resolution: null },
    ],
    reconciliationJournalEntryIds: [],
    restorationJournalEntryIds: journal === null ? [] : [journal.id],
    legs: [
      makeLeg('office_cash', cashCounted, 0n, CASH_TARGET),
      makeLeg('office_wallet', WALLET_TARGET, 0n, WALLET_TARGET),
    ],
  }
  return { countId, journalId: journal?.id ?? 0, plan, reason }
}

const attachRestorationJournal = async (
  client: PoolClient,
  pool: Pool,
  fixture: Fixture,
  evidence: Awaited<ReturnType<typeof makeEvidence>>,
) => {
  const [journal] = await post(
    client,
    pool,
    fixture,
    [sweepToCompany('office_cash', minor(100n), `${DATE}:office_cash`)],
    evidence.reason,
  )
  return {
    ...evidence,
    journalId: journal!.id,
    plan: { ...evidence.plan, restorationJournalEntryIds: [journal!.id] },
  }
}

const makeDebtOnlyEvidence = async (
  client: PoolClient,
  pool: Pool,
  fixture: Fixture,
) => {
  const driverId = randomUUID()
  const proof = '9'.repeat(64)
  const reason = 'debt-only forged sweep'
  const receivable = 6_000_000n
  const sweep = 1_000_000n
  await client.query(
    `INSERT INTO drivers (id, branch_id, code, full_name_ar)
     VALUES ($1, $2, $3, 'Debt-only guard driver')`,
    [driverId, fixture.branchId, `RESTORE-DEBT-${fixture.suffix}`],
  )
  await post(client, pool, fixture, [{
    eventType: 'manual',
    occurrenceKey: `restoration-debt-opening-${fixture.suffix}`,
    lines: [
      { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(WALLET_TARGET) },
      { fund: { kind: 'driver_receivable_cash', driverId }, side: 'D', amount: minor(receivable) },
      {
        fund: { kind: 'company_box' },
        side: 'C',
        amount: minor(WALLET_TARGET + receivable),
      },
    ],
  }], 'debt-only opening balances')
  await client.query(
    `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
     VALUES ($1, 'office_cash', 'none', NULL, 'office_cash', 'office cash')
     ON CONFLICT (branch_id, code) DO NOTHING`,
    [fixture.branchId],
  )
  const count = await client.query<{ id: bigint }>(
    `INSERT INTO cash_counts
       (branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-08-23 09:00:00+00', $4,
             TIMESTAMPTZ '2026-08-23 09:00:00+00')
     RETURNING id`,
    [fixture.branchId, DATE, fixture.managerId, proof],
  )
  const countId = count.rows[0]!.id
  await client.query(
    `INSERT INTO cash_count_lines
       (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor, resolution)
     SELECT $2, f.id,
            CASE f.code WHEN 'office_cash' THEN 0 ELSE $3::bigint END,
            CASE f.code WHEN 'office_cash' THEN 0 ELSE $3::bigint END,
            0, NULL
       FROM funds f
      WHERE f.branch_id = $1 AND f.code IN ('office_cash', 'office_wallet')`,
    [fixture.branchId, countId, WALLET_TARGET],
  )
  const [journal] = await post(
    client,
    pool,
    fixture,
    [sweepToCompany('office_cash', minor(sweep), `${DATE}:office_cash`)],
    reason,
  )
  return {
    countId,
    journalId: journal!.id,
    reason,
    plan: {
      schemaVersion: 2,
      cashCountProofSha256: proof,
      cashCountSealedAt: '2026-08-23T09:00:00.000Z',
      countReconciliation: [
        { fundCode: 'office_cash', variance: '0.00', resolution: null },
        { fundCode: 'office_wallet', variance: '0.00', resolution: null },
      ],
      reconciliationJournalEntryIds: [],
      restorationJournalEntryIds: [journal!.id],
      legs: [
        makeLeg('office_cash', 0n, receivable, CASH_TARGET),
        makeLeg('office_wallet', WALLET_TARGET, 0n, WALLET_TARGET),
      ],
    },
  }
}

const insertRestoration = (
  client: PoolClient,
  fixture: Fixture,
  evidence: Awaited<ReturnType<typeof makeEvidence>>,
  patch: Record<string, unknown> = {},
) => client.query(
  `INSERT INTO restorations
     (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by)
   VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
  [
    patch.branchId ?? fixture.branchId,
    patch.businessDate ?? DATE,
    patch.cashCountId ?? evidence.countId,
    JSON.stringify(patch.plan ?? evidence.plan),
    patch.netToCompany ?? 100n,
    patch.reason ?? evidence.reason,
    patch.performedBy ?? fixture.managerId,
  ],
)

const waitForLock = async (pool: Pool, pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [pid],
    )
    if (result.rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`backend ${pid} did not block on the restoration lock`)
}

if (!DATABASE_URL) {
  describe('PostgreSQL restoration/target guards', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL restoration/target guards', () => {
    it('fails closed, follows live grants, binds sealed evidence/journals, and freezes history', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const own = await createFixture(client, 'OWN')
        const other = await createFixture(client, 'OTHER')

        // Revoking a formerly hard-coded role must deny immediately.
        await client.query(
          `DELETE FROM role_permissions
            WHERE role_key = 'branch_manager' AND permission_key = 'journal.manual.write'`,
        )
        await client.query('SAVEPOINT revoked_manager')
        await setActor(client, own.managerId)
        await expect(
          client.query(
            `INSERT INTO office_capital_targets
               (branch_id, fund_code, target_minor, effective_from, created_by, note)
             VALUES ($1, 'office_cash', 1, $2, $3, 'revoked manager')`,
            [own.branchId, DATE, own.managerId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'office_capital_targets_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT revoked_manager')

        // Conversely, a custom branch grant must work even for a role that used to be denied.
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('accountant', 'journal.manual.write', 'branch')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await setActor(client, own.accountantId)
        await client.query(
          `INSERT INTO office_capital_targets
             (branch_id, fund_code, target_minor, effective_from, created_by, note)
           VALUES ($1, 'office_cash', 1, DATE '2026-08-22', $2, 'custom grant works')`,
          [own.branchId, own.accountantId],
        )
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope)
           VALUES ('branch_manager', 'journal.manual.write', 'branch')
           ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
        )
        await client.query(
          `DELETE FROM role_permissions
            WHERE role_key = 'accountant' AND permission_key = 'journal.manual.write'`,
        )

        await client.query('SAVEPOINT target_missing_actor')
        await setActor(client, null)
        await expect(
          client.query(
            `INSERT INTO office_capital_targets
               (branch_id, fund_code, target_minor, effective_from, created_by, note)
             VALUES ($1, 'office_wallet', 1, DATE '2026-08-22', $2, 'no actor')`,
            [own.branchId, own.managerId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'office_capital_targets_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT target_missing_actor')

        await client.query('SAVEPOINT target_cross_branch')
        await setActor(client, other.managerId)
        await expect(
          client.query(
            `INSERT INTO office_capital_targets
               (branch_id, fund_code, target_minor, effective_from, created_by, note)
             VALUES ($1, 'office_wallet', 1, DATE '2026-08-22', $2, 'wrong branch')`,
            [own.branchId, other.managerId],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'office_capital_targets_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT target_cross_branch')

        await client.query('SAVEPOINT target_invisible_note')
        await setActor(client, own.managerId)
        await expect(
          client.query(
            `INSERT INTO office_capital_targets
               (branch_id, fund_code, target_minor, effective_from, created_by, note)
             VALUES ($1, 'office_wallet', 1, DATE '2026-08-22', $2, $3)`,
            [own.branchId, own.managerId, '\u200B'],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'office_capital_targets_actor_guard' })
        await client.query('ROLLBACK TO SAVEPOINT target_invisible_note')

        await putTargets(client, own)
        await putTargets(client, other)
        const evidence = await makeEvidence(client, pool, own)

        for (const [savepoint, actorId, patch] of [
          ['restoration_no_actor', null, {}],
          ['restoration_wrong_role', own.accountantId, { performedBy: own.accountantId }],
          ['restoration_wrong_branch', other.managerId, { performedBy: other.managerId }],
        ] as const) {
          await client.query(`SAVEPOINT ${savepoint}`)
          await setActor(client, actorId)
          await expect(insertRestoration(client, own, evidence, patch)).rejects.toMatchObject({
            code: '23514',
            constraint: 'restorations_actor_guard',
          })
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }

        await setActor(client, own.managerId)
        const crossCount = await client.query<{ id: bigint }>(
          `INSERT INTO cash_counts
             (branch_id, business_date, counted_by, proof_sha256, sealed_at)
           VALUES ($1, $2, $3, $4, now()) RETURNING id`,
          [other.branchId, DATE, other.managerId, 'e'.repeat(64)],
        )
        await client.query('SAVEPOINT cross_count')
        await expect(
          insertRestoration(client, own, evidence, { cashCountId: crossCount.rows[0]!.id }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'restorations_cash_count_guard' })
        await client.query('ROLLBACK TO SAVEPOINT cross_count')
        await client.query('DELETE FROM cash_counts WHERE id = $1', [crossCount.rows[0]!.id])

        const wrongDateCount = await client.query<{ id: bigint }>(
          `INSERT INTO cash_counts
             (branch_id, business_date, counted_by, proof_sha256, sealed_at)
           VALUES ($1, DATE '2026-08-24', $2, $3, now()) RETURNING id`,
          [own.branchId, own.managerId, 'f'.repeat(64)],
        )
        await client.query('SAVEPOINT wrong_date_count')
        await expect(
          insertRestoration(client, own, evidence, { cashCountId: wrongDateCount.rows[0]!.id }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'restorations_cash_count_guard' })
        await client.query('ROLLBACK TO SAVEPOINT wrong_date_count')

        const unsealedCount = await client.query<{ id: bigint }>(
          `INSERT INTO cash_counts (branch_id, business_date, counted_by)
           VALUES ($1, DATE '2026-08-25', $2) RETURNING id`,
          [own.branchId, own.managerId],
        )
        await client.query('SAVEPOINT unsealed_count')
        await expect(
          insertRestoration(client, own, evidence, {
            cashCountId: unsealedCount.rows[0]!.id,
            businessDate: '2026-08-25',
          }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'restorations_cash_count_sealed_guard' })
        await client.query('ROLLBACK TO SAVEPOINT unsealed_count')

        await client.query('SAVEPOINT journal_plan_mismatch')
        await expect(
          insertRestoration(client, own, evidence, {
            plan: { ...evidence.plan, restorationJournalEntryIds: [] },
          }),
        ).rejects.toMatchObject({ code: '23514', constraint: 'restorations_journal_guard' })
        await client.query('ROLLBACK TO SAVEPOINT journal_plan_mismatch')

        await client.query('SAVEPOINT duplicate_daily_key')
        await expect(
          client.query(
            `INSERT INTO journal_entries
               (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                week_start_date, fx_day_id, reason, created_by)
             SELECT branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                    week_start_date, fx_day_id, reason, created_by
               FROM journal_entries WHERE id = $1`,
            [evidence.journalId],
          ),
        ).rejects.toMatchObject({ code: '23505' })
        await client.query('ROLLBACK TO SAVEPOINT duplicate_daily_key')

        await insertRestoration(client, own, evidence)

        await client.query('SAVEPOINT append_restoration_lines')
        await client.query(
          `INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role)
           SELECT $1, f.id, v.side, 1, 'forged_append'
             FROM (VALUES ('office_cash', 'D'::char(1)), ('company_box', 'C'::char(1))) v(code, side)
             JOIN funds f ON f.branch_id = $2 AND f.code = v.code`,
          [evidence.journalId, own.branchId],
        )
        await expect(
          client.query('SET CONSTRAINTS restoration_journal_line_fact_from_line IMMEDIATE'),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'restoration_journal_lines_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT append_restoration_lines')

        for (const [savepoint, query, params] of [
          [
            'freeze_count_header',
            'UPDATE cash_counts SET notes = \'rewritten\' WHERE id = $1',
            [evidence.countId],
          ],
          [
            'freeze_count_line_insert',
            `INSERT INTO cash_count_lines
               (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor)
             SELECT $1, id, 0, 0, 0 FROM funds
              WHERE branch_id = $2 AND code = 'company_box'`,
            [evidence.countId, own.branchId],
          ],
          [
            'freeze_target_note',
            `UPDATE office_capital_targets SET note = 'rewritten only'
              WHERE branch_id = $1 AND fund_code = 'office_cash' AND effective_from = $2`,
            [own.branchId, DATE],
          ],
        ] as const) {
          await client.query(`SAVEPOINT ${savepoint}`)
          await expect(client.query(query, [...params])).rejects.toMatchObject({ code: '55000' })
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        }

        const spareCount = await client.query<{ id: bigint }>(
          `INSERT INTO cash_counts
             (branch_id, business_date, counted_by, proof_sha256, sealed_at)
           VALUES ($1, DATE '2026-08-26', $2, $3, now()) RETURNING id`,
          [own.branchId, own.managerId, 'a'.repeat(64)],
        )
        await client.query('SAVEPOINT move_referenced_line')
        await expect(
          client.query(
            `UPDATE cash_count_lines SET cash_count_id = $2
              WHERE cash_count_id = $1 AND fund_id = (
                SELECT id FROM funds WHERE branch_id = $3 AND code = 'office_cash'
              )`,
            [evidence.countId, spareCount.rows[0]!.id, own.branchId],
          ),
        ).rejects.toMatchObject({ code: '55000', constraint: 'restorations_cash_count_immutable_guard' })
        await client.query('ROLLBACK TO SAVEPOINT move_referenced_line')

        await client.query('SAVEPOINT app_user_delete_target')
        await client.query('SET LOCAL ROLE app_user')
        await expect(
          client.query(
            `DELETE FROM office_capital_targets
              WHERE branch_id = $1 AND fund_code = 'office_cash' AND effective_from = $2`,
            [own.branchId, DATE],
          ),
        ).rejects.toMatchObject({ code: '42501' })
        await client.query('ROLLBACK TO SAVEPOINT app_user_delete_target')

        // Otherwise-canonical evidence against a stale live office balance must fail the final
        // accounting postcondition, not bless the frozen computed value.
        await client.query('SAVEPOINT stale_live_balance')
        const stale = await makeEvidence(client, pool, other, { opening: false, proof: 'b'.repeat(64) })
        await expect(insertRestoration(client, other, stale)).rejects.toMatchObject({
          code: '23514',
          constraint: 'restorations_postcondition_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT stale_live_balance')

        // Debt can make paper position exceed target while the physical drawer is empty. Even an
        // exact journal recipe and a passing final balance equation must not sweep absent cash.
        await client.query('SAVEPOINT debt_only_sweep')
        const debtOnly = await makeDebtOnlyEvidence(client, pool, other)
        await expect(insertRestoration(client, other, debtOnly)).rejects.toMatchObject({
          code: '23514',
          constraint: 'restorations_plan_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT debt_only_sweep')

        // Physical cash cannot be negative. A signed office wallet remains valid, so constrain
        // only the canonical office_cash line at the database trust boundary.
        await client.query('SAVEPOINT negative_physical_cash')
        const negativeCash = await makeEvidence(client, pool, other, {
          opening: false,
          proof: '8'.repeat(64),
        })
        await client.query(
          `UPDATE cash_count_lines
              SET counted_minor = -1, computed_minor = -1, variance_minor = 0
            WHERE cash_count_id = $1 AND fund_id = (
              SELECT id FROM funds WHERE branch_id = $2 AND code = 'office_cash'
            )`,
          [negativeCash.countId, other.branchId],
        )
        await client.query(
          `UPDATE cash_count_lines
              SET counted_minor = -1, computed_minor = -1, variance_minor = 0
            WHERE cash_count_id = $1 AND fund_id = (
              SELECT id FROM funds WHERE branch_id = $2 AND code = 'office_wallet'
            )`,
          [negativeCash.countId, other.branchId],
        )
        await expect(insertRestoration(client, other, negativeCash)).rejects.toMatchObject({
          code: '23514',
          constraint: 'restorations_cash_count_lines_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT negative_physical_cash')

        await client.query('ROLLBACK')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('serializes target publication and cash-count mutations behind restoration publication', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)

      const setup = await pool.connect()
      const targetWaiter = await pool.connect()
      try {
        await setup.query('BEGIN')
        const fixture = await createFixture(setup, 'RACE-TARGET')
        await putTargets(setup, fixture)
        const prepared = await makeEvidence(setup, pool, fixture, { journal: false })
        await setup.query('COMMIT')

        await setup.query('BEGIN')
        await setActor(setup, fixture.managerId)
        const evidence = await attachRestorationJournal(setup, pool, fixture, prepared)
        await insertRestoration(setup, fixture, evidence)

        await targetWaiter.query('BEGIN')
        await targetWaiter.query("SET LOCAL statement_timeout = '5s'")
        await setActor(targetWaiter, fixture.managerId)
        const targetPid = await targetWaiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const targetUpdate = targetWaiter.query(
          `UPDATE office_capital_targets SET note = 'concurrent rewrite'
            WHERE branch_id = $1 AND fund_code = 'office_cash' AND effective_from = $2`,
          [fixture.branchId, DATE],
        )
        await waitForLock(pool, targetPid.rows[0]!.pid)
        await setup.query('COMMIT')
        await expect(targetUpdate).rejects.toMatchObject({
          code: '55000',
          constraint: 'office_capital_targets_history_guard',
        })
        await targetWaiter.query('ROLLBACK')
      } finally {
        await setup.query('ROLLBACK').catch(() => undefined)
        await targetWaiter.query('ROLLBACK').catch(() => undefined)
        setup.release()
        targetWaiter.release()
      }

      const publisher = await pool.connect()
      const lineWaiter = await pool.connect()
      try {
        await publisher.query('BEGIN')
        const fixture = await createFixture(publisher, 'RACE-COUNT')
        await putTargets(publisher, fixture)
        const prepared = await makeEvidence(publisher, pool, fixture, { journal: false })
        await publisher.query('COMMIT')

        await publisher.query('BEGIN')
        await setActor(publisher, fixture.managerId)
        const evidence = await attachRestorationJournal(publisher, pool, fixture, prepared)
        await insertRestoration(publisher, fixture, evidence)

        await lineWaiter.query('BEGIN')
        await lineWaiter.query("SET LOCAL statement_timeout = '5s'")
        await setActor(lineWaiter, fixture.managerId)
        const linePid = await lineWaiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const lineUpdate = lineWaiter.query(
          `UPDATE cash_count_lines SET counted_minor = counted_minor + 1
            WHERE cash_count_id = $1 AND fund_id = (
              SELECT id FROM funds WHERE branch_id = $2 AND code = 'office_cash'
            )`,
          [evidence.countId, fixture.branchId],
        )
        await waitForLock(pool, linePid.rows[0]!.pid)
        await publisher.query('COMMIT')
        await expect(lineUpdate).rejects.toMatchObject({
          code: '55000',
          constraint: 'restorations_cash_count_immutable_guard',
        })
        await lineWaiter.query('ROLLBACK')
      } finally {
        await publisher.query('ROLLBACK').catch(() => undefined)
        await lineWaiter.query('ROLLBACK').catch(() => undefined)
        publisher.release()
        lineWaiter.release()
      }
    })
  })
}
