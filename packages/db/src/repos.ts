import type {
  AuditFilter,
  AuditRecord,
  AuditRepo,
  FxRepo,
  JournalEntryRecord,
  LedgerRepo,
  OrderRepo,
  SessionRecord,
  SessionRepo,
  OrderPointRecord,
  ShiftOrderRecord,
  UserRecord,
  UserRepo,
  WalletMovementInput,
  WalletMovementRecord,
  WalletMovementRepo,
  WalletMovementRole,
} from '@ash/contracts'
import { normalizeUsername } from '@ash/contracts'
import { type CalendarDate, type FxDay, type Minor, type Posting, minor } from '@ash/domain'
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
 * Stable fund identity. Matches `fundCodeOf` in the memory adapter exactly — the conformance
 * suite asserts balances by these strings, so they must not drift.
 */
export function fundCodeOf(fund: Posting['lines'][number]['fund']): string {
  switch (fund.kind) {
    case 'driver_cash':
    case 'driver_wallet':
    case 'driver_share_payable':
    // A ذمة belongs to one named driver; without the suffix every driver's receivable merges into
    // a single fund and the totals stay right while «who owes this» becomes unanswerable.
    case 'driver_receivable_cash':
    case 'driver_receivable_wallet':
      return `${fund.kind}:${fund.driverId}`
    case 'cost_center':
      return `cost_center:${fund.costCenterId}`
    default:
      return fund.kind
  }
}

/** Which `fund_type` enum value a code maps to. */
function fundTypeOf(fund: Posting['lines'][number]['fund']): string {
  switch (fund.kind) {
    case 'company_revenue':
    case 'yalago_income':
    case 'fee_earned':
      // Not in the client's literal E-1 tree; they are the P&L accounts the tree implies.
      return 'cost_center'
    default:
      return fund.kind
  }
}

/**
 * Funds are created on first use.
 *
 * The client's tree has one cash and one wallet fund PER DRIVER (E-1), so provisioning them
 * lazily is simpler and less error-prone than a trigger on `drivers` that has to be kept in
 * step with every future fund type.
 */
async function ensureFund(client: PoolClient, branchId: string, fund: Posting['lines'][number]['fund']): Promise<string> {
  const code = fundCodeOf(fund)
  // A cost centre owned by a VEHICLE carries that vehicle's uuid; a NAMED contra account
  // ("opening_balance", "owner_funding", "adjustments") has no owner and is owner_kind='none'.
  // Getting this wrong trips funds_owner_ck: CHECK ((owner_kind='none') = (owner_id IS NULL)).
  const costUuid = 'costCenterId' in fund ? toUuidOrNull(fund.costCenterId) : null
  const ownerId = 'driverId' in fund ? fund.driverId : costUuid
  const ownerKind = 'driverId' in fund ? 'driver' : costUuid !== null ? 'vehicle' : 'none'

  const found = await client.query<{ id: string }>(
    'SELECT id FROM funds WHERE branch_id = $1 AND code = $2',
    [branchId, code],
  )
  if (found.rows[0]) return found.rows[0].id

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
     VALUES ($1, $2::fund_type, $3, $4, $5, $5)
     ON CONFLICT (branch_id, code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [branchId, fundTypeOf(fund), ownerKind, ownerId, code],
  )
  return inserted.rows[0]!.id
}

