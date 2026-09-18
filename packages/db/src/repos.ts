import type {
  AuditFilter,
  AuditRecord,
  AuditRepo,
  CashDeductionRecord,
  CashDeductionRepo,
  FxRepo,
  JournalEntryRecord,
  LedgerRepo,
  OperationBatch,
  OperationBatchRepo,
  OperationWindowRepo,
  OrderRepo,
  SessionRecord,
  SessionRepo,
  OrderPointRecord,
  ShiftOrderRecord,
  TreasuryPositionRecord,
  TreasuryPositionSource,
  TreasuryMovementFilter,
  TreasuryMovementPage,
  UserRecord,
  UserRepo,
  WalletMovementInput,
  WalletMovementRecord,
  WalletMovementRepo,
  WalletMovementRole,
} from '@ash/contracts'
import { normalizeUsername } from '@ash/contracts'
import {
  type CalendarDate,
  type Currency,
  type FundRef,
  type FxDay,
  type Minor,
  type Posting,
  currencyOf,
  fundCode,
  minor,
  postingBalanceProblem,
} from '@ash/domain'
import { PG, type Pool, type PoolClient, isPgError, withTransaction } from './pool.ts'

/**
 * PostgreSQL implementations of the ports.
 *
 * These pass the same conformance suite as the in-memory adapters — see
 * `packages/db/test/conformance.test.ts`. Where the database enforces an invariant with a
 * constraint or a trigger, these adapters translate the Postgres error code into the same
 * behaviour the memory adapter produces, so the layer above cannot tell them apart.
 */

/**
 * Stable fund identity — the domain's `fundCode`, re-exported under its historical name.
 *
 * There used to be three copies of this switch (domain, here, memory adapter) held together only by
 * the conformance suite comparing strings. Now there is one: a new fund kind cannot be coded one way
 * in PostgreSQL and another in the fake.
 */
export const fundCodeOf: (fund: FundRef) => string = fundCode

/**
 * Which `fund_type` enum value a fund maps to. EXHAUSTIVE: a new kind that is not decided here
 * fails to compile rather than quietly landing under some default.
 */
export function fundTypeOf(fund: FundRef): string {
  switch (fund.kind) {
    case 'company_revenue':
    case 'yalago_income':
    case 'fee_earned':
    // `other_income` joins them for the same reason, and WITHOUT this line the first direct income
    // would try to insert 'other_income'::fund_type and fail at 22P02 — the enum has no such value
    // and deliberately gains none, because this is a P&L account and not a box anyone counts.
    case 'other_income':
    case 'cost_center':
      // Not in the client's literal E-1 tree; they are the P&L accounts the tree implies.
      return 'cost_center'
    case 'office_cash':
    case 'office_wallet':
    case 'driver_cash':
    case 'driver_wallet':
    case 'yalago_share':
    case 'driver_share_payable':
    case 'company_box':
    case 'driver_receivable_cash':
    case 'driver_receivable_wallet':
    case 'driver_shift_funding_cash':
    case 'driver_shift_funding_wallet':
    // A سلفة is a COUNTED asset like a ذمة, not a P&L account: its own enum value (0055).
    case 'advance_receivable_cash':
    case 'advance_receivable_wallet':
    // The company ledger (0065). Each is its own enum value — none may hide under cost_center,
    // because 0066's partition and pocket guards read the TYPE.
    case 'company_cash':
    case 'depreciation_reserve':
    case 'company_fx_position':
    case 'branch_clearing':
    case 'company_payable':
    case 'company_receivable':
    case 'fixed_asset':
    case 'company_expense':
    case 'company_income':
    case 'company_equity':
      return fund.kind
    default: {
      const unreachable: never = fund
      throw new RangeError(`no fund_type for ${JSON.stringify(unreachable)}`)
    }
  }
}

/** Raised when a stored fund's currency disagrees with the currency its reference implies. */
export class FundCurrencyMismatchError extends Error {
  readonly code = 'fund_currency_mismatch'
  readonly fundCode: string
  readonly stored: string
  readonly expected: Currency
  constructor(fundCode: string, stored: string, expected: Currency) {
    super(`fund_currency_mismatch: fund ${fundCode} is stored in ${stored}, the posting expects ${expected}`)
    this.name = 'FundCurrencyMismatchError'
    this.fundCode = fundCode
    this.stored = stored
    this.expected = expected
  }
}

/**
 * Funds are created on first use.
 *
 * The client's tree has one cash and one wallet fund PER DRIVER (E-1), so provisioning them
 * lazily is simpler and less error-prone than a trigger on `drivers` that has to be kept in
 * step with every future fund type.
 */
async function ensureFund(client: PoolClient, branchId: string, fund: FundRef): Promise<string> {
  const code = fundCode(fund)
  const currency = currencyOf(fund)
  // A cost centre owned by a VEHICLE carries that vehicle's uuid; a NAMED contra account
  // ("opening_balance", "owner_funding", "adjustments") has no owner and is owner_kind='none'.
  // Getting this wrong trips funds_owner_ck: CHECK ((owner_kind='none') = (owner_id IS NULL)).
  // Every company account is owner_kind='none' with its identity in the code, as an advance is.
  const costUuid = 'costCenterId' in fund ? toUuidOrNull(fund.costCenterId) : null
  const ownerId = 'driverId' in fund ? fund.driverId : costUuid
  const ownerKind = 'driverId' in fund ? 'driver' : costUuid !== null ? 'vehicle' : 'none'

  const found = await client.query<{ id: string; currency: string }>(
    'SELECT id, currency FROM funds WHERE branch_id = $1 AND code = $2',
    [branchId, code],
  )
  const existing = found.rows[0]
  if (existing) {
    // The fund's currency is its lines' currency. A row that disagrees with the reference would
    // silently post dollars into a lira account, or the reverse — refuse by name instead.
    if (existing.currency !== currency) throw new FundCurrencyMismatchError(code, existing.currency, currency)
    return existing.id
  }

  const inserted = await client.query<{ id: string; currency: string }>(
    `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar, currency)
     VALUES ($1, $2::fund_type, $3, $4, $5, $5, $6)
     ON CONFLICT (branch_id, code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, currency`,
    [branchId, fundTypeOf(fund), ownerKind, ownerId, code, currency],
  )
  const row = inserted.rows[0]!
  // A concurrent writer may have created the row first; the conflict path returns ITS currency.
  if (row.currency !== currency) throw new FundCurrencyMismatchError(code, row.currency, currency)
  return row.id
}

/**
 * The application-side copy of 0066's COMMIT-time rules, so a bad posting fails with a clear error
 * before any row is staged: balanced per currency, two currencies only for an exchange, and a USD
 * line exactly when the entry freezes a rate. The memory adapter runs the same checks.
 */
function assertPostingBalances(posting: Posting, sypMinorPerUsd: bigint | null): void {
  const problem = postingBalanceProblem(posting)
  if (problem?.kind === 'unbalanced') {
    throw new Error(
      `unbalanced posting ${posting.eventType}: D ${problem.debits} <> C ${problem.credits}` +
        (problem.currency === 'SYP_NEW' ? '' : ` in ${problem.currency}`),
    )
  }
  if (problem?.kind === 'mixed_currency') {
    throw new Error(
      `posting ${posting.eventType} spans ${problem.currencies.join(' + ')}; only company_fx_exchange (or its company_correction reversal) may span two currencies`,
    )
  }
  const hasUsd = posting.lines.some((line) => currencyOf(line.fund) === 'USD')
  if (hasUsd && sypMinorPerUsd === null) {
    throw new Error(`posting ${posting.eventType} has a USD line but no frozen syp_minor_per_usd`)
  }
  if (!hasUsd && sypMinorPerUsd !== null) {
    throw new Error(`posting ${posting.eventType} freezes a USD rate but has no USD line`)
  }
  if (sypMinorPerUsd !== null && sypMinorPerUsd <= 0n) {
    throw new Error(`posting ${posting.eventType} freezes a non-positive rate ${sypMinorPerUsd}`)
  }
}

/** Driver ids in this system are uuids; a non-uuid (test fixture) becomes NULL rather than an error. */
function toUuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
}

/**
 * The lines of a journal entry as one JSON array, for a query that joins `journal_lines jl` and
 * `funds f` and groups by `je.id`. Amounts travel as TEXT and are parsed to BigInt — never through a
 * JSON number.
 */
export const JOURNAL_LINES_JSON = `COALESCE(
  json_agg(json_build_object('fundCode', f.code, 'side', jl.side,
                             'amount', jl.amount_minor::text, 'role', jl.line_role,
                             'currency', f.currency)
           ORDER BY jl.id) FILTER (WHERE jl.id IS NOT NULL), '[]'
)`

/** One `journal_entries` row, with its `lines` from `JOURNAL_LINES_JSON`, as the port's record. */
export function journalEntryFromRow(r: Record<string, unknown>): JournalEntryRecord {
  return {
    id: Number(r.id),
    branchId: String(r.branch_id),
    eventType: r.event_type as JournalEntryRecord['eventType'],
    shiftId: (r.shift_id as string | null) ?? null,
    occurrenceKey: String(r.occurrence_key),
    businessDate: isoDate(r.business_date),
    postingDate: isoDate(r.posting_date),
    weekStartDate: isoDate(r.week_start_date),
    fxDayId: Number(r.fx_day_id),
    // int8 is parsed to bigint by the pool (pool.ts), so this is already exact.
    sypMinorPerUsd: r.syp_minor_per_usd === null || r.syp_minor_per_usd === undefined
      ? null
      : BigInt(r.syp_minor_per_usd as bigint),
    weekLockId: r.week_lock_id === null ? null : Number(r.week_lock_id),
    reason: (r.reason as string | null) ?? null,
    createdBy: String(r.created_by),
    createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at)),
    // amount comes back as ::text and is parsed to BigInt here — never through Number().
    lines: (
      r.lines as Array<{ fundCode: string; side: 'D' | 'C'; amount: string; role: string | null; currency: Currency }>
    ).map((l) => ({
      fundCode: l.fundCode,
      side: l.side,
      amount: minor(BigInt(l.amount)),
      currency: l.currency,
      ...(l.role === null ? {} : { role: l.role }),
    })),
  }
}

