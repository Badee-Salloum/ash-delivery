import type {
  AssignmentRecord,
  AssignmentRepo,
  AttendanceRecord,
  AttendanceRepo,
  AuditFilter,
  BatteryReadingRecord,
  BatteryReadingRepo,
  BatteryRecord,
  BatterySwapRecord,
  BatterySwapRepo,
  GovernorateRecord,
  VehicleTypeRecord,
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
  ShiftDecisionRecord,
  ShiftDecisionRepo,
  GpsPingRecord,
  GpsPingRepo,
  OrderPointRecord,
  ShiftOrderRecord,
  ShiftRecord,
  ShiftRepo,
  UserRecord,
  UserRepo,
  VehicleEventRecord,
  VehicleEventRepo,
  VehicleRecord,
  WalletMovementInput,
  WalletMovementRecord,
  WalletMovementRepo,
  WalletMovementRole,
  WeekLockRecord,
  WeekLockRepo,
} from '@ash/contracts'
import { normalizeUsername } from '@ash/contracts'
import { type CalendarDate, type FxDay, type Minor, type Posting, isAwaitingDecision, isLive, minor } from '@ash/domain'
import { memoryCipher } from '../crypto.ts'
import { MemoryBlobStore, MemoryMediaRepo } from './media.ts'
import { MemoryExpenseRepo, MemorySettingsRepo } from './expenses.ts'
import { MemoryCashCountRepo } from './cashcount.ts'
import { MemoryNotificationRepo, MemoryTierRepo } from './tiers.ts'

export { MemoryBlobStore, MemoryMediaRepo } from './media.ts'
export { MemoryExpenseRepo, MemorySettingsRepo } from './expenses.ts'
export { MemoryCashCountRepo } from './cashcount.ts'
export { MemoryNotificationRepo, MemoryTierRepo } from './tiers.ts'

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
    // Same rule as PgUserRepo: an account whose stored name carries characters that cannot be
    // typed back (an invisible kasra from the Arabic layout, a zero-width joiner) is still
    // reachable — but only when exactly ONE account normalises to what was asked for.
    const wanted = normalizeUsername(username)
    if (wanted === '') return null
    const matches = [...this.rows.values()].filter((u) => normalizeUsername(u.username) === wanted)
    return matches.length === 1 ? { ...matches[0]! } : null
  }
  async findById(id: string): Promise<UserRecord | null> {
    const u = this.rows.get(id)
    return u ? { ...u } : null
  }
  async update(user: UserRecord): Promise<void> {
    this.rows.set(user.id, { ...user })
  }
  async create(user: UserRecord): Promise<void> {
    for (const u of this.rows.values()) {
      if (u.username === user.username) {
        throw Object.assign(new Error(`duplicate username ${user.username}`), { code: 'DUPLICATE_USERNAME' })
      }
    }
    this.rows.set(user.id, { ...user })
  }
  async list(branchId?: string | null): Promise<UserRecord[]> {
    const all = [...this.rows.values()].map((u) => ({ ...u }))
    return branchId === undefined ? all : all.filter((u) => u.branchId === branchId)
  }
  /** Test seed. mfa fields default to unenrolled so callers need not spell them out. */
  seed(user: Omit<UserRecord, 'mfaSecret' | 'mfaEnrolledAtMs'> & Partial<Pick<UserRecord, 'mfaSecret' | 'mfaEnrolledAtMs'>>): void {
    this.rows.set(user.id, { mfaSecret: null, mfaEnrolledAtMs: null, ...user })
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
  async listLiveForBranch(branchId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.branchId === branchId && isLive(s.state))
  }
  async listAwaitingDecisionForBranch(branchId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.branchId === branchId && isAwaitingDecision(s.state))
  }
  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.branchId === branchId && s.businessDate === businessDate)
  }

  async listByBranchAndDateRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.branchId === branchId && s.businessDate >= from && s.businessDate <= to)
  }
  async listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter(
      (s) => s.driverId === driverId && s.businessDate === businessDate && (s.state === 'approved' || s.state === 'week_locked'),
    )
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

