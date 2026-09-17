import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  COMPANY_FUND_ALLOWED_EVENTS,
  COMPANY_FUND_KINDS,
  COMPANY_LEDGER_EVENTS,
  type FundRef,
  type Posting,
  advance,
  currencyOf,
  formatMinor,
  fundCode,
  minor,
  sweepToCompany,
} from '@ash/domain'
import { createPool, bindPoolToTransaction, type PoolClient } from '../src/pool.ts'
import { PgShiftSettlementRepo } from '../src/repos-settlement.ts'
import { PgLedgerRepo, fundTypeOf } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

/**
 * «صندوق الشركة» as its own ledger — migrations 0065 + 0066 against a real PostgreSQL (C1).
 *
 * The memory adapter has no triggers, so this file is the proof. It builds a database at 0064,
 * fills it with the three kinds of history production actually holds — a fixed-40 shift approval,
 * a sealed-count restoration and an advance, each through its own live guards — applies 0065 and
 * 0066, and then tries every forbidden shape directly in SQL.
 */

const DATABASE_URL = process.env.DATABASE_URL
const migrationsDir = new URL('../migrations/', import.meta.url)
const HQ = '10000000-0000-4000-8000-000000000100'
const DATE = '2026-08-23' // a Sunday: its own week start
const RATE = 13_050n

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`
const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
const sqlOf = (file: string): string => readFileSync(new URL(file, migrationsDir), 'utf8')

type Line = readonly [FundRef, 'D' | 'C', bigint]

interface Fixture {
  branchId: string
  managerId: string
  gmId: string
  driverId: string
  vehicleId: string
  shiftId: string
  advanceId: string
  categoryId: string
  fxDayId: number
}

const applyInTransaction = async (client: PoolClient, sql: string): Promise<void> => {
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

const setActor = (client: PoolClient, actorId: string) =>
  client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId])

/**
 * Posting as the API did BEFORE 0066: no rate column, funds created with their default currency
 * and the same type/owner rules `ensureFund` has always used.
 */
const legacyFund = async (client: PoolClient, branchId: string, fund: FundRef): Promise<string> => {
  const code = fundCode(fund)
  const ownerId = 'driverId' in fund ? fund.driverId : null
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
     VALUES ($1, $2::fund_type, $3, $4, $5, $5)
     ON CONFLICT (branch_id, code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [branchId, fundTypeOf(fund), ownerId === null ? 'none' : 'driver', ownerId, code],
  )
  return rows[0]!.id
}

const postLegacy = async (
  client: PoolClient,
  fixture: Fixture,
  postings: readonly Posting[],
  meta: { shiftId: string | null; reason: string | null },
): Promise<number[]> => {
  const ids: number[] = []
  for (const posting of postings) {
    const { rows } = await client.query<{ id: bigint }>(
      `INSERT INTO journal_entries
         (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
          week_start_date, fx_day_id, reason, created_by)
       VALUES ($1, $2::ledger_event, $3, $4, $5::date, $5::date, $5::date, $6, $7, $8)
       RETURNING id`,
      [fixture.branchId, posting.eventType, meta.shiftId, posting.occurrenceKey, DATE, fixture.fxDayId, meta.reason, fixture.managerId],
    )
    const entryId = Number(rows[0]!.id)
    for (const line of posting.lines) {
      await client.query(
        'INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role) VALUES ($1, $2, $3, $4, $5)',
        [entryId, await legacyFund(client, fixture.branchId, line.fund), line.side, line.amount, line.role ?? null],
      )
    }
    ids.push(entryId)
  }
  return ids
}

/** Build 0064 history the way production holds it, through every guard that was live then. */
const seedLegacyHistory = async (client: PoolClient): Promise<Fixture> => {
  const fixture: Fixture = {
    branchId: randomUUID(),
    managerId: randomUUID(),
    gmId: randomUUID(),
    driverId: randomUUID(),
    vehicleId: randomUUID(),
    shiftId: randomUUID(),
    advanceId: randomUUID(),
    categoryId: randomUUID(),
    fxDayId: 0,
  }
  await client.query('BEGIN')
  await client.query(
    `INSERT INTO roles (key, name_ar, name_en) VALUES
       ('branch_manager', 'مدير فرع', 'Branch manager'),
       ('general_manager', 'مدير عام', 'General manager')
     ON CONFLICT (key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO permissions (key, name_ar, name_en) VALUES
       ('journal.manual.write', 'قيد يدوي', 'Manual journal'),
       ('expense.write', 'صرفية', 'Expense')
     ON CONFLICT (key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES
       ('branch_manager', 'journal.manual.write', 'branch'),
       ('branch_manager', 'expense.write', 'branch')`,
  )
  // DAM deliberately in governorate no. 2, so the HQ row can be seen to follow DAM rather than no. 1.
  await client.query(
    `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
     SELECT $1, 'DAM', 'دمشق', 'Damascus', g.id, 1 FROM governorates g WHERE g.no = 2`,
    [fixture.branchId],
  )
  await client.query(
    `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash) VALUES
       ($1, $2, 'branch_manager', 'c1-manager', 'مدير', 'x'),
       ($3, NULL, 'general_manager', 'c1-gm', 'مدير عام', 'x')`,
    [fixture.managerId, fixture.branchId, fixture.gmId],
  )
  await client.query(
    `INSERT INTO drivers (id, branch_id, code, full_name_ar) VALUES ($1, $2, 'C1-DRV', 'سائق')`,
    [fixture.driverId, fixture.branchId],
  )
  await client.query(
    `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
     SELECT $1, $2, t.id, 'C1-VEH', 1 FROM vehicle_types t WHERE t.code = 'e_motorbike'`,
    [fixture.vehicleId, fixture.branchId],
  )
  await client.query(
    `INSERT INTO shifts
       (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
        state, submitted_at, kept_as_receivable_minor)
     VALUES ($1, $2, $3, $4, 1, $5::date, $5::date,
             'pending_review', TIMESTAMPTZ '2026-08-23 11:00:00+00', 600)`,
    [fixture.shiftId, fixture.branchId, fixture.driverId, fixture.vehicleId, DATE],
  )
  await client.query(`INSERT INTO expense_categories (id, code, name_ar) VALUES ($1, 'c1-advance', 'سلفة')`, [
    fixture.categoryId,
  ])
  const fx = await client.query<{ id: bigint }>(
    `INSERT INTO fx_days (business_date, syp_minor_per_usd) VALUES ($1::date, 13000) RETURNING id`,
    [DATE],
  )
  fixture.fxDayId = Number(fx.rows[0]!.id)
  await setActor(client, fixture.managerId)
  await client.query('SELECT set_config($1, $2, true)', ['app.request_id', 'c1-legacy-seed'])

  // ── The opening balances and capital targets الترميم judges against ─────────────────────
  const cashTarget = 5_000_000n
  const walletTarget = 1_000_000n
  const cashCounted = cashTarget + 100n
  await client.query(
    `INSERT INTO office_capital_targets (branch_id, fund_code, target_minor, effective_from, created_by, note)
     VALUES ($1, 'office_cash', $2, $4::date, $5, 'c1 cash target'),
            ($1, 'office_wallet', $3, $4::date, $5, 'c1 wallet target')`,
    [fixture.branchId, cashTarget, walletTarget, DATE, fixture.managerId],
  )
  await postLegacy(
    client,
    fixture,
    [
      {
        eventType: 'manual',
        occurrenceKey: 'c1-opening',
        lines: [
          { fund: { kind: 'office_cash' }, side: 'D', amount: minor(cashCounted) },
          { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(walletTarget) },
          { fund: { kind: 'company_box' }, side: 'C', amount: minor(cashCounted + walletTarget) },
        ],
      },
    ],
    { shiftId: null, reason: 'c1 opening balances' },
  )

  // ── A restoration: sealed count, a «كييش» sweep, and its immutable fact ──────────────────
  const proof = 'c'.repeat(64)
  const count = await client.query<{ id: bigint }>(
    `INSERT INTO cash_counts (branch_id, business_date, counted_by, counted_at, proof_sha256, sealed_at, notes)
     VALUES ($1, $2::date, $3, TIMESTAMPTZ '2026-08-23 09:00:00+00', $4, TIMESTAMPTZ '2026-08-23 09:00:00+00', 'c1')
     RETURNING id`,
    [fixture.branchId, DATE, fixture.managerId, proof],
  )
  await client.query(
    `INSERT INTO cash_count_lines (cash_count_id, fund_id, counted_minor, computed_minor, variance_minor, resolution)
     SELECT $2, f.id,
            CASE f.code WHEN 'office_cash' THEN $3::bigint ELSE $4::bigint END,
            CASE f.code WHEN 'office_cash' THEN $3::bigint ELSE $4::bigint END,
            0, NULL
       FROM funds f
      WHERE f.branch_id = $1 AND f.code IN ('office_cash', 'office_wallet')`,
    [fixture.branchId, count.rows[0]!.id, cashCounted, walletTarget],
  )
  const reason = 'c1 restoration'
  const [sweepId] = await postLegacy(client, fixture, [sweepToCompany('office_cash', minor(100n), `${DATE}:office_cash`)], {
    shiftId: null,
    reason,
  })
  const leg = (fundCodeName: 'office_cash' | 'office_wallet', counted: bigint, target: bigint) => {
    const delta = counted - target
    return {
      fundCode: fundCodeName,
      counted: formatMinor(minor(counted)),
      receivables: '0.00',
      position: formatMinor(minor(counted)),
      capitalTarget: formatMinor(minor(target)),
      delta: formatMinor(minor(delta)),
      direction: delta === 0n ? null : 'to_company',
      amount: formatMinor(minor(delta < 0n ? -delta : delta)),
      feasible: true,
      refusals: [],
    }
  }
  await client.query(
    `INSERT INTO restorations (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by)
     VALUES ($1, $2::date, $3, $4::jsonb, 100, $5, $6)`,
    [
      fixture.branchId,
      DATE,
      count.rows[0]!.id,
      JSON.stringify({
        schemaVersion: 2,
        cashCountProofSha256: proof,
        cashCountSealedAt: '2026-08-23T09:00:00.000Z',
        countReconciliation: [
          { fundCode: 'office_cash', variance: '0.00', resolution: null },
          { fundCode: 'office_wallet', variance: '0.00', resolution: null },
        ],
        reconciliationJournalEntryIds: [],
        restorationJournalEntryIds: [sweepId],
        legs: [leg('office_cash', cashCounted, cashTarget), leg('office_wallet', walletTarget, walletTarget)],
      }),
      reason,
      fixture.managerId,
    ],
  )

  // ── A fixed-40 shift approval: both return journals, the signed settlement, the state ──────
  const driverId = fixture.driverId
  await postLegacy(
    client,
    fixture,
    [
      {
        eventType: 'wallet_return',
        occurrenceKey: '1',
        lines: [
          { fund: { kind: 'driver_wallet', driverId }, side: 'C', amount: minor(2_000n), role: 'wallet_cleared' },
          { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(1_500n), role: 'wallet_settlement' },
          { fund: { kind: 'driver_shift_funding_wallet', driverId }, side: 'D', amount: minor(500n), role: 'wallet_settlement_deferred' },
        ],
      },
      {
        eventType: 'float_return',
        occurrenceKey: '1',
        lines: [
          { fund: { kind: 'driver_cash', driverId }, side: 'C', amount: minor(8_000n), role: 'cash_cleared' },
          { fund: { kind: 'driver_share_payable', driverId }, side: 'D', amount: minor(400n), role: 'driver_share_settled' },
          { fund: { kind: 'driver_shift_funding_cash', driverId }, side: 'D', amount: minor(600n), role: 'cash_settlement_deferred' },
          { fund: { kind: 'office_cash' }, side: 'D', amount: minor(7_000n), role: 'cash_settlement' },
        ],
      },
    ],
    { shiftId: fixture.shiftId, reason: null },
  )
  const bound = bindPoolToTransaction(pool!, client, { actorId: fixture.managerId, requestId: 'c1-legacy-seed' })
  await new PgShiftSettlementRepo(bound).create({
    shiftId: fixture.shiftId,
    branchId: fixture.branchId,
    driverId,
    businessDate: DATE,
    policyCode: 'fixed_40_cash_close_v2_receivable',
    driverRateBps: 4_000,
    deliveryFeeTotal: minor(1_000n),
    fixedDriverShare: minor(400n),
    manualDriverShare: minor(0n),
    grossDriverShare: minor(400n),
    cashDeductionTotal: minor(0n),
    baseDriverShare: minor(400n),
    managerCharge: minor(0n),
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
    maximumCashShortageReceivable: minor(0n),
    cashShortageReceivable: minor(0n),
    cashToOffice: minor(7_000n),
    walletToOffice: minor(1_500n),
    cashAction: 'collect',
    cashAmount: minor(7_000n),
    walletAction: 'collect',
    walletAmount: minor(1_500n),
    reviewedOrdersHash: 'c1-legacy-orders',
    settlementHash: 'd'.repeat(64),
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    confirmedBy: fixture.managerId,
    confirmedAtMs: Date.UTC(2026, 7, 23, 11, 1),
    varianceReason: null,
  })
  await client.query(
    `UPDATE shifts SET state = 'approved', kept_as_receivable_minor = 600, wallet_diff_minor = 0, approved_by = $2
      WHERE id = $1`,
    [fixture.shiftId, fixture.managerId],
  )

  // ── An advance: the command row and its two-line journal ──────────────────────────────────
  const description = 'c1 advance to the workshop'
  const [advanceEntry] = await postLegacy(client, fixture, [advance('office_cash', fixture.advanceId, minor(2_500n), fixture.advanceId)], {
    shiftId: null,
    reason: description,
  })
  await client.query(
    `INSERT INTO advances
       (id, branch_id, party_name, party_key, category_id, cost_center_kind, vehicle_id, channel,
        amount_minor, business_date, description, journal_entry_id, created_by)
     VALUES ($1, $2, 'ورشة', 'ورشة', $3, 'general', NULL, 'office_cash', 2500, $4::date, $5, $6, $7)`,
    [fixture.advanceId, fixture.branchId, fixture.categoryId, DATE, description, advanceEntry, fixture.managerId],
  )

  await client.query('COMMIT')
  return fixture
}

/** Per entry, per currency, D − C. Empty means every entry balances. */
const unbalancedEntries = async (client: PoolClient) =>
  (
    await client.query<{ entry_id: string }>(
      `SELECT jl.entry_id::text
         FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
        GROUP BY jl.entry_id, f.currency
       HAVING SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END) <> 0`,
    )
  ).rows

let pool: ReturnType<typeof createPool> | null = null

if (!DATABASE_URL) {
  describe('PostgreSQL company ledger foundation (0065/0066)', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const admin = createPool(DATABASE_URL)

  afterAll(async () => {
    await admin.end()
  })

  describe('PostgreSQL company ledger foundation (0065/0066)', () => {
    it(
      'keeps legacy history, and refuses every way company money could leak across ledgers',
      async () => {
        await assertDisposableDatabaseConnection(admin, disposable)
        const databaseName = `ash_guardcheck_c1_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
        const url = new URL(DATABASE_URL)
        url.pathname = `/${databaseName}`
        const isolatedUrl = url.toString()
        const isolated = assertDisposableDatabaseUrl(isolatedUrl)
        let created = false
        try {
          await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
          created = true
          pool = createPool(isolatedUrl, 2)
          await assertDisposableDatabaseConnection(pool, isolated)
          const client = await pool.connect()
          try {
            // ── 0001 … 0064, then real history ───────────────────────────────────────────
            const through0064 = migrationFiles.filter((file) => file <= '0064_company_fund_permission.sql')
            expect(through0064.at(-1)).toBe('0064_company_fund_permission.sql')
            for (const file of through0064) await applyInTransaction(client, sqlOf(file))
            const fixture = await seedLegacyHistory(client)

            const legacy = await client.query<{ id: string; event_type: string; lines: number }>(
              `SELECT je.id::text, je.event_type::text, count(jl.id)::int AS lines
                 FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
                GROUP BY je.id ORDER BY je.id`,
            )
            expect(legacy.rows.map((r) => r.event_type)).toEqual([
              'manual',
              'restoration',
              'wallet_return',
              'float_return',
              'advance',
            ])
            expect(await unbalancedEntries(client)).toEqual([])

            // ── 0065 ───────────────────────────────────────────────────────────────────────
            await applyInTransaction(client, sqlOf('0065_company_ledger_enum_values.sql'))

            // ── The proof aborts 0066 on history that no longer balances ─────────────────
            const foundation = sqlOf('0066_company_ledger_foundation.sql')
            await client.query('BEGIN')
            await client.query('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_balanced')
            await client.query(
              `WITH entry AS (
                 INSERT INTO journal_entries
                   (branch_id, event_type, occurrence_key, business_date, posting_date, week_start_date,
                    fx_day_id, reason, created_by)
                 VALUES ($1, 'manual', 'c1-forged-history', $2::date, $2::date, $2::date, $3, 'forged', $4)
                 RETURNING id
               )
               INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor)
               SELECT entry.id, f.id, 'D', 1 FROM entry JOIN funds f ON f.branch_id = $1 AND f.code = 'office_cash'`,
              [fixture.branchId, DATE, fixture.fxDayId, fixture.managerId],
            )
            // Fire the forged entry's other deferred checks now: ALTER TABLE refuses a table with
            // pending trigger events, and the migrator never runs with any.
            await client.query('SET CONSTRAINTS ALL IMMEDIATE')
            await client.query('ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_balanced')
            await expect(client.query(foundation)).rejects.toThrow(/0066 proof failed — entries unbalanced per currency: entry \d+ SYP_NEW: 1/)
            await client.query('ROLLBACK')
            expect(await unbalancedEntries(client)).toEqual([])

            // ── 0066, for real ────────────────────────────────────────────────────────────
            await applyInTransaction(client, foundation)

            // History is untouched and still balances under the per-currency rule.
            const after = await client.query<{ id: string; event_type: string; lines: number }>(
              `SELECT je.id::text, je.event_type::text, count(jl.id)::int AS lines
                 FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
                GROUP BY je.id ORDER BY je.id`,
            )
            expect(after.rows).toEqual(legacy.rows)
            expect(await unbalancedEntries(client)).toEqual([])
            expect(
              (await client.query(`SELECT DISTINCT currency FROM funds`)).rows,
            ).toEqual([{ currency: 'SYP_NEW' }])
            expect(
              (await client.query(`SELECT count(*)::int AS n FROM journal_entries WHERE syp_minor_per_usd IS NOT NULL`)).rows,
            ).toEqual([{ n: 0 }])

            // The HQ row: once, number 0, in DAM's governorate (no. 2 here — not no. 1).
            const hq = await client.query(
              `SELECT b.id, b.code, b.name_ar, b.name_en, b.branch_no, b.kind,
                      b.governorate_id = dam.governorate_id AS follows_dam
                 FROM branches b CROSS JOIN branches dam
                WHERE b.kind = 'company' AND dam.code = 'DAM'`,
            )
            expect(hq.rows).toEqual([
              {
                id: HQ,
                code: 'HQ',
                name_ar: 'صندوق الشركة',
                name_en: 'Company',
                branch_no: 0,
                kind: 'company',
                follows_dam: true,
              },
            ])
            expect((await client.query(`SELECT kind FROM branches WHERE code = 'DAM'`)).rows).toEqual([{ kind: 'branch' }])

            // ── The vocabulary matches the domain, pair by pair ───────────────────────────
            const fundTypes = (await client.query<{ v: string }>(`SELECT unnest(enum_range(NULL::fund_type))::text AS v`)).rows.map((r) => r.v)
            const events = (await client.query<{ v: string }>(`SELECT unnest(enum_range(NULL::ledger_event))::text AS v`)).rows.map((r) => r.v)
            for (const kind of COMPANY_FUND_KINDS) expect(fundTypes).toContain(kind)
            for (const event of COMPANY_LEDGER_EVENTS) expect(events).toContain(event)
            const vocabulary = await client.query<{ t: string; e: string; company_type: boolean; company_event: boolean; allowed: boolean }>(
              `SELECT t, e, ash_is_company_fund_type(t) AS company_type, ash_is_company_event(e) AS company_event,
                      ash_company_fund_event_allowed(t, e) AS allowed
                 FROM unnest($1::text[]) t CROSS JOIN unnest($2::text[]) e`,
              [fundTypes, events],
            )
            for (const row of vocabulary.rows) {
              const domainType = (COMPANY_FUND_KINDS as readonly string[]).includes(row.t)
              expect(row.company_type, row.t).toBe(domainType)
              expect(row.company_event, row.e).toBe((COMPANY_LEDGER_EVENTS as readonly string[]).includes(row.e))
              const domainAllowed = domainType
                ? (COMPANY_FUND_ALLOWED_EVENTS[row.t as (typeof COMPANY_FUND_KINDS)[number]] as readonly string[]).includes(row.e)
                : false
              expect(row.allowed, `${row.t} × ${row.e}`).toBe(domainAllowed)
            }

            // ── Helpers for the forbidden shapes ─────────────────────────────────────────
            const ensureFund = async (branchId: string, fund: FundRef): Promise<string> => {
              const { rows } = await client.query<{ id: string }>(
                `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar, currency)
                 VALUES ($1, $2::fund_type, 'none', NULL, $3, $3, $4)
                 ON CONFLICT (branch_id, code) DO UPDATE SET code = EXCLUDED.code
                 RETURNING id`,
                [branchId, fundTypeOf(fund), fundCode(fund), currencyOf(fund)],
              )
              return rows[0]!.id
            }
            const entry = async (
              branchId: string,
              event: string,
              rate: bigint | null,
              lines: readonly Line[],
              key: string = randomUUID(),
            ): Promise<void> => {
              const { rows } = await client.query<{ id: bigint }>(
                `INSERT INTO journal_entries
                   (branch_id, event_type, occurrence_key, business_date, posting_date, week_start_date,
                    fx_day_id, reason, created_by, syp_minor_per_usd)
                 VALUES ($1, $2::ledger_event, $3, $4::date, $4::date, $4::date, $5, 'c1 guard probe', $6, $7)
                 RETURNING id`,
                [branchId, event, key, DATE, fixture.fxDayId, fixture.gmId, rate],
              )
              for (const [fund, side, amount] of lines) {
                await client.query(
                  'INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor) VALUES ($1, $2, $3, $4)',
                  [rows[0]!.id, await ensureFund(branchId, fund), side, amount],
                )
              }
            }
            /** Run `work` in its own transaction and COMMIT: the error it or the COMMIT raised, or null. */
            const outcome = async (work: () => Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string } | null> => {
              await client.query('BEGIN')
              await setActor(client, fixture.gmId)
              try {
                await work()
              } catch (error) {
                await client.query('ROLLBACK')
                return error as { code?: string; constraint?: string; message: string }
              }
              try {
                await client.query('COMMIT')
                return null
              } catch (error) {
                return error as { code?: string; constraint?: string; message: string }
              }
            }
            const usdCash: FundRef = { kind: 'company_cash', currency: 'USD' }
            const sypCash: FundRef = { kind: 'company_cash', currency: 'SYP_NEW' }
            const usdFx: FundRef = { kind: 'company_fx_position', currency: 'USD' }
            const sypFx: FundRef = { kind: 'company_fx_position', currency: 'SYP_NEW' }
            const usdOwner: FundRef = { kind: 'company_equity', currency: 'USD', account: 'owner_funding' }
            const sypOwner: FundRef = { kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_funding' }
            const sypDrawings: FundRef = { kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_drawings' }
            const clearing: FundRef = { kind: 'branch_clearing', branchId: fixture.branchId }
            const balance = async (code: string): Promise<bigint> =>
              (
                await client.query<{ b: bigint }>(
                  `SELECT COALESCE(SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0)::bigint AS b
                     FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
                    WHERE f.branch_id = $1 AND f.code = $2`,
                  [HQ, code],
                )
              ).rows[0]!.b

            // A deposit of dollars, so the exchange below has something to spend.
            expect(await outcome(() => entry(HQ, 'company_deposit', RATE, [[usdCash, 'D', 50_000n], [usdOwner, 'C', 50_000n]]))).toBeNull()

            // D USD 100 / C SYP 100: the plain sums agree; each currency is unbalanced.
            expect(
              await outcome(() => entry(HQ, 'company_correction', RATE, [[usdCash, 'D', 100n], [sypCash, 'C', 100n]])),
            ).toMatchObject({ code: '23514', message: expect.stringMatching(/unbalanced: SYP_NEW debits 0 <> credits 100; USD debits 100 <> credits 0/) })

            // Balanced in each currency, but not an exchange.
            const fourLines: Line[] = [
              [usdFx, 'D', 5_000n],
              [usdCash, 'C', 5_000n],
              [sypCash, 'D', 652_500n],
              [sypFx, 'C', 652_500n],
            ]
            expect(await outcome(() => entry(HQ, 'company_correction', RATE, fourLines))).toMatchObject({
              code: '23514',
              message: expect.stringMatching(/spans 2 currencies; only company_fx_exchange may span exactly two/),
            })
            // …and `manual` is not even allowed into the company ledger.
            expect(await outcome(() => entry(HQ, 'manual', RATE, fourLines))).toMatchObject({ code: '23514' })

            // The four-line exchange with its frozen rate passes.
            expect(await outcome(() => entry(HQ, 'company_fx_exchange', RATE, fourLines, 'c1-exchange'))).toBeNull()
            expect(
              (await client.query(`SELECT syp_minor_per_usd FROM journal_entries WHERE occurrence_key = 'c1-exchange'`)).rows,
            ).toEqual([{ syp_minor_per_usd: RATE }])
            expect(await balance('company_cash:USD')).toBe(45_000n)
            expect(await balance('company_cash:SYP_NEW')).toBe(652_500n)

            // A USD line needs a rate; a rate needs a USD line.
            expect(
              await outcome(() => entry(HQ, 'company_deposit', null, [[usdCash, 'D', 1n], [usdOwner, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'journal_entry_usd_rate_guard' })
            expect(
              await outcome(() => entry(HQ, 'company_deposit', RATE, [[sypCash, 'D', 1n], [sypOwner, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'journal_entry_usd_rate_guard' })
            expect(
              await outcome(() => entry(HQ, 'company_deposit', 0n, [[usdCash, 'D', 1n], [usdOwner, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'je_syp_minor_per_usd_ck' })

            // The generic routes cannot reach the company ledger: manual (/journal/manual) and
            // correction (the generic reverse).
            for (const event of ['manual', 'correction', 'expense', 'restoration']) {
              expect(
                await outcome(() => entry(HQ, event, null, [[sypCash, 'D', 1n], [sypOwner, 'C', 1n]])),
                event,
              ).toMatchObject({ code: '23514', constraint: 'journal_ledger_partition_guard' })
            }
            // …nor a company event a branch.
            const officeCash: FundRef = { kind: 'office_cash' }
            const contra: FundRef = { kind: 'cost_center', costCenterId: 'owner_funding' }
            expect(
              await outcome(() => entry(fixture.branchId, 'company_deposit', null, [[officeCash, 'D', 1n], [contra, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'journal_ledger_partition_guard' })
            // An HQ entry cannot move a branch fund, even under a company event.
            expect(
              await outcome(async () => {
                const { rows } = await client.query<{ id: bigint }>(
                  `INSERT INTO journal_entries
                     (branch_id, event_type, occurrence_key, business_date, posting_date, week_start_date, fx_day_id, reason, created_by)
                   VALUES ($1, 'company_deposit', 'c1-cross', $2::date, $2::date, $2::date, $3, 'cross', $4) RETURNING id`,
                  [HQ, DATE, fixture.fxDayId, fixture.gmId],
                )
                await client.query(
                  `INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor)
                   SELECT $1, f.id, v.side, 1 FROM (VALUES ('office_cash', 'D'::char(1)), ('company_box', 'C'::char(1))) v(code, side)
                     JOIN funds f ON f.branch_id = $2 AND f.code = v.code`,
                  [rows[0]!.id, fixture.branchId],
                )
              }),
            ).toMatchObject({ code: '23514', constraint: 'journal_ledger_partition_guard' })
            // The per-account matrix: an exchange never touches equity.
            expect(
              await outcome(() => entry(HQ, 'company_fx_exchange', null, [[sypCash, 'D', 1n], [sypOwner, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'journal_company_event_guard' })
            // …and a correction never touches the clearing account.
            expect(
              await outcome(() => entry(HQ, 'company_correction', null, [[sypCash, 'D', 1n], [clearing, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'journal_company_event_guard' })

            // Accounts live in their own ledger — refused at the fund row, immediately.
            expect(await outcome(() => ensureFund(fixture.branchId, sypCash))).toMatchObject({
              code: '23514',
              constraint: 'funds_ledger_partition_guard',
            })
            expect(await outcome(() => ensureFund(HQ, officeCash))).toMatchObject({
              code: '23514',
              constraint: 'funds_ledger_partition_guard',
            })
            expect(await outcome(() => ensureFund(HQ, { kind: 'company_box' }))).toMatchObject({
              code: '23514',
              constraint: 'funds_ledger_partition_guard',
            })
            // USD is a company-account currency only, and the clearing account is lira.
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO funds (branch_id, type, owner_kind, code, name_ar, currency)
                   VALUES ($1, 'office_wallet', 'none', 'office_wallet_usd', 'x', 'USD')`,
                  [fixture.branchId],
                ),
              ),
            ).toMatchObject({ code: '23514', constraint: 'funds_currency_scope_ck' })
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO funds (branch_id, type, owner_kind, code, name_ar, currency)
                   VALUES ($1, 'branch_clearing', 'none', 'branch_clearing:usd', 'x', 'USD')`,
                  [HQ],
                ),
              ),
            ).toMatchObject({ code: '23514', constraint: 'funds_currency_scope_ck' })
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO funds (branch_id, type, owner_kind, code, name_ar, currency)
                   VALUES ($1, 'company_cash', 'none', 'company_cash:EUR', 'x', 'EUR')`,
                  [HQ],
                ),
              ),
            ).toMatchObject({ code: '23514', constraint: 'funds_currency_ck' })
            // A fund's identity is fixed.
            for (const [column, value] of [
              ['currency', 'SYP_NEW'],
              ['code', 'company_cash:renamed'],
              ['type', 'depreciation_reserve'],
            ] as const) {
              expect(
                await outcome(() =>
                  client.query(`UPDATE funds SET ${column} = $1${column === 'type' ? '::fund_type' : ''} WHERE branch_id = $2 AND code = 'company_cash:USD'`, [value, HQ]),
                ),
                column,
              ).toMatchObject({ code: '23514', constraint: 'funds_identity_immutable' })
            }

            // ── The pockets never go negative — except through the restoration mirror ──────
            // Spend exactly what is there: fine. One minor more: refused at COMMIT.
            expect(
              await outcome(() => entry(HQ, 'company_withdrawal', null, [[sypDrawings, 'D', 652_500n], [sypCash, 'C', 652_500n]])),
            ).toBeNull()
            expect(await balance('company_cash:SYP_NEW')).toBe(0n)
            expect(
              await outcome(() => entry(HQ, 'company_withdrawal', null, [[sypDrawings, 'D', 1n], [sypCash, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'company_pocket_negative_guard' })
            expect(
              await outcome(() =>
                entry(HQ, 'depreciation_release', null, [[sypCash, 'D', 1n], [{ kind: 'depreciation_reserve', currency: 'SYP_NEW' }, 'C', 1n]]),
              ),
            ).toMatchObject({ code: '23514', constraint: 'company_pocket_negative_guard' })
            // «شحن» from an empty company pocket: allowed, the owner's own decision.
            expect(
              await outcome(() => entry(HQ, 'company_restoration_mirror', null, [[clearing, 'D', 10_000n], [sypCash, 'C', 10_000n]])),
            ).toBeNull()
            expect(await balance('company_cash:SYP_NEW')).toBe(-10_000n)
            // A deposit into a negative pocket is always welcome, even if it stays negative…
            expect(
              await outcome(() => entry(HQ, 'company_deposit', null, [[sypCash, 'D', 4_000n], [sypOwner, 'C', 4_000n]])),
            ).toBeNull()
            expect(await balance('company_cash:SYP_NEW')).toBe(-6_000n)
            // …but nothing else may take from it while it is.
            expect(
              await outcome(() => entry(HQ, 'company_expense', null, [[{ kind: 'company_expense', currency: 'SYP_NEW', centre: 'general' }, 'D', 1n], [sypCash, 'C', 1n]])),
            ).toMatchObject({ code: '23514', constraint: 'company_pocket_negative_guard' })
            // The dollar pocket is judged on its own: 45,000 cents are there to spend.
            expect(
              await outcome(() =>
                entry(HQ, 'company_withdrawal', RATE, [[{ kind: 'company_equity', currency: 'USD', account: 'owner_drawings' }, 'D', 45_000n], [usdCash, 'C', 45_000n]]),
              ),
            ).toBeNull()
            expect(await balance('company_cash:USD')).toBe(0n)

            // ── branches.kind is fixed, single, and numbered by kind ─────────────────────
            expect(
              await outcome(() => client.query(`UPDATE branches SET kind = 'company' WHERE code = 'DAM'`)),
            ).toMatchObject({ code: '23514', constraint: 'branches_kind_immutable' })
            expect(
              await outcome(() => client.query(`UPDATE branches SET kind = 'branch', branch_no = 7 WHERE id = $1`, [HQ])),
            ).toMatchObject({ code: '23514', constraint: 'branches_kind_immutable' })
            expect(
              await outcome(() => client.query(`UPDATE branches SET branch_no = 5 WHERE id = $1`, [HQ])),
            ).toMatchObject({ code: '23514', constraint: 'branches_kind_number_ck' })
            expect(
              await outcome(() => client.query(`UPDATE branches SET branch_no = 0 WHERE code = 'DAM'`)),
            ).toMatchObject({ code: '23514', constraint: 'branches_kind_number_ck' })
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no, kind)
                   SELECT $1, 'HQ2', 'x', 'x', g.id, 0, 'company' FROM governorates g WHERE g.no = 14`,
                  [randomUUID()],
                ),
              ),
            ).toMatchObject({ code: '23505', constraint: 'branches_single_company_uq' })
            // Renaming the row is still an ordinary update.
            expect(await outcome(() => client.query(`UPDATE branches SET name_en = 'Company fund' WHERE id = $1`, [HQ]))).toBeNull()

            // ── Branch-only tables refuse the company row ───────────────────────────────
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
                   VALUES ($1, $2, 'branch_manager', 'c1-hq-manager', 'x', 'x')`,
                  [randomUUID(), HQ],
                ),
              ),
            ).toMatchObject({ code: '23514', constraint: 'branch_kind_guard' })
            expect(
              await outcome(() => client.query(`UPDATE users SET branch_id = $1 WHERE id = $2`, [HQ, fixture.managerId])),
            ).toMatchObject({ code: '23514', constraint: 'branch_kind_guard' })
            expect(
              await outcome(() =>
                client.query(`INSERT INTO drivers (id, branch_id, code, full_name_ar) VALUES ($1, $2, 'C1-HQ-DRV', 'x')`, [randomUUID(), HQ]),
              ),
            ).toMatchObject({ code: '23514', constraint: 'branch_kind_guard' })
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO cash_counts (branch_id, business_date, counted_by) VALUES ($1, DATE '2026-08-30', $2)`,
                  [HQ, fixture.gmId],
                ),
              ),
            ).toMatchObject({ code: '23514', constraint: 'branch_kind_guard' })
            // An org-wide user keeps a NULL branch, and branch users keep working.
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
                   VALUES ($1, NULL, 'general_manager', 'c1-gm-2', 'x', 'x'),
                          ($2, $3, 'branch_manager', 'c1-manager-2', 'x', 'x')`,
                  [randomUUID(), randomUUID(), fixture.branchId],
                ),
              ),
            ).toBeNull()
            // A week lock is not branch-only: the company closes its week too.
            expect(
              await outcome(() =>
                client.query(
                  `INSERT INTO week_locks (branch_id, week_start_date, week_end_date) VALUES ($1, DATE '2026-08-23', DATE '2026-08-29')`,
                  [HQ],
                ),
              ),
            ).toBeNull()

            // ── Branch postings through the real repository are exactly as before ────────
            const repoOutcome = await outcome(async () => {
              const bound = bindPoolToTransaction(pool!, client, { actorId: fixture.managerId })
              await setActor(client, fixture.managerId)
              const written = await new PgLedgerRepo(bound).post(
                fixture.branchId,
                [
                  {
                    eventType: 'manual',
                    occurrenceKey: 'c1-after-migration',
                    lines: [
                      { fund: { kind: 'office_cash' }, side: 'D', amount: minor(300n) },
                      { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(200n) },
                      { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: minor(500n) },
                    ],
                  },
                ],
                {
                  shiftId: null,
                  businessDate: '2026-08-30',
                  postingDate: '2026-08-30',
                  weekStartDate: '2026-08-30',
                  fxDayId: fixture.fxDayId,
                  sypMinorPerUsd: null,
                  createdBy: fixture.managerId,
                  reason: 'after 0066',
                },
              )
              expect(written[0]!.lines.map((l) => l.currency)).toEqual(['SYP_NEW', 'SYP_NEW', 'SYP_NEW'])
            })
            expect(repoOutcome).toBeNull()
            expect(await unbalancedEntries(client)).toEqual([])
          } finally {
            await client.query('ROLLBACK').catch(() => undefined)
            client.release()
          }
        } finally {
          if (pool) await pool.end()
          pool = null
          if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
        }
      },
      180_000,
    )
  })
}