export class PgLedgerRepo implements LedgerRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async post(
    branchId: string,
    postings: readonly Posting[],
    meta: Parameters<LedgerRepo['post']>[2],
  ): Promise<JournalEntryRecord[]> {
    return withTransaction(this.pool, { actorId: meta.createdBy }, async (client) => {
      // One branch-money lock covers every ledger writer. Restoration takes this same lock before
      // comparing the sealed count's frozen balance with the live ledger, so a manual entry or
      // expense cannot slip between that check and its reconciliation/restoration postings.
      // Shift open/close and direct receivables already use this namespace; reacquiring the same
      // transaction-scoped advisory lock is harmless and keeps lock ordering consistent.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `ash:financial:receivables:${branchId}`,
      ])
      const written: JournalEntryRecord[] = []

      for (const posting of postings) {
        // Balance is ALSO enforced by a deferred constraint trigger at COMMIT. Checking here
        // first turns it into a clear application error instead of a transaction that fails at
        // the very end with every other posting already staged. Per currency, with the one
        // two-currency exception, exactly as 0066's trigger — through the domain's single rule.
        assertPostingBalances(posting, meta.sypMinorPerUsd)

        /*
         * ON CONFLICT DO NOTHING, not a caught unique violation.
         *
         * This used to `try { INSERT } catch (23505) { continue }`. In PostgreSQL a statement
         * error ABORTS THE WHOLE TRANSACTION: every later statement fails with 25P02, and — the
         * part that made it dangerous — `COMMIT` on an aborted block silently performs a ROLLBACK
         * and reports success. Catching the error does not recover the transaction; only
         * `ROLLBACK TO SAVEPOINT` would, and `withTransaction` opens none.
         *
         * So a replayed approval had two failure modes, both real. If the duplicate came first,
         * the NEXT posting raised 25P02, which is not a unique violation, so it was rethrown and
         * the manager got a 500 on a shift that could then never be approved. If the duplicate
         * came later, everything before it was rolled back while this function still RETURNED the
         * rows it believed it had written — money reported as posted that was not.
         *
         * Neither was visible in tests: `MemoryLedgerRepo` implements the `continue` correctly
         * because an array has no transaction to poison, and the Postgres conformance suite only
         * ever posted one posting per call — precisely the case where the difference cannot show.
         *
         * An empty `rows` is now the replay signal, no exception is raised, and the transaction
         * stays healthy. `DO NOTHING` with no conflict target covers the idempotency index.
         */
        const res = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO journal_entries
             (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
              week_start_date, fx_day_id, reason, created_by, syp_minor_per_usd)
           VALUES ($1, $2::ledger_event, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT DO NOTHING
           RETURNING id, created_at`,
          [
            branchId,
            posting.eventType,
            meta.shiftId,
            posting.occurrenceKey,
            meta.businessDate,
            meta.postingDate,
            meta.weekStartDate,
            meta.fxDayId,
            meta.reason ?? null,
            meta.createdBy,
            meta.sypMinorPerUsd === null ? null : meta.sypMinorPerUsd.toString(),
          ],
        )
        // Already posted. Writing nothing and carrying on is the whole point — a retried
        // approval must not double-post — and now the rest of the batch still posts.
        if (res.rows.length === 0) continue
        const entryId = Number(res.rows[0]!.id)

        for (const line of posting.lines) {
          const fundId = await ensureFund(client, branchId, line.fund)
          await client.query(
            'INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor, line_role) VALUES ($1, $2, $3, $4, $5)',
            [entryId, fundId, line.side, line.amount.toString(), line.role ?? null],
          )
        }

        written.push({
          id: entryId,
          branchId,
          eventType: posting.eventType,
          shiftId: meta.shiftId,
          occurrenceKey: posting.occurrenceKey,
          businessDate: meta.businessDate,
          postingDate: meta.postingDate,
          weekStartDate: meta.weekStartDate,
          fxDayId: meta.fxDayId,
          sypMinorPerUsd: meta.sypMinorPerUsd,
          weekLockId: null,
          reason: meta.reason ?? null,
          createdBy: meta.createdBy,
          createdAtMs: res.rows[0]!.created_at.getTime(),
          lines: posting.lines.map((l) => ({
            fundCode: fundCode(l.fund),
            side: l.side,
            amount: l.amount,
            currency: currencyOf(l.fund),
            ...(l.role === undefined ? {} : { role: l.role }),
          })),
        })
      }
      return written
    })
  }

  async listByShift(shiftId: string): Promise<JournalEntryRecord[]> {
    return this.load('je.shift_id = $1', [shiftId])
  }

  async listByWeek(branchId: string, weekStartDate: CalendarDate): Promise<JournalEntryRecord[]> {
    return this.load('je.branch_id = $1 AND je.week_start_date = $2', [branchId, weekStartDate])
  }

  async listTreasuryMovements(
    branchId: string,
    filter: TreasuryMovementFilter,
  ): Promise<TreasuryMovementPage> {
    const params: unknown[] = [branchId, filter.from, filter.to]
    // A journal that debits and credits the same office fund by the same amount mentions the
    // treasury but does not move it. It must not become a misleading “internal transfer”.
    const conditions: string[] = ['(office.cash <> 0 OR office.wallet <> 0)']
    const add = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }
    if (filter.eventType !== undefined) conditions.push(`je.event_type::text = ${add(filter.eventType)}`)
    if (filter.actorId !== undefined) conditions.push(`je.created_by::text = ${add(filter.actorId)}`)
    if (filter.query !== undefined) {
      conditions.push(`strpos(lower(COALESCE(je.reason, '')), lower(${add(filter.query)})) > 0`)
    }
    if (filter.beforeId !== undefined) conditions.push(`je.id < ${add(filter.beforeId)}`)
    if (filter.channel === 'cash') conditions.push('office.cash <> 0')
    if (filter.channel === 'wallet') conditions.push('office.wallet <> 0')
    if (filter.flow === 'in') conditions.push('(office.cash + office.wallet) > 0')
    if (filter.flow === 'out') conditions.push('(office.cash + office.wallet) < 0')
    if (filter.flow === 'internal') {
      conditions.push('(office.cash + office.wallet) = 0 AND (office.cash <> 0 OR office.wallet <> 0)')
    }
    const limitParam = add(filter.limit + 1)
    const filteredWhere = `WHERE ${conditions.join(' AND ')}`

    const rowsQuery = this.pool.query<Record<string, unknown>>(
      `WITH office AS (
         SELECT je.id,
                COALESCE(SUM(CASE WHEN f.code = 'office_cash'
                                  THEN CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END
                                  ELSE 0 END), 0)::bigint AS cash,
                COALESCE(SUM(CASE WHEN f.code = 'office_wallet'
                                  THEN CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END
                                  ELSE 0 END), 0)::bigint AS wallet
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN funds f ON f.id = jl.fund_id
          WHERE je.branch_id = $1
            AND je.business_date BETWEEN $2 AND $3
            AND f.code IN ('office_cash', 'office_wallet')
          GROUP BY je.id
       )
       SELECT je.*, ${JOURNAL_LINES_JSON} AS lines
         FROM office
         JOIN journal_entries je ON je.id = office.id
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
         LEFT JOIN funds f ON f.id = jl.fund_id
         ${filteredWhere}
        GROUP BY je.id, office.cash, office.wallet
        ORDER BY je.id DESC
        LIMIT ${limitParam}`,
      params,
    )
    const facetsQuery = this.pool.query<{ event_types: string[] | null; actor_ids: string[] | null }>(
      `SELECT array_agg(DISTINCT je.event_type::text ORDER BY je.event_type::text) AS event_types,
              array_agg(DISTINCT je.created_by::text ORDER BY je.created_by::text) AS actor_ids
         FROM journal_entries je
        WHERE je.branch_id = $1
          AND je.business_date BETWEEN $2 AND $3
          AND EXISTS (
            SELECT 1
              FROM journal_lines jl
              JOIN funds f ON f.id = jl.fund_id
             WHERE jl.entry_id = je.id AND f.code IN ('office_cash', 'office_wallet')
             GROUP BY jl.entry_id
            HAVING SUM(CASE WHEN f.code = 'office_cash'
                             THEN CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END
                             ELSE 0 END) <> 0
                OR SUM(CASE WHEN f.code = 'office_wallet'
                             THEN CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END
                             ELSE 0 END) <> 0
          )`,
      [branchId, filter.from, filter.to],
    )
    const [pageResult, facetResult] = await Promise.all([rowsQuery, facetsQuery])
    const page = pageResult.rows.map(journalEntryFromRow)
    const hasMore = page.length > filter.limit
    const entries = hasMore ? page.slice(0, filter.limit) : page
    const facets = facetResult.rows[0]
    return {
      entries,
      nextBeforeId: hasMore ? (entries.at(-1)?.id ?? null) : null,
      eventTypes: (facets?.event_types ?? []) as TreasuryMovementPage['eventTypes'],
      actorIds: facets?.actor_ids ?? [],
    }
  }

  async findStandaloneEntry(
    branchId: string,
    eventType: JournalEntryRecord['eventType'],
    occurrenceKey: string,
  ): Promise<JournalEntryRecord | null> {
    // `shift_id IS NULL` is the COALESCE(shift_id::text, '') = '' half of je_idempotency_uq (0017),
    // so this can match at most one row.
    const rows = await this.load(
      'je.branch_id = $1 AND je.event_type = $2::ledger_event AND je.shift_id IS NULL AND je.occurrence_key = $3',
      [branchId, eventType, occurrenceKey],
    )
    return rows[0] ?? null
  }

  private async load(where: string, params: unknown[]): Promise<JournalEntryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT je.*, ${JOURNAL_LINES_JSON} AS lines
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
         LEFT JOIN funds f ON f.id = jl.fund_id
        WHERE ${where}
        GROUP BY je.id
        ORDER BY je.id`,
      params,
    )
    return rows.map(journalEntryFromRow)
  }

  async fundBalance(branchId: string, fundCode: string): Promise<Minor> {
    const { rows } = await this.pool.query<{ balance: string | null }>(
      `SELECT COALESCE(SUM(CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0)::text AS balance
         FROM journal_lines jl
         JOIN funds f ON f.id = jl.fund_id
        WHERE f.branch_id = $1 AND f.code = $2`,
      [branchId, fundCode],
    )
    return minor(BigInt(rows[0]?.balance ?? '0'))
  }

  /** Every fund under a code prefix, in one query — الترميم needs Σ الذمم across all drivers. */
  async balancesByPrefix(branchId: string, prefix: string): Promise<Record<string, bigint>> {
    const { rows } = await this.pool.query<{ code: string; balance: string }>(
      `SELECT f.code,
              COALESCE(SUM(CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0)::text AS balance
         FROM funds f
         LEFT JOIN journal_lines jl ON jl.fund_id = f.id
        WHERE f.branch_id = $1 AND left(f.code, char_length($2)) = $2
        GROUP BY f.code`,
      [branchId, prefix],
    )
    return Object.fromEntries(rows.map((r) => [r.code, BigInt(r.balance)]))
  }
}

