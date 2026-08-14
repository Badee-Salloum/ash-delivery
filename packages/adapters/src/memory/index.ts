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
  CashDeductionRecord,
  CashDeductionRepo,
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
  ShiftCloseTransactionDeps,
  ShiftCloseUnitOfWork,
  ShiftCloseUnitOfWorkInput,
  GpsPingRecord,
  GpsPingRepo,
  OrderPointRecord,
  OperationBatch,
  OperationBatchRepo,
  OperationWindowRepo,
  ShiftOrderRecord,
  ShiftRecord,
  ShiftRepo,
  NewShiftSettlementRecord,
  ShiftSettlementRecord,
  ShiftSettlementRepo,
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
import {
  FIXED_CASH_SETTLEMENT_POLICY,
  FIXED_DRIVER_RATE_BPS,
  classifyOperationWindow,
  includedByOperationWindow,
  normalizeUsername,
} from '@ash/contracts'
import { type CalendarDate, type FxDay, type Minor, type Posting, isAwaitingDecision, isLive, minor } from '@ash/domain'
import { memoryCipher } from '../crypto.ts'
import { MemoryBlobStore, MemoryMediaRepo } from './media.ts'
import { MemoryOcrReadRepo, MemoryOcrReader } from '../ocr/memory.ts'
import { MemoryExpenseRepo, MemorySettingsRepo } from './expenses.ts'
import { MemoryCashCountRepo } from './cashcount.ts'
import { MemoryOfficeCapitalTargetRepo, MemoryRestorationRepo } from './restoration.ts'
import { MemoryNotificationRepo, MemoryTierRepo } from './tiers.ts'