/**
 * Per-pack BMS readings (SRS §L seam).
 *
 * Keyed exactly like the table's UNIQUE (shift, battery, package): a re-upload after a retake
 * CORRECTS the reading rather than adding a second one, which is what stops a driver stacking
 * readings until one of them looks right.
 */
export class MemoryBatteryReadingRepo implements BatteryReadingRepo {
  readonly rows = new Map<string, BatteryReadingRecord>()
  private key(r: Pick<BatteryReadingRecord, 'shiftId' | 'batteryId' | 'package'>): string {
    return `${r.shiftId}|${r.batteryId}|${r.package}`
  }
  async upsert(reading: BatteryReadingRecord): Promise<void> {
    this.rows.set(this.key(reading), { ...reading })
  }
  async listByShift(shiftId: string): Promise<BatteryReadingRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.shiftId === shiftId)
      .sort((a, b) => a.package.localeCompare(b.package) || a.slotNo - b.slotNo)
      .map((r) => ({ ...r }))
  }
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, ordered by seq_no per shift. */
export class MemoryBatterySwapRepo implements BatterySwapRepo {
  readonly rows: BatterySwapRecord[] = []
  async create(swap: BatterySwapRecord): Promise<void> {
    this.rows.push({ ...swap })
  }
  async listByShift(shiftId: string): Promise<BatterySwapRecord[]> {
    return this.rows
      .filter((r) => r.shiftId === shiftId)
      .sort((a, b) => a.seqNo - b.seqNo)
      .map((r) => ({ ...r }))
  }
}

/** Driver↔vehicle assignments (SRS B-3), mirroring the table's two uniqueness rules. */
export class MemoryAssignmentRepo implements AssignmentRepo {
  readonly rows = new Map<string, AssignmentRecord>()
  async create(a: AssignmentRecord): Promise<void> {
    for (const existing of this.rows.values()) {
      const sameSlot = existing.businessDate === a.businessDate && existing.shiftNo === a.shiftNo
      if (sameSlot && (existing.driverId === a.driverId || existing.vehicleId === a.vehicleId)) {
        throw Object.assign(new Error('already assigned'), { code: 'DUPLICATE_ASSIGNMENT' })
      }
    }
    this.rows.set(a.id, { ...a })
  }
  async listByDate(branchId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]> {
    return [...this.rows.values()].filter((a) => a.branchId === branchId && a.businessDate === businessDate)
  }
  async findForDriver(driverId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]> {
    return [...this.rows.values()].filter((a) => a.driverId === driverId && a.businessDate === businessDate)
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
}

export class MemoryOrderRepo implements OrderRepo {
  readonly rows = new Map<string, ShiftOrderRecord>()
  /** Samples kept only so a test can assert one was written; nothing reads them back in memory. */
  readonly ocrSamples: Array<{ shiftOrderId: string; source: 'ocr' | 'refused'; bytes: number }> = []