/**
 * «رأس مال المكتب» — effective-dated, resolved like a tier rule.
 *
 * The status filter includes 'superseded' deliberately. Filtering on 'active' alone would make
 * every historical day resolve to nothing the moment a successor target is published, silently
 * restating the profit of every ترميم already run — the exact trap CLAUDE.md records for tiers.
 */
export class PgOfficeCapitalTargetRepo {
  // Explicit field, not a parameter property: Node's strip-only type stripping cannot erase those.
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async resolve(
    branchId: string,
    businessDate: string,
  ): Promise<Partial<Record<'office_cash' | 'office_wallet', Minor>>> {
    const { rows } = await this.pool.query<{ fund_code: string; target_minor: string }>(
      `SELECT DISTINCT ON (fund_code) fund_code, target_minor::text
         FROM office_capital_targets
        WHERE branch_id = $1
          AND effective_from <= $2
          AND status IN ('active', 'superseded')
        ORDER BY fund_code, effective_from DESC`,
      [branchId, businessDate],
    )
    const out: Partial<Record<'office_cash' | 'office_wallet', Minor>> = {}
    for (const r of rows) out[r.fund_code as 'office_cash'] = minor(BigInt(r.target_minor))
    return out
  }

  async upsert(row: {
    branchId: string
    fundCode: 'office_cash' | 'office_wallet'
    target: Minor
    effectiveFrom: string
    createdBy: string
    note: string | null
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO office_capital_targets (branch_id, fund_code, target_minor, effective_from, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (branch_id, fund_code, effective_from)
       DO UPDATE SET target_minor = EXCLUDED.target_minor,
                     note = EXCLUDED.note,
                     created_by = EXCLUDED.created_by,
                     created_at = now()
       WHERE office_capital_targets.target_minor IS DISTINCT FROM EXCLUDED.target_minor
          OR office_capital_targets.note IS DISTINCT FROM EXCLUDED.note
          OR office_capital_targets.created_by IS DISTINCT FROM EXCLUDED.created_by`,
      [row.branchId, row.fundCode, row.target.toString(), row.effectiveFrom, row.createdBy, row.note],
    )
  }
}

/** «الترميم» — once per branch per working day, enforced by the unique index, not by a check. */
export class PgRestorationRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(row: {
    branchId: string
    businessDate: string
    cashCountId: string | null
    plan: unknown
    netToCompany: Minor
    reason: string
    performedBy: string
    runNo: number
  }): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ id: bigint | string | number }>(
        `INSERT INTO restorations (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by, run_no)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
         RETURNING id`,
        [
          row.branchId,
          row.businessDate,
          row.cashCountId,
          JSON.stringify(row.plan),
          row.netToCompany.toString(),
          row.reason,
          row.performedBy,
          row.runNo,
        ],
      )
      // The company mirror of each journal of this run names the row (C2). A driver that does not
      // echo RETURNING is not one this system runs on; say so rather than invent an id.
      const id = rows[0]?.id
      if (id === undefined || id === null) throw new Error('restorations insert returned no id')
      return Number(id)
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        // Two managers racing the same run number inside the branch-money lock. The loser is told,
        // rather than quietly posting the same movement twice under a different key.
        throw Object.assign(new Error('restoration run already recorded'), { code: 'DUPLICATE_RESTORATION' })
      }
      throw err
    }
  }

  /** How many runs that business date already holds; the next run is this plus one. */
  async runsOnDay(branchId: string, businessDate: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM restorations WHERE branch_id = $1 AND business_date = $2',
      [branchId, businessDate],
    )
    return Number(rows[0]?.n ?? '0')
  }

  /** The LATEST run of that day. Since 0061 a day may hold several. */
  async find(branchId: string, businessDate: string) {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM restorations WHERE branch_id = $1 AND business_date = $2 ORDER BY run_no DESC LIMIT 1',
      [branchId, businessDate],
    )
    const r = rows[0]
    if (!r) return null
    return {
      branchId: String(r.branch_id),
      businessDate: String(r.business_date).slice(0, 10),
      cashCountId: r.cash_count_id === null ? null : String(r.cash_count_id),
      plan: r.plan,
      netToCompany: minor(BigInt(String(r.net_to_company_minor))),
      reason: String(r.reason),
      performedBy: String(r.performed_by),
      runNo: Number(r.run_no ?? 1),
    }
  }
}

/** Postgres `date` comes back as a JS Date in local time; format it back without a timezone hop. */
export function isoDate(value: unknown): CalendarDate {
  if (typeof value === 'string') return value.slice(0, 10)
  const d = value as Date
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class PgOrderRepo implements OrderRepo {
  private readonly pool: Pool
  private readonly transactionClient: PoolClient | null
  constructor(pool: Pool, transactionClient: PoolClient | null = null) {
    this.pool = pool
    this.transactionClient = transactionClient
  }

  private mutate<T>(actorId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transactionClient ? fn(this.transactionClient) : withTransaction(this.pool, { actorId }, fn)
  }
  /**
   * Keep the fee's own pixels beside what the reader made of them. See `ocr_fee_samples` (0019).
   *
   * `ON CONFLICT DO NOTHING` because a close is re-submittable and the same strip must not stack.
   * The approved fee is deliberately NOT copied here — it is joined from `shift_orders.fee_minor`
   * at export time, so this table can never drift out of agreement with the money.
   */
  async recordOcrSample(shiftOrderId: string, source: 'ocr' | 'refused', stripPng: Uint8Array): Promise<void> {
    await this.pool.query(
      `INSERT INTO ocr_fee_samples (shift_order_id, source, strip_png)
       VALUES ($1, $2, $3) ON CONFLICT (shift_order_id) DO NOTHING`,
      [shiftOrderId, source, Buffer.from(stripPng)],
    )
  }

  async recordShiftOcrSample(input: {
    shiftId: string
    package: 'start' | 'end'
    kind: 'wallet' | 'odometer'
    source: 'ocr' | 'refused'
    stripPng: Uint8Array
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ocr_samples (kind, shift_id, package, source, strip_png)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shift_id, package, kind) WHERE kind <> 'fee' DO NOTHING`,
      [input.kind, input.shiftId, input.package, input.source, Buffer.from(input.stripPng)],
    )
  }

  async listOcrSamples(kind: 'fee' | 'wallet' | 'odometer'): Promise<
    Array<{
      id: string
      kind: string
      shiftOrderId: string | null
      shiftId: string | null
      package: string | null
      source: 'ocr' | 'refused'
      stripPng: Uint8Array
    }>
  > {
    // `ocr_fee_samples` (0019) is still the home of fee strips; 0022 covers the rest. Reading both
    // here keeps the export one call rather than making every caller know the history.
    const { rows } =
      kind === 'fee'
        ? await this.pool.query<Record<string, unknown>>(
            `SELECT id::text, 'fee' AS kind, shift_order_id, NULL::uuid AS shift_id, NULL::text AS package,
                    source, strip_png FROM ocr_fee_samples ORDER BY id`,
          )
        : await this.pool.query<Record<string, unknown>>(
            `SELECT id::text, kind, shift_order_id, shift_id, package, source, strip_png
               FROM ocr_samples WHERE kind = $1 ORDER BY id`,
            [kind],
          )
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      shiftOrderId: (r.shift_order_id as string | null) ?? null,
      shiftId: (r.shift_id as string | null) ?? null,
      package: (r.package as string | null) ?? null,
      source: r.source as 'ocr' | 'refused',
      stripPng: new Uint8Array(r.strip_png as Buffer),
    }))
  }

  async create(order: ShiftOrderRecord, actorId: string | null): Promise<void> {
    try {
      // The order and its route go in together: a manual job whose points failed to write would be
      // a delivery from nowhere to nowhere, and the manager would have no way to see it went wrong.
      await this.mutate(actorId, async (client) => {
        await client.query(
          `INSERT INTO shift_orders (id, shift_id, provider_order_no, pay_mode, fee_minor, zone, driver_confirmed,
                                     source, fee_ocr_minor, kind, driver_share_minor, company_share_minor, notes, created_by,
                                     included, wallet_amount_minor, occurred_minute, occurred_date,
                                     window_status, decision_reason, decided_by, decided_at,
                                     window_basis, position_evidence, close_draft_observation_id,
                                     close_draft_client_key, close_draft_review_reasons)
           VALUES ($1, $2, $3, $4::pay_mode, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                   $19, $20, $21, $22::timestamptz, $23, $24::jsonb, $25, $26, $27::jsonb)`,
          [
            order.id,
            order.shiftId,
            order.providerOrderNo,
            order.payMode,
            order.fee.toString(),
            order.zone,
            order.driverConfirmed,
            order.source,
            order.feeOcr?.toString() ?? null,
            order.kind,
            order.driverShare?.toString() ?? null,
            order.companyShare?.toString() ?? null,
            order.notes,
            order.createdBy,
            order.included,
            order.walletAmount?.toString() ?? null,
            order.occurredMinute,
            order.occurredDate,
            order.windowStatus,
            order.decisionReason,
            order.decidedBy,
            order.decidedAt,
            order.windowBasis ?? null,
            order.positionEvidence === null || order.positionEvidence === undefined
              ? null
              : JSON.stringify(order.positionEvidence),
            order.observationId ?? null,
            order.closeDraftClientKey ?? null,
            JSON.stringify(order.closeDraftReviewReasons ?? []),
          ],
        )
        for (const [i, point] of order.points.entries()) {
          await client.query(
            `INSERT INTO shift_order_points (order_id, seq, role, label, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)`,
            [order.id, i + 1, point.role, point.label, point.lat, point.lng],
          )
        }
      })
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        // Same shape the memory adapter throws, so callers handle one case, not two.
        throw Object.assign(new Error(`duplicate provider_order_no ${order.providerOrderNo}`), {
          code: 'DUPLICATE_ORDER_NO',
        })
      }
      throw err
    }
  }
  /** Identity — the shift and the order number — is never touched; only what a human may correct. */
  async update(order: ShiftOrderRecord, actorId: string | null): Promise<void> {
    await this.mutate(actorId, async (client) => {
      await client.query(
        `UPDATE shift_orders
            SET pay_mode = $2::pay_mode, fee_minor = $3, zone = $4, source = $5, fee_ocr_minor = $6,
                notes = $7, included = $8, wallet_amount_minor = $9, occurred_minute = $10,
                occurred_date = $11, window_status = $12, decision_reason = $13,
                decided_by = $14, decided_at = $15::timestamptz,
                window_basis = $16, position_evidence = $17::jsonb,
                close_draft_observation_id = $18, close_draft_client_key = $19,
                close_draft_review_reasons = $20::jsonb,
                removed_at = $21::timestamptz, removed_by = $22, removal_reason = $23
          WHERE id = $1`,
        [
          order.id,
          order.payMode,
          order.fee.toString(),
          order.zone,
          order.source,
          order.feeOcr?.toString() ?? null,
          order.notes,
          order.included,
          order.walletAmount?.toString() ?? null,
          order.occurredMinute,
          order.occurredDate,
          order.windowStatus,
          order.decisionReason,
          order.decidedBy,
          order.decidedAt,
          order.windowBasis ?? null,
          order.positionEvidence === null || order.positionEvidence === undefined
            ? null
            : JSON.stringify(order.positionEvidence),
          order.observationId ?? null,
          order.closeDraftClientKey ?? null,
          JSON.stringify(order.closeDraftReviewReasons ?? []),
          order.removedAt ?? null,
          order.removedBy ?? null,
          order.removalReason ?? null,
        ],
      )
    })
  }
  async listByShift(shiftId: string): Promise<ShiftOrderRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${ORDER_COLUMNS} WHERE shift_id = $1 ORDER BY provider_order_no`,
      [shiftId],
    )
    return rows.map(toOrder)
  }
  async listByShiftIds(shiftIds: readonly string[]): Promise<ShiftOrderRecord[]> {
    if (shiftIds.length === 0) return []
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${ORDER_COLUMNS} WHERE o.shift_id = ANY($1::uuid[]) ORDER BY o.shift_id, o.provider_order_no`,
      [shiftIds],
    )
    return rows.map(toOrder)
  }
  async findByProviderNo(providerOrderNo: string): Promise<ShiftOrderRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${ORDER_COLUMNS} WHERE provider_order_no = $1`,
      [providerOrderNo],
    )
    return rows[0] ? toOrder(rows[0]) : null
  }
  /** One transaction: an order must never be seen with half a route. */
  async replacePoints(
    orderId: string,
    points: readonly OrderPointRecord[],
    actorId: string | null,
  ): Promise<void> {
    await this.mutate(actorId, async (client) => {
      await client.query('SELECT id FROM shift_orders WHERE id = $1 FOR UPDATE', [orderId])
      await client.query('DELETE FROM shift_order_points WHERE order_id = $1', [orderId])
      for (const [i, point] of points.entries()) {
        await client.query(
          `INSERT INTO shift_order_points (order_id, seq, role, label, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderId, i + 1, point.role, point.label, point.lat, point.lng],
        )
      }
    })
  }
  async delete(id: string, actorId: string | null): Promise<void> {
    await this.mutate(actorId, async (client) => {
      await client.query('DELETE FROM shift_orders WHERE id = $1', [id])
    })
  }
}