export { MemoryBlobStore, MemoryMediaRepo } from './media.ts'
export { MemoryOcrReadRepo, MemoryOcrReader, ScriptedOcrReader } from '../ocr/memory.ts'
export { MemoryExpenseRepo, MemorySettingsRepo } from './expenses.ts'
export { MemoryCashCountRepo } from './cashcount.ts'
export { MemoryOfficeCapitalTargetRepo, MemoryRestorationRepo } from './restoration.ts'
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

  async create(shift: ShiftRecord, _actorId: string | null): Promise<void> {
    /*
     * Postgres has `shifts_no_uq` UNIQUE (driver_id, business_date, shift_no); without the same
     * rule here the fake would accept a shift the real database refuses, and the collision that
     * blocked a driver in production would still be untestable without Docker.
     */
    const taken = [...this.rows.values()].some(
      (s) => s.driverId === shift.driverId && s.businessDate === shift.businessDate && s.shiftNo === shift.shiftNo,
    )
    if (taken) throw Object.assign(new Error('shift number already taken'), { code: 'DUPLICATE_SHIFT_NO' })
    this.rows.set(shift.id, structuredClone(shift))
  }
  async findById(id: string): Promise<ShiftRecord | null> {
    const s = this.rows.get(id)
    return s ? this.withSlots(s) : null
  }
  async update(shift: ShiftRecord, _actorId: string | null): Promise<void> {
    this.rows.set(shift.id, structuredClone(shift))
  }
  async listLiveForDriver(driverId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.driverId === driverId && isLive(s.state))
  }
  async listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]> {
    return [...this.rows.values()].filter((s) => s.vehicleId === vehicleId && isLive(s.state))
  }
  async existsForVehicle(vehicleId: string): Promise<boolean> {
    return [...this.rows.values()].some((s) => s.vehicleId === vehicleId)
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
  /** Counts EVERY state, matching the Postgres unique index the number has to dodge. */
  async nextShiftNo(driverId: string, businessDate: CalendarDate): Promise<number> {
    const used = [...this.rows.values()]
      .filter((s) => s.driverId === driverId && s.businessDate === businessDate)
      .map((s) => s.shiftNo)
    return used.length === 0 ? 1 : Math.max(...used) + 1
  }
  async delete(id: string, _actorId: string | null): Promise<void> {
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
  async existsForBattery(batteryId: string): Promise<boolean> {
    return [...this.rows.values()].some((r) => r.batteryId === batteryId)
  }

  /** Capture only this shift's readings so a rollback cannot erase another shift's writes. */
  snapshotForShift(shiftId: string): BatteryReadingRecord[] {
    return [...this.rows.values()]
      .filter((reading) => reading.shiftId === shiftId)
      .map((reading) => structuredClone(reading))
  }

  /** Replace this shift's readings with a snapshot, leaving every other shift untouched. */
  restoreForShift(shiftId: string, snapshot: readonly BatteryReadingRecord[]): void {
    for (const [key, reading] of this.rows) {
      if (reading.shiftId === shiftId) this.rows.delete(key)
    }
    for (const reading of snapshot) {
      if (reading.shiftId !== shiftId) {
        throw new Error(`battery-reading snapshot belongs to shift ${reading.shiftId}, not ${shiftId}`)
      }
      this.rows.set(this.key(reading), structuredClone(reading))
    }
  }
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, ordered by seq_no per shift. */
export class MemoryBatterySwapRepo implements BatterySwapRepo {
  readonly rows: BatterySwapRecord[] = []
  async create(swap: BatterySwapRecord): Promise<void> {
    this.rows.push({ ...swap })
  }
  async existsForBattery(batteryId: string): Promise<boolean> {
    return this.rows.some((r) => r.outBatteryId === batteryId || r.inBatteryId === batteryId)
  }
  async listByShift(shiftId: string): Promise<BatterySwapRecord[]> {
    return this.rows
      .filter((r) => r.shiftId === shiftId)
      .sort((a, b) => a.seqNo - b.seqNo)
      .map((r) => ({ ...r }))
  }

  /** Capture only this shift's swap log so rollback preserves unrelated append-only events. */
  snapshotForShift(shiftId: string): BatterySwapRecord[] {
    return this.rows.filter((swap) => swap.shiftId === shiftId).map((swap) => structuredClone(swap))
  }

  /** Replace this shift's swap log with a snapshot, leaving every other shift untouched. */
  restoreForShift(shiftId: string, snapshot: readonly BatterySwapRecord[]): void {
    const retained = this.rows.filter((swap) => swap.shiftId !== shiftId)
    for (const swap of snapshot) {
      if (swap.shiftId !== shiftId) {
        throw new Error(`battery-swap snapshot belongs to shift ${swap.shiftId}, not ${shiftId}`)
      }
    }
    this.rows.splice(0, this.rows.length, ...retained, ...structuredClone(snapshot))
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

  /** Shift-scoped samples: the wallet, the payments log, the odometer. */
  readonly shiftOcrSamples: Array<{
    shiftId: string
    package: 'start' | 'end'
    kind: 'wallet' | 'odometer'
    source: 'ocr' | 'refused'
    bytes: number
  }> = []

  async recordShiftOcrSample(input: {
    shiftId: string
    package: 'start' | 'end'
    kind: 'wallet' | 'odometer'
    source: 'ocr' | 'refused'
    stripPng: Uint8Array
  }): Promise<void> {
    // Mirrors the partial unique index: one sample per (shift, package, reader).
    const already = this.shiftOcrSamples.some(
      (x) => x.shiftId === input.shiftId && x.package === input.package && x.kind === input.kind,
    )
    if (already) return
    this.shiftOcrSamples.push({ ...input, bytes: input.stripPng.length })
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
    if (kind === 'fee') {
      return this.ocrSamples.map((x, i) => ({
        id: String(i + 1),
        kind: 'fee',
        shiftOrderId: x.shiftOrderId,
        shiftId: null,
        package: null,
        source: x.source,
        stripPng: new Uint8Array(x.bytes),
      }))
    }
    return this.shiftOcrSamples
      .filter((x) => x.kind === kind)
      .map((x, i) => ({
        id: String(i + 1),
        kind: x.kind,
        shiftOrderId: null,
        shiftId: x.shiftId,
        package: x.package,
        source: x.source,
        stripPng: new Uint8Array(x.bytes),
      }))
  }

  async create(order: ShiftOrderRecord, _actorId: string | null): Promise<void> {
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
  async update(order: ShiftOrderRecord, _actorId: string | null): Promise<void> {
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
      windowStatus: order.windowStatus,
      decisionReason: order.decisionReason,
      decidedBy: order.decidedBy,
      decidedAt: order.decidedAt,
    })
  }
  async replacePoints(orderId: string, points: readonly OrderPointRecord[], _actorId: string | null): Promise<void> {
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
  async delete(id: string, _actorId: string | null): Promise<void> {
    this.rows.delete(id)
  }
}

export class MemoryCashDeductionRepo implements CashDeductionRepo {
  readonly rows = new Map<string, CashDeductionRecord>()

  async create(deduction: CashDeductionRecord, _actorId: string | null): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.shiftId === deduction.shiftId && row.operationKey === deduction.operationKey) {
        throw Object.assign(new Error(`duplicate cash deduction ${deduction.operationKey}`), {
          code: 'DUPLICATE_CASH_DEDUCTION',
        })
      }
    }
    this.rows.set(deduction.id, { ...deduction })
  }

  async update(deduction: CashDeductionRecord, _actorId: string | null): Promise<void> {
    const existing = this.rows.get(deduction.id)
    if (!existing) return
    this.rows.set(deduction.id, {
      ...deduction,
      id: existing.id,
      shiftId: existing.shiftId,
      operationKey: existing.operationKey,
      createdBy: existing.createdBy,
    })
  }

  async listByShift(shiftId: string): Promise<CashDeductionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.shiftId === shiftId)
      .sort((a, b) => a.operationKey.localeCompare(b.operationKey))
      .map((row) => ({ ...row }))
  }

  async findByOperationKey(shiftId: string, operationKey: string): Promise<CashDeductionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.shiftId === shiftId && row.operationKey === operationKey) return { ...row }
    }
    return null
  }

  async delete(id: string, _actorId: string | null): Promise<void> {
    this.rows.delete(id)
  }
}