  async recordOcrSample(shiftOrderId: string, source: 'ocr' | 'refused', stripPng: Uint8Array): Promise<void> {
    // Mirrors the table's UNIQUE (shift_order_id): a re-submitted close must not stack duplicates.
    if (this.ocrSamples.some((x) => x.shiftOrderId === shiftOrderId)) return
    this.ocrSamples.push({ shiftOrderId, source, bytes: stripPng.length })
  }

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
  /** Identity is never changed — only what a human may correct. Mirrors `PgOrderRepo.update`. */
  async update(order: ShiftOrderRecord): Promise<void> {
    const existing = this.rows.get(order.id)
    if (!existing) return
    this.rows.set(order.id, {
      ...existing,
      payMode: order.payMode,
      fee: order.fee,
      zone: order.zone,
      source: order.source,
      feeOcr: order.feeOcr,
      notes: order.notes,
      included: order.included,
      walletAmount: order.walletAmount,
      occurredMinute: order.occurredMinute,
      occurredDate: order.occurredDate,
    })
  }
  async replacePoints(orderId: string, points: readonly OrderPointRecord[]): Promise<void> {
    const existing = this.rows.get(orderId)
    if (!existing) return
    this.rows.set(orderId, { ...existing, points: points.map((p) => ({ ...p })) })
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

export class MemoryWalletMovementRepo implements WalletMovementRepo {
  readonly rows = new Map<string, WalletMovementRecord>()
  private nextId = 1

  async listByShift(shiftId: string): Promise<WalletMovementRecord[]> {
    return [...this.rows.values()]
      .filter((m) => m.shiftId === shiftId)
      .sort((a, b) => {
        if (a.occurredMinute !== b.occurredMinute) return a.occurredMinute.localeCompare(b.occurredMinute)
        // Compared as bigints. `Number(a.amount - b.amount)` would order correctly today and lose
        // precision on a large enough difference — and money never becomes a float here, ever.
        if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1
        return a.seq - b.seq
      })
      .map((m) => ({ ...m }))
  }

  /** The same multiset merge the database does: consume a match, insert only the surplus. */
  async merge(shiftId: string, movements: readonly WalletMovementInput[]): Promise<WalletMovementRecord[]> {
    const tally = new Map<string, number>()
    for (const m of this.rows.values()) {
      if (m.shiftId !== shiftId) continue
      const key = `${m.occurredMinute}|${m.amount.toString()}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    const written: WalletMovementRecord[] = []
    for (const input of movements) {
      const key = `${input.occurredMinute}|${input.amount.toString()}`
      const already = tally.get(key) ?? 0
      if (already > 0) {
        tally.set(key, already - 1)
        continue
      }
      let maxSeq = 0
      for (const m of this.rows.values()) {
        if (m.shiftId === shiftId && m.occurredMinute === input.occurredMinute && m.amount === input.amount) {
          maxSeq = Math.max(maxSeq, m.seq)
        }
      }
      const row: WalletMovementRecord = {
        id: `wm-${this.nextId++}`,
        shiftId,
        amount: input.amount,
        occurredMinute: input.occurredMinute,
        seq: maxSeq + 1,
        orderId: input.orderId ?? null,
        role: input.role ?? 'unmatched',
        ambiguous: input.ambiguous ?? false,
        included: input.included ?? true,
        source: input.source ?? 'ocr',
        mediaId: input.mediaId ?? null,
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
      }
      this.rows.set(row.id, row)
      written.push({ ...row })
    }
    return written
  }

  async update(
    id: string,
    patch: { role?: WalletMovementRole; orderId?: string | null; included?: boolean; ambiguous?: boolean },
  ): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return
    this.rows.set(id, {
      ...row,
      role: patch.role ?? row.role,
      // `orderId: null` is a real instruction — «belongs to no order» — so presence decides, not truthiness.
      orderId: Object.hasOwn(patch, 'orderId') ? (patch.orderId ?? null) : row.orderId,
      included: patch.included ?? row.included,
      ambiguous: patch.ambiguous ?? row.ambiguous,
    })
  }

  async deleteByShift(shiftId: string): Promise<void> {
    for (const [id, m] of this.rows) if (m.shiftId === shiftId) this.rows.delete(id)
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
  async listBranches(): Promise<BranchRecord[]> {
    return [...this.branches.values()].map((b) => ({ ...b }))
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
  async setGrant(
    roleKey: RoleGrantRecord['roleKey'],
    permissionKey: RoleGrantRecord['permissionKey'],
    scope: RoleGrantRecord['scope'] | null,
  ): Promise<void> {
    const rest = this.grantRows.filter((g) => !(g.roleKey === roleKey && g.permissionKey === permissionKey))
    this.grantRows = scope === null ? rest : [...rest, { roleKey, permissionKey, scope }]
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

  // ── Geography and the vehicle-numbering scheme ──────────────────────────────────────────
  readonly governorates = new Map<string, GovernorateRecord>()
  readonly vehicleTypes = new Map<string, VehicleTypeRecord>()

  async listGovernorates(): Promise<GovernorateRecord[]> {
    return [...this.governorates.values()].sort((a, b) => a.no - b.no).map((g) => ({ ...g }))
  }
  async createGovernorate(governorate: GovernorateRecord): Promise<void> {
    this.assertFreeNo(this.governorates, governorate, 'governorate')
    this.governorates.set(governorate.id, { ...governorate })
  }
  async updateGovernorate(governorate: GovernorateRecord): Promise<void> {
    this.assertFreeNo(this.governorates, governorate, 'governorate')
    this.governorates.set(governorate.id, { ...governorate })
  }
  async createBranch(branch: BranchRecord): Promise<void> {
    this.assertBranchNumberFree(branch)
    this.branches.set(branch.id, { ...branch })
  }
  async updateBranch(branch: BranchRecord): Promise<void> {
    this.assertBranchNumberFree(branch)
    this.branches.set(branch.id, { ...branch })
  }

  /** Mirrors the schema's UNIQUE (governorate_id, branch_no): branch 1 of Damascus is one place. */
  private assertBranchNumberFree(branch: BranchRecord): void {
    for (const existing of this.branches.values()) {
      if (existing.id === branch.id) continue
      if (existing.governorateId === branch.governorateId && existing.branchNo === branch.branchNo) {
        throw Object.assign(new Error(`branch number ${branch.branchNo} is taken in that governorate`), {
          code: 'DUPLICATE_CODE',
        })
      }
      if (existing.code === branch.code) {
        throw Object.assign(new Error(`branch code ${branch.code} is taken`), { code: 'DUPLICATE_CODE' })
      }
    }
  }

  async listVehicleTypes(): Promise<VehicleTypeRecord[]> {
    return [...this.vehicleTypes.values()].sort((a, b) => a.typeNo - b.typeNo).map((t) => ({ ...t }))
  }
  async createVehicleType(type: VehicleTypeRecord): Promise<void> {
    for (const t of this.vehicleTypes.values()) {
      if (t.id !== type.id && (t.typeNo === type.typeNo || t.code === type.code)) {
        throw Object.assign(new Error(`duplicate vehicle type ${type.code}/${type.typeNo}`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.vehicleTypes.set(type.id, { ...type })
  }

  /**
   * Renumbering a type restates every one of its vehicles' codes, here in one step because the
   * Postgres adapter does it in one transaction. Doing only half of it would leave the stored
   * codes quietly disagreeing with the scheme that produced them.
   */
  async updateVehicleType(
    type: VehicleTypeRecord,
    format: (v: { governorateNo: number; branchNo: number; typeNo: number; machineNo: number }) => string,
  ): Promise<void> {
    for (const t of this.vehicleTypes.values()) {
      if (t.id !== type.id && t.typeNo === type.typeNo) {
        throw Object.assign(new Error(`vehicle type number ${type.typeNo} is taken`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.vehicleTypes.set(type.id, { ...type })

    for (const vehicle of this.vehicles.values()) {
      if (vehicle.vehicleTypeId !== type.id) continue
      const branch = this.branches.get(vehicle.branchId)
      const governorate = branch ? this.governorates.get(branch.governorateId) : undefined
      if (!branch || !governorate) continue
      this.vehicles.set(vehicle.id, {
        ...vehicle,
        code: format({
          governorateNo: governorate.no,
          branchNo: branch.branchNo,
          typeNo: type.typeNo,
          machineNo: vehicle.machineNo,
        }),
      })
    }
  }

  private assertFreeNo(
    map: Map<string, { id: string; no: number }>,
    row: { id: string; no: number },
    what: string,
  ): void {
    for (const existing of map.values()) {
      if (existing.id !== row.id && existing.no === row.no) {
        throw Object.assign(new Error(`${what} number ${row.no} is taken`), { code: 'DUPLICATE_CODE' })
      }
    }
  }

  // ── Batteries (SRS §L seam) ─────────────────────────────────────────────────────────────
  readonly batteries = new Map<string, BatteryRecord>()

  async listBatteries(branchId: string): Promise<BatteryRecord[]> {
    return [...this.batteries.values()].filter((b) => b.branchId === branchId).map((b) => ({ ...b }))
  }
  async listBatteriesForVehicle(vehicleId: string): Promise<BatteryRecord[]> {
    return [...this.batteries.values()]
      .filter((b) => b.vehicleId === vehicleId && b.active)
      .sort((a, b) => (a.slotNo ?? 0) - (b.slotNo ?? 0))
      .map((b) => ({ ...b }))
  }
  async battery(id: string): Promise<BatteryRecord | null> {
    const found = this.batteries.get(id)
    return found ? { ...found } : null
  }
  async createBattery(battery: BatteryRecord): Promise<void> {
    this.assertBatteryPlacement(battery)
    this.batteries.set(battery.id, { ...battery })
  }
  async updateBattery(battery: BatteryRecord): Promise<void> {
    this.assertBatteryPlacement(battery)
    this.batteries.set(battery.id, { ...battery })
  }

  /** Mirrors the schema: fitted means BOTH vehicle and slot, and one pack per slot. */
  private assertBatteryPlacement(battery: BatteryRecord): void {
    if ((battery.vehicleId === null) !== (battery.slotNo === null)) {
      throw Object.assign(new Error('a battery is fitted to a slot on a bike, or to neither'), {
        code: 'BATTERY_HALF_FITTED',
      })
    }
    for (const existing of this.batteries.values()) {
      if (existing.id === battery.id) continue
      if (battery.serialNo !== null && existing.serialNo === battery.serialNo) {
        throw Object.assign(new Error(`duplicate battery serial ${battery.serialNo}`), { code: 'DUPLICATE_CODE' })
      }
      if (
        battery.vehicleId !== null &&
        existing.vehicleId === battery.vehicleId &&
        existing.slotNo === battery.slotNo
      ) {
        throw Object.assign(new Error(`slot ${battery.slotNo} is already taken`), { code: 'BATTERY_SLOT_TAKEN' })
      }
    }
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

/** The vehicle life log (SRS B-2 / س66): append-only events, read newest-first. */
export class MemoryVehicleEventRepo implements VehicleEventRepo {
  readonly rows: VehicleEventRecord[] = []
  private nextId = 1

  async create(event: Omit<VehicleEventRecord, 'id'>): Promise<VehicleEventRecord> {
    const row: VehicleEventRecord = { ...event, id: this.nextId++ }
    this.rows.push(row)
    return structuredClone(row)
  }

  async listByVehicle(vehicleId: string, limit = 100): Promise<VehicleEventRecord[]> {
    return this.rows
      .filter((r) => r.vehicleId === vehicleId)
      .sort((a, b) => b.occurredAtMs - a.occurredAtMs || b.id - a.id)
      .slice(0, limit)
      .map((r) => structuredClone(r))
  }
}

/** The manager's decision log on a shift (SRS C-7): append-only, read newest-first. */
export class MemoryShiftDecisionRepo implements ShiftDecisionRepo {
  readonly rows: ShiftDecisionRecord[] = []
  private nextId = 1

  async record(decision: Omit<ShiftDecisionRecord, 'id'>): Promise<ShiftDecisionRecord> {
    const row: ShiftDecisionRecord = { ...decision, id: this.nextId++ }
    this.rows.push(row)
    return structuredClone(row)
  }

  async listByShift(shiftId: string): Promise<ShiftDecisionRecord[]> {
    return this.rows
      .filter((r) => r.shiftId === shiftId)
      .sort((a, b) => b.decidedAtMs - a.decidedAtMs || b.id - a.id)
      .map((r) => structuredClone(r))
  }
}

/** Live GPS pings (SRS K): append-only telemetry; the live map reads the latest per driver. */
export class MemoryGpsPingRepo implements GpsPingRepo {
  readonly rows: GpsPingRecord[] = []
  private nextId = 1

  async append(ping: Omit<GpsPingRecord, 'id'>): Promise<void> {
    this.rows.push({ ...ping, id: this.nextId++ })
  }

  async latestPerDriverForBranch(branchId: string): Promise<GpsPingRecord[]> {
    const latest = new Map<string, GpsPingRecord>()
    for (const r of this.rows) {
      if (r.branchId !== branchId) continue
      const seen = latest.get(r.driverId)
      // Tie-break on id (insertion order) so a fixed clock still resolves the newest — the Pg repo
      // does the same with `ORDER BY received_at DESC, id DESC`.
      if (!seen || r.receivedAtMs > seen.receivedAtMs || (r.receivedAtMs === seen.receivedAtMs && r.id > seen.id)) {
        latest.set(r.driverId, r)
      }
    }
    return [...latest.values()].map((r) => structuredClone(r))
  }

  async listForShift(shiftId: string): Promise<GpsPingRecord[]> {
    return this.rows
      .filter((r) => r.shiftId === shiftId)
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.id - b.id)
      .map((r) => structuredClone(r))
  }
}

/** Admin-staff attendance (SRS B-4 / س41): one row per user per day, last-seen bumped on repeat. */
export class MemoryAttendanceRepo implements AttendanceRepo {
  readonly rows: AttendanceRecord[] = []

  async touch(userId: string, branchId: string, businessDate: CalendarDate, atMs: number): Promise<void> {
    const existing = this.rows.find((r) => r.userId === userId && r.businessDate === businessDate)
    if (existing) {
      existing.lastSeenAtMs = atMs
      return
    }
    this.rows.push({ userId, branchId, businessDate, firstSeenAtMs: atMs, lastSeenAtMs: atMs })
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<AttendanceRecord[]> {
    return this.rows
      .filter((r) => r.branchId === branchId && r.businessDate === businessDate)
      .sort((a, b) => a.firstSeenAtMs - b.firstSeenAtMs)
      .map((r) => ({ ...r }))
  }
}

export interface MemoryDeps extends Deps {
  clock: FixedClock
  media: MemoryMediaRepo
  blobs: MemoryBlobStore
  expenses: MemoryExpenseRepo
  cashCounts: MemoryCashCountRepo
  tiers: MemoryTierRepo
  notifications: MemoryNotificationRepo
  settings: MemorySettingsRepo
  users: MemoryUserRepo
  shifts: MemoryShiftRepo
  orders: MemoryOrderRepo
  ledger: MemoryLedgerRepo
  fx: MemoryFxRepo
  weekLocks: MemoryWeekLockRepo
  audit: MemoryAuditRepo
  directory: MemoryDirectoryRepo
  assignments: MemoryAssignmentRepo
  batteryReadings: MemoryBatteryReadingRepo
  batterySwaps: MemoryBatterySwapRepo
  vehicleEvents: MemoryVehicleEventRepo
  attendance: MemoryAttendanceRepo
  decisions: MemoryShiftDecisionRepo
  gps: MemoryGpsPingRepo
}

export function createMemoryDeps(nowMs: number): MemoryDeps {
  const ledger = new MemoryLedgerRepo()
  const media = new MemoryMediaRepo()
  return {
    clock: new FixedClock(nowMs),
    ids: new SeqIdGen(),
    hasher: new PlainHasher(),
    cipher: memoryCipher(),
    users: new MemoryUserRepo(),
    sessions: new MemorySessionRepo(),
    shifts: new MemoryShiftRepo(media),
    assignments: new MemoryAssignmentRepo(),
    batteryReadings: new MemoryBatteryReadingRepo(),
    batterySwaps: new MemoryBatterySwapRepo(),
    orders: new MemoryOrderRepo(),
    movements: new MemoryWalletMovementRepo(),
    ledger,
    expenses: new MemoryExpenseRepo(),
    cashCounts: new MemoryCashCountRepo(),
    tiers: new MemoryTierRepo(),
    notifications: new MemoryNotificationRepo(),
    settings: new MemorySettingsRepo(),
    media,
    blobs: new MemoryBlobStore(),
    fx: new MemoryFxRepo(),
    weekLocks: new MemoryWeekLockRepo(ledger),
    audit: new MemoryAuditRepo(),
    directory: new MemoryDirectoryRepo(),
    vehicleEvents: new MemoryVehicleEventRepo(),
    attendance: new MemoryAttendanceRepo(),
    decisions: new MemoryShiftDecisionRepo(),
    gps: new MemoryGpsPingRepo(),
  }
}