/**
 * The order columns, with its route folded in as JSON.
 *
 * A lateral aggregate rather than a second round-trip per order: the review screen lists a whole
 * shift's orders at once, and N+1 queries for points nobody pinned would be the slowest part of it.
 */
const ORDER_COLUMNS = `
  SELECT o.id, o.shift_id, o.provider_order_no, o.pay_mode, o.fee_minor::text AS fee, o.zone,
         o.driver_confirmed, o.source, o.fee_ocr_minor::text AS fee_ocr, o.kind,
         o.driver_share_minor::text  AS driver_share,
         o.company_share_minor::text AS company_share,
         o.notes, o.created_by, o.included, o.wallet_amount_minor::text AS wallet_amount, o.occurred_minute,
         to_char(o.occurred_date, 'YYYY-MM-DD') AS occurred_date,
         o.window_status, o.decision_reason, o.decided_by, o.decided_at,
         o.window_basis, o.position_evidence, o.close_draft_observation_id,
         o.close_draft_client_key, o.close_draft_review_reasons,
         o.removed_at, o.removed_by, o.removal_reason,
         COALESCE(
           (SELECT json_agg(json_build_object('role', p.role, 'label', p.label, 'lat', p.lat, 'lng', p.lng)
                            ORDER BY p.seq)
              FROM shift_order_points p WHERE p.order_id = o.id),
           '[]'::json
         ) AS points
    FROM shift_orders o`