/** Driver ids in this system are uuids; a non-uuid (test fixture) becomes NULL rather than an error. */
function toUuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
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
      const written: JournalEntryRecord[] = []

      for (const posting of postings) {
        // Balance is ALSO enforced by a deferred constraint trigger at COMMIT. Checking here
        // first turns it into a clear application error instead of a transaction that fails at
        // the very end with every other posting already staged.
        let d = 0n
        let c = 0n
        for (const l of posting.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
        if (d !== c) throw new Error(`unbalanced posting ${posting.eventType}: D ${d} <> C ${c}`)

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
        const res = await client.query<{ id: string }>(
          `INSERT INTO journal_entries
             (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
              week_start_date, fx_day_id, reason, created_by)
           VALUES ($1, $2::ledger_event, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
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
          weekLockId: null,
          reason: meta.reason ?? null,
          createdBy: meta.createdBy,
          lines: posting.lines.map((l) => ({
            fundCode: fundCodeOf(l.fund),
            side: l.side,
            amount: l.amount,
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

  private async load(where: string, params: unknown[]): Promise<JournalEntryRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT je.*,
              COALESCE(
                json_agg(json_build_object('fundCode', f.code, 'side', jl.side,
                                           'amount', jl.amount_minor::text, 'role', jl.line_role)
                         ORDER BY jl.id) FILTER (WHERE jl.id IS NOT NULL), '[]'
              ) AS lines
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
         LEFT JOIN funds f ON f.id = jl.fund_id
        WHERE ${where}
        GROUP BY je.id
        ORDER BY je.id`,
      params,
    )
    return rows.map((r) => ({
      id: Number(r.id),
      branchId: String(r.branch_id),
      eventType: r.event_type as JournalEntryRecord['eventType'],
      shiftId: (r.shift_id as string | null) ?? null,
      occurrenceKey: String(r.occurrence_key),
      businessDate: isoDate(r.business_date),
      postingDate: isoDate(r.posting_date),
      weekStartDate: isoDate(r.week_start_date),
      fxDayId: Number(r.fx_day_id),
      weekLockId: r.week_lock_id === null ? null : Number(r.week_lock_id),
      reason: (r.reason as string | null) ?? null,
      createdBy: String(r.created_by),
      // amount comes back as ::text and is parsed to BigInt here — never through Number().
      lines: (r.lines as Array<{ fundCode: string; side: 'D' | 'C'; amount: string; role: string | null }>).map(
        (l) => ({
          fundCode: l.fundCode,
          side: l.side,
          amount: minor(BigInt(l.amount)),
          ...(l.role === null ? {} : { role: l.role }),
        }),
      ),
    }))
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
        WHERE f.branch_id = $1 AND f.code LIKE $2 || '%'
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
       DO UPDATE SET target_minor = EXCLUDED.target_minor, note = EXCLUDED.note`,
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
    cashCountId: string
    plan: unknown
    netToCompany: Minor
    reason: string
    performedBy: string
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO restorations (branch_id, business_date, cash_count_id, plan, net_to_company_minor, reason, performed_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
        [
          row.branchId,
          row.businessDate,
          row.cashCountId,
          JSON.stringify(row.plan),
          row.netToCompany.toString(),
          row.reason,
          row.performedBy,
        ],
      )
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error('already restored today'), { code: 'DUPLICATE_RESTORATION' })
      }
      throw err
    }
  }

  async find(branchId: string, businessDate: string) {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM restorations WHERE branch_id = $1 AND business_date = $2',
      [branchId, businessDate],
    )
    const r = rows[0]
    if (!r) return null
    return {
      branchId: String(r.branch_id),
      businessDate: String(r.business_date).slice(0, 10),
      cashCountId: String(r.cash_count_id),
      plan: r.plan,
      netToCompany: minor(BigInt(String(r.net_to_company_minor))),
      reason: String(r.reason),
      performedBy: String(r.performed_by),
    }
  }
}

/** Postgres `date` comes back as a JS Date in local time; format it back without a timezone hop. */
function isoDate(value: unknown): CalendarDate {
  if (typeof value === 'string') return value.slice(0, 10)
  const d = value as Date
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class PgOrderRepo implements OrderRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
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

  async create(order: ShiftOrderRecord): Promise<void> {
    try {
      // The order and its route go in together: a manual job whose points failed to write would be
      // a delivery from nowhere to nowhere, and the manager would have no way to see it went wrong.
      await withTransaction(this.pool, {}, async (client) => {
        await client.query(
          `INSERT INTO shift_orders (id, shift_id, provider_order_no, pay_mode, fee_minor, zone, driver_confirmed,
                                     source, fee_ocr_minor, kind, driver_share_minor, company_share_minor, notes, created_by,
                                     included, wallet_amount_minor, occurred_minute, occurred_date)
           VALUES ($1, $2, $3, $4::pay_mode, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
  async update(order: ShiftOrderRecord): Promise<void> {
    await this.pool.query(
      `UPDATE shift_orders
          SET pay_mode = $2::pay_mode, fee_minor = $3, zone = $4, source = $5, fee_ocr_minor = $6,
              notes = $7, included = $8, wallet_amount_minor = $9, occurred_minute = $10,
              occurred_date = $11
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
      ],
    )
  }
  async listByShift(shiftId: string): Promise<ShiftOrderRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${ORDER_COLUMNS} WHERE shift_id = $1 ORDER BY provider_order_no`,
      [shiftId],
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
  async replacePoints(orderId: string, points: readonly OrderPointRecord[]): Promise<void> {
    await withTransaction(this.pool, {}, async (client) => {
      await client.query('DELETE FROM shift_order_points WHERE order_id = $1', [orderId])
      for (const [i, point] of points.entries()) {
        await client.query(
          `INSERT INTO shift_order_points (order_id, seq, role, label, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)`,
          [orderId, i + 1, point.role, point.label, point.lat, point.lng],
        )
      }
    })
  }
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM shift_orders WHERE id = $1', [id])
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
})

/**
 * The wallet's own rows, merged page by page.
 *
 * `merge` is the interesting one: two screenshots of one scrolling log overlap, so the same rows
 * arrive twice and re-uploading a page must add nothing. It counts what is already stored for each
 * `(minute, amount)` and inserts only the surplus, numbering from there.
 */
export class PgWalletMovementRepo implements WalletMovementRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async listByShift(shiftId: string): Promise<WalletMovementRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `${MOVEMENT_COLUMNS} WHERE shift_id = $1 ORDER BY occurred_minute, amount_minor, seq`,
      [shiftId],
    )
    return rows.map(toMovement)
  }

  async merge(shiftId: string, movements: readonly WalletMovementInput[]): Promise<WalletMovementRecord[]> {
    if (movements.length === 0) return []
    return withTransaction(this.pool, {}, async (client) => {
      // One locked read of the existing tallies, inside the transaction, so two pages uploaded at
      // once cannot both decide they are the surplus.
      const { rows: existing } = await client.query<{ occurred_minute: string; amount_minor: string; n: string }>(
        `SELECT occurred_minute, amount_minor::text AS amount_minor, COUNT(*)::text AS n
           FROM shift_wallet_movements WHERE shift_id = $1
          GROUP BY occurred_minute, amount_minor
          FOR UPDATE`,
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
  ): Promise<void> {
    await this.pool.query(
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
    )
  }

  async deleteByShift(shiftId: string): Promise<void> {
    await this.pool.query('DELETE FROM shift_wallet_movements WHERE shift_id = $1', [shiftId])
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
