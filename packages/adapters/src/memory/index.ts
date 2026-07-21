import type {
  AuditFilter,
  AuditRecord,
  AuditRepo,
  BranchRecord,
  Clock,
  Deps,
  DirectoryRepo,
  DocumentRecord,
  DriverRecord,
  FxRepo,
  IdGen,
  JournalEntryRecord,
  LedgerRepo,
  OrderRepo,
  PasswordHasher,
  RoleGrantRecord,
  SessionRecord,
  SessionRepo,
  ShiftOrderRecord,
  ShiftRecord,
  ShiftRepo,
  UserRecord,
  UserRepo,
  VehicleRecord,
  WeekLockRecord,
  WeekLockRepo,
} from '@ash/contracts'
import { type CalendarDate, type FxDay, type Minor, type Posting, isLive, minor } from '@ash/domain'
import { MemoryBlobStore, MemoryMediaRepo } from './media.ts'

export { MemoryBlobStore, MemoryMediaRepo } from './media.ts'

/**
 * In-memory implementations of every port.
 *
 * These are not toys. They enforce the same invariants the database does — notably the
 * idempotency key `(shiftId, eventType, occurrenceKey)` and the double-entry balance check — so
 * an API test that passes here is testing real behaviour, not a stub that always says yes.
 *
 * The PostgreSQL adapters replace these one file at a time. Anything that passes against these
 * and fails against Postgres is a genuine difference worth knowing about.
 */

export class FixedClock implements Clock {
  // Explicit fields, not TypeScript parameter properties: Node's strip-only type stripping
  // cannot erase those, and this code is executed as source in development.
  private ms: number
  private readonly offset: number
  constructor(ms: number, offset = 180) {
    // Asia/Damascus, UTC+3 year-round since Oct 2022
    this.ms = ms
    this.offset = offset
  }
  nowMs(): number {
    return this.ms
  }
  offsetMinutes(): number {
    return this.offset
  }
  advance(ms: number): void {
    this.ms += ms
  }
  set(ms: number): void {
    this.ms = ms
  }
}

