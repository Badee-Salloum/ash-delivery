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
  ShiftOrderRecord,
  UserRecord,
  UserRepo,
} from '@ash/contracts'
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
  const owner = 'driverId' in fund ? fund.driverId : 'costCenterId' in fund ? fund.costCenterId : null
  const ownerKind = 'driverId' in fund ? 'driver' : 'costCenterId' in fund ? 'vehicle' : 'none'

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
    [branchId, fundTypeOf(fund), ownerKind, owner === null ? null : toUuidOrNull(owner), code],
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

        let entryId: number
        try {
          const res = await client.query<{ id: string }>(
            `INSERT INTO journal_entries
               (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date,
                week_start_date, fx_day_id, reason, created_by)
             VALUES ($1, $2::ledger_event, $3, $4, $5, $6, $7, $8, $9, $10)
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
          entryId = Number(res.rows[0]!.id)
        } catch (err) {
          // The idempotency index did its job: this exact event already posted. Writing nothing
          // and carrying on is the whole point — a retried approval must not double-post.
          if (isPgError(err, PG.UNIQUE_VIOLATION)) continue
          throw err
        }

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
  async create(order: ShiftOrderRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO shift_orders (id, shift_id, provider_order_no, pay_mode, fee_minor, zone, driver_confirmed)
         VALUES ($1, $2, $3, $4::pay_mode, $5, $6, $7)`,
        [order.id, order.shiftId, order.providerOrderNo, order.payMode, order.fee.toString(), order.zone, order.driverConfirmed],
      )
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
  async listByShift(shiftId: string): Promise<ShiftOrderRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, shift_id, provider_order_no, pay_mode, fee_minor::text AS fee, zone, driver_confirmed FROM shift_orders WHERE shift_id = $1 ORDER BY provider_order_no',
      [shiftId],
    )
    return rows.map(toOrder)
  }
  async findByProviderNo(providerOrderNo: string): Promise<ShiftOrderRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT id, shift_id, provider_order_no, pay_mode, fee_minor::text AS fee, zone, driver_confirmed FROM shift_orders WHERE provider_order_no = $1',
      [providerOrderNo],
    )
    return rows[0] ? toOrder(rows[0]) : null
  }
  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM shift_orders WHERE id = $1', [id])
  }
}

const toOrder = (r: Record<string, unknown>): ShiftOrderRecord => ({
  id: String(r.id),
  shiftId: String(r.shift_id),
  providerOrderNo: String(r.provider_order_no),
  payMode: r.pay_mode as ShiftOrderRecord['payMode'],
  fee: minor(BigInt(String(r.fee))),
  zone: (r.zone as string | null) ?? null,
  driverConfirmed: Boolean(r.driver_confirmed),
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
    return this.one('username = $1', [username])
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
    if (!r) return null
    return {
      id: String(r.id),
      branchId: (r.branch_id as string | null) ?? null,
      roleKey: r.role_key as UserRecord['roleKey'],
      username: String(r.username),
      fullNameAr: String(r.full_name_ar),
      passwordHash: String(r.password_hash),
      driverId: (r.driver_id as string | null) ?? null,
      failedAttempts: Number(r.failed_attempts),
      lockedUntilMs: r.locked_until === null ? null : (r.locked_until as Date).getTime(),
      active: Boolean(r.active),
    }
  }
  async update(user: UserRecord): Promise<void> {
    await this.pool.query(
      `UPDATE users SET failed_attempts = $2,
                        locked_until = CASE WHEN $3::bigint IS NULL THEN NULL
                                            ELSE to_timestamp($3::double precision / 1000) END,
                        active = $4, updated_at = now()
        WHERE id = $1`,
      [user.id, user.failedAttempts, user.lockedUntilMs, user.active],
    )
  }
}

export class PgSessionRepo implements SessionRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }
  async create(s: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4::double precision/1000), to_timestamp($5::double precision/1000), to_timestamp($6::double precision/1000))`,
      [s.id, s.userId, s.tokenHash, s.createdAtMs, s.lastSeenAtMs, s.expiresAtMs],
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
      createdAtMs: (r.created_at as Date).getTime(),
      lastSeenAtMs: (r.last_seen_at as Date).getTime(),
      expiresAtMs: (r.expires_at as Date).getTime(),
      revokedAtMs: r.revoked_at === null ? null : (r.revoked_at as Date).getTime(),
    }
  }
  async update(s: SessionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_seen_at = to_timestamp($2::double precision/1000),
                           expires_at   = to_timestamp($3::double precision/1000),
                           revoked_at   = CASE WHEN $4::bigint IS NULL THEN NULL
                                               ELSE to_timestamp($4::double precision/1000) END
        WHERE id = $1`,
      [s.id, s.lastSeenAtMs, s.expiresAtMs, s.revokedAtMs],
    )
  }
  async revokeAllForUser(userId: string, atMs = Date.now()): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = to_timestamp($2::double precision/1000) WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, atMs],
    )
  }
}
