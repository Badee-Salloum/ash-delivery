import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompanyCommandRecord, CompanyDebtRecord, FixedAssetRecord } from '@ash/contracts'
import {
  type FundRef,
  type Minor,
  type Posting,
  companyBoxMovement,
  companyDeposit,
  companyExpense,
  companyFxExchange,
  companyIncome,
  companyOpeningTransfer,
  companyReversal,
  companyWithdrawal,
  assetPurchase,
  companyDebtOpen,
  companyDebtOutstanding,
  companyDebtPayment,
  depreciationSchedule,
  depreciationTransfer,
  planDepreciationTransfer,
  exchangeRate,
  formatMinor,
  fundCode,
  manualKaish,
  minor,
  money,
  restorationMirror,
  reverse,
  sweepToCompany,
} from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { bindPoolToTransaction, createPool, type Pool, type PoolClient } from '../src/pool.ts'
import { PgCompanyLedgerRepo } from '../src/repos-company.ts'
import { PgCompanyFinanceRepo } from '../src/repos-company-finance.ts'
import { PgLedgerRepo, fundTypeOf } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

/**
 * «صندوق الشركة» commands, the restoration mirror and the cutover — migration 0067 against a real
 * PostgreSQL (finance redesign C2).
 *
 * The memory adapter has no triggers, so this file is the proof: every command row is refused with
 * a forged line, a wrong actor, a missing row, a pocket driven below zero or a wrong rate; the
 * cutover moves exactly the branch's company_box and nothing before its watermark is mirrored; and
 * after it, no company_box movement commits without its HQ half.
 */

const DATABASE_URL = process.env.DATABASE_URL
const HQ = '10000000-0000-4000-8000-000000000100'
const DATE = '2026-09-17' // a Thursday
const WEEK = '2026-09-13'
const RATE = 13_050n
const m = (n: bigint): Minor => minor(n)
const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

interface PgError {
  code?: string
  constraint?: string
  message: string
}

interface Ids {
  dam: string
  alp: string
  gm: string
  admin: string
  manager: string
  retired: string
  vehicle: string
  expenseCategory: string
  closedExpenseCategory: string
  incomeCategory: string
  closedIncomeCategory: string
  fxDayId: number
}