export class SeqIdGen implements IdGen {
  private n = 0
  uuid(): string {
    this.n += 1
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`
  }
  token(): string {
    this.n += 1
    return `token-${this.n}`
  }
}

/** Test-only hasher: deterministic and instant. Production uses bcrypt cost 12 (SRS §7). */
export class PlainHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `plain:${plain}`
  }
  async verify(plain: string, hash: string): Promise<boolean> {
    return hash === `plain:${plain}`
  }
}

export class MemoryUserRepo implements UserRepo {
  readonly rows: Map<string, UserRecord>
  constructor(rows = new Map<string, UserRecord>()) {
    this.rows = rows
  }
  async findByUsername(username: string): Promise<UserRecord | null> {
    for (const u of this.rows.values()) if (u.username === username) return { ...u }
    return null
  }
  async findById(id: string): Promise<UserRecord | null> {
    const u = this.rows.get(id)
    return u ? { ...u } : null
  }
  async update(user: UserRecord): Promise<void> {
    this.rows.set(user.id, { ...user })
  }
  seed(user: UserRecord): void {
    this.rows.set(user.id, { ...user })
  }
}

export class MemorySessionRepo implements SessionRepo {
  private readonly rows = new Map<string, SessionRecord>()
  async create(session: SessionRecord): Promise<void> {
    this.rows.set(session.id, { ...session })
  }
  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    for (const s of this.rows.values()) if (s.tokenHash === tokenHash) return { ...s }
    return null
  }
  async update(session: SessionRecord): Promise<void> {
    this.rows.set(session.id, { ...session })
  }
  async revokeAllForUser(userId: string, atMs = 0): Promise<void> {
    // Time is passed in, never read from the wall clock — same rule as the domain.
    for (const [id, s] of this.rows) {
      if (s.userId === userId) this.rows.set(id, { ...s, revokedAtMs: atMs })
    }
  }
}

export class MemoryShiftRepo implements ShiftRepo {
  readonly rows = new Map<string, ShiftRecord>()
  private readonly media: MemoryMediaRepo
  constructor(media: MemoryMediaRepo) {
    this.media = media
  }

  /**
   * Evidence slots are a PROJECTION of uploaded media, never whatever the caller passed in.
   * Persisting a client-supplied list would let the driver's app assert a photo exists that
   * never arrived — and the BR5 gates read exactly this field.
   */
  private async withSlots(shift: ShiftRecord): Promise<ShiftRecord> {
    const attached = await this.media.listSlots(shift.id)
    return {
      ...structuredClone(shift),
      mediaSlotsStart: attached.filter((a) => a.package === 'start').map((a) => a.slot).sort(),
      mediaSlotsEnd: attached.filter((a) => a.package === 'end').map((a) => a.slot).sort(),
    }
  }

  async create(shift: ShiftRecord): Promise<void> {
    this.rows.set(shift.id, structuredClone(shift))
  }
  async findById(id: string): Promise<ShiftRecord | null> {
    const s = this.rows.get(id)
    return s ? this.withSlots(s) : null
  }
  async update(shift: ShiftRecord): Promise<void> {
    this.rows.set(shift.id, structuredClone(shift))
  }
  async listLiveForDriver(driverId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.driverId === driverId && isLive(s.state))
  }
  async listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.vehicleId === vehicleId && isLive(s.state))
  }
  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.branchId === branchId && s.businessDate === businessDate)
  }
  async listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter(
      (s) => s.driverId === driverId && s.businessDate === businessDate && (s.state === 'approved' || s.state === 'week_locked'),
    )
  }
}

export class MemoryOrderRepo implements OrderRepo {
  readonly rows = new Map<string, ShiftOrderRecord>()
  async create(order: ShiftOrderRecord): Promise<void> {
    // The database has a GLOBAL unique index on provider_order_no; mirror it here so a test
    // cannot pass against a laxer rule than production enforces.
    for (const o of this.rows.values()) {
      if (o.providerOrderNo === order.providerOrderNo) {
        throw Object.assign(new Error(`duplicate provider_order_no ${order.providerOrderNo}`), {
          code: 'DUPLICATE_ORDER_NO',
        })
      }
    }
    this.rows.set(order.id, { ...order })
  }
  async listByShift(shiftId: string): Promise<ShiftOrderRecord[]> {
    return [...this.rows.values()].filter((o) => o.shiftId === shiftId)
  }
  async findByProviderNo(providerOrderNo: string): Promise<ShiftOrderRecord | null> {
    for (const o of this.rows.values()) if (o.providerOrderNo === providerOrderNo) return { ...o }
    return null
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

export class MemoryLedgerRepo implements LedgerRepo {
  readonly entries: JournalEntryRecord[] = []
  private nextId = 1
  /** Mirrors the database's UNIQUE (shift_id, event_type, occurrence_key). */
  private readonly seen = new Set<string>()

  async post(
    branchId: string,
    postings: readonly Posting[],
    meta: Parameters<LedgerRepo['post']>[2],
  ): Promise<JournalEntryRecord[]> {
    const written: JournalEntryRecord[] = []
    for (const posting of postings) {
      // Balance, exactly as the deferred constraint trigger does at COMMIT.
      let d = 0n
      let c = 0n
      for (const l of posting.lines) {
        if (l.side === 'D') d += l.amount
        else c += l.amount
      }
      if (d !== c) throw new Error(`unbalanced posting ${posting.eventType}: D ${d} <> C ${c}`)

      const key = `${meta.shiftId ?? '-'}|${posting.eventType}|${posting.occurrenceKey}`
      if (meta.shiftId !== null && this.seen.has(key)) continue // idempotent replay: write nothing
      if (meta.shiftId !== null) this.seen.add(key)

      const entry: JournalEntryRecord = {
        id: this.nextId++,
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
      }
      this.entries.push(entry)
      written.push(entry)
    }
    return written
  }

  async listByShift(shiftId: string): Promise<JournalEntryRecord[]> {
    return this.entries.filter((e) => e.shiftId === shiftId)
  }
  async listByWeek(branchId: string, weekStartDate: CalendarDate): Promise<JournalEntryRecord[]> {
    return this.entries.filter((e) => e.branchId === branchId && e.weekStartDate === weekStartDate)
  }
  async fundBalance(branchId: string, fundCode: string): Promise<Minor> {
    let total = 0n
    for (const e of this.entries) {
      if (e.branchId !== branchId) continue
      for (const l of e.lines) {
        if (l.fundCode !== fundCode) continue
        total += l.side === 'D' ? l.amount : -l.amount
      }
    }
    return minor(total)
  }
  sealWeek(branchId: string, weekStartDate: CalendarDate, lockId: number): number {
    let n = 0
    for (const e of this.entries) {
      if (e.branchId === branchId && e.weekStartDate === weekStartDate && e.weekLockId === null) {
        e.weekLockId = lockId
        n++
      }
    }
    return n
  }
}

/** Stable fund identity, mirroring `funds.code` in the schema. */
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

export class MemoryFxRepo implements FxRepo {
  private readonly rows = new Map<CalendarDate, { id: number; day: FxDay }>()
  private nextId = 1
  async list(): Promise<FxDay[]> {
    return [...this.rows.values()].map((r) => r.day)
  }
  async upsert(day: FxDay): Promise<number> {
    const existing = this.rows.get(day.businessDate)
    if (existing) {
      existing.day = day
      return existing.id
    }
    const id = this.nextId++
    this.rows.set(day.businessDate, { id, day })
    return id
  }
  async idFor(businessDate: CalendarDate): Promise<number | null> {
    return this.rows.get(businessDate)?.id ?? null
  }
}

export class MemoryWeekLockRepo implements WeekLockRepo {
  readonly rows: WeekLockRecord[] = []
  private nextId = 1
  private readonly ledger: MemoryLedgerRepo
  constructor(ledger: MemoryLedgerRepo) {
    this.ledger = ledger
  }
  async find(branchId: string, weekStartDate: CalendarDate): Promise<WeekLockRecord | null> {
    return this.rows.find((r) => r.branchId === branchId && r.weekStartDate === weekStartDate) ?? null
  }
  async create(lock: Omit<WeekLockRecord, 'id'>): Promise<WeekLockRecord> {
    const row = { ...lock, id: this.nextId++ }
    this.rows.push(row)
    return row
  }
  async seal(id: number, closedBy: string, closedAtMs: number): Promise<number> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) throw new Error(`no week lock ${id}`)
    // Stamp the entries FIRST, then close — the same order fin_seal_week() uses, because the
    // week-lock trigger refuses writes to entries already belonging to a closed week.
    const sealed = this.ledger.sealWeek(row.branchId, row.weekStartDate, id)
    row.closedAtMs = closedAtMs
    row.closedBy = closedBy
    return sealed
  }
  async listClosedStarts(branchId: string): Promise<CalendarDate[]> {
    return this.rows.filter((r) => r.branchId === branchId && r.closedAtMs !== null).map((r) => r.weekStartDate)
  }
}

export class MemoryAuditRepo implements AuditRepo {
  readonly rows: AuditRecord[] = []
  private nextId = 1
  async append(record: Omit<AuditRecord, 'id'>): Promise<void> {
    this.rows.push({ ...record, id: this.nextId++ })
  }
  async list(filter: AuditFilter): Promise<AuditRecord[]> {
    return this.rows.filter(
      (r) =>
        (filter.tableName === undefined || r.tableName === filter.tableName) &&
        (filter.recordId === undefined || r.recordId === filter.recordId) &&
        (filter.actorId === undefined || r.actorId === filter.actorId),
    )
  }
}

export class MemoryDirectoryRepo implements DirectoryRepo {
  readonly branches = new Map<string, BranchRecord>()
  readonly drivers = new Map<string, DriverRecord>()
  readonly vehicles = new Map<string, VehicleRecord>()
  private grantRows: RoleGrantRecord[] = []

  async branch(id: string): Promise<BranchRecord | null> {
    return this.branches.get(id) ?? null
  }
  async driver(id: string): Promise<DriverRecord | null> {
    return this.drivers.get(id) ?? null
  }
  async vehicle(id: string): Promise<VehicleRecord | null> {
    return this.vehicles.get(id) ?? null
  }
  async grants(): Promise<RoleGrantRecord[]> {
    return this.grantRows
  }
  setGrants(rows: RoleGrantRecord[]): void {
    this.grantRows = rows
  }

  // ── Fleet management (SRS B) ────────────────────────────────────────────────────────────
  readonly documents = new Map<string, DocumentRecord>()

  async listDrivers(branchId: string): Promise<DriverRecord[]> {
    return [...this.drivers.values()].filter((d) => d.branchId === branchId)
  }
  async createDriver(driver: DriverRecord): Promise<void> {
    for (const d of this.drivers.values()) {
      // Mirrors the schema's UNIQUE on drivers.code.
      if (d.code === driver.code) {
        throw Object.assign(new Error(`duplicate driver code ${driver.code}`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.drivers.set(driver.id, { ...driver })
  }
  async updateDriver(driver: DriverRecord): Promise<void> {
    this.drivers.set(driver.id, { ...driver })
  }

  async listVehicles(branchId: string): Promise<VehicleRecord[]> {
    return [...this.vehicles.values()].filter((v) => v.branchId === branchId)
  }
  async createVehicle(vehicle: VehicleRecord): Promise<void> {
    for (const v of this.vehicles.values()) {
      if (v.code === vehicle.code) {
        throw Object.assign(new Error(`duplicate vehicle code ${vehicle.code}`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.vehicles.set(vehicle.id, { ...vehicle })
  }
  async updateVehicle(vehicle: VehicleRecord): Promise<void> {
    this.vehicles.set(vehicle.id, { ...vehicle })
  }

  async createDocument(doc: DocumentRecord): Promise<void> {
    this.documents.set(doc.id, { ...doc })
  }
  async listDocuments(owner: { driverId?: string; vehicleId?: string }): Promise<DocumentRecord[]> {
    return [...this.documents.values()].filter(
      (d) =>
        d.supersededBy === null &&
        ((owner.driverId !== undefined && d.driverId === owner.driverId) ||
          (owner.vehicleId !== undefined && d.vehicleId === owner.vehicleId)),
    )
  }
  async listExpiringDocuments(branchId: string, through: CalendarDate): Promise<DocumentRecord[]> {
    return [...this.documents.values()].filter(
      (d) => d.branchId === branchId && d.supersededBy === null && d.expiresOn !== null && d.expiresOn <= through,
    )
  }
}

export interface MemoryDeps extends Deps {
  clock: FixedClock
  media: MemoryMediaRepo
  blobs: MemoryBlobStore
  users: MemoryUserRepo
  shifts: MemoryShiftRepo
  orders: MemoryOrderRepo
  ledger: MemoryLedgerRepo
  fx: MemoryFxRepo
  weekLocks: MemoryWeekLockRepo
  audit: MemoryAuditRepo
  directory: MemoryDirectoryRepo
}

export function createMemoryDeps(nowMs: number): MemoryDeps {
  const ledger = new MemoryLedgerRepo()
  const media = new MemoryMediaRepo()
  return {
    clock: new FixedClock(nowMs),
    ids: new SeqIdGen(),
    hasher: new PlainHasher(),
    users: new MemoryUserRepo(),
    sessions: new MemorySessionRepo(),
    shifts: new MemoryShiftRepo(media),
    orders: new MemoryOrderRepo(),
    ledger,
    media,
    blobs: new MemoryBlobStore(),
    fx: new MemoryFxRepo(),
    weekLocks: new MemoryWeekLockRepo(ledger),
    audit: new MemoryAuditRepo(),
    directory: new MemoryDirectoryRepo(),
  }
}
