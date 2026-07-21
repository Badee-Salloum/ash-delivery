import type {
  CalendarDate,
  FxDay,
  Minor,
  PayMode,
  Posting,
  RoleKey,
  ShiftState,
  Scope,
  PermissionKey,
} from '@ash/domain'

/**
 * The ports. Everything the application needs from the outside world, expressed as interfaces
 * the domain never sees.
 *
 * There are two implementations of each: an in-memory one in `@ash/adapters/memory`, and (from
 * M2) a PostgreSQL one. The API cannot tell them apart, which is what lets the whole HTTP layer
 * be tested without Docker — and what will let the Bundle-2 OCR and PDF sources drop in behind
 * `DashboardSource` without touching a line of domain code.
 */

// ── Infrastructure ────────────────────────────────────────────────────────────────────────

/** Time is injected. Nothing in this system reads the wall clock directly. */
export interface Clock {
  nowMs(): number
  /** Asia/Damascus offset for `businessDateFor`. A value, so history stays reproducible. */
  offsetMinutes(): number
}

export interface IdGen {
  uuid(): string
  /** Opaque, high-entropy session token. Only its sha256 is ever stored. */
  token(): string
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>
  verify(plain: string, hash: string): Promise<boolean>
}

/** Content-addressed blob storage. Local disk now, S3-compatible later — same interface. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  exists(key: string): Promise<boolean>
}

// ── Records ───────────────────────────────────────────────────────────────────────────────

export interface BranchRecord {
  id: string
  code: string
  nameAr: string
  nameEn: string
}

export interface UserRecord {
  id: string
  branchId: string | null
  roleKey: RoleKey
  username: string
  fullNameAr: string
  passwordHash: string
  driverId: string | null
  failedAttempts: number
  lockedUntilMs: number | null
  active: boolean
}

export interface SessionRecord {
  id: string
  userId: string
  tokenHash: string
  createdAtMs: number
  lastSeenAtMs: number
  expiresAtMs: number
  revokedAtMs: number | null
}

export interface DriverRecord {
  id: string
  branchId: string
  code: string
  fullNameAr: string
  active: boolean
}

export interface VehicleRecord {
  id: string
  branchId: string
  vehicleTypeId: string
  code: string
  state: 'ready' | 'charging' | 'maintenance' | 'stopped'
  active: boolean
}

export interface ShiftRecord {
  id: string
  branchId: string
  driverId: string
  vehicleId: string
  shiftNo: number
  businessDate: CalendarDate
  weekStartDate: CalendarDate
  state: ShiftState
  floatTranches: Minor[]
  topupTranches: Minor[]
  mediaSlotsStart: string[]
  mediaSlotsEnd: string[]
  odoStart: number | null
  odoEnd: number | null
  batteryStart: number | null
  batteryEnd: number | null
  endCashDeclared: Minor | null
  endWalletDeclared: Minor | null
  driverConfirmedAt: string | null
  equationDiff: Minor | null
  cashDiff: Minor | null
  walletDiff: Minor | null
  ordersHash: string | null
  approvedBy: string | null
}

export interface ShiftOrderRecord {
  id: string
  shiftId: string
  providerOrderNo: string
  payMode: PayMode
  fee: Minor
  zone: string | null
  driverConfirmed: boolean
}

export interface JournalEntryRecord {
  id: number
  branchId: string
  eventType: Posting['eventType']
  shiftId: string | null
  occurrenceKey: string
  businessDate: CalendarDate
  postingDate: CalendarDate
  weekStartDate: CalendarDate
  fxDayId: number
  weekLockId: number | null
  reason: string | null
  createdBy: string
  lines: Array<{ fundCode: string; side: 'D' | 'C'; amount: Minor; role?: string }>
}

export interface WeekLockRecord {
  id: number
  branchId: string
  weekStartDate: CalendarDate
  weekEndDate: CalendarDate
  closedAtMs: number | null
  closedBy: string | null
}

export interface AuditRecord {
  id: number
  tableName: string
  recordId: string
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  actorId: string | null
  actorKind: 'user' | 'system' | 'anonymous'
  branchId: string | null
  requestId: string | null
  before: unknown
  after: unknown
  occurredAtMs: number
}

export interface RoleGrantRecord {
  roleKey: RoleKey
  permissionKey: PermissionKey
  scope: Scope
}

// ── Repositories ──────────────────────────────────────────────────────────────────────────

export interface UserRepo {
  findByUsername(username: string): Promise<UserRecord | null>
  findById(id: string): Promise<UserRecord | null>
  update(user: UserRecord): Promise<void>
}

export interface SessionRepo {
  create(session: SessionRecord): Promise<void>
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>
  update(session: SessionRecord): Promise<void>
  revokeAllForUser(userId: string): Promise<void>
}

export interface ShiftRepo {
  create(shift: ShiftRecord): Promise<void>
  findById(id: string): Promise<ShiftRecord | null>
  update(shift: ShiftRecord): Promise<void>
  listLiveForDriver(driverId: string): Promise<ShiftRecord[]>
  listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]>
  listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
  listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
}

export interface OrderRepo {
  create(order: ShiftOrderRecord): Promise<void>
  listByShift(shiftId: string): Promise<ShiftOrderRecord[]>
  findByProviderNo(providerOrderNo: string): Promise<ShiftOrderRecord | null>
  delete(id: string): Promise<void>
}

export interface LedgerRepo {
  /**
   * Persist a set of postings atomically.
   *
   * Idempotent on (shiftId, eventType, occurrenceKey) — the third component is what makes SRS
   * C-5's multiple float tranches postable. Returns the entries actually written; a replay
   * writes nothing and returns an empty array rather than double-posting.
   */
  post(
    branchId: string,
    postings: readonly Posting[],
    meta: {
      shiftId: string | null
      businessDate: CalendarDate
      postingDate: CalendarDate
      weekStartDate: CalendarDate
      fxDayId: number
      createdBy: string
      reason?: string
    },
  ): Promise<JournalEntryRecord[]>
  listByShift(shiftId: string): Promise<JournalEntryRecord[]>
  listByWeek(branchId: string, weekStartDate: CalendarDate): Promise<JournalEntryRecord[]>
  fundBalance(branchId: string, fundCode: string): Promise<Minor>
}