/** A deterministic PRNG, so the random mirror sequence is reproducible from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

if (!DATABASE_URL) {
  describe('PostgreSQL company commands, mirror and cutover (0067)', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const admin = createPool(DATABASE_URL)
  const databaseName = `ash_guardcheck_c2_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  let pool: Pool | null = null
  let client: PoolClient
  let created = false
  const ids: Ids = {
    dam: randomUUID(),
    alp: randomUUID(),
    gm: randomUUID(),
    admin: randomUUID(),
    manager: randomUUID(),
    retired: randomUUID(),
    vehicle: randomUUID(),
    expenseCategory: randomUUID(),
    closedExpenseCategory: randomUUID(),
    incomeCategory: randomUUID(),
    closedIncomeCategory: randomUUID(),
    fxDayId: 0,
  }

  beforeAll(async () => {
    await assertDisposableDatabaseConnection(admin, disposable)
    const url = new URL(DATABASE_URL)
    url.pathname = `/${databaseName}`
    const isolated = assertDisposableDatabaseUrl(url.toString())
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    created = true
    pool = createPool(url.toString(), 2)
    await assertDisposableDatabaseConnection(pool, isolated)
    await migrate(pool)
    client = await pool.connect()

    await client.query(
      `INSERT INTO roles (key, name_ar, name_en) VALUES
         ('general_manager', 'مدير عام', 'GM'), ('system_admin', 'مدير النظام', 'Admin'),
         ('branch_manager', 'مدير فرع', 'BM')
       ON CONFLICT (key) DO NOTHING`,
    )
    await client.query(
      `INSERT INTO permissions (key, name_ar, name_en) VALUES
         ('company_fund.manage', 'x', 'x'), ('settings.write', 'x', 'x'),
         ('journal.manual.write', 'x', 'x'), ('expense.write', 'x', 'x')
       ON CONFLICT (key) DO NOTHING`,
    )
    await client.query(
      `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES
         ('general_manager', 'company_fund.manage', 'all'),
         ('general_manager', 'journal.manual.write', 'all'),
         ('system_admin', 'company_fund.manage', 'all'),
         ('system_admin', 'settings.write', 'all'),
         ('system_admin', 'journal.manual.write', 'all'),
         ('branch_manager', 'journal.manual.write', 'branch'),
         ('branch_manager', 'expense.write', 'branch')
       ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
    )
    await client.query(
      `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
       SELECT v.id, v.code, v.code, v.code, g.id, v.no
         FROM (VALUES ($1::uuid, 'DAM', 1), ($2::uuid, 'ALP', 2)) v(id, code, no)
         CROSS JOIN governorates g WHERE g.no = 1`,
      [ids.dam, ids.alp],
    )
    await client.query(
      `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash, active) VALUES
         ($1, NULL, 'general_manager', 'c2-gm', 'مدير عام', 'x', true),
         ($2, NULL, 'system_admin', 'c2-admin', 'مدير النظام', 'x', true),
         ($3, $5, 'branch_manager', 'c2-manager', 'مدير فرع', 'x', true),
         ($4, NULL, 'system_admin', 'c2-retired', 'متقاعد', 'x', false)`,
      [ids.gm, ids.admin, ids.manager, ids.retired, ids.dam],
    )
    await client.query(
      `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
       SELECT $1, $2, t.id, 'C2-VEH', 1 FROM vehicle_types t WHERE t.code = 'e_motorbike'`,
      [ids.vehicle, ids.dam],
    )
    await client.query(
      `INSERT INTO expense_categories (id, code, name_ar, active) VALUES ($1, 'c2-exp', 'صرفية', true), ($2, 'c2-exp-off', 'مغلقة', false)`,
      [ids.expenseCategory, ids.closedExpenseCategory],
    )
    await client.query(
      `INSERT INTO income_categories (id, code, name_ar, active) VALUES ($1, 'c2-inc', 'مدخول', true), ($2, 'c2-inc-off', 'مغلق', false)`,
      [ids.incomeCategory, ids.closedIncomeCategory],
    )
    const fx = await client.query<{ id: bigint }>(
      `INSERT INTO fx_days (business_date, syp_minor_per_usd) VALUES ($1::date, 13000) RETURNING id`,
      [DATE],
    )
    ids.fxDayId = Number(fx.rows[0]!.id)
  }, 180_000)

  afterAll(async () => {
    client?.release()
    if (pool) await pool.end()
    if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
    await admin.end()
  }, 60_000)

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────

  const bound = (actorId: string) => bindPoolToTransaction(pool!, client, { actorId, requestId: 'c2-guard' })
  const ledger = (actorId: string) => new PgLedgerRepo(bound(actorId))
  const company = (actorId: string) => new PgCompanyLedgerRepo(bound(actorId))
  const finance = (actorId: string) => new PgCompanyFinanceRepo(bound(actorId))

  /** Run `work` as `actorId` in its own transaction and COMMIT: the error it or the COMMIT raised, or null. */
  async function outcome(actorId: string, work: () => Promise<unknown>): Promise<PgError | null> {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId])
    try {
      await work()
    } catch (error) {
      await client.query('ROLLBACK')
      return error as PgError
    }
    try {
      await client.query('COMMIT')
      return null
    } catch (error) {
      return error as PgError
    }
  }

  const meta = (createdBy: string, reason: string, rate: bigint | null = null) => ({
    shiftId: null,
    businessDate: DATE,
    postingDate: DATE,
    weekStartDate: WEEK,
    fxDayId: ids.fxDayId,
    sypMinorPerUsd: rate,
    createdBy,
    reason,
  })

  const post = async (branchId: string, posting: Posting, createdBy: string, reason: string, rate: bigint | null = null) => {
    const [entry] = await ledger(createdBy).post(branchId, [posting], meta(createdBy, reason, rate))
    if (!entry) throw new Error(`posting ${posting.eventType}/${posting.occurrenceKey} was a replay`)
    return entry
  }

  /** A journal entry with exactly these lines, bypassing the domain recipes — how a forger would. */
  async function forge(
    branchId: string,
    event: string,
    key: string,
    createdBy: string,
    reason: string | null,
    rate: bigint | null,
    lines: ReadonlyArray<readonly [FundRef, 'D' | 'C', bigint, string | null]>,
    businessDate = DATE,
  ): Promise<number> {
    const { rows } = await client.query<{ id: bigint }>(
      `INSERT INTO journal_entries
         (branch_id, event_type, occurrence_key, business_date, posting_date, week_start_date,
          fx_day_id, reason, created_by, syp_minor_per_usd)
       VALUES ($1, $2::ledger_event, $3, $4::date, $4::date, ($4::date - extract(dow FROM $4::date)::integer),
               $5, $6, $7, $8)
       RETURNING id`,
      [branchId, event, key, businessDate, ids.fxDayId, reason, createdBy, rate],
    )
    const entryId = Number(rows[0]!.id)
    for (const [fund, side, amount, role] of lines) {
      const fundRow = await client.query<{ id: string }>(
        `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar, currency)
         VALUES ($1, $2::fund_type, 'none', NULL, $3, $3, $4)
         ON CONFLICT (branch_id, code) DO UPDATE SET code = EXCLUDED.code
         RETURNING id`,
        [branchId, fundTypeOf(fund), fundCode(fund), 'currency' in fund ? fund.currency : 'SYP_NEW'],
      )
      await client.query(
        'INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role) VALUES ($1, $2, $3, $4, $5)',
        [entryId, fundRow.rows[0]!.id, side, amount, role],
      )
    }
    return entryId
  }

  const linesOf = (posting: Posting) =>
    posting.lines.map((l) => [l.fund, l.side, l.amount as bigint, l.role ?? null] as const)

  const balance = async (branchId: string, code: string): Promise<bigint> =>
    (
      await client.query<{ b: bigint }>(
        `SELECT COALESCE(SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0)::bigint AS b
           FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
          WHERE f.branch_id = $1 AND f.code = $2`,
        [branchId, code],
      )
    ).rows[0]!.b

  const moveRow = (
    id: string,
    kind: 'deposit' | 'withdrawal',
    currency: 'SYP_NEW' | 'USD',
    amount: bigint,
    journalEntryId: number,
    createdBy: string,
    reason: string,
    overrides: Partial<CompanyCommandRecord> = {},
  ): CompanyCommandRecord =>
    ({
      id,
      branchId: HQ,
      kind,
      equityAccount: kind === 'deposit' ? 'owner_funding' : 'owner_drawings',
      currency,
      amount: m(amount),
      sypMinorPerUsd: currency === 'USD' ? RATE : null,
      occurredOn: DATE,
      businessDate: DATE,
      reason,
      journalEntryId,
      createdBy,
      createdAtMs: 0,
      ...overrides,
    }) as CompanyCommandRecord

  /** Post a command exactly as the API does, as `actorId`, and commit. */
  async function issue(
    actorId: string,
    posting: Posting,
    rate: bigint | null,
    reason: string,
    row: (entryId: number) => CompanyCommandRecord,
  ): Promise<{ error: PgError | null; entryId: number }> {
    let entryId = 0
    const error = await outcome(actorId, async () => {
      entryId = (await post(HQ, posting, actorId, reason, rate)).id
      await company(actorId).createCommand(row(entryId))
    })
    return { error, entryId }
  }

  const deposit = async (actorId: string, currency: 'SYP_NEW' | 'USD', amount: bigint, reason = 'إيداع') => {
    const id = randomUUID()
    const result = await issue(actorId, companyDeposit(currency, m(amount), 'owner_funding', id), currency === 'USD' ? RATE : null, reason, (entryId) =>
      moveRow(id, 'deposit', currency, amount, entryId, actorId, reason),
    )
    expect(result.error).toBeNull()
    return { id, entryId: result.entryId }
  }

  const expectRefused = (error: PgError | null, constraint: string | undefined, code = '23514'): void => {
    expect(error, `expected ${constraint}`).not.toBeNull()
    expect({ code: error!.code, constraint: error!.constraint }, error!.message).toEqual({ code, constraint })
  }

  // ── company_moves ───────────────────────────────────────────────────────────────────────────

  describe('company_moves', () => {
    it('accepts the exact deposit and withdrawal in both currencies, freezing the dollar rate', async () => {
      await deposit(ids.gm, 'SYP_NEW', 1_000_000n)
      const usd = await deposit(ids.admin, 'USD', 50_000n)
      const id = randomUUID()
      const out = await issue(ids.gm, companyWithdrawal('SYP_NEW', m(250_000n), id), null, 'سحب', (entryId) =>
        moveRow(id, 'withdrawal', 'SYP_NEW', 250_000n, entryId, ids.gm, 'سحب'),
      )
      expect(out.error).toBeNull()
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(750_000n)
      expect(await balance(HQ, 'company_cash:USD')).toBe(50_000n)
      const rows = await client.query(
        `SELECT m.syp_minor_per_usd AS row_rate, je.syp_minor_per_usd AS entry_rate
           FROM company_moves m JOIN journal_entries je ON je.id = m.journal_entry_id WHERE m.id = $1`,
        [usd.id],
      )
      expect(rows.rows).toEqual([{ row_rate: RATE, entry_rate: RATE }])
      // The audit trigger recorded the row with its actor.
      const audit = await client.query(`SELECT actor_id FROM audit_log WHERE table_name = 'company_moves' AND record_id = $1`, [usd.id])
      expect(audit.rows).toEqual([{ actor_id: ids.admin }])
    })

    it('refuses a forged line: another amount, another role, another account, an extra line', async () => {
      const cash: FundRef = { kind: 'company_cash', currency: 'SYP_NEW' }
      const owner: FundRef = { kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_funding' }
      const opening: FundRef = { kind: 'company_equity', currency: 'SYP_NEW', account: 'opening' }
      const cases: Array<ReadonlyArray<readonly [FundRef, 'D' | 'C', bigint, string | null]>> = [
        [[cash, 'D', 101n, 'deposit_received'], [owner, 'C', 101n, 'deposit_source']],
        [[cash, 'D', 100n, 'deposit_received'], [owner, 'C', 100n, 'kaish']],
        [[cash, 'D', 100n, 'deposit_received'], [opening, 'C', 100n, 'deposit_source']],
        [[cash, 'D', 100n, 'deposit_received'], [owner, 'C', 60n, 'deposit_source'], [owner, 'C', 40n, 'deposit_source']],
        [[cash, 'D', 100n, 'deposit_received'], [owner, 'C', 100n, null]],
      ]
      for (const lines of cases) {
        const id = randomUUID()
        const error = await outcome(ids.gm, async () => {
          const entryId = await forge(HQ, 'company_deposit', id, ids.gm, 'مزوّر', null, lines)
          await company(ids.gm).createCommand(moveRow(id, 'deposit', 'SYP_NEW', 100n, entryId, ids.gm, 'مزوّر'))
        })
        expectRefused(error, 'company_moves_lines_guard')
      }
    })

    it('refuses a branch manager, a retired admin, a borrowed name and a revoked grant', async () => {
      const attempt = async (actor: string, createdBy: string) => {
        const id = randomUUID()
        return outcome(actor, async () => {
          const entryId = await forge(HQ, 'company_deposit', id, createdBy, 'x', null, linesOf(companyDeposit('SYP_NEW', m(5n), 'owner_funding', id)))
          await company(actor).createCommand(moveRow(id, 'deposit', 'SYP_NEW', 5n, entryId, createdBy, 'x'))
        })
      }
      expectRefused(await attempt(ids.manager, ids.manager), 'company_moves_actor_guard')
      expectRefused(await attempt(ids.retired, ids.retired), 'company_moves_actor_guard')
      expectRefused(await attempt(ids.manager, ids.gm), 'company_moves_actor_guard')
      await client.query(`DELETE FROM role_permissions WHERE role_key = 'general_manager' AND permission_key = 'company_fund.manage'`)
      try {
        expectRefused(await attempt(ids.gm, ids.gm), 'company_moves_actor_guard')
      } finally {
        await client.query(
          `INSERT INTO role_permissions (role_key, permission_key, scope) VALUES ('general_manager', 'company_fund.manage', 'all')`,
        )
      }
      // A branch-scoped grant is not enough: the company fund is managed at scope `all` only.
      await client.query(`UPDATE role_permissions SET scope = 'branch' WHERE role_key = 'general_manager' AND permission_key = 'company_fund.manage'`)
      try {
        expectRefused(await attempt(ids.gm, ids.gm), 'company_moves_actor_guard')
      } finally {
        await client.query(`UPDATE role_permissions SET scope = 'all' WHERE role_key = 'general_manager' AND permission_key = 'company_fund.manage'`)
      }
      expect(await attempt(ids.gm, ids.gm)).toBeNull()
    })

    it('refuses a journal whose identity differs: event, key, reason, date, author', async () => {
      const lines = (id: string) => linesOf(companyDeposit('SYP_NEW', m(7n), 'owner_funding', id))
      const variants: Array<(id: string) => Promise<number>> = [
        (id) => forge(HQ, 'company_withdrawal', id, ids.gm, 'r', null, lines(id)),
        (id) => forge(HQ, 'company_deposit', randomUUID(), ids.gm, 'r', null, lines(id)),
        (id) => forge(HQ, 'company_deposit', id, ids.gm, 'another reason', null, lines(id)),
        (id) => forge(HQ, 'company_deposit', id, ids.gm, 'r', null, lines(id), '2026-09-16'),
        (id) => forge(HQ, 'company_deposit', id, ids.admin, 'r', null, lines(id)),
      ]
      for (const variant of variants) {
        const id = randomUUID()
        const error = await outcome(ids.gm, async () => {
          const entryId = await variant(id)
          await company(ids.gm).createCommand(moveRow(id, 'deposit', 'SYP_NEW', 7n, entryId, ids.gm, 'r'))
        })
        expect(['company_moves_journal_guard', 'company_moves_lines_guard']).toContain(error?.constraint)
      }
    })

    it('holds the dollar rate to the currency: required for USD, refused for lira, equal on row and entry', async () => {
      const usdLines = (id: string) => linesOf(companyDeposit('USD', m(9n), 'owner_funding', id))
      const sypLines = (id: string) => linesOf(companyDeposit('SYP_NEW', m(9n), 'owner_funding', id))
      const attempt = async (
        entryRate: bigint | null,
        lines: (id: string) => ReturnType<typeof linesOf>,
        currency: 'SYP_NEW' | 'USD',
        rowRate: bigint | null,
      ) => {
        const id = randomUUID()
        return outcome(ids.gm, async () => {
          const entryId = await forge(HQ, 'company_deposit', id, ids.gm, 'r', entryRate, lines(id))
          await company(ids.gm).createCommand(moveRow(id, 'deposit', currency, 9n, entryId, ids.gm, 'r', { sypMinorPerUsd: rowRate }))
        })
      }
      // The row and its entry must freeze the SAME rate.
      expectRefused(await attempt(RATE, usdLines, 'USD', null), 'company_moves_journal_guard')
      expectRefused(await attempt(RATE, usdLines, 'USD', RATE + 1n), 'company_moves_journal_guard')
      expectRefused(await attempt(null, sypLines, 'SYP_NEW', RATE), 'company_moves_journal_guard')
      // Agreeing on a wrong shape is still refused by the table: USD needs a rate, lira has none.
      expectRefused(await attempt(null, usdLines, 'USD', null), 'company_moves_rate_ck')
      expectRefused(await attempt(RATE, sypLines, 'SYP_NEW', RATE), 'company_moves_rate_ck')
      // …and a USD entry without its rate cannot commit whatever the row says (0066).
      const bare = randomUUID()
      expectRefused(
        await outcome(ids.gm, () => forge(HQ, 'company_deposit', bare, ids.gm, 'r', null, usdLines(bare))),
        'company_journal_fact_guard',
      )
    })

    it('refuses the row shapes the table itself forbids', async () => {
      const cash: FundRef = { kind: 'company_cash', currency: 'SYP_NEW' }
      const equity = (account: 'owner_funding' | 'owner_drawings' | 'opening'): FundRef => ({
        kind: 'company_equity',
        currency: 'SYP_NEW',
        account,
      })
      /** The journal the guard expects for this (possibly invalid) row, so the table's CHECK decides. */
      const attempt = async (
        kind: 'deposit' | 'withdrawal',
        account: 'owner_funding' | 'owner_drawings' | 'opening',
        overrides: Partial<CompanyCommandRecord> = {},
        reason = 'r',
      ) => {
        const id = randomUUID()
        const lines: ReadonlyArray<readonly [FundRef, 'D' | 'C', bigint, string | null]> =
          kind === 'deposit'
            ? [[cash, 'D', 1n, 'deposit_received'], [equity(account), 'C', 1n, 'deposit_source']]
            : [[equity(account), 'D', 1n, 'withdrawal_destination'], [cash, 'C', 1n, 'withdrawal_paid']]
        return outcome(ids.gm, async () => {
          const entryId = await forge(HQ, kind === 'deposit' ? 'company_deposit' : 'company_withdrawal', id, ids.gm, reason, null, lines)
          await company(ids.gm).createCommand(
            moveRow(id, kind, 'SYP_NEW', 1n, entryId, ids.gm, reason, { equityAccount: account, ...overrides } as Partial<CompanyCommandRecord>),
          )
        })
      }
      expectRefused(await attempt('withdrawal', 'opening'), 'company_moves_account_ck')
      expectRefused(await attempt('deposit', 'owner_drawings'), 'company_moves_account_ck')
      expectRefused(await attempt('deposit', 'owner_funding', { occurredOn: '2026-09-18' }), 'company_moves_occurred_ck')
      expectRefused(await attempt('deposit', 'owner_funding', { occurredOn: '1999-12-31' }), 'company_moves_occurred_ck')
      expectRefused(await attempt('deposit', 'owner_funding', {}, '​'), 'company_moves_reason_check')
      // A historical date is exactly what occurred_on is for.
      expect(await attempt('deposit', 'opening', { occurredOn: '2025-08-10' })).toBeNull()
    })

    it('refuses a journal with no command row, and a command filed under a branch', async () => {
      const id = randomUUID()
      expectRefused(
        await outcome(ids.gm, () => post(HQ, companyDeposit('SYP_NEW', m(3n), 'owner_funding', id), ids.gm, 'r')),
        'company_journal_fact_guard',
      )
      const branchId = randomUUID()
      expectRefused(
        await outcome(ids.gm, async () => {
          const entryId = (await post(HQ, companyDeposit('SYP_NEW', m(3n), 'owner_funding', branchId), ids.gm, 'r')).id
          await company(ids.gm).createCommand(moveRow(branchId, 'deposit', 'SYP_NEW', 3n, entryId, ids.gm, 'r', { branchId: ids.dam }))
        }),
        'branch_kind_guard',
      )
      // Events whose command tables arrive in C3–C5 cannot post at all yet.
      const payable: FundRef = { kind: 'company_payable', currency: 'SYP_NEW', debtId: 'c2-debt' }
      const reserve: FundRef = { kind: 'depreciation_reserve', currency: 'SYP_NEW' }
      const cash: FundRef = { kind: 'company_cash', currency: 'SYP_NEW' }
      for (const [event, lines] of [
        ['company_debt_open', [[cash, 'D', 1n, null], [payable, 'C', 1n, null]]],
        ['asset_purchase', [[cash, 'D', 1n, null], [payable, 'C', 1n, null]]],
        ['depreciation_transfer', [[reserve, 'D', 1n, null], [cash, 'C', 1n, null]]],
      ] as const) {
        const error = await outcome(ids.gm, () => forge(HQ, event, randomUUID(), ids.gm, 'r', null, lines))
        expectRefused(error, 'company_journal_fact_guard')
      }
    })

    it('refuses a withdrawal the pocket cannot cover', async () => {
      const held = await balance(HQ, 'company_cash:SYP_NEW')
      const id = randomUUID()
      const out = await issue(ids.gm, companyWithdrawal('SYP_NEW', m(held + 1n), id), null, 'أكثر من الرصيد', (entryId) =>
        moveRow(id, 'withdrawal', 'SYP_NEW', held + 1n, entryId, ids.gm, 'أكثر من الرصيد'),
      )
      expectRefused(out.error, 'company_pocket_negative_guard')
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(held)
    })

    it('replays nothing: the key is unique in the journal and across command tables', async () => {
      const first = await deposit(ids.gm, 'SYP_NEW', 11n, 'مرة')
      const again = await outcome(ids.gm, async () => {
        const written = await ledger(ids.gm).post(HQ, [companyDeposit('SYP_NEW', m(11n), 'owner_funding', first.id)], meta(ids.gm, 'مرة'))
        expect(written).toEqual([])
        await company(ids.gm).createCommand(moveRow(first.id, 'deposit', 'SYP_NEW', 11n, first.entryId, ids.gm, 'مرة'))
      })
      expect(again).toMatchObject({ code: 'DUPLICATE_COMPANY_COMMAND' })
      // Straight SQL meets the journal's unique keys.
      const duplicateEntry = await outcome(ids.gm, () =>
        forge(HQ, 'company_deposit', first.id, ids.gm, 'مرة', null, linesOf(companyDeposit('SYP_NEW', m(11n), 'owner_funding', first.id))),
      )
      expect(duplicateEntry?.code).toBe('23505')
      expect(['je_idempotency_uq', 'je_company_deposit_command_uq']).toContain(duplicateEntry?.constraint)
      // …and straight SQL meets the command's primary key.
      const duplicateRow = await outcome(ids.gm, () =>
        client.query(
          `INSERT INTO company_moves (id, branch_id, kind, equity_account, currency, amount_minor, occurred_on,
                                      business_date, reason, journal_entry_id, created_by)
           VALUES ($1, $2, 'deposit', 'owner_funding', 'SYP_NEW', 11, $3, $3, 'مرة', $4, $5)`,
          [first.id, HQ, DATE, first.entryId, ids.gm],
        ),
      )
      expect(duplicateRow?.code).toBe('23505')
    })

    it('is immutable: no UPDATE or DELETE, and for the application role not even the privilege', async () => {
      const { id } = await deposit(ids.gm, 'SYP_NEW', 13n)
      expectRefused(await outcome(ids.gm, () => client.query(`UPDATE company_moves SET reason = 'x' WHERE id = $1`, [id])), 'company_command_immutable')
      expectRefused(await outcome(ids.gm, () => client.query(`DELETE FROM company_moves WHERE id = $1`, [id])), 'company_command_immutable')
      const tables: Array<[string, string]> = [
        ['company_moves', 'created_at'],
        ['company_expenses', 'created_at'],
        ['company_incomes', 'created_at'],
        ['company_fx_exchanges', 'created_at'],
        ['company_reversals', 'created_at'],
        ['company_ledger_cutovers', 'performed_at'],
        ['company_restoration_mirrors', 'created_at'],
      ]
      for (const [table, column] of tables) {
        for (const statement of [`UPDATE ${table} SET ${column} = ${column} WHERE false`, `DELETE FROM ${table} WHERE false`, `TRUNCATE ${table}`]) {
          const error = await outcome(ids.gm, async () => {
            await client.query('SET LOCAL ROLE app_user')
            await client.query(statement)
          })
          expect(error?.code, statement).toBe('42501')
        }
        const read = await outcome(ids.gm, async () => {
          await client.query('SET LOCAL ROLE app_user')
          await client.query(`SELECT count(*) FROM ${table}`)
        })
        expect(read, table).toBeNull()
      }
    })
  })

  // ── company_expenses and company_incomes ───────────────────────────────────────────────────

  describe('company_expenses and company_incomes', () => {
    const expenseRow = (id: string, entryId: number, overrides: Partial<CompanyCommandRecord> = {}): CompanyCommandRecord =>
      ({
        id,
        branchId: HQ,
        kind: 'expense',
        currency: 'SYP_NEW',
        amount: m(2_000n),
        sypMinorPerUsd: null,
        categoryId: ids.expenseCategory,
        costCenterKind: 'vehicle',
        vehicleId: ids.vehicle,
        assetId: null,
        paidFrom: 'pocket',
        receiptMediaId: null,
        description: 'إطار',
        occurredOn: '2026-03-02',
        businessDate: DATE,
        journalEntryId: entryId,
        createdBy: ids.gm,
        createdAtMs: 0,
        ...overrides,
      }) as CompanyCommandRecord

    it('files an expense under a vehicle of any branch, from the pocket or by the owner', async () => {
      const ownerFundingBefore = await balance(HQ, 'company_equity:USD:owner_funding')
      let id = randomUUID()
      const pocket = await issue(ids.gm, companyExpense('SYP_NEW', m(2_000n), `vehicle:${ids.vehicle}`, 'pocket', id), null, 'إطار', (entryId) =>
        expenseRow(id, entryId),
      )
      expect(pocket.error).toBeNull()
      id = randomUUID()
      const outside = await issue(ids.admin, companyExpense('USD', m(35_000n), 'general', 'owner_outside', id), RATE, 'تسجيل شركة', (entryId) =>
        expenseRow(id, entryId, {
          currency: 'USD', amount: m(35_000n), sypMinorPerUsd: RATE, costCenterKind: 'general', vehicleId: null,
          paidFrom: 'owner_outside', description: 'تسجيل شركة', createdBy: ids.admin,
        } as Partial<CompanyCommandRecord>),
      )
      expect(outside.error).toBeNull()
      expect(await balance(HQ, `company_expense:SYP_NEW:vehicle:${ids.vehicle}`)).toBe(2_000n)
      expect(await balance(HQ, 'company_equity:USD:owner_funding')).toBe(ownerFundingBefore - 35_000n)
    })

    it('refuses the reserve it does not yet hold, the asset register it does not yet have, and closed categories', async () => {
      let id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyExpense('SYP_NEW', m(1n), 'general', 'reserve', id), null, 'r', (entryId) =>
          expenseRow(id, entryId, { amount: m(1n), costCenterKind: 'general', vehicleId: null, paidFrom: 'reserve', description: 'r' } as Partial<CompanyCommandRecord>),
        )).error,
        'company_pocket_negative_guard',
      )
      const asset = randomUUID()
      id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyExpense('SYP_NEW', m(1n), `asset:${asset}`, 'pocket', id), null, 'r', (entryId) =>
          expenseRow(id, entryId, { amount: m(1n), costCenterKind: 'asset', vehicleId: null, assetId: asset, description: 'r' } as Partial<CompanyCommandRecord>),
        )).error,
        'company_expenses_asset_guard',
      )
      id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyExpense('SYP_NEW', m(1n), `vehicle:${ids.vehicle}`, 'pocket', id), null, 'r', (entryId) =>
          expenseRow(id, entryId, { amount: m(1n), categoryId: ids.closedExpenseCategory, description: 'r' } as Partial<CompanyCommandRecord>),
        )).error,
        'company_expenses_category_guard',
      )
      const ghost = randomUUID()
      id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyExpense('SYP_NEW', m(1n), `vehicle:${ghost}`, 'pocket', id), null, 'r', (entryId) =>
          expenseRow(id, entryId, { amount: m(1n), vehicleId: ghost, description: 'r' } as Partial<CompanyCommandRecord>),
        )).error,
        'company_expenses_vehicle_guard',
      )
      id = randomUUID()
      expectRefused(
        (await issue(ids.manager, companyExpense('SYP_NEW', m(1n), `vehicle:${ids.vehicle}`, 'pocket', id), null, 'r', (entryId) =>
          expenseRow(id, entryId, { amount: m(1n), description: 'r', createdBy: ids.manager } as Partial<CompanyCommandRecord>),
        )).error,
        'company_expenses_actor_guard',
      )
    })

    it('refuses an expense whose journal pays from another source or files under another centre', async () => {
      const cases: Array<[Posting, Partial<CompanyCommandRecord>]> = []
      let id = randomUUID()
      cases.push([companyExpense('SYP_NEW', m(1n), `vehicle:${ids.vehicle}`, 'owner_outside', id), { id, amount: m(1n), description: 'r' } as Partial<CompanyCommandRecord>])
      id = randomUUID()
      cases.push([companyExpense('SYP_NEW', m(1n), 'general', 'pocket', id), { id, amount: m(1n), description: 'r' } as Partial<CompanyCommandRecord>])
      for (const [posting, overrides] of cases) {
        const error = await outcome(ids.gm, async () => {
          const entryId = (await post(HQ, posting, ids.gm, 'r')).id
          await company(ids.gm).createCommand(expenseRow(String(overrides.id), entryId, overrides))
        })
        expectRefused(error, 'company_expenses_lines_guard')
      }
    })

    it('takes income against an active category and refuses a closed one or a forged line', async () => {
      const incomeRow = (id: string, entryId: number, overrides: Partial<CompanyCommandRecord> = {}): CompanyCommandRecord =>
        ({
          id, branchId: HQ, kind: 'income', currency: 'SYP_NEW', amount: m(40_000n), sypMinorPerUsd: null,
          categoryId: ids.incomeCategory, description: 'خردة', occurredOn: DATE, businessDate: DATE,
          journalEntryId: entryId, createdBy: ids.gm, createdAtMs: 0, ...overrides,
        }) as CompanyCommandRecord
      let id = randomUUID()
      expect((await issue(ids.gm, companyIncome('SYP_NEW', m(40_000n), id), null, 'خردة', (e) => incomeRow(id, e))).error).toBeNull()
      id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyIncome('SYP_NEW', m(40_000n), id), null, 'خردة', (e) =>
          incomeRow(id, e, { categoryId: ids.closedIncomeCategory } as Partial<CompanyCommandRecord>),
        )).error,
        'company_incomes_category_guard',
      )
      id = randomUUID()
      expectRefused(
        await outcome(ids.gm, async () => {
          const entryId = await forge(HQ, 'company_income', id, ids.gm, 'خردة', null, [
            [{ kind: 'company_cash', currency: 'SYP_NEW' }, 'D', 40_000n, 'income_received'],
            [{ kind: 'company_equity', currency: 'SYP_NEW', account: 'owner_funding' }, 'C', 40_000n, 'income_earned'],
          ])
          await company(ids.gm).createCommand(incomeRow(id, entryId))
        }),
        'company_incomes_lines_guard',
      )
    })
  })

  // ── company_fx_exchanges ────────────────────────────────────────────────────────────────────

  describe('company_fx_exchanges', () => {
    const exchangeRow = (
      id: string,
      entryId: number,
      from: ['SYP_NEW' | 'USD', bigint],
      to: ['SYP_NEW' | 'USD', bigint],
      rate: bigint,
      createdBy = ids.gm,
    ): CompanyCommandRecord => ({
      id, branchId: HQ, kind: 'exchange', fromCurrency: from[0], fromAmount: m(from[1]), toCurrency: to[0],
      toAmount: m(to[1]), sypMinorPerUsd: rate, reason: 'تصريف', occurredOn: DATE, businessDate: DATE,
      journalEntryId: entryId, createdBy, createdAtMs: 0,
    })

    const exchange = async (from: ['SYP_NEW' | 'USD', bigint], to: ['SYP_NEW' | 'USD', bigint], rate?: bigint, entryRate?: bigint) => {
      const id = randomUUID()
      const derived = exchangeRate(money(from[0], m(from[1])), money(to[0], m(to[1])))
      return issue(
        ids.gm,
        companyFxExchange(money(from[0], m(from[1])), money(to[0], m(to[1])), id),
        entryRate ?? rate ?? derived,
        'تصريف',
        (entryId) => exchangeRow(id, entryId, from, to, rate ?? derived),
      )
    }

    it('records both actual amounts and freezes the rate they imply, both ways', async () => {
      const usdBefore = await balance(HQ, 'company_cash:USD')
      const sypBefore = await balance(HQ, 'company_cash:SYP_NEW')
      expect((await exchange(['USD', 10_000n], ['SYP_NEW', 1_305_500n])).error).toBeNull()
      // $37 for 4,820.00 has no exact integer rate: recorded as it happened, at the nearest one.
      const odd = await exchange(['USD', 3_700n], ['SYP_NEW', 482_000n])
      expect(odd.error).toBeNull()
      expect((await client.query(`SELECT syp_minor_per_usd FROM journal_entries WHERE id = $1`, [odd.entryId])).rows).toEqual([
        { syp_minor_per_usd: 13_027n },
      ])
      expect((await exchange(['SYP_NEW', 130_000n], ['USD', 1_000n])).error).toBeNull()
      expect(await balance(HQ, 'company_cash:USD')).toBe(usdBefore - 10_000n - 3_700n + 1_000n)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(sypBefore + 1_305_500n + 482_000n - 130_000n)
      expect(await balance(HQ, 'company_fx_position:USD')).toBe(10_000n + 3_700n - 1_000n)
    })

    it('refuses a rate the amounts do not imply, on the row or on the entry', async () => {
      expectRefused((await exchange(['USD', 100n], ['SYP_NEW', 13_050n], 13_051n)).error, 'company_fx_exchanges_rate_ck')
      expectRefused((await exchange(['USD', 100n], ['SYP_NEW', 13_050n], 13_050n, 13_000n)).error, 'company_fx_exchanges_journal_guard')
    })

    it('refuses swapped roles, one currency twice, and dollars the pocket does not hold', async () => {
      const id = randomUUID()
      const error = await outcome(ids.gm, async () => {
        const entryId = await forge(HQ, 'company_fx_exchange', id, ids.gm, 'تصريف', RATE, [
          [{ kind: 'company_fx_position', currency: 'USD' }, 'D', 100n, 'fx_paid'],
          [{ kind: 'company_cash', currency: 'USD' }, 'C', 100n, 'fx_sold'],
          [{ kind: 'company_cash', currency: 'SYP_NEW' }, 'D', 13_050n, 'fx_received'],
          [{ kind: 'company_fx_position', currency: 'SYP_NEW' }, 'C', 13_050n, 'fx_bought'],
        ])
        await company(ids.gm).createCommand(exchangeRow(id, entryId, ['USD', 100n], ['SYP_NEW', 13_050n], RATE))
      })
      expectRefused(error, 'company_fx_exchanges_lines_guard')
      const same = randomUUID()
      expectRefused(
        await outcome(ids.gm, async () => {
          const entryId = (await post(HQ, companyDeposit('USD', m(1n), 'owner_funding', same), ids.gm, 'r', RATE)).id
          await company(ids.gm).createCommand(exchangeRow(same, entryId, ['USD', 1n], ['USD', 1n], RATE))
        }),
        'company_fx_exchanges_journal_guard',
      )
      const held = await balance(HQ, 'company_cash:USD')
      expectRefused((await exchange(['USD', held + 1n], ['SYP_NEW', (held + 1n) * 130n])).error, 'company_pocket_negative_guard')
    })
  })

  // ── company_reversals ───────────────────────────────────────────────────────────────────────

  describe('company_reversals', () => {
    const reversalRow = (
      id: string,
      entryId: number,
      target: { kind: 'move' | 'expense' | 'income' | 'exchange'; id: string; entryId: number },
      rate: bigint | null,
      reason = 'عكس',
    ): CompanyCommandRecord => ({
      id, branchId: HQ, kind: 'reversal', targetKind: target.kind, targetId: target.id, targetEntryId: target.entryId,
      sypMinorPerUsd: rate, reason, occurredOn: DATE, businessDate: DATE, journalEntryId: entryId,
      createdBy: ids.gm, createdAtMs: 0,
    })

    const reverseCommand = async (
      targetPosting: Posting,
      target: { kind: 'move' | 'expense' | 'income' | 'exchange'; id: string; entryId: number },
      rate: bigint | null,
      options: { rowRate?: bigint | null; lines?: Posting | ((id: string) => Posting) } = {},
    ) => {
      const id = randomUUID()
      const reversal = typeof options.lines === 'function'
        ? options.lines(id)
        : options.lines ?? companyReversal(targetPosting, id)
      return issue(ids.gm, reversal, rate, 'عكس', (entryId) =>
        reversalRow(id, entryId, target, options.rowRate === undefined ? rate : options.rowRate),
      )
    }

    it('undoes a deposit exactly once, and puts the pocket back', async () => {
      const before = await balance(HQ, 'company_cash:SYP_NEW')
      const target = await deposit(ids.gm, 'SYP_NEW', 777n)
      const posting = companyDeposit('SYP_NEW', m(777n), 'owner_funding', target.id)
      expect((await reverseCommand(posting, { kind: 'move', ...target }, null)).error).toBeNull()
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(before)
      expectRefused(
        (await reverseCommand(posting, { kind: 'move', ...target }, null)).error,
        undefined,
        'DUPLICATE_REVERSAL',
      )
    })

    it('undoes an exchange as a two-currency correction at the same frozen rate', async () => {
      const id = randomUUID()
      const from = money('USD', m(200n))
      const to = money('SYP_NEW', m(26_100n))
      const done = await issue(ids.gm, companyFxExchange(from, to, id), 13_050n, 'تصريف', (entryId) => ({
        id, branchId: HQ, kind: 'exchange', fromCurrency: 'USD', fromAmount: m(200n), toCurrency: 'SYP_NEW',
        toAmount: m(26_100n), sypMinorPerUsd: 13_050n, reason: 'تصريف', occurredOn: DATE, businessDate: DATE,
        journalEntryId: entryId, createdBy: ids.gm, createdAtMs: 0,
      }))
      expect(done.error).toBeNull()
      const target = { kind: 'exchange' as const, id, entryId: done.entryId }
      const posting = companyFxExchange(from, to, id)
      expectRefused((await reverseCommand(posting, target, 13_050n, { rowRate: 13_000n })).error, 'company_reversals_journal_guard')
      expect((await reverseCommand(posting, target, null, { rowRate: null })).error?.message).toMatch(/USD line but no frozen syp_minor_per_usd/)
      expect((await reverseCommand(posting, target, 13_050n)).error).toBeNull()
      expect(await balance(HQ, 'company_fx_position:SYP_NEW')).toBe(
        -(1_305_500n + 482_000n) + 130_000n,
      )
    })

    it('refuses a correction that is not the exact inverse, names another kind, or has no row', async () => {
      const target = await deposit(ids.gm, 'SYP_NEW', 555n)
      const posting = companyDeposit('SYP_NEW', m(555n), 'owner_funding', target.id)
      expectRefused(
        (await reverseCommand(posting, { kind: 'move', ...target }, null, {
          lines: (id) => ({ ...companyReversal(posting, id), lines: posting.lines }),
        })).error,
        'company_reversals_lines_guard',
      )
      expectRefused((await reverseCommand(posting, { kind: 'move', ...target }, null, {
        lines: (id) => companyReversal(companyDeposit('SYP_NEW', m(554n), 'owner_funding', target.id), id),
      })).error, 'company_reversals_lines_guard')
      expectRefused((await reverseCommand(posting, { kind: 'expense', ...target }, null)).error, 'company_reversals_target_guard')
      expectRefused(
        await outcome(ids.gm, () => post(HQ, companyReversal(posting, randomUUID()), ids.gm, 'بلا سجل')),
        'company_journal_fact_guard',
      )
      // …and a two-currency correction with no exchange behind it has no row to stand on either.
      expectRefused(
        await outcome(ids.gm, () =>
          post(HQ, companyReversal(companyFxExchange(money('USD', m(1n)), money('SYP_NEW', m(130n)), 'z'), randomUUID()), ids.gm, 'r', 13_000n),
        ),
        'company_journal_fact_guard',
      )
      // A two-currency deposit can never acquire the one immutable deposit fact its event requires.
      const mixed = await outcome(ids.gm, () =>
        forge(HQ, 'company_deposit', randomUUID(), ids.gm, 'r', RATE, [
          [{ kind: 'company_cash', currency: 'USD' }, 'D', 1n, null],
          [{ kind: 'company_fx_position', currency: 'USD' }, 'C', 1n, null],
          [{ kind: 'company_cash', currency: 'SYP_NEW' }, 'D', 130n, null],
          [{ kind: 'company_fx_position', currency: 'SYP_NEW' }, 'C', 130n, null],
        ]),
      )
      expectRefused(mixed, 'company_journal_fact_guard')
    })

    it('refuses to take back a deposit whose money was already spent', async () => {
      const target = await deposit(ids.gm, 'SYP_NEW', 10_000n)
      const held = await balance(HQ, 'company_cash:SYP_NEW')
      const spend = randomUUID()
      expect(
        (await issue(ids.gm, companyWithdrawal('SYP_NEW', m(held), spend), null, 'كل الرصيد', (entryId) =>
          moveRow(spend, 'withdrawal', 'SYP_NEW', held, entryId, ids.gm, 'كل الرصيد'),
        )).error,
      ).toBeNull()
      expectRefused(
        (await reverseCommand(companyDeposit('SYP_NEW', m(10_000n), 'owner_funding', target.id), { kind: 'move', ...target }, null)).error,
        'company_pocket_negative_guard',
      )
      // Put money back for the tests that follow.
      await deposit(ids.gm, 'SYP_NEW', held)
    })
  })

  // ── the cutover, the mirror, and the invariant ──────────────────────────────────────────────

  describe('cutover and the restoration mirror', () => {
    const cutoverRow = (
      branchId: string,
      opening: bigint,
      openingEntryId: number | null,
      watermark: number,
      performedBy = ids.admin,
    ) => ({
      branchId,
      companyBranchId: HQ,
      openingAmount: m(opening),
      openingEntryId,
      watermarkEntryId: watermark,
      businessDate: DATE,
      reason: 'الانتقال إلى الصندوق المستقل',
      performedBy,
      performedAtMs: 0,
    })

    const latest = async (): Promise<number> => company(ids.admin).latestEntryId()

    /** Post a branch entry and, when it moved company_box, its HQ half — the API's recipe. */
    async function postWithMirror(
      actor: string,
      branchId: string,
      posting: Posting,
      reason: string,
      options: { restorationId?: number | null; skipMirror?: boolean; tamper?: (p: Posting) => Posting; amount?: bigint } = {},
    ) {
      const source = await post(branchId, posting, actor, reason)
      const movement = companyBoxMovement(source.lines)
      if (!movement || options.skipMirror) return { source, mirror: null }
      let half = restorationMirror(movement.direction, movement.amount, branchId, source.id)
      if (options.tamper) half = options.tamper(half)
      const [mirror] = await ledger(actor).post(HQ, [half], {
        ...meta(actor, reason),
        businessDate: source.businessDate,
        postingDate: source.postingDate,
        weekStartDate: source.weekStartDate,
      })
      await company(actor).createMirror({
        id: randomUUID(),
        sourceBranchId: branchId,
        sourceEntryId: source.id,
        mirrorEntryId: mirror!.id,
        direction: movement.direction,
        amount: m(options.amount ?? movement.amount),
        restorationId: options.restorationId ?? null,
        createdBy: actor,
        createdAtMs: 0,
      })
      return { source, mirror }
    }

    const invariant = async (branchId: string): Promise<bigint> =>
      (await balance(branchId, 'company_box')) + (await balance(HQ, `branch_clearing:${branchId}`))

    let historyEntryId = 0
    let watermark = 0

    it('leaves company_box alone before the cutover, and refuses a clearing movement for it', async () => {
      // DAM's own history: a hand sweep and a legacy owner deposit into company_box.
      expect(await outcome(ids.gm, async () => {
        historyEntryId = (await post(ids.dam, manualKaish('office_cash', m(7_000_000n), 'c2-hist-1'), ids.gm, 'كييش قديم')).id
        await post(ids.dam, {
          eventType: 'manual',
          occurrenceKey: 'c2-hist-2',
          lines: [
            { fund: { kind: 'company_box' }, side: 'D', amount: m(905_726n) },
            { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: m(905_726n) },
          ],
        }, ids.gm, 'إيداع قديم')
      })).toBeNull()
      expect(await balance(ids.dam, 'company_box')).toBe(7_905_726n)
      expectRefused(
        await outcome(ids.gm, () =>
          forge(HQ, 'manual', randomUUID(), ids.gm, 'r', null, [
            [{ kind: 'company_cash', currency: 'SYP_NEW' }, 'D', 1n, 'kaish_mirror'],
            [{ kind: 'branch_clearing', branchId: ids.alp }, 'C', 1n, 'kaish_mirror'],
          ]),
        ),
        'journal_ledger_partition_guard',
      )
    })

    it('refuses a cutover with the wrong opening, watermark, author or transfer', async () => {
      const attempt = async (
        opening: bigint,
        transfer: bigint,
        mark: (latestId: number) => number,
        performedBy = ids.admin,
        key?: string,
      ) =>
        outcome(performedBy, async () => {
          const latestId = await latest()
          let entryId: number | null = null
          if (transfer > 0n) {
            const posting = companyOpeningTransfer(ids.dam, m(transfer))
            entryId = (await post(HQ, key ? { ...posting, occurrenceKey: key } : posting, performedBy, 'الانتقال إلى الصندوق المستقل')).id
          }
          await company(performedBy).createCutover(cutoverRow(ids.dam, opening, entryId, mark(latestId), performedBy))
        })
      expectRefused(await attempt(7_905_725n, 7_905_725n, (id) => id), 'company_cutovers_opening_guard')
      expectRefused(await attempt(7_905_726n, 7_905_726n, () => historyEntryId - 1), 'company_cutovers_watermark_guard')
      expectRefused(await attempt(7_905_726n, 7_905_726n, (id) => id + 10), 'company_cutovers_watermark_guard')
      expectRefused(await attempt(7_905_726n, 7_905_726n, (id) => id, ids.gm), 'company_cutovers_actor_guard')
      expectRefused(await attempt(7_905_726n, 7_905_726n, (id) => id, ids.manager), 'company_cutovers_actor_guard')
      expectRefused(await attempt(7_905_726n, 7_905_726n, (id) => id, ids.admin, `opening:${ids.alp}`), 'company_cutovers_journal_guard')
      expectRefused(await attempt(0n, 0n, (id) => id), 'company_cutovers_opening_guard')
      expectRefused(await attempt(7_905_726n, 0n, (id) => id), 'company_cutovers_journal_guard')
    })

    it('moves the company_box balance as-is, once, and never mirrors what came before', async () => {
      const done = await outcome(ids.admin, async () => {
        watermark = await latest()
        const opening = await balance(ids.dam, 'company_box')
        const entry = await post(HQ, companyOpeningTransfer(ids.dam, m(opening)), ids.admin, 'الانتقال إلى الصندوق المستقل')
        await company(ids.admin).createCutover(cutoverRow(ids.dam, opening, entry.id, watermark))
      })
      expect(done).toBeNull()
      expect(await balance(HQ, `branch_clearing:${ids.dam}`)).toBe(-7_905_726n)
      expect(await invariant(ids.dam)).toBe(0n)
      const stored = await company(ids.admin).cutoverFor(ids.dam)
      expect(stored).toMatchObject({ openingAmount: 7_905_726n, watermarkEntryId: watermark })
      expect(stored!.watermarkEntryId).toBeGreaterThanOrEqual(historyEntryId)

      // A second cutover of the same branch: refused.
      const again = await outcome(ids.admin, () => company(ids.admin).createCutover(cutoverRow(ids.dam, 7_905_726n, stored!.openingEntryId, watermark)))
      expect(again).toMatchObject({ code: 'DUPLICATE_CUTOVER' })

      // History is not mirrored: a mirror row for a pre-watermark entry is refused.
      expectRefused(
        await outcome(ids.gm, async () => {
          const [mirror] = await ledger(ids.gm).post(HQ, [restorationMirror('to_company', m(7_000_000n), ids.dam, historyEntryId)], meta(ids.gm, 'كييش قديم'))
          await company(ids.gm).createMirror({
            id: randomUUID(), sourceBranchId: ids.dam, sourceEntryId: historyEntryId, mirrorEntryId: mirror!.id,
            direction: 'to_company', amount: m(7_000_000n), restorationId: null, createdBy: ids.gm, createdAtMs: 0,
          })
        }),
        'company_mirrors_source_guard',
      )

      // A branch with an empty company_box cuts over with no transfer at all.
      expect(
        await outcome(ids.admin, async () => {
          await company(ids.admin).createCutover(cutoverRow(ids.alp, 0n, null, await latest()))
        }),
      ).toBeNull()
      expect(await balance(HQ, `branch_clearing:${ids.alp}`)).toBe(0n)
    })

    it('refuses a company_box movement after the cutover without its HQ half, or with a wrong one', async () => {
      const box = await balance(ids.dam, 'company_box')
      expectRefused(
        await outcome(ids.gm, () => postWithMirror(ids.gm, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'بلا مرآة', { skipMirror: true })),
        'company_box_mirror_guard',
      )
      expectRefused(
        await outcome(ids.gm, () => postWithMirror(ids.gm, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'مبلغ آخر', { amount: 99n })),
        'company_mirrors_source_line_guard',
      )
      expectRefused(
        await outcome(ids.gm, () =>
          postWithMirror(ids.gm, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'اتجاه آخر', {
            tamper: (p) => restorationMirror('from_company', m(100n), ids.dam, Number(p.occurrenceKey.slice('mirror:'.length))),
          }),
        ),
        'company_mirrors_lines_guard',
      )
      expectRefused(
        await outcome(ids.gm, () =>
          postWithMirror(ids.gm, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'مفتاح آخر', {
            tamper: (p) => ({ ...p, occurrenceKey: `${p.occurrenceKey}-x` }),
          }),
        ),
        'company_mirrors_journal_guard',
      )
      // The branch manager may not mirror a hand sweep: that is not his ترميم.
      expectRefused(
        await outcome(ids.manager, () => postWithMirror(ids.manager, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'مدير فرع')),
        'company_mirrors_actor_guard',
      )
      // Nor may anyone pin a hand sweep to a restoration run.
      const run = await client.query<{ id: bigint }>(`SELECT id FROM restorations ORDER BY id DESC LIMIT 1`)
      if (run.rows[0]) {
        expectRefused(
          await outcome(ids.gm, () =>
            postWithMirror(ids.gm, ids.dam, manualKaish('office_cash', m(100n), randomUUID()), 'ليس ترميماً', { restorationId: Number(run.rows[0]!.id) }),
          ),
          'company_mirrors_restoration_guard',
        )
      }
      expect(await balance(ids.dam, 'company_box')).toBe(box)
      // The correct pair commits, and the two ledgers still cancel.
      expect(await outcome(ids.gm, () => postWithMirror(ids.gm, ids.dam, manualKaish('office_wallet', m(250n), randomUUID()), 'كييش يدوي'))).toBeNull()
      expect(await invariant(ids.dam)).toBe(0n)
    })

    it('mirrors a branch manager\'s ترميم with its run, and lets a «شحن» drive the pocket negative', async () => {
      // Capital targets and office boxes: cash 6,300.00 over, wallet on target.
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', ids.manager])
      await client.query(
        `INSERT INTO office_capital_targets (branch_id, fund_code, target_minor, effective_from, created_by, note)
         VALUES ($1, 'office_cash', 5000000, $2::date, $3, 'c2'), ($1, 'office_wallet', 1000000, $2::date, $3, 'c2')`,
        [ids.dam, DATE, ids.manager],
      )
      await client.query('COMMIT')
      const officeCash = await balance(ids.dam, 'office_cash')
      const officeWallet = await balance(ids.dam, 'office_wallet')
      expect(
        await outcome(ids.gm, () =>
          post(ids.dam, {
            eventType: 'manual',
            occurrenceKey: 'c2-capital',
            lines: [
              { fund: { kind: 'office_cash' }, side: 'D', amount: m(5_630_000n - officeCash) },
              { fund: { kind: 'office_wallet' }, side: 'D', amount: m(1_000_000n - officeWallet) },
              { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: m(6_630_000n - officeCash - officeWallet) },
            ],
          }, ids.gm, 'رأس المال'),
        ),
      ).toBeNull()

      const reason = 'ترميم نهاية اليوم'
      const leg = (fundCode: 'office_cash' | 'office_wallet', office: bigint, target: bigint) => {
        const delta = office - target
        return {
          fundCode,
          officeBalance: formatMinor(m(office)),
          receivables: '0.00',
          advances: '0.00',
          position: formatMinor(m(office)),
          capitalTarget: formatMinor(m(target)),
          delta: formatMinor(m(delta)),
          direction: delta === 0n ? null : delta > 0n ? 'to_company' : 'from_company',
          amount: formatMinor(m(delta < 0n ? -delta : delta)),
          feasible: true,
          refusals: [],
        }
      }
      const pocketBefore = await balance(HQ, 'company_cash:SYP_NEW')
      const done = await outcome(ids.manager, async () => {
        const { source } = await postWithMirror(ids.manager, ids.dam, sweepToCompany('office_cash', m(630_000n), `${DATE}#1:office_cash`), reason, {
          skipMirror: true,
        })
        const run = await client.query<{ id: bigint }>(
          `INSERT INTO restorations (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by, run_no)
           VALUES ($1, $2::date, NULL, $3::jsonb, 630000, $4, $5, 1) RETURNING id`,
          [
            ids.dam,
            DATE,
            JSON.stringify({
              schemaVersion: 4,
              source: 'live_ledger',
              openingBalances: [
                { fundCode: 'office_cash', balance: '56300.00' },
                { fundCode: 'office_wallet', balance: '10000.00' },
              ],
              restorationJournalEntryIds: [source.id],
              legs: [leg('office_cash', 5_630_000n, 5_000_000n), leg('office_wallet', 1_000_000n, 1_000_000n)],
            }),
            reason,
            ids.manager,
          ],
        )
        // Without its run, the branch manager's mirror is refused…
        const [half] = await ledger(ids.manager).post(HQ, [restorationMirror('to_company', m(630_000n), ids.dam, source.id)], {
          ...meta(ids.manager, reason),
        })
        const mirrorRow = {
          id: randomUUID(),
          sourceBranchId: ids.dam,
          sourceEntryId: source.id,
          mirrorEntryId: half!.id,
          direction: 'to_company' as const,
          amount: m(630_000n),
          restorationId: Number(run.rows[0]!.id),
          createdBy: ids.manager,
          createdAtMs: 0,
        }
        await client.query('SAVEPOINT no_run')
        await expect(company(ids.manager).createMirror({ ...mirrorRow, restorationId: null })).rejects.toMatchObject({
          constraint: 'company_mirrors_actor_guard',
        })
        await client.query('ROLLBACK TO SAVEPOINT no_run')
        // …with it, accepted.
        await company(ids.manager).createMirror(mirrorRow)
      })
      expect(done).toBeNull()
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(pocketBefore + 630_000n)
      expect(await invariant(ids.dam)).toBe(0n)
      const stored = await client.query(`SELECT restoration_id IS NOT NULL AS linked, created_by FROM company_restoration_mirrors ORDER BY source_entry_id DESC LIMIT 1`)
      expect(stored.rows).toEqual([{ linked: true, created_by: ids.manager }])

      // A «شحن» larger than the whole company pocket: allowed, and the pocket goes negative.
      const pocket = await balance(HQ, 'company_cash:SYP_NEW')
      const shahn = pocket + 1_000n
      expect(
        await outcome(ids.gm, () =>
          postWithMirror(ids.gm, ids.dam, {
            eventType: 'manual',
            occurrenceKey: randomUUID(),
            lines: [
              { fund: { kind: 'office_cash' }, side: 'D', amount: m(shahn) },
              { fund: { kind: 'company_box' }, side: 'C', amount: m(shahn) },
            ],
          }, 'شحن يدوي أكبر من الرصيد'),
        ),
      ).toBeNull()
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(-1_000n)
      expect(await invariant(ids.dam)).toBe(0n)
      // …while an ordinary withdrawal from the negative pocket is still refused.
      const id = randomUUID()
      expectRefused(
        (await issue(ids.gm, companyWithdrawal('SYP_NEW', m(1n), id), null, 'r', (entryId) => moveRow(id, 'withdrawal', 'SYP_NEW', 1n, entryId, ids.gm, 'r'))).error,
        'company_pocket_negative_guard',
      )
      await deposit(ids.gm, 'SYP_NEW', 10_000_000n, 'تمويل')
    })

    it('keeps company_box + clearing at zero through random sweeps, top-ups and reversals', async () => {
      for (const seed of [11, 29, 47]) {
        const random = prng(seed)
        const moving: Posting[] = []
        for (let step = 0; step < 12; step++) {
          const office = random() < 0.5 ? 'office_cash' : 'office_wallet'
          const amount = m(BigInt(1 + Math.floor(random() * 50_000)))
          const pick = random()
          const key = `c2-seq-${seed}-${step}`
          let posting: Posting
          if (pick < 0.35) posting = manualKaish(office, amount, key)
          else if (pick < 0.7)
            posting = {
              eventType: 'manual',
              occurrenceKey: key,
              lines: [
                { fund: { kind: office }, side: 'D', amount },
                { fund: { kind: 'company_box' }, side: 'C', amount },
              ],
            }
          else if (moving.length > 0) posting = reverse(moving[Math.floor(random() * moving.length)]!, `${key}-rev`)
          else posting = manualKaish(office, amount, key)
          if (posting.eventType !== 'correction') moving.push(posting)
          const error = await outcome(ids.gm, () => postWithMirror(ids.gm, ids.dam, posting, `تسلسل ${seed}/${step}`))
          expect(error, `seed ${seed} step ${step}`).toBeNull()
          expect(await invariant(ids.dam)).toBe(0n)
        }
      }
      const mirrors = await company(ids.gm).listMirrors(ids.dam)
      const unmirrored = await client.query(
        `SELECT count(*)::int AS n FROM journal_lines jl JOIN funds f ON f.id = jl.fund_id
          WHERE f.branch_id = $1 AND f.code = 'company_box' AND jl.entry_id > $2
            AND NOT EXISTS (SELECT 1 FROM company_restoration_mirrors m WHERE m.source_entry_id = jl.entry_id)`,
        [ids.dam, watermark],
      )
      expect(unmirrored.rows).toEqual([{ n: 0 }])
      expect(mirrors.length).toBeGreaterThanOrEqual(36)
    })
  })

  describe('company debts, assets and depreciation repository path (0069-0071)', () => {
    it('commits a guarded debt opening and payment through the typed repository', async () => {
      const debtId = randomUUID()
      const paymentId = randomUUID()
      const principal = m(90_000n)
      const paid = m(30_000n)
      const opened = companyDebtOpen({
        debtId,
        direction: 'payable',
        currency: 'SYP_NEW',
        principal,
        origin: 'opening',
        occurrenceKey: debtId,
      })
      expect(await outcome(ids.gm, async () => {
        const entry = await post(HQ, opened, ids.gm, 'supplier opening')
        const row: CompanyDebtRecord = {
          id: debtId,
          branchId: HQ,
          direction: 'payable',
          partyName: 'Supplier',
          partyKey: 'supplier',
          currency: 'SYP_NEW',
          principal,
          sypMinorPerUsd: null,
          openedOn: DATE,
          businessDate: DATE,
          dueOn: null,
          note: 'supplier opening',
          origin: 'opening',
          expenseCategoryId: null,
          incomeCategoryId: null,
          costCenterKind: null,
          vehicleId: null,
          assetId: null,
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        }
        await finance(ids.gm).createDebt(row)
        const outstanding = companyDebtOutstanding(
          row.direction,
          await ledger(ids.gm).fundBalance(HQ, `company_payable:SYP_NEW:${debtId}`),
        )
        const payment = companyDebtPayment({
          debtId,
          direction: 'payable',
          currency: 'SYP_NEW',
          amount: paid,
          outstanding,
          paidFrom: 'owner_outside',
          occurrenceKey: paymentId,
        })
        const paymentEntry = await post(HQ, payment, ids.gm, 'first instalment')
        await finance(ids.gm).createDebtEvent({
          id: paymentId,
          debtId,
          branchId: HQ,
          kind: 'payment',
          amount: paid,
          source: 'owner_outside',
          sypMinorPerUsd: null,
          occurredOn: DATE,
          businessDate: DATE,
          reason: 'first instalment',
          journalEntryId: paymentEntry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        })
      })).toBeNull()
      expect((await finance(ids.gm).getDebt(debtId))?.principal).toBe(principal)
      expect((await finance(ids.gm).getDebtEvent(paymentId))?.amount).toBe(paid)
      expect(companyDebtOutstanding(
        'payable',
        await ledger(ids.gm).fundBalance(HQ, `company_payable:SYP_NEW:${debtId}`),
      )).toBe(m(60_000n))
    })

    it('commits an exact 36-row asset schedule and FIFO depreciation transfer', async () => {
      const assetId = randomUUID()
      const transferId = randomUUID()
      const price = m(360_000n)
      const purchase = assetPurchase({
        assetId,
        currency: 'SYP_NEW',
        price,
        paidNow: price,
        paidFrom: 'owner_outside',
        occurrenceKey: assetId,
      })
      await deposit(ids.gm, 'SYP_NEW', 100_000n, 'depreciation cash')
      expect(await outcome(ids.gm, async () => {
        const entry = await post(HQ, purchase.posting, ids.gm, 'asset purchase')
        const row: FixedAssetRecord = {
          id: assetId,
          branchId: HQ,
          kind: 'equipment',
          vehicleId: null,
          name: 'Guarded asset',
          currency: 'SYP_NEW',
          price,
          sypMinorPerUsd: null,
          purchasedOn: DATE,
          businessDate: DATE,
          usefulMonths: 36,
          paidNow: price,
          paidFrom: 'owner_outside',
          debtId: null,
          description: 'asset purchase',
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        }
        await finance(ids.gm).createAsset(row)
        await finance(ids.gm).createAssetSchedule(depreciationSchedule(assetId, price, DATE))
      })).toBeNull()
      expect(await finance(ids.gm).listAssetSchedule(assetId)).toHaveLength(36)

      expect(await outcome(ids.gm, async () => {
        const assetIds = new Set((await finance(ids.gm).listAssets(HQ))
          .filter((asset) => asset.currency === 'SYP_NEW')
          .map((asset) => asset.id))
        const schedule = (await finance(ids.gm).listAssetSchedule()).filter((row) => assetIds.has(row.assetId))
        const funded = await finance(ids.gm).listDepreciationAllocations(HQ, 'SYP_NEW')
        const available = await ledger(ids.gm).fundBalance(HQ, 'company_cash:SYP_NEW')
        const plan = planDepreciationTransfer({ schedule, funded, asOfMonth: '2026-09-01', available })
        expect(plan.transferAmount).toBeGreaterThan(0n)
        expect(plan.allocations.map((allocation) => ({
          assetId: allocation.assetId,
          period: allocation.period,
          periodMonth: allocation.periodMonth,
        }))).toEqual([{ assetId, period: 1, periodMonth: '2026-09-01' }])
        const entry = await post(
          HQ,
          depreciationTransfer('SYP_NEW', plan.transferAmount, transferId),
          ids.gm,
          'monthly depreciation',
        )
        await finance(ids.gm).createDepreciationTransfer({
          id: transferId,
          branchId: HQ,
          currency: 'SYP_NEW',
          amount: plan.transferAmount,
          expectedAmount: plan.transferAmount,
          sypMinorPerUsd: null,
          asOfMonth: '2026-09-01',
          businessDate: DATE,
          reason: 'monthly depreciation',
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        }, plan.allocations.map((allocation) => ({
          transferId,
          assetId: allocation.assetId,
          period: allocation.period,
          amount: allocation.amount,
        })))
      })).toBeNull()
      expect((await finance(ids.gm).listDepreciationTransfers(HQ)).some((row) => row.id === transferId)).toBe(true)
      expect((await finance(ids.gm).listDepreciationAllocations(HQ, 'SYP_NEW'))
        .filter((row) => row.transferId === transferId).length).toBeGreaterThan(0)
    })

    it('keeps an asset installment as a plan around the existing payable payment, never an expense', async () => {
      const assetId = randomUUID()
      const debtId = randomUUID()
      const planId = randomUUID()
      const paymentId = randomUUID()
      const price = m(900n)
      const installment = m(300n)
      const expensesBefore = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM company_expenses')
      const purchase = assetPurchase({
        assetId,
        currency: 'SYP_NEW',
        price,
        paidNow: m(0n),
        paidFrom: 'owner_outside',
        debtId,
        occurrenceKey: assetId,
      })
      expect(await outcome(ids.gm, async () => {
        const entry = await post(HQ, purchase.posting, ids.gm, 'financed terminal')
        const asset: FixedAssetRecord = {
          id: assetId,
          branchId: HQ,
          kind: 'equipment',
          vehicleId: null,
          name: 'Installment terminal',
          currency: 'SYP_NEW',
          price,
          sypMinorPerUsd: null,
          purchasedOn: DATE,
          businessDate: DATE,
          usefulMonths: 36,
          paidNow: m(0n),
          paidFrom: 'owner_outside',
          debtId,
          description: 'financed terminal',
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        }
        const debt: CompanyDebtRecord = {
          id: debtId,
          branchId: HQ,
          direction: 'payable',
          partyName: 'Terminal supplier',
          partyKey: 'terminal supplier',
          currency: 'SYP_NEW',
          principal: price,
          sypMinorPerUsd: null,
          openedOn: DATE,
          businessDate: DATE,
          dueOn: null,
          note: null,
          origin: 'asset_purchase',
          expenseCategoryId: null,
          incomeCategoryId: null,
          costCenterKind: null,
          vehicleId: null,
          assetId,
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        }
        await finance(ids.gm).createAsset(asset)
        await finance(ids.gm).createDebt(debt)
        await finance(ids.gm).createAssetSchedule(depreciationSchedule(assetId, price, DATE))
        await finance(ids.gm).createAssetInstallmentPlan({
          id: planId,
          assetId,
          debtId,
          branchId: HQ,
          currency: 'SYP_NEW',
          amount: installment,
          paidFrom: 'owner_outside',
          scheduleKind: 'weekly',
          weekday: 4,
          intervalDays: null,
          startsOn: DATE,
          active: true,
          deactivatedOn: null,
          deactivatedAtMs: null,
          deactivatedBy: null,
          deactivationReason: null,
          createdBy: ids.gm,
          createdAtMs: 0,
        })
      })).toBeNull()

      expect((await finance(ids.gm).listAssetInstallmentPlans(assetId)).map((row) => row.id)).toEqual([planId])
      expect(await outcome(ids.gm, async () => {
        const outstanding = companyDebtOutstanding(
          'payable',
          await ledger(ids.gm).fundBalance(HQ, `company_payable:SYP_NEW:${debtId}`),
        )
        const payment = companyDebtPayment({
          debtId,
          direction: 'payable',
          currency: 'SYP_NEW',
          amount: installment,
          outstanding,
          paidFrom: 'owner_outside',
          occurrenceKey: paymentId,
        })
        const entry = await post(HQ, payment, ids.gm, 'terminal installment')
        await finance(ids.gm).createDebtEvent({
          id: paymentId,
          debtId,
          branchId: HQ,
          kind: 'payment',
          amount: installment,
          source: 'owner_outside',
          sypMinorPerUsd: null,
          occurredOn: DATE,
          businessDate: DATE,
          reason: 'terminal installment',
          journalEntryId: entry.id,
          createdBy: ids.gm,
          createdAtMs: 0,
        })
        await finance(ids.gm).createAssetInstallmentOccurrence({
          id: paymentId,
          planId,
          branchId: HQ,
          dueDate: DATE,
          status: 'paid',
          debtEventId: paymentId,
          reason: null,
          actedBy: ids.gm,
          actedAtMs: 0,
        })
      })).toBeNull()
      expect(await finance(ids.gm).getAssetInstallmentOccurrence(planId, DATE)).toMatchObject({
        debtEventId: paymentId,
        status: 'paid',
      })
      const expenses = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM company_expenses')
      expect(expenses.rows).toEqual(expensesBefore.rows)
    })
  })
}