const toOrder = (r: Record<string, unknown>): ShiftOrderRecord => ({
  id: String(r.id),
  shiftId: String(r.shift_id),
  providerOrderNo: String(r.provider_order_no),
  payMode: r.pay_mode as ShiftOrderRecord['payMode'],
  fee: minor(BigInt(String(r.fee))),
  zone: (r.zone as string | null) ?? null,
  driverConfirmed: Boolean(r.driver_confirmed),
  source: (r.source as ShiftOrderRecord['source'] | null) ?? 'manual',
  feeOcr: r.fee_ocr === null || r.fee_ocr === undefined ? null : minor(BigInt(String(r.fee_ocr))),
  kind: (r.kind as ShiftOrderRecord['kind'] | null) ?? 'yallago',
  driverShare: r.driver_share === null || r.driver_share === undefined ? null : minor(BigInt(String(r.driver_share))),
  companyShare:
    r.company_share === null || r.company_share === undefined ? null : minor(BigInt(String(r.company_share))),
  notes: (r.notes as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  points: (r.points as ShiftOrderRecord['points'] | null) ?? [],
  // `?? true` and `?? null` are the pre-0015 meanings: every order recorded before the operations
  // list existed was counted, and none of them had a measured wallet amount.
  included: (r.included as boolean | null) ?? true,
  walletAmount:
    r.wallet_amount === null || r.wallet_amount === undefined ? null : minor(BigInt(String(r.wallet_amount))),
  occurredMinute: (r.occurred_minute as string | null) ?? null,
  // Formatted in SQL, never via the JS Date: a timezone conversion here moves a late-evening
  // order to the next day, which is the whole failure this column exists to make visible.
  occurredDate: (r.occurred_date as string | null) ?? null,
  windowStatus: (r.window_status as ShiftOrderRecord['windowStatus'] | null) ?? 'unknown',
  decisionReason: (r.decision_reason as string | null) ?? null,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at === null || r.decided_at === undefined ? null : (r.decided_at as Date).toISOString(),
  windowBasis: (r.window_basis as ShiftOrderRecord['windowBasis'] | null) ?? null,
  positionEvidence: (r.position_evidence as ShiftOrderRecord['positionEvidence'] | null) ?? null,
  observationId: (r.close_draft_observation_id as string | null) ?? null,
  closeDraftClientKey: (r.close_draft_client_key as string | null) ?? null,
  removedAt: r.removed_at === null || r.removed_at === undefined ? null : new Date(r.removed_at as string).toISOString(),
  removedBy: (r.removed_by as string | null) ?? null,
  removalReason: (r.removal_reason as string | null) ?? null,
  closeDraftReviewReasons:
    (r.close_draft_review_reasons as ShiftOrderRecord['closeDraftReviewReasons'] | null) ?? [],
})

/** Positive cash deductions read from the provider's operation history. */
export class PgCashDeductionRepo implements CashDeductionRepo {
  private readonly pool: Pool
  private readonly transactionClient: PoolClient | null
  constructor(pool: Pool, transactionClient: PoolClient | null = null) {
    this.pool = pool
    this.transactionClient = transactionClient
  }

  private mutate<T>(actorId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transactionClient ? fn(this.transactionClient) : withTransaction(this.pool, { actorId }, fn)
  }

  async create(deduction: CashDeductionRecord, actorId: string | null): Promise<void> {
    try {
      await this.mutate(actorId, async (client) => {
        await client.query(
          `INSERT INTO cash_deductions
             (id, shift_id, operation_key, amount_minor, occurred_date, occurred_minute, source,
              amount_ocr_minor, point_a, point_b, included, window_status, decision_reason,
              decided_by, decided_at, created_by, window_basis, position_evidence,
              close_draft_observation_id, close_draft_client_key, close_draft_review_reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16,$17,$18::jsonb,$19,$20,$21::jsonb)`,
          [
            deduction.id,
            deduction.shiftId,
            deduction.operationKey,
            deduction.amount.toString(),
            deduction.occurredDate,
            deduction.occurredMinute,
            deduction.source,
            deduction.amountOcr?.toString() ?? null,
            deduction.pointA,
            deduction.pointB,
            deduction.included,
            deduction.windowStatus,
            deduction.decisionReason,
            deduction.decidedBy,
            deduction.decidedAt,
            deduction.createdBy,
            deduction.windowBasis ?? null,
            deduction.positionEvidence === null || deduction.positionEvidence === undefined
              ? null
              : JSON.stringify(deduction.positionEvidence),
            deduction.observationId ?? null,
            deduction.closeDraftClientKey ?? null,
            JSON.stringify(deduction.closeDraftReviewReasons ?? []),
          ],
        )
      })
    } catch (err) {
      if (
        isPgError(err, PG.UNIQUE_VIOLATION) &&
        (err as { constraint?: string }).constraint === 'cash_deductions_operation_uq'
      ) {
        throw Object.assign(new Error(`duplicate cash-deduction operation key ${deduction.operationKey}`), {
          code: 'DUPLICATE_CASH_DEDUCTION',
        })
      }
      throw err
    }
  }

  async update(deduction: CashDeductionRecord, actorId: string | null): Promise<void> {
    await this.mutate(actorId, async (client) => {
      await client.query(
        `UPDATE cash_deductions
            SET amount_minor = $2, occurred_date = $3, occurred_minute = $4, source = $5,
                amount_ocr_minor = $6, point_a = $7, point_b = $8, included = $9,
                window_status = $10, decision_reason = $11, decided_by = $12,
                decided_at = $13::timestamptz, window_basis = $14,
                position_evidence = $15::jsonb, close_draft_observation_id = $16,
                close_draft_client_key = $17, close_draft_review_reasons = $18::jsonb,
                removed_at = $19::timestamptz, removed_by = $20, removal_reason = $21
          WHERE id = $1`,
        [
          deduction.id,
          deduction.amount.toString(),
          deduction.occurredDate,
          deduction.occurredMinute,
          deduction.source,
          deduction.amountOcr?.toString() ?? null,
          deduction.pointA,
          deduction.pointB,
          deduction.included,
          deduction.windowStatus,
          deduction.decisionReason,
          deduction.decidedBy,
          deduction.decidedAt,
          deduction.windowBasis ?? null,
          deduction.positionEvidence === null || deduction.positionEvidence === undefined
            ? null
            : JSON.stringify(deduction.positionEvidence),
          deduction.observationId ?? null,
          deduction.closeDraftClientKey ?? null,
          JSON.stringify(deduction.closeDraftReviewReasons ?? []),
          deduction.removedAt ?? null,
          deduction.removedBy ?? null,
          deduction.removalReason ?? null,
        ],
      )
    })
  }

  async listByShift(shiftId: string): Promise<CashDeductionRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${CASH_DEDUCTION_COLUMNS}
        WHERE shift_id = $1
        ORDER BY occurred_date NULLS LAST, occurred_minute NULLS LAST, operation_key`,
      [shiftId],
    )
    return rows.map(toCashDeduction)
  }

  async findByOperationKey(shiftId: string, operationKey: string): Promise<CashDeductionRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${CASH_DEDUCTION_COLUMNS} WHERE shift_id = $1 AND operation_key = $2`,
      [shiftId, operationKey],
    )
    return rows[0] ? toCashDeduction(rows[0]) : null
  }

  async delete(id: string, actorId: string | null): Promise<void> {
    await this.mutate(actorId, async (client) => {
      await client.query('DELETE FROM cash_deductions WHERE id = $1', [id])
    })
  }
}

const CASH_DEDUCTION_COLUMNS = `
  SELECT id, shift_id, operation_key, amount_minor::text AS amount,
         to_char(occurred_date, 'YYYY-MM-DD') AS occurred_date, occurred_minute, source,
         amount_ocr_minor::text AS amount_ocr, point_a, point_b, included, window_status,
         decision_reason, decided_by, decided_at, created_by, window_basis,
         position_evidence, close_draft_observation_id, close_draft_client_key,
         close_draft_review_reasons, removed_at, removed_by, removal_reason
    FROM cash_deductions`

const toCashDeduction = (r: Record<string, unknown>): CashDeductionRecord => ({
  id: String(r.id),
  shiftId: String(r.shift_id),
  operationKey: String(r.operation_key),
  amount: minor(BigInt(String(r.amount))),
  occurredDate: (r.occurred_date as CalendarDate | null) ?? null,
  occurredMinute: (r.occurred_minute as string | null) ?? null,
  source: r.source as CashDeductionRecord['source'],
  amountOcr: r.amount_ocr === null || r.amount_ocr === undefined ? null : minor(BigInt(String(r.amount_ocr))),
  pointA: (r.point_a as string | null) ?? null,
  pointB: (r.point_b as string | null) ?? null,
  included: Boolean(r.included),
  windowStatus: r.window_status as CashDeductionRecord['windowStatus'],
  decisionReason: (r.decision_reason as string | null) ?? null,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at === null || r.decided_at === undefined ? null : (r.decided_at as Date).toISOString(),
  createdBy: (r.created_by as string | null) ?? null,
  windowBasis: (r.window_basis as CashDeductionRecord['windowBasis'] | null) ?? null,
  positionEvidence: (r.position_evidence as CashDeductionRecord['positionEvidence'] | null) ?? null,
  observationId: (r.close_draft_observation_id as string | null) ?? null,
  closeDraftClientKey: (r.close_draft_client_key as string | null) ?? null,
  removedAt: r.removed_at === null || r.removed_at === undefined ? null : new Date(r.removed_at as string).toISOString(),
  removedBy: (r.removed_by as string | null) ?? null,
  removalReason: (r.removal_reason as string | null) ?? null,
  closeDraftReviewReasons:
    (r.close_draft_review_reasons as CashDeductionRecord['closeDraftReviewReasons'] | null) ?? [],
})

const sameCashDeductionRecord = (left: CashDeductionRecord, right: CashDeductionRecord): boolean =>
  left.id === right.id &&
  left.shiftId === right.shiftId &&
  left.operationKey === right.operationKey &&
  left.amount === right.amount &&
  left.occurredDate === right.occurredDate &&
  left.occurredMinute === right.occurredMinute &&
  left.source === right.source &&
  left.amountOcr === right.amountOcr &&
  left.pointA === right.pointA &&
  left.pointB === right.pointB &&
  left.included === right.included &&
  left.windowStatus === right.windowStatus &&
  left.decisionReason === right.decisionReason &&
  left.decidedBy === right.decidedBy &&
  left.decidedAt === right.decidedAt &&
  left.createdBy === right.createdBy &&
  (left.windowBasis ?? null) === (right.windowBasis ?? null) &&
  JSON.stringify(left.positionEvidence ?? null) === JSON.stringify(right.positionEvidence ?? null) &&
  (left.observationId ?? null) === (right.observationId ?? null) &&
  (left.closeDraftClientKey ?? null) === (right.closeDraftClientKey ?? null) &&
  JSON.stringify(left.closeDraftReviewReasons ?? []) === JSON.stringify(right.closeDraftReviewReasons ?? [])

/** Calls the database-owned classifier; no caller-provided status or inclusion crosses this port. */
export class PgOperationWindowRepo implements OperationWindowRepo {
  private readonly pool: Pool
  private readonly transactionClient: PoolClient | null
  constructor(pool: Pool, transactionClient: PoolClient | null = null) {
    this.pool = pool
    this.transactionClient = transactionClient
  }

  async reclassify(
    shiftId: string,
    actorId: string | null,
  ): Promise<{ orders: number; cashDeductions: number }> {
    const run = async (client: PoolClient) => {
      const { rows } = await client.query<{ order_updates: number; deduction_updates: number }>(
        'SELECT order_updates, deduction_updates FROM reclassify_shift_operations($1)',
        [shiftId],
      )
      const result = rows[0]
      return {
        orders: Number(result?.order_updates ?? 0),
        cashDeductions: Number(result?.deduction_updates ?? 0),
      }
    }
    return this.transactionClient
      ? run(this.transactionClient)
      : withTransaction(this.pool, { actorId }, run)
  }
}