/** In-memory parity for PostgreSQL's deterministic SECURITY DEFINER classifier. */
export class MemoryOperationWindowRepo implements OperationWindowRepo {
  private readonly shifts: MemoryShiftRepo
  private readonly orders: MemoryOrderRepo
  private readonly deductions: MemoryCashDeductionRepo
  private readonly directory: MemoryDirectoryRepo
  private readonly clock: Clock

  constructor(
    shifts: MemoryShiftRepo,
    orders: MemoryOrderRepo,
    deductions: MemoryCashDeductionRepo,
    directory: MemoryDirectoryRepo,
    clock: Clock,
  ) {
    this.shifts = shifts
    this.orders = orders
    this.deductions = deductions
    this.directory = directory
    this.clock = clock
  }

  async reclassify(
    shiftId: string,
    actorId: string | null,
  ): Promise<{ orders: number; cashDeductions: number }> {
    const shift = await this.shifts.findById(shiftId)
    if (!shift) {
      throw Object.assign(new Error(`shift ${shiftId} not found`), { code: 'OPERATION_WINDOW_SHIFT_NOT_FOUND' })
    }
    const branch = await this.directory.branch(shift.branchId)
    const classify = (occurredDate: string | null, occurredMinute: string | null) =>
      classifyOperationWindow({
        occurredDate,
        occurredMinute,
        openApprovedAt: shift.openApprovedAt,
        submittedAt: shift.submittedAt,
        ...(branch?.timezone ? { timeZone: branch.timezone } : {}),
        offsetMinutes: this.clock.offsetMinutes(),
      })

    let orderUpdates = 0
    for (const order of await this.orders.listByShift(shiftId)) {
      if (order.kind === 'manual') continue
      const windowStatus = classify(order.occurredDate, order.occurredMinute)
      const included = order.decidedBy === null ? includedByOperationWindow(windowStatus) : order.included
      if (windowStatus === order.windowStatus && included === order.included) continue
      await this.orders.update({ ...order, windowStatus, included }, actorId)
      orderUpdates++
    }

    let deductionUpdates = 0
    for (const deduction of await this.deductions.listByShift(shiftId)) {
      const windowStatus = classify(deduction.occurredDate, deduction.occurredMinute)
      const included = deduction.decidedBy === null ? includedByOperationWindow(windowStatus) : deduction.included
      if (windowStatus === deduction.windowStatus && included === deduction.included) continue
      await this.deductions.update({ ...deduction, windowStatus, included }, actorId)
      deductionUpdates++
    }

    return { orders: orderUpdates, cashDeductions: deductionUpdates }
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
  async merge(
    shiftId: string,
    movements: readonly WalletMovementInput[],
    _actorId: string | null,
  ): Promise<WalletMovementRecord[]> {
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
    _actorId: string | null,
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

  async deleteByShift(shiftId: string, _actorId: string | null): Promise<void> {
    for (const [id, m] of this.rows) if (m.shiftId === shiftId) this.rows.delete(id)
  }

  /** Transaction emulation needs to restore generated IDs as well as rows after a failed batch. */
  snapshotNextId(): number {
    return this.nextId
  }

  restoreNextId(nextId: number): void {
    this.nextId = nextId
  }
}

/** A tiny FIFO mutex shared by driver operation batches and close/approval units of work. */
export class MemoryTransactionGate {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = previous.then(() => turn, () => turn)
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
}

/** One all-or-nothing write for a complete OCR operations submission. */
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
  left.createdBy === right.createdBy

export class MemoryOperationBatchRepo implements OperationBatchRepo {
  private readonly shifts: MemoryShiftRepo
  private readonly orders: MemoryOrderRepo
  private readonly deductions: MemoryCashDeductionRepo
  private readonly movements: MemoryWalletMovementRepo
  private readonly gate: MemoryTransactionGate

  constructor(
    shifts: MemoryShiftRepo,
    orders: MemoryOrderRepo,
    deductions: MemoryCashDeductionRepo,
    movements: MemoryWalletMovementRepo,
    gate = new MemoryTransactionGate(),
  ) {
    this.shifts = shifts
    this.orders = orders
    this.deductions = deductions
    this.movements = movements
    this.gate = gate
  }

  async apply(
    shiftId: string,
    batch: OperationBatch,
    actorId: string | null,
  ): Promise<{ insertedMovements: WalletMovementRecord[] }> {
    return this.gate.run(() => this.applyLocked(shiftId, batch, actorId))
  }

  private async applyLocked(
    shiftId: string,
    batch: OperationBatch,
    actorId: string | null,
  ): Promise<{ insertedMovements: WalletMovementRecord[] }> {
    const belongs = [
      ...batch.orderCreates.map((record) => record.shiftId),
      ...batch.orderUpdates.map(({ record }) => record.shiftId),
      ...batch.cashDeductionCreates.map((record) => record.shiftId),
      ...batch.cashDeductionUpdates.map(({ record }) => record.shiftId),
      ...(batch.cashDeductionDeletes ?? []).map(({ expected }) => expected.shiftId),
    ].every((owner) => owner === shiftId)
    if (!belongs) {
      throw Object.assign(new Error('operation batch contains a row from another shift'), {
        code: 'OPERATION_BATCH_SHIFT_MISMATCH',
      })
    }
    const shift = await this.shifts.findById(shiftId)
    if (!shift) {
      throw Object.assign(new Error(`shift ${shiftId} not found`), { code: 'OPERATION_BATCH_SHIFT_NOT_FOUND' })
    }
    if ((shift.state !== 'open' && shift.state !== 'suspended') || shift.submittedAt !== null) {
      throw Object.assign(new Error(`shift ${shiftId} no longer accepts operations`), {
        code: 'OPERATION_BATCH_SHIFT_CLOSED',
      })
    }

    const legacyKindTransitions = normalizeLegacyKindTransitions(batch.legacyKindTransitions ?? [])

    const orderSnapshot = new Map([...this.orders.rows].map(([id, row]) => [id, structuredClone(row)]))
    const deductionSnapshot = new Map([...this.deductions.rows].map(([id, row]) => [id, structuredClone(row)]))
    const movementSnapshot = new Map([...this.movements.rows].map(([id, row]) => [id, structuredClone(row)]))
    const movementNextId = this.movements.snapshotNextId()
    const restore = <T>(target: Map<string, T>, snapshot: Map<string, T>): void => {
      target.clear()
      for (const [id, row] of snapshot) target.set(id, row)
    }

    try {
      for (const transition of legacyKindTransitions) {
        const order = [...this.orders.rows.values()].find(
          (row) => row.shiftId === shiftId && row.providerOrderNo === transition.providerOrderNo,
        )
        const deduction = [...this.deductions.rows.values()].find(
          (row) => row.shiftId === shiftId && row.operationKey === `legacy:${transition.providerOrderNo}`,
        )
        if (transition.targetKind === 'order') {
          const matchesExpected = transition.expectedOppositeId === null
            ? deduction === undefined
            : deduction?.id === transition.expectedOppositeId &&
              deduction.decidedAt === transition.expectedOppositeDecidedAt &&
              transition.expectedOppositeDecidedAt === null &&
              deduction.decidedBy === null
          if (!matchesExpected) {
            throw staleMemoryOperation(
              'cash_deduction',
              deduction?.id ?? transition.expectedOppositeId ?? transition.providerOrderNo,
            )
          }
          if (deduction) await this.deductions.delete(deduction.id, actorId)
        }
        if (transition.targetKind === 'cash_deduction') {
          const matchesExpected = transition.expectedOppositeId === null
            ? order === undefined
            : order?.id === transition.expectedOppositeId &&
              order.decidedAt === transition.expectedOppositeDecidedAt &&
              transition.expectedOppositeDecidedAt === null &&
              order.decidedBy === null &&
              order.kind !== 'manual'
          if (!matchesExpected) {
            throw staleMemoryOperation('order', order?.id ?? transition.expectedOppositeId ?? transition.providerOrderNo)
          }
          if (!order) continue
          // Keep wallet-log evidence, but it no longer has an order whose financial role could
          // explain it. Excluding it avoids turning a detached matched row into BR1 money.
          for (const movement of this.movements.rows.values()) {
            if (movement.shiftId !== shiftId || movement.orderId !== order.id) continue
            await this.movements.update(
              movement.id,
              { role: 'unmatched', orderId: null, included: false, ambiguous: true },
              actorId,
            )
          }
          await this.orders.delete(order.id, actorId)
        }
      }

      for (const deletion of batch.cashDeductionDeletes ?? []) {
        const current = this.deductions.rows.get(deletion.expected.id)
        if (!current || current.shiftId !== shiftId || !sameCashDeductionRecord(current, deletion.expected)) {
          throw staleMemoryOperation('cash_deduction', deletion.expected.id)
        }
        await this.deductions.delete(current.id, actorId)
      }

      for (const order of batch.orderCreates) await this.orders.create(order, actorId)
      for (const movement of batch.movements) {
        if (movement.orderId == null) continue
        const linkedOrder = this.orders.rows.get(movement.orderId)
        if (!linkedOrder || linkedOrder.shiftId !== shiftId) {
          throw Object.assign(new Error('wallet movement links an order from another shift'), {
            code: 'OPERATION_BATCH_SHIFT_MISMATCH',
          })
        }
      }
      for (const update of batch.orderUpdates) {
        const current = this.orders.rows.get(update.record.id)
        if (!current || current.shiftId !== shiftId || current.decidedAt !== update.expectedDecidedAt) {
          throw staleMemoryOperation('order', update.record.id)
        }
        await this.orders.update(update.record, actorId)
      }
      for (const replacement of batch.orderPointReplacements) {
        const current = this.orders.rows.get(replacement.orderId)
        if (!current || current.shiftId !== shiftId || current.points.length !== 0) {
          throw staleMemoryOperation('order', replacement.orderId)
        }
        await this.orders.replacePoints(replacement.orderId, replacement.points, actorId)
      }
      for (const deduction of batch.cashDeductionCreates) await this.deductions.create(deduction, actorId)
      for (const update of batch.cashDeductionUpdates) {
        const current = this.deductions.rows.get(update.record.id)
        if (!current || current.shiftId !== shiftId || current.decidedAt !== update.expectedDecidedAt) {
          throw staleMemoryOperation('cash_deduction', update.record.id)
        }
        await this.deductions.update(update.record, actorId)
      }
      return { insertedMovements: await this.movements.merge(shiftId, batch.movements, actorId) }
    } catch (error) {
      restore(this.orders.rows, orderSnapshot)
      restore(this.deductions.rows, deductionSnapshot)
      restore(this.movements.rows, movementSnapshot)
      this.movements.restoreNextId(movementNextId)
      throw error
    }
  }
}

const normalizeLegacyKindTransitions = (
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

const staleMemoryOperation = (kind: 'order' | 'cash_deduction', id: string): Error & { code: string } =>
  Object.assign(new Error(`${kind} ${id} changed while the operations batch was being prepared`), {
    code: 'STALE_OPERATION_BATCH',
  })

export class MemoryLedgerRepo implements LedgerRepo {
  readonly entries: JournalEntryRecord[] = []
  private nextId = 1
  /**
   * Mirrors `journal_entries_idem_uq` as migration 0017 REDEFINED it:
   * `UNIQUE (branch_id, event_type, COALESCE(shift_id::text, ''), occurrence_key)`.
   *
   * The original 0004 index carried `WHERE shift_id IS NOT NULL`, and this fake was written against
   * it. 0017 dropped that predicate precisely because a shift-less posting — الترميم, a treasury
   * move — had no replay protection at all; leaving the predicate here made the fake ACCEPT a
   * second sweep that the real database refuses, which is the one direction a test double must
   * never be wrong in.
   */
  private readonly seen = new Set<string>()

  snapshotState(): { entries: JournalEntryRecord[]; seen: Set<string>; nextId: number } {
    return {
      entries: structuredClone(this.entries),
      seen: new Set(this.seen),
      nextId: this.nextId,
    }
  }

  restoreState(state: { entries: JournalEntryRecord[]; seen: Set<string>; nextId: number }): void {
    this.entries.splice(0, this.entries.length, ...structuredClone(state.entries))
    this.seen.clear()
    for (const key of state.seen) this.seen.add(key)
    this.nextId = state.nextId
  }

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

      const key = `${branchId}|${posting.eventType}|${meta.shiftId ?? ''}|${posting.occurrenceKey}`
      if (this.seen.has(key)) continue // idempotent replay: write nothing
      this.seen.add(key)

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

  /** Same shape as the Pg repo: every fund under a prefix, with its balance. */
  async balancesByPrefix(branchId: string, prefix: string): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    for (const e of this.entries) {
      if (e.branchId !== branchId) continue
      for (const l of e.lines) {
        if (!l.fundCode.startsWith(prefix)) continue
        out[l.fundCode] = (out[l.fundCode] ?? 0n) + (l.side === 'D' ? l.amount : -l.amount)
      }
    }
    return out
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
    // Same rule as the Pg repo and the domain: a ذمة is per driver, so it carries his id.
    case 'driver_receivable_cash':
    case 'driver_receivable_wallet':
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
  snapshotState(): { rows: Map<CalendarDate, { id: number; day: FxDay }>; nextId: number } {
    return { rows: structuredClone(this.rows), nextId: this.nextId }
  }
  restoreState(state: { rows: Map<CalendarDate, { id: number; day: FxDay }>; nextId: number }): void {
    this.rows.clear()
    for (const [date, row] of state.rows) this.rows.set(date, structuredClone(row))
    this.nextId = state.nextId
  }
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
  async deleteVehicle(id: string): Promise<void> {
    this.vehicles.delete(id)
  }
  async deleteBattery(id: string): Promise<void> {
    this.batteries.delete(id)
  }
  async createBattery(battery: BatteryRecord): Promise<void> {
    this.assertBatteryPlacement(battery)
    this.batteries.set(battery.id, { ...battery })
  }
  async updateBattery(battery: BatteryRecord): Promise<void> {
    this.assertBatteryPlacement(battery)
    this.batteries.set(battery.id, { ...battery })
  }

  /**
   * Capture exact battery rows, including absence, for a targeted multi-record rollback.
   * Every requested id is present in the returned map; `null` means it did not exist.
   */
  snapshotBatteries(batteryIds: Iterable<string>): Map<string, BatteryRecord | null> {
    const snapshot = new Map<string, BatteryRecord | null>()
    for (const id of batteryIds) {
      const battery = this.batteries.get(id)
      snapshot.set(id, battery === undefined ? null : structuredClone(battery))
    }
    return snapshot
  }

  /** Restore only the exact battery ids captured by `snapshotBatteries`. */
  restoreBatteries(snapshot: ReadonlyMap<string, BatteryRecord | null>): void {
    for (const [id, battery] of snapshot) {
      if (battery === null) this.batteries.delete(id)
      else this.batteries.set(id, structuredClone(battery))
    }
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

  snapshotState(): { rows: ShiftDecisionRecord[]; nextId: number } {
    return { rows: structuredClone(this.rows), nextId: this.nextId }
  }

  restoreState(state: { rows: ShiftDecisionRecord[]; nextId: number }): void {
    this.rows.splice(0, this.rows.length, ...structuredClone(state.rows))
    this.nextId = state.nextId
  }

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

const invalidSettlement = (message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code: 'INVALID_SHIFT_SETTLEMENT' })

const immutableSettlement = (shiftId: string): Error & { code: string } =>
  Object.assign(new Error(`shift ${shiftId} already has a different immutable settlement`), {
    code: 'SHIFT_SETTLEMENT_IMMUTABLE',
  })

function assertSettlement(record: NewShiftSettlementRecord): void {
  if (record.policyCode !== FIXED_CASH_SETTLEMENT_POLICY || record.driverRateBps !== FIXED_DRIVER_RATE_BPS) {
    throw invalidSettlement('the fixed 40% settlement policy is required')
  }
  const nonnegative = [
    record.deliveryFeeTotal,
    record.fixedDriverShare,
    record.manualDriverShare,
    record.grossDriverShare,
    record.cashDeductionTotal,
    record.actualCash,
    record.walletAmount,
    record.cashAmount,
  ]
  if (nonnegative.some((amount) => amount < 0n)) throw invalidSettlement('settlement magnitudes must be non-negative')
  if (record.fixedDriverShare !== (record.deliveryFeeTotal * 4_000n) / 10_000n) {
    throw invalidSettlement('fixed driver share is not 40% of delivery fees')
  }
  if (record.grossDriverShare !== record.fixedDriverShare + record.manualDriverShare) {
    throw invalidSettlement('gross driver share does not include the fixed and manual shares')
  }
  if (record.baseDriverShare !== record.grossDriverShare - record.cashDeductionTotal) {
    throw invalidSettlement('base driver share does not apply the cash deductions')
  }
  if (record.actualTotal !== record.actualCash + record.actualWallet) {
    throw invalidSettlement('actual total does not equal cash plus wallet')
  }
  if (record.variance !== record.actualTotal - record.expectedTotal) {
    throw invalidSettlement('variance does not equal actual minus expected')
  }
  const direction = record.variance > 0n ? 'surplus' : record.variance < 0n ? 'shortage' : 'balanced'
  if (record.varianceDirection !== direction) throw invalidSettlement('variance direction disagrees with its sign')
  if (record.finalEmployeeCash !== record.baseDriverShare + record.variance) {
    throw invalidSettlement('final employee cash does not include the closing variance')
  }
  if (record.walletToOffice !== record.actualWallet) {
    throw invalidSettlement('the settlement does not empty the complete actual wallet')
  }
  const walletAction = record.walletToOffice > 0n ? 'collect' : record.walletToOffice < 0n ? 'fund' : 'none'
  const walletAmount = record.walletToOffice < 0n ? -record.walletToOffice : record.walletToOffice
  if (record.walletAction !== walletAction || record.walletAmount !== walletAmount) {
    throw invalidSettlement('wallet action does not match the signed wallet transfer')
  }
  if (record.cashToOffice !== record.actualCash - record.finalEmployeeCash) {
    throw invalidSettlement('cash action does not close the final employee cash')
  }
  const cashAction = record.cashToOffice > 0n ? 'collect' : record.cashToOffice < 0n ? 'pay' : 'none'
  const cashAmount = record.cashToOffice < 0n ? -record.cashToOffice : record.cashToOffice
  if (record.cashAction !== cashAction || record.cashAmount !== cashAmount) {
    throw invalidSettlement('cash action does not match the signed cash transfer')
  }
  if (
    !record.reviewedOrdersHash.trim() ||
    record.reviewedOrdersHash.length > 128 ||
    !/^[0-9a-f]{64}$/.test(record.settlementHash)
  ) {
    throw invalidSettlement('settlement hashes are missing or malformed')
  }
  if (!record.walletTransferConfirmed || !record.cashSettlementConfirmed) {
    throw invalidSettlement('both physical settlement actions must be confirmed')
  }
  if (record.variance !== 0n && !record.varianceReason?.trim()) {
    throw invalidSettlement('a non-zero variance requires a manager reason')
  }
  if (record.varianceReason !== null && record.varianceReason.length > 500) {
    throw invalidSettlement('variance reason is longer than 500 characters')
  }
  if (!Number.isFinite(record.confirmedAtMs)) throw invalidSettlement('confirmation time is invalid')
}

/** Append-only in-memory counterpart to `shift_settlements`. */
export class MemoryShiftSettlementRepo implements ShiftSettlementRepo {
  readonly rows = new Map<string, ShiftSettlementRecord>()
  private nextId = 1

  snapshotState(): { rows: Map<string, ShiftSettlementRecord>; nextId: number } {
    return { rows: structuredClone(this.rows), nextId: this.nextId }
  }

  restoreState(state: { rows: Map<string, ShiftSettlementRecord>; nextId: number }): void {
    this.rows.clear()
    for (const [shiftId, row] of state.rows) this.rows.set(shiftId, structuredClone(row))
    this.nextId = state.nextId
  }

  async create(record: NewShiftSettlementRecord): Promise<ShiftSettlementRecord> {
    assertSettlement(record)
    const existing = this.rows.get(record.shiftId)
    if (existing) {
      if (existing.settlementHash !== record.settlementHash) throw immutableSettlement(record.shiftId)
      return structuredClone(existing)
    }
    for (const row of this.rows.values()) {
      if (row.settlementHash === record.settlementHash) {
        throw Object.assign(new Error(`settlement hash ${record.settlementHash} already exists`), {
          code: 'SHIFT_SETTLEMENT_HASH_CONFLICT',
        })
      }
    }
    const created: ShiftSettlementRecord = { ...structuredClone(record), id: this.nextId++ }
    this.rows.set(record.shiftId, created)
    return structuredClone(created)
  }

  async findByShift(shiftId: string): Promise<ShiftSettlementRecord | null> {
    const row = this.rows.get(shiftId)
    return row ? structuredClone(row) : null
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
  ocrReads: MemoryOcrReadRepo
  expenses: MemoryExpenseRepo
  cashCounts: MemoryCashCountRepo
  capitalTargets: MemoryOfficeCapitalTargetRepo
  restorations: MemoryRestorationRepo
  tiers: MemoryTierRepo
  notifications: MemoryNotificationRepo
  settings: MemorySettingsRepo
  users: MemoryUserRepo
  shifts: MemoryShiftRepo
  orders: MemoryOrderRepo
  cashDeductions: MemoryCashDeductionRepo
  operationWindows: MemoryOperationWindowRepo
  operationBatches: MemoryOperationBatchRepo
  closeUnitOfWork: MemoryShiftCloseUnitOfWork
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
  settlements: MemoryShiftSettlementRepo
  gps: MemoryGpsPingRepo
}

/**
 * In-memory parity for the PostgreSQL close unit of work.
 *
 * The shared gate makes an operation upload either land before this snapshot or wait until after
 * it, mirroring the shift-row lock in PostgreSQL. On failure every repository that a close/review
 * callback may mutate is restored, including generated ledger/decision/movement ids.
 */
export class MemoryShiftCloseUnitOfWork implements ShiftCloseUnitOfWork {
  private readonly deps: ShiftCloseTransactionDeps
  private readonly shifts: MemoryShiftRepo
  private readonly orders: MemoryOrderRepo
  private readonly deductions: MemoryCashDeductionRepo
  private readonly movements: MemoryWalletMovementRepo
  private readonly ledger: MemoryLedgerRepo
  private readonly decisions: MemoryShiftDecisionRepo
  private readonly settlements: MemoryShiftSettlementRepo
  private readonly fx: MemoryFxRepo
  private readonly batteryReadings: MemoryBatteryReadingRepo
  private readonly batterySwaps: MemoryBatterySwapRepo
  private readonly directory: MemoryDirectoryRepo
  private readonly gate: MemoryTransactionGate

  constructor(
    deps: ShiftCloseTransactionDeps,
    shifts: MemoryShiftRepo,
    orders: MemoryOrderRepo,
    deductions: MemoryCashDeductionRepo,
    movements: MemoryWalletMovementRepo,
    ledger: MemoryLedgerRepo,
    decisions: MemoryShiftDecisionRepo,
    settlements: MemoryShiftSettlementRepo,
    fx: MemoryFxRepo,
    batteryReadings: MemoryBatteryReadingRepo,
    batterySwaps: MemoryBatterySwapRepo,
    directory: MemoryDirectoryRepo,
    gate: MemoryTransactionGate,
  ) {
    this.deps = deps
    this.shifts = shifts
    this.orders = orders
    this.deductions = deductions
    this.movements = movements
    this.ledger = ledger
    this.decisions = decisions
    this.settlements = settlements
    this.fx = fx
    this.batteryReadings = batteryReadings
    this.batterySwaps = batterySwaps
    this.directory = directory
    this.gate = gate
  }

  async run<T>(
    input: ShiftCloseUnitOfWorkInput,
    work: (deps: ShiftCloseTransactionDeps) => Promise<T>,
  ): Promise<T> {
    return this.gate.run(async () => {
      const shiftSnapshot = new Map([...this.shifts.rows].map(([id, row]) => [id, structuredClone(row)]))
      const orderSnapshot = new Map([...this.orders.rows].map(([id, row]) => [id, structuredClone(row)]))
      const deductionSnapshot = new Map([...this.deductions.rows].map(([id, row]) => [id, structuredClone(row)]))
      const movementSnapshot = new Map([...this.movements.rows].map(([id, row]) => [id, structuredClone(row)]))
      const movementNextId = this.movements.snapshotNextId()
      const ledgerSnapshot = this.ledger.snapshotState()
      const decisionSnapshot = this.decisions.snapshotState()
      const settlementSnapshot = this.settlements.snapshotState()
      const fxSnapshot = this.fx.snapshotState()
      const batteryReadingSnapshot = this.batteryReadings.snapshotForShift(input.shiftId)
      const batterySwapSnapshot = this.batterySwaps.snapshotForShift(input.shiftId)
      const batterySnapshot = this.directory.snapshotBatteries(this.directory.batteries.keys())

      const restoreMap = <V>(target: Map<string, V>, snapshot: Map<string, V>): void => {
        target.clear()
        for (const [id, row] of snapshot) target.set(id, structuredClone(row))
      }

      try {
        return await work(this.deps)
      } catch (error) {
        restoreMap(this.shifts.rows, shiftSnapshot)
        restoreMap(this.orders.rows, orderSnapshot)
        restoreMap(this.deductions.rows, deductionSnapshot)
        restoreMap(this.movements.rows, movementSnapshot)
        this.movements.restoreNextId(movementNextId)
        this.ledger.restoreState(ledgerSnapshot)
        this.decisions.restoreState(decisionSnapshot)
        this.settlements.restoreState(settlementSnapshot)
        this.fx.restoreState(fxSnapshot)
        this.batteryReadings.restoreForShift(input.shiftId, batteryReadingSnapshot)
        this.batterySwaps.restoreForShift(input.shiftId, batterySwapSnapshot)
        this.directory.restoreBatteries(batterySnapshot)
        throw error
      }
    })
  }
}

export function createMemoryDeps(nowMs: number): MemoryDeps {
  const clock = new FixedClock(nowMs)
  const ledger = new MemoryLedgerRepo()
  const media = new MemoryMediaRepo()
  const shifts = new MemoryShiftRepo(media)
  const orders = new MemoryOrderRepo()
  const cashDeductions = new MemoryCashDeductionRepo()
  const movements = new MemoryWalletMovementRepo()
  const batteryReadings = new MemoryBatteryReadingRepo()
  const batterySwaps = new MemoryBatterySwapRepo()
  const tiers = new MemoryTierRepo()
  const fx = new MemoryFxRepo()
  const weekLocks = new MemoryWeekLockRepo(ledger)
  const directory = new MemoryDirectoryRepo()
  const operationWindows = new MemoryOperationWindowRepo(
    shifts,
    orders,
    cashDeductions,
    directory,
    clock,
  )
  const decisions = new MemoryShiftDecisionRepo()
  const settlements = new MemoryShiftSettlementRepo()
  const gate = new MemoryTransactionGate()
  const transactionDeps: ShiftCloseTransactionDeps = {
    shifts,
    orders,
    cashDeductions,
    operationWindows,
    movements,
    ledger,
    decisions,
    fx,
    tiers,
    directory,
    media,
    batteryReadings,
    batterySwaps,
    weekLocks,
    settlements,
  }
  const closeUnitOfWork = new MemoryShiftCloseUnitOfWork(
    transactionDeps,
    shifts,
    orders,
    cashDeductions,
    movements,
    ledger,
    decisions,
    settlements,
    fx,
    batteryReadings,
    batterySwaps,
    directory,
    gate,
  )
  return {
    clock,
    ids: new SeqIdGen(),
    hasher: new PlainHasher(),
    cipher: memoryCipher(),
    users: new MemoryUserRepo(),
    sessions: new MemorySessionRepo(),
    shifts,
    assignments: new MemoryAssignmentRepo(),
    batteryReadings,
    batterySwaps,
    orders,
    cashDeductions,
    operationWindows,
    operationBatches: new MemoryOperationBatchRepo(shifts, orders, cashDeductions, movements, gate),
    closeUnitOfWork,
    movements,
    ledger,
    expenses: new MemoryExpenseRepo(),
    cashCounts: new MemoryCashCountRepo(),
    capitalTargets: new MemoryOfficeCapitalTargetRepo(),
    restorations: new MemoryRestorationRepo(),
    tiers,
    notifications: new MemoryNotificationRepo(),
    settings: new MemorySettingsRepo(),
    media,
    blobs: new MemoryBlobStore(),
    // `available: false`. Every test that exists today inherits a reader that never calls out, so
    // adding this port cannot make anything start hitting the network by accident.
    ocr: new MemoryOcrReader(),
    ocrReads: new MemoryOcrReadRepo(),
    fx,
    weekLocks,
    audit: new MemoryAuditRepo(),
    directory,
    vehicleEvents: new MemoryVehicleEventRepo(),
    attendance: new MemoryAttendanceRepo(),
    decisions,
    settlements,
    gps: new MemoryGpsPingRepo(),
  }
}
