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
  /**
   * READ-ONLY projections of the evidence actually uploaded.
   *
   * These are derived from `MediaRepo`, never supplied by the client. An earlier version let
   * the driver's app send a list of slot names, which meant the BR5 gates were verifying that
   * the app *claimed* a photo existed — not that one did. For a system whose premise is
   * «الأدلة المصوَّرة», a claim is not evidence.
   */
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

export type EvidencePackage = 'start' | 'end'

export interface MediaRecord {
  id: string
  branchId: string
  /** Content address. Also the upload idempotency key: a retry after a dropped Wi-Fi dedupes. */
  sha256: string
  byteSize: number
  mimeType: string
  storageKey: string
  /**
   * The phone's clock is a CLAIM; `receivedAtMs` is authoritative. Both are kept, and a large
   * gap is surfaced to the branch manager — that difference is what makes a photo evidence
   * rather than just a picture.
   */
  clientTakenAtMs: number | null
  receivedAtMs: number
  uploadedBy: string
}

export interface AttachedSlot {
  package: EvidencePackage
  slot: string
  mediaId: string
}

export interface MediaRepo {
  /** Content-addressed: an existing sha256 returns the stored record instead of duplicating. */
  put(record: MediaRecord): Promise<MediaRecord>
  findBySha(branchId: string, sha256: string): Promise<MediaRecord | null>
  findById(id: string): Promise<MediaRecord | null>
  /** One photo per (shift, package, slot): re-shooting replaces rather than accumulating. */
  attach(shiftId: string, pkg: EvidencePackage, slot: string, mediaId: string): Promise<void>
  listSlots(shiftId: string): Promise<AttachedSlot[]>
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

export interface DocumentRecord {
  id: string
  branchId: string
  ownerKind: 'driver' | 'vehicle'
  driverId: string | null
  vehicleId: string | null
  /** driving_licence | national_id | criminal_record | registration | insurance */
  kind: string
  issuedOn: CalendarDate | null
  expiresOn: CalendarDate | null
  mediaId: string | null
  supersededBy: string | null
}

export interface DirectoryRepo {
  branch(id: string): Promise<BranchRecord | null>
  driver(id: string): Promise<DriverRecord | null>
  vehicle(id: string): Promise<VehicleRecord | null>
  grants(): Promise<RoleGrantRecord[]>

  // ── Fleet management (SRS B) ────────────────────────────────────────────────────────────
  listDrivers(branchId: string): Promise<DriverRecord[]>
  createDriver(driver: DriverRecord): Promise<void>
  updateDriver(driver: DriverRecord): Promise<void>

  listVehicles(branchId: string): Promise<VehicleRecord[]>
  createVehicle(vehicle: VehicleRecord): Promise<void>
  updateVehicle(vehicle: VehicleRecord): Promise<void>

  createDocument(doc: DocumentRecord): Promise<void>
  listDocuments(owner: { driverId?: string; vehicleId?: string }): Promise<DocumentRecord[]>
  /** Everything expiring on or before `through`, for the morning alert sweep (س37). */
  listExpiringDocuments(branchId: string, through: CalendarDate): Promise<DocumentRecord[]>
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
  media: MediaRepo
  blobs: BlobStore
  fx: FxRepo
  weekLocks: WeekLockRepo
  audit: AuditRepo
  directory: DirectoryRepo
}