/**
 * Read the full working-capital position in one PostgreSQL statement snapshot.
 *
 * The office boxes and receivables alone are the restoration position. Driver cash/wallet remains
 * company working capital after approval moves it out of those boxes, so it is added only while a
 * shift has both the immutable open marker and a financially-live state.
 */
export class PgTreasuryPositionSource implements TreasuryPositionSource {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async readCurrent(branchId: string): Promise<TreasuryPositionRecord> {
    const { rows } = await this.pool.query<{
      office_cash: string
      office_wallet: string
      receivables_cash: string
      receivables_wallet: string
      advances_cash: string
      advances_wallet: string
      active_custody_cash: string
      active_custody_wallet: string
      active_shift_count: number
      negative_receivable_fund_code: string | null
    }>(
      `WITH active_shifts AS (
         SELECT driver_id
           FROM shifts
          WHERE branch_id = $1
            AND open_approved_at IS NOT NULL
            AND state IN ('open', 'pending_review', 'suspended')
       ),
       active_drivers AS (
         SELECT DISTINCT driver_id FROM active_shifts
       ),
       fund_balances AS (
         SELECT f.code,
                f.type::text AS fund_type,
                f.owner_id,
                COALESCE(SUM(
                  CASE WHEN jl.side = 'D' THEN jl.amount_minor ELSE -jl.amount_minor END
                ), 0) AS balance
           FROM funds f
           LEFT JOIN journal_lines jl ON jl.fund_id = f.id
          WHERE f.branch_id = $1
            AND f.type::text IN (
              'office_cash',
              'office_wallet',
              'driver_receivable_cash',
              'driver_receivable_wallet',
              'driver_shift_funding_cash',
              'driver_shift_funding_wallet',
              'advance_receivable_cash',
              'advance_receivable_wallet',
              'driver_cash',
              'driver_wallet'
            )
          GROUP BY f.id, f.code, f.type, f.owner_id
       )
       SELECT COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'office_cash'
              ), 0)::text AS office_cash,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'office_wallet'
              ), 0)::text AS office_wallet,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type IN ('driver_receivable_cash', 'driver_shift_funding_cash')
              ), 0)::text AS receivables_cash,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type IN ('driver_receivable_wallet', 'driver_shift_funding_wallet')
              ), 0)::text AS receivables_wallet,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'advance_receivable_cash'
              ), 0)::text AS advances_cash,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'advance_receivable_wallet'
              ), 0)::text AS advances_wallet,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'driver_cash'
                  AND EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = fund_balances.owner_id)
              ), 0)::text AS active_custody_cash,
              COALESCE(SUM(balance) FILTER (
                WHERE fund_type = 'driver_wallet'
                  AND EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = fund_balances.owner_id)
              ), 0)::text AS active_custody_wallet,
              (SELECT COUNT(*)::int FROM active_shifts) AS active_shift_count,
              (SELECT code
                 FROM fund_balances
                WHERE balance < 0
                  AND fund_type IN (
                    'driver_receivable_cash',
                    'driver_receivable_wallet',
                    'driver_shift_funding_cash',
                    'driver_shift_funding_wallet',
                    'advance_receivable_cash',
                    'advance_receivable_wallet'
                  )
                ORDER BY code
                LIMIT 1) AS negative_receivable_fund_code
         FROM fund_balances`,
      [branchId],
    )
    const row = rows[0]
    return {
      officeCash: minor(BigInt(row?.office_cash ?? '0')),
      officeWallet: minor(BigInt(row?.office_wallet ?? '0')),
      receivablesCash: minor(BigInt(row?.receivables_cash ?? '0')),
      receivablesWallet: minor(BigInt(row?.receivables_wallet ?? '0')),
      advancesCash: minor(BigInt(row?.advances_cash ?? '0')),
      advancesWallet: minor(BigInt(row?.advances_wallet ?? '0')),
      activeCustodyCash: minor(BigInt(row?.active_custody_cash ?? '0')),
      activeCustodyWallet: minor(BigInt(row?.active_custody_wallet ?? '0')),
      activeShiftCount: Number(row?.active_shift_count ?? 0),
      negativeReceivableFundCode: row?.negative_receivable_fund_code ?? null,
    }
  }
}

/**
 * The wallet's own rows, merged page by page.
 *
 * `merge` is the interesting one: two screenshots of one scrolling log overlap, so the same rows
 * arrive twice and re-uploading a page must add nothing. It counts what is already stored for each
 * `(minute, amount)` and inserts only the surplus, numbering from there.
 */
export class PgWalletMovementRepo implements WalletMovementRepo {
  private readonly pool: Pool
  private readonly transactionClient: PoolClient | null
  constructor(pool: Pool, transactionClient: PoolClient | null = null) {
    this.pool = pool
    this.transactionClient = transactionClient
  }

  private mutate<T>(actorId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transactionClient ? fn(this.transactionClient) : withTransaction(this.pool, { actorId }, fn)
  }