export interface FxRepo {
  list(): Promise<FxDay[]>
  upsert(day: FxDay): Promise<number>
  idFor(businessDate: CalendarDate): Promise<number | null>
}

export interface WeekLockRepo {
  find(branchId: string, weekStartDate: CalendarDate): Promise<WeekLockRecord | null>
  create(lock: Omit<WeekLockRecord, 'id'>): Promise<WeekLockRecord>
  seal(id: number, closedBy: string, closedAtMs: number): Promise<number>
  listClosedStarts(branchId: string): Promise<CalendarDate[]>
}

export interface AuditFilter {
  // `| undefined` explicitly, because `exactOptionalPropertyTypes` distinguishes "absent" from
  // "present and undefined" — and a parsed query object hands us the latter.
  tableName?: string | undefined
  recordId?: string | undefined
  actorId?: string | undefined
}

export interface AuditRepo {
  append(record: Omit<AuditRecord, 'id'>): Promise<void>
  list(filter: AuditFilter): Promise<AuditRecord[]>
}

export interface DirectoryRepo {
  branch(id: string): Promise<BranchRecord | null>
  driver(id: string): Promise<DriverRecord | null>
  vehicle(id: string): Promise<VehicleRecord | null>
  grants(): Promise<RoleGrantRecord[]>
}

/** Everything the API is handed at construction. One object, so wiring is explicit. */
export interface Deps {
  clock: Clock
  ids: IdGen
  hasher: PasswordHasher
  users: UserRepo
  sessions: SessionRepo
  shifts: ShiftRepo
  orders: OrderRepo
  ledger: LedgerRepo
  fx: FxRepo
  weekLocks: WeekLockRepo
  audit: AuditRepo
  directory: DirectoryRepo
}