  async listByShift(shiftId: string): Promise<WalletMovementRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${MOVEMENT_COLUMNS} WHERE shift_id = $1 ORDER BY occurred_minute, amount_minor, seq`,
      [shiftId],
    )
    return rows.map(toMovement)
  }

  async merge(
    shiftId: string,
    movements: readonly WalletMovementInput[],
    actorId: string | null,
  ): Promise<WalletMovementRecord[]> {
    if (movements.length === 0) return []
    return this.mutate(actorId, async (client) => {
      // PostgreSQL forbids FOR UPDATE on a grouped query. Locking the owning shift serializes all
      // merges for this shift, then the tally can be aggregated safely inside the same transaction.
      await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])
      const { rows: existing } = await client.query<{ occurred_minute: string; amount_minor: string; n: string }>(
        `SELECT occurred_minute, amount_minor::text AS amount_minor, COUNT(*)::text AS n
           FROM shift_wallet_movements WHERE shift_id = $1
          GROUP BY occurred_minute, amount_minor`,
        [shiftId],
      )
      const tally = new Map<string, number>()
      for (const r of existing) tally.set(`${r.occurred_minute}|${r.amount_minor}`, Number(r.n))

      const written: WalletMovementRecord[] = []
      for (const m of movements) {
        const key = `${m.occurredMinute}|${m.amount.toString()}`
        const already = tally.get(key) ?? 0
        // The page re-showed a row we already hold: consume one and write nothing.
        if (already > 0) {
          tally.set(key, already - 1)
          continue
        }
        const { rows } = await client.query<Record<string, unknown>>(
          `INSERT INTO shift_wallet_movements
             (shift_id, amount_minor, occurred_minute, seq, order_id, role, ambiguous, included, source, media_id, notes, created_by)
           VALUES ($1,$2,$3,
                   (SELECT COALESCE(MAX(seq),0)+1 FROM shift_wallet_movements
                     WHERE shift_id = $1 AND occurred_minute = $3 AND amount_minor = $2),
                   $4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id, shift_id, amount_minor::text AS amount, occurred_minute, seq, order_id, role,
                     ambiguous, included, source, media_id, notes, created_by`,
          [
            shiftId,
            m.amount.toString(),
            m.occurredMinute,
            m.orderId ?? null,
            m.role ?? 'unmatched',
            m.ambiguous ?? false,
            m.included ?? true,
            m.source ?? 'ocr',
            m.mediaId ?? null,
            m.notes ?? null,
            m.createdBy ?? null,
          ],
        )
        written.push(toMovement(rows[0]!))
      }
      return written
    })
  }

  async update(
    id: string,
    patch: { role?: WalletMovementRole; orderId?: string | null; included?: boolean; ambiguous?: boolean },
    actorId: string | null,
  ): Promise<void> {
    await this.mutate(actorId, (client) => client.query(
      `UPDATE shift_wallet_movements
          SET role      = COALESCE($2, role),
              order_id  = CASE WHEN $3::boolean THEN $4 ELSE order_id END,
              included  = COALESCE($5, included),
              ambiguous = COALESCE($6, ambiguous)
        WHERE id = $1`,
      [
        id,
        patch.role ?? null,
        // A null orderId is a real value — «this credit belongs to no order» — so it cannot be
        // expressed by COALESCE, which cannot tell "set to null" from "leave alone".
        Object.hasOwn(patch, 'orderId'),
        patch.orderId ?? null,
        patch.included ?? null,
        patch.ambiguous ?? null,
      ],
    ))
  }

  async deleteByShift(shiftId: string, actorId: string | null): Promise<void> {
    await this.mutate(actorId, (client) =>
      client.query('DELETE FROM shift_wallet_movements WHERE shift_id = $1', [shiftId]),
    )
  }
}

const MOVEMENT_COLUMNS = `
  SELECT id, shift_id, amount_minor::text AS amount, occurred_minute, seq, order_id, role,
         ambiguous, included, source, media_id, notes, created_by
    FROM shift_wallet_movements`

const toMovement = (r: Record<string, unknown>): WalletMovementRecord => ({
  id: String(r.id),
  shiftId: String(r.shift_id),
  amount: minor(BigInt(String(r.amount))),
  occurredMinute: String(r.occurred_minute ?? ''),
  seq: Number(r.seq),
  orderId: (r.order_id as string | null) ?? null,
  role: r.role as WalletMovementRecord['role'],
  ambiguous: Boolean(r.ambiguous),
  included: Boolean(r.included),
  source: (r.source as WalletMovementRecord['source'] | null) ?? 'ocr',
  mediaId: (r.media_id as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
})

/** Commits one submitted operations page without exposing a generic transaction callback. */
export class PgOperationBatchRepo implements OperationBatchRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async apply(
    shiftId: string,
    batch: OperationBatch,
    actorId: string | null,
  ): Promise<{ insertedMovements: WalletMovementRecord[] }> {
    const wrongShift = [
      ...batch.orderCreates.map((record) => ({ kind: 'order', id: record.id, shiftId: record.shiftId })),
      ...batch.orderUpdates.map(({ record }) => ({ kind: 'order', id: record.id, shiftId: record.shiftId })),
      ...batch.cashDeductionCreates.map((record) => ({ kind: 'cash_deduction', id: record.id, shiftId: record.shiftId })),
      ...batch.cashDeductionUpdates.map(({ record }) => ({
        kind: 'cash_deduction',
        id: record.id,
        shiftId: record.shiftId,
      })),
      ...(batch.cashDeductionDeletes ?? []).map(({ expected }) => ({
        kind: 'cash_deduction',
        id: expected.id,
        shiftId: expected.shiftId,
      })),
    ].find((record) => record.shiftId !== shiftId)
    if (wrongShift) {
      throw Object.assign(new Error(`${wrongShift.kind} ${wrongShift.id} belongs to another shift`), {
        code: 'OPERATION_BATCH_SHIFT_MISMATCH',
      })
    }
    const legacyKindTransitions = normalizePgLegacyKindTransitions(batch.legacyKindTransitions ?? [])

    return withTransaction(this.pool, { actorId }, async (client) => {
      // Serializes complete submissions for one shift. This also makes the movement surplus tally
      // and concurrent natural-key decisions observe the immediately preceding committed batch.
      const lockedShift = await client.query<{ state: string; submitted_at: Date | null }>(
        'SELECT state, submitted_at FROM shifts WHERE id = $1 FOR UPDATE',
        [shiftId],
      )
      if (lockedShift.rowCount !== 1) {
        throw Object.assign(new Error(`shift ${shiftId} not found`), {
          code: 'OPERATION_BATCH_SHIFT_NOT_FOUND',
        })
      }
      const lockedState = lockedShift.rows[0]!
      if (!['open', 'suspended'].includes(lockedState.state) || lockedState.submitted_at !== null) {
        throw Object.assign(new Error(`shift ${shiftId} is no longer open for operation changes`), {
          code: 'OPERATION_BATCH_SHIFT_CLOSED',
        })
      }
      if (batch.closeDraftMaterialization) {
        await client.query('SELECT begin_close_draft_materialization($1,$2,$3)', [
          shiftId,
          batch.closeDraftMaterialization.revision,
          batch.closeDraftMaterialization.draftHash,
        ])
      }

      const orders = new PgOrderRepo(this.pool, client)
      const deductions = new PgCashDeductionRepo(this.pool, client)
      const movements = new PgWalletMovementRepo(this.pool, client)

      // Resolve sign changes only after owning the shift lock. A concurrent opposite-sign batch may
      // have committed after the service read; inspecting current rows here keeps the XOR invariant.
      for (const transition of legacyKindTransitions) {
        if (transition.targetKind === 'order') {
          const opposite = await client.query<{ id: string; decided_by: string | null; decided_at: Date | null }>(
            `SELECT id::text, decided_by::text, decided_at
               FROM cash_deductions
              WHERE shift_id = $1 AND operation_key = $2
              FOR UPDATE`,
            [shiftId, `legacy:${transition.providerOrderNo}`],
          )
          const row = opposite.rows[0]
          const decidedAt = row?.decided_at?.toISOString() ?? null
          const matchesExpected = transition.expectedOppositeId === null
            ? row === undefined
            : row?.id === transition.expectedOppositeId &&
              decidedAt === transition.expectedOppositeDecidedAt &&
              transition.expectedOppositeDecidedAt === null &&
              row.decided_by === null
          if (!matchesExpected) {
            throw staleOperationBatch(
              'cash_deduction',
              row?.id ?? transition.expectedOppositeId ?? transition.providerOrderNo,
            )
          }
          if (row) await deductions.delete(row.id, actorId)
        } else {
          const opposite = await client.query<{
            id: string
            kind: string
            decided_by: string | null
            decided_at: Date | null
          }>(
            `SELECT id::text, kind, decided_by::text, decided_at
               FROM shift_orders
              WHERE shift_id = $1 AND provider_order_no = $2
              FOR UPDATE`,
            [shiftId, transition.providerOrderNo],
          )
          const row = opposite.rows[0]
          const decidedAt = row?.decided_at?.toISOString() ?? null
          const matchesExpected = transition.expectedOppositeId === null
            ? row === undefined
            : row?.id === transition.expectedOppositeId &&
              decidedAt === transition.expectedOppositeDecidedAt &&
              transition.expectedOppositeDecidedAt === null &&
              row.decided_by === null &&
              row.kind !== 'manual'
          if (!matchesExpected) {
            throw staleOperationBatch('order', row?.id ?? transition.expectedOppositeId ?? transition.providerOrderNo)
          }
          if (row) {
            // ON DELETE SET NULL cannot preserve a matched role (the row-level CHECK rejects it).
            // Retain the evidence, explicitly detach it, and exclude it from BR1 pending review.
            await client.query(
              `UPDATE shift_wallet_movements
                  SET role = 'unmatched', order_id = NULL, included = false, ambiguous = true
                WHERE shift_id = $1 AND order_id = $2`,
              [shiftId, row.id],
            )
            await orders.delete(row.id, actorId)
          }
        }
      }

      for (const deletion of batch.cashDeductionDeletes ?? []) {
        const locked = await client.query<Record<string, unknown>>(
          `${CASH_DEDUCTION_COLUMNS}
            WHERE id = $1 AND shift_id = $2
            FOR UPDATE`,
          [deletion.expected.id, shiftId],
        )
        const current = locked.rows[0] === undefined ? null : toCashDeduction(locked.rows[0])
        if (current === null || !sameCashDeductionRecord(current, deletion.expected)) {
          throw staleOperationBatch('cash_deduction', deletion.expected.id)
        }
        await deductions.delete(current.id, actorId)
      }

      for (const order of batch.orderCreates) await orders.create(order, actorId)
      for (const update of batch.orderUpdates) {
        const locked = await client.query(
          `SELECT id
             FROM shift_orders
            WHERE id = $1 AND shift_id = $2
              AND decided_at IS NOT DISTINCT FROM $3::timestamptz
            FOR UPDATE`,
          [update.record.id, shiftId, update.expectedDecidedAt],
        )
        if (locked.rowCount !== 1) throw staleOperationBatch('order', update.record.id)
        await orders.update(update.record, actorId)
      }

      for (const replacement of batch.orderPointReplacements) {
        const locked = await client.query(
          `SELECT o.id
             FROM shift_orders o
            WHERE o.id = $1 AND o.shift_id = $2
            FOR UPDATE`,
          [replacement.orderId, shiftId],
        )
        if (locked.rowCount !== 1) throw staleOperationBatch('order', replacement.orderId)
        // Use a fresh READ COMMITTED statement after acquiring the parent lock. A manager who held
        // that lock first may have inserted points without changing the parent row, so folding the
        // NOT EXISTS into the waiting SELECT could observe its older command snapshot.
        const existingPoints = await client.query('SELECT 1 FROM shift_order_points WHERE order_id = $1 LIMIT 1', [
          replacement.orderId,
        ])
        if (existingPoints.rowCount !== 0) throw staleOperationBatch('order', replacement.orderId)
        await orders.replacePoints(replacement.orderId, replacement.points, actorId)
      }

      for (const deduction of batch.cashDeductionCreates) await deductions.create(deduction, actorId)
      for (const update of batch.cashDeductionUpdates) {
        const locked = await client.query(
          `SELECT id
             FROM cash_deductions
            WHERE id = $1 AND shift_id = $2
              AND decided_at IS NOT DISTINCT FROM $3::timestamptz
            FOR UPDATE`,
          [update.record.id, shiftId, update.expectedDecidedAt],
        )
        if (locked.rowCount !== 1) throw staleOperationBatch('cash_deduction', update.record.id)
        await deductions.update(update.record, actorId)
      }

      const movementOrderIds = [
        ...new Set(batch.movements.flatMap((movement) => (movement.orderId ? [movement.orderId] : []))),
      ]
      if (movementOrderIds.length > 0) {
        const ownedOrders = await client.query<{ id: string }>(
          `SELECT id
             FROM shift_orders
            WHERE shift_id = $1 AND id = ANY($2::uuid[])
            FOR KEY SHARE`,
          [shiftId, movementOrderIds],
        )
        if (ownedOrders.rowCount !== movementOrderIds.length) {
          throw Object.assign(new Error('operation batch movement references an order from another shift'), {
            code: 'OPERATION_BATCH_SHIFT_MISMATCH',
          })
        }
      }

      const insertedMovements = await movements.merge(shiftId, batch.movements, actorId)
      if (batch.closeDraftMaterialization) {
        await client.query('SELECT end_close_draft_materialization($1)', [shiftId])
      }
      return { insertedMovements }
    })
  }
}

const normalizePgLegacyKindTransitions = (
  transitions: NonNullable<OperationBatch['legacyKindTransitions']>,
): Array<NonNullable<OperationBatch['legacyKindTransitions']>[number]> => {
  const targets = new Map<string, NonNullable<OperationBatch['legacyKindTransitions']>[number]>()
  for (const transition of transitions) {
    const current = targets.get(transition.providerOrderNo)
    if (
      transition.providerOrderNo.length === 0 ||
      (current !== undefined && (
        current.targetKind !== transition.targetKind ||
        current.expectedOppositeId !== transition.expectedOppositeId ||
        current.expectedOppositeDecidedAt !== transition.expectedOppositeDecidedAt
      ))
    ) {
      throw Object.assign(new Error(`conflicting legacy operation kind for ${transition.providerOrderNo}`), {
        code: 'OPERATION_BATCH_KIND_CONFLICT',
      })
    }
    targets.set(transition.providerOrderNo, transition)
  }
  return [...targets]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, transition]) => transition)
}

const staleOperationBatch = (kind: 'order' | 'cash_deduction', id: string): Error & { code: string } =>
  Object.assign(new Error(`${kind} ${id} changed while the operations batch was being prepared`), {
    code: 'STALE_OPERATION_BATCH',
  })

export class PgFxRepo implements FxRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }
  async list(): Promise<FxDay[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT business_date, syp_minor_per_usd::text AS rate, provisional FROM fx_days ORDER BY business_date',
    )
    return rows.map((r) => ({
      businessDate: isoDate(r.business_date),
      sypMinorPerUsd: BigInt(String(r.rate)),
      provisional: Boolean(r.provisional),
    }))
  }
  async upsert(day: FxDay): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO fx_days (business_date, syp_minor_per_usd, provisional)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_date)
       DO UPDATE SET syp_minor_per_usd = EXCLUDED.syp_minor_per_usd, provisional = EXCLUDED.provisional
       RETURNING id`,
      [day.businessDate, day.sypMinorPerUsd.toString(), day.provisional],
    )
    return Number(rows[0]!.id)
  }
  async idFor(businessDate: CalendarDate): Promise<number | null> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM fx_days WHERE business_date = $1', [businessDate])
    return rows[0] ? Number(rows[0].id) : null
  }
}

export class PgAuditRepo implements AuditRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }
  async append(record: Omit<AuditRecord, 'id'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (table_name, record_id, action, actor_id, actor_kind, branch_id, request_id, before, after, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10::double precision / 1000))`,
      [
        record.tableName,
        record.recordId,
        record.action,
        record.actorId,
        record.actorKind,
        record.branchId,
        record.requestId,
        record.before === null ? null : JSON.stringify(record.before),
        record.after === null ? null : JSON.stringify(record.after),
        record.occurredAtMs,
      ],
    )
  }
  async list(filter: AuditFilter): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM audit_log
        WHERE ($1::text IS NULL OR table_name = $1)
          AND ($2::text IS NULL OR record_id = $2)
          AND ($3::uuid IS NULL OR actor_id = $3)
        ORDER BY id`,
      [filter.tableName ?? null, filter.recordId ?? null, filter.actorId ?? null],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      tableName: String(r.table_name),
      recordId: String(r.record_id),
      action: r.action as AuditRecord['action'],
      actorId: (r.actor_id as string | null) ?? null,
      actorKind: r.actor_kind as AuditRecord['actorKind'],
      branchId: (r.branch_id as string | null) ?? null,
      requestId: (r.request_id as string | null) ?? null,
      before: r.before ?? null,
      after: r.after ?? null,
      occurredAtMs: (r.occurred_at as Date).getTime(),
    }))
  }
}

export class PgUserRepo implements UserRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }
  async findByUsername(username: string): Promise<UserRecord | null> {
    const exact = await this.one('username = $1', [username])
    if (exact) return exact

    /*
     * Nothing matched literally. Before giving up, look for an account whose STORED name carries
     * characters that cannot be typed back — the invisible Arabic kasra a wrong keyboard layout
     * leaves in front of a name, a zero-width joiner pasted in from elsewhere. Such an account
     * looks perfectly normal in the admin and is impossible to log into, and the person locked out
     * has no way to see why.
     *
     * This runs only on a miss, and it is NOT fuzzy matching: the caller's input is already
     * normalised, so this compares two normalised forms for equality. If more than one account
     * normalises to the same name the request is refused rather than resolved to a guess —
     * authentication must never pick which of two people you meant.
     */
    const wanted = normalizeUsername(username)
    if (wanted === '') return null
    const { rows } = await this.pool.query<{ username: string }>('SELECT username FROM users')
    const matches = rows.map((r) => r.username).filter((u) => u !== username && normalizeUsername(u) === wanted)
    return matches.length === 1 ? this.one('username = $1', [matches[0]]) : null
  }
  async findById(id: string): Promise<UserRecord | null> {
    return this.one('u.id = $1', [id])
  }
  private async one(where: string, params: unknown[]): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT u.*, d.id AS driver_id FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
        WHERE ${where}`,
      params,
    )
    const r = rows[0]
    return r ? this.mapRow(r) : null
  }

  private mapRow(r: Record<string, unknown>): UserRecord {
    return {
      id: String(r.id),
      branchId: (r.branch_id as string | null) ?? null,
      roleKey: r.role_key as UserRecord['roleKey'],
      username: String(r.username),
      fullNameAr: String(r.full_name_ar),
      passwordHash: String(r.password_hash),
      driverId: (r.driver_id as string | null) ?? null,
      // mfa_secret_enc is bytea; here it is decoded from UTF-8. App-side AES-GCM wrapping is a
      // documented follow-up (docs/DEPLOY-VERCEL-NEON — key management).
      mfaSecret: r.mfa_secret_enc === null || r.mfa_secret_enc === undefined
        ? null
        : Buffer.from(r.mfa_secret_enc as Buffer).toString('utf8'),
      mfaEnrolledAtMs: r.mfa_enrolled_at === null ? null : (r.mfa_enrolled_at as Date).getTime(),
      failedAttempts: Number(r.failed_attempts),
      lockedUntilMs: r.locked_until === null ? null : (r.locked_until as Date).getTime(),
      active: Boolean(r.active),
    }
  }
  /**
   * Write the whole mutable record, exactly as the memory adapter's `update` does — otherwise the
   * two drift and an admin "edit account" silently changes nothing on Postgres. `username` is the
   * one field deliberately NOT updated: it is the login identity, and renaming it is a different
   * (and auditable) decision from editing a profile.
   */
  async update(user: UserRecord): Promise<void> {
    await this.pool.query(
      `UPDATE users SET full_name_ar = $2,
                        role_key = $3,
                        branch_id = $4,
                        password_hash = $5,
                        failed_attempts = $6,
                        locked_until = CASE WHEN $7::bigint IS NULL THEN NULL
                                            ELSE to_timestamp($7::double precision / 1000) END,
                        active = $8,
                        mfa_secret_enc = $9,
                        mfa_enrolled_at = CASE WHEN $10::bigint IS NULL THEN NULL
                                               ELSE to_timestamp($10::double precision / 1000) END,
                        updated_at = now()
        WHERE id = $1`,
      [
        user.id,
        user.fullNameAr,
        user.roleKey,
        user.branchId,
        user.passwordHash,
        user.failedAttempts,
        user.lockedUntilMs,
        user.active,
        user.mfaSecret === null ? null : Buffer.from(user.mfaSecret, 'utf8'),
        user.mfaEnrolledAtMs,
      ],
    )
  }

  async create(user: UserRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.id, user.branchId, user.roleKey, user.username, user.fullNameAr, user.passwordHash, user.active],
      )
    } catch (err) {
      // Same shape the memory adapter throws, so the route handles one case, not two.
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate username ${user.username}`), { code: 'DUPLICATE_USERNAME' })
      }
      throw err
    }
  }

  async list(branchId?: string | null): Promise<UserRecord[]> {
    // `undefined` = every branch; an explicit value (incl. null for global admins) scopes it.
    // IS NOT DISTINCT FROM matches NULL against NULL, which plain `=` does not.
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT u.*, d.id AS driver_id FROM users u
         LEFT JOIN drivers d ON d.user_id = u.id
         ${branchId === undefined ? '' : 'WHERE u.branch_id IS NOT DISTINCT FROM $1'}
        ORDER BY u.created_at`,
      branchId === undefined ? [] : [branchId],
    )
    return rows.map((r) => this.mapRow(r))
  }
}

export class PgSessionRepo implements SessionRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }
  async create(s: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, mfa_satisfied, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5::double precision/1000), to_timestamp($6::double precision/1000), to_timestamp($7::double precision/1000))`,
      [s.id, s.userId, s.tokenHash, s.mfaSatisfied, s.createdAtMs, s.lastSeenAtMs, s.expiresAtMs],
    )
  }
  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash])
    const r = rows[0]
    if (!r) return null
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      mfaSatisfied: Boolean(r.mfa_satisfied),
      createdAtMs: (r.created_at as Date).getTime(),
      lastSeenAtMs: (r.last_seen_at as Date).getTime(),
      expiresAtMs: (r.expires_at as Date).getTime(),
      revokedAtMs: r.revoked_at === null ? null : (r.revoked_at as Date).getTime(),
    }
  }
  async update(s: SessionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_seen_at   = to_timestamp($2::double precision/1000),
                           expires_at    = to_timestamp($3::double precision/1000),
                           mfa_satisfied = $4,
                           revoked_at    = CASE WHEN $5::bigint IS NULL THEN NULL
                                                ELSE to_timestamp($5::double precision/1000) END
        WHERE id = $1`,
      [s.id, s.lastSeenAtMs, s.expiresAtMs, s.mfaSatisfied, s.revokedAtMs],
    )
  }
  async revokeAllForUser(userId: string, atMs = Date.now()): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = to_timestamp($2::double precision/1000) WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, atMs],
    )
  }
}
