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

/**
 * Authenticated encryption at rest for the handful of PII fields the schema marks encrypted
 * (a driver's national ID today; `document_no_enc` and the TOTP secret are follow-ups). AES-256-GCM
 * lives in the adapter, behind this port, so the domain and the routes never touch `node:crypto`.
 *
 * `available` is false when no key is configured. Writers must check it and refuse rather than
 * store plaintext — losing PII confidentiality silently is worse than a loud failure. `decrypt`
 * throws on a tampered or wrong-key blob; readers treat that as "cannot show it".
 */
export interface Cipher {
  readonly available: boolean
  encrypt(plaintext: string): Uint8Array
  decrypt(blob: Uint8Array): string
}

/** Content-addressed blob storage. Local disk now, S3-compatible later — same interface. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  exists(key: string): Promise<boolean>
}

// ── Records ───────────────────────────────────────────────────────────────────────────────

export interface GovernorateRecord {
  id: string
  /** The first segment of «رقم الآلية». Editable — the client's own numbering wins over ours. */
  no: number
  nameAr: string
  nameEn: string
  active: boolean
}

export interface BranchRecord {
  id: string
  code: string
  nameAr: string
  nameEn: string
  /** The second segment of the vehicle number. Unique within the governorate. */
  governorateId: string
  branchNo: number
}

export interface VehicleTypeRecord {
  id: string
  code: string
  nameAr: string
  nameEn: string
  /**
   * The third segment of the vehicle number, editable by the system admin.
   *
   * Editing it restates the printed code of every vehicle of this type — which is why the repo
   * does both in one transaction, and why `vehicle_types` is audited.
   */
  typeNo: number
  /**
   * The maximum battery packs a machine of this type may carry (configurable, sysadmin-set). The
   * ceiling, not the count: a bike's actual pack count is `COUNT(*)` of the packs fitted to it. The
   * per-bike `slot_no` is validated against this app-side (a cross-table CHECK cannot).
   */
  batterySlots: number
  active: boolean
}

/**
 * A battery pack: an asset, not an attribute of a bike.
 *
 * Packs are the expensive consumable and they move between machines, so they are rows with their
 * own history. `vehicleId` and `slotNo` are set together or not at all — fitted to a slot, or a
 * spare on the shelf. The serial and MAC come straight off the BMS app, which is what lets a
 * shift reading be tied to the pack that was actually photographed.
 */
export interface BatteryRecord {
  id: string
  branchId: string
  serialNo: string | null
  bmsMac: string | null
  /** Today 30 or 50. Stored as whole amp-hours; the BMS's tenths live on the reading. */
  capacityAh: number
  vehicleId: string | null
  slotNo: number | null
  state: 'ready' | 'charging' | 'maintenance' | 'retired'
  active: boolean
  /**
   * Which BMS phone app this pack ships with, so the reader knows the label spellings and the
   * layout to expect. `null` means nobody has said, and the reader tries everything.
   */
  bmsProfile: string | null
}

/**
 * What the driver's BMS screenshot said, for one pack at one end of one shift.
 *
 * Every physical quantity is a SCALED INTEGER, never a float — millivolts, deci-amp-hours,
 * deci-Celsius. `ocrRaw` keeps what the OCR actually read before any correction, so SRS D-3's
 * "log the manual edit WITH its difference from the OCR reading" stays computable at any time
 * rather than only at the moment of typing.
 */
/**
 * When a pack reading was taken. `start`/`end` are the two shift gates; `swap_out`/`swap_in` are
 * the two halves of a mid-shift swap — the final reading of the pack coming off and the first
 * reading of the pack going on. Distinct from `EvidencePackage` (media slots), which has no swap.
 */
export type BatteryReadingPackage = 'start' | 'end' | 'swap_out' | 'swap_in'

export interface BatteryReadingRecord {
  shiftId: string
  batteryId: string
  package: BatteryReadingPackage
  slotNo: number
  percent: number | null
  packMillivolts: number | null
  cycleCount: number | null
  remainCapacityDah: number | null
  fullCapacityDah: number | null
  mosTempDc: number | null
  t1Dc: number | null
  t2Dc: number | null
  mediaId: string | null
  source: 'ocr' | 'manual'
  ocrRaw: unknown
  /** The mid-shift swap this reading belongs to; null for the ordinary start/end readings. */
  batterySwapId: string | null
}

/**
 * A mid-shift battery swap (SRS §L seam): the driver traded a depleted pack for a charged spare
 * at a charging stop. One row per swap, discriminated per shift by `seqNo` (like a float tranche).
 * The pack fitment change itself lives on `batteries` and is audited there; this is the event log.
 */
export interface BatterySwapRecord {
  id: string
  shiftId: string
  seqNo: number
  slotNo: number
  outBatteryId: string
  inBatteryId: string
  occurredAtMs: number
  createdBy: string | null
}

export interface UserRecord {
  id: string
  branchId: string | null
  roleKey: RoleKey
  username: string
  fullNameAr: string
  passwordHash: string
  driverId: string | null
  /**
   * TOTP shared secret, base32. `null` until enrolled. In PostgreSQL this lands in
   * `mfa_secret_enc bytea`; app-side AES-256-GCM wrapping around it is a documented follow-up
   * (see docs/DEPLOY-VERCEL-NEON — key management). The port exposes the decrypted secret.
   */
  mfaSecret: string | null
  mfaEnrolledAtMs: number | null
  failedAttempts: number
  lockedUntilMs: number | null
  active: boolean
}

export interface SessionRecord {
  id: string
  userId: string
  tokenHash: string
  /** False until the second factor is presented, for an admin role that has enrolled. */
  mfaSatisfied: boolean
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
  /** The login account that operates as this driver, if one is linked. */
  userId?: string | null
  /** Profile fields (B-1). Optional so seeds and older callers stay valid. */
  fullNameEn?: string | null
  phone?: string | null
  hiredOn?: CalendarDate | null
  /** National ID, AES-256-GCM ciphertext. Written encrypted; never returned as plaintext. */
  nationalIdEnc?: Uint8Array | null
}

export interface VehicleRecord {
  id: string
  branchId: string
  vehicleTypeId: string
  /**
   * The formatted vehicle number, «1-1-1-1» — a WRITTEN column fed by `formatVehicleNumber`,
   * deliberately not generated: the expression reaches across `branches` and `governorates`,
   * which a Postgres generated column cannot do. The four components are the source of truth.
   */
  code: string
  /** The fourth segment. Unique within (branch, type). */
  machineNo: number
  plateNo: string | null
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
  /**
   * SRS D-3 baselines: the pre-correction OCR values, kept so «the manual edit and its difference
   * from the OCR reading» stays computable. `null` = OCR did not run (or the driver typed straight).
   */
  odoStartOcr: number | null
  batteryStartOcr: number | null
  endWalletDeclaredOcr: Minor | null
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
  /** SRS D-1: whether the fee came from OCR of «Recent orders» or was typed. */
  source: 'manual' | 'ocr'
  /** SRS D-3: the pre-correction OCR fee, so a silently-lowered fee is visible. null = no OCR. */
  feeOcr: Minor | null
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
  /** Create a login account. Rejects a duplicate username with a DUPLICATE_USERNAME code. */
  create(user: UserRecord): Promise<void>
  /** All accounts, optionally scoped to one branch (global admins have a null branch). */
  list(branchId?: string | null): Promise<UserRecord[]>
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
  /** Every shift currently out working in the branch, across dates — one may have opened yesterday
   *  and never closed. Backs the live map: only a driver on a live shift belongs on it. */
  listLiveForBranch(branchId: string): Promise<ShiftRecord[]>
  /**
   * Remove a shift that never opened. Only legal for `draft` / `awaiting_open_approval`, which
   * have posted nothing to the ledger — it is how a mistakenly started shift releases the bike and
   * the driver it would otherwise hold hostage. The audit trigger records the deletion.
   */
  delete(id: string): Promise<void>
  listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
  listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
}

/**
 * A driver↔vehicle binding the branch manager makes IN ADVANCE (SRS B-3): the driver does not
 * choose a bike, he is given one. The table enforces one bike per driver and one driver per bike
 * for a given (business date, shift no).
 */
export interface AssignmentRecord {
  id: string
  branchId: string
  driverId: string
  vehicleId: string
  businessDate: CalendarDate
  shiftNo: number
  createdBy: string | null
}

export interface AssignmentRepo {
  create(assignment: AssignmentRecord): Promise<void>
  listByDate(branchId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]>
  findForDriver(driverId: string, businessDate: CalendarDate): Promise<AssignmentRecord[]>
  delete(id: string): Promise<void>
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

// ── Expenses (SRS G) ──────────────────────────────────────────────────────────────────────

export interface ExpenseCategoryRecord {
  id: string
  code: string
  nameAr: string
  active: boolean
}

export interface ExpenseRecord {
  id: string
  branchId: string
  categoryId: string
  /** G-1 cost centres: vehicle / branch / general — these feed per-axis profitability. */
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  amount: Minor
  businessDate: CalendarDate
  description: string
  /** Required above the configured ceiling (G-3 / س52). */
  receiptMediaId: string | null
  journalEntryId: number | null
  createdBy: string
}

export interface ExpenseRepo {
  listCategories(): Promise<ExpenseCategoryRecord[]>
  createCategory(category: ExpenseCategoryRecord): Promise<void>
  create(expense: ExpenseRecord): Promise<void>
  listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]>
  /** Per-cost-centre totals — G-1's «تُغذي ربحية كل محور». */
  totalsByCostCenter(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Array<{ costCenterKind: string; vehicleId: string | null; total: Minor }>>
}

// ── Daily cash count (SRS E-5 / س51) ──────────────────────────────────────────────────────

export interface CashCountLine {
  fundCode: string
  counted: Minor
  /** Frozen at count time, NOT recomputed at read time — otherwise a later posting silently
   *  rewrites history and the variance a manager signed off disappears. */
  computed: Minor
  variance: Minor
  resolution: string | null
}

export interface CashCountRecord {
  id: string
  branchId: string
  businessDate: CalendarDate
  countedBy: string
  countedAtMs: number
  lines: CashCountLine[]
  /** sha256 over the frozen lines. «إثبات الجرد» — the count cannot be quietly restated. */
  proofSha256: string | null
  sealedAtMs: number | null
  notes: string | null
}

export interface CashCountRepo {
  create(count: CashCountRecord): Promise<void>
  find(branchId: string, businessDate: CalendarDate): Promise<CashCountRecord | null>
  listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]>
}

// ── Tier rules (SRS F) ────────────────────────────────────────────────────────────────────

export interface TierRuleRecord {
  id: number
  basis: 'orders' | 'revenue'
  mode: 'whole' | 'marginal'
  vehicleTypeId: string | null
  bands: Array<{ from: number; to: number | null; driverBps: number }>
  effectiveFrom: CalendarDate
  /** Resolution reads 'active' AND 'superseded' — see the note on TierRepo.resolve. */
  status: 'active' | 'superseded' | 'withdrawn'
  createdBy: string
}

export interface TierRepo {
  list(): Promise<TierRuleRecord[]>
  /**
   * Publish a new version. Marks any incumbent for the same vehicle type 'superseded' rather
   * than deleting it — a past day must still resolve to the rate that actually applied to it.
   */
  publish(rule: Omit<TierRuleRecord, 'id' | 'status'>): Promise<TierRuleRecord>
  withdraw(id: number, actorId: string): Promise<void>
}

// ── Notifications (SRS A-6) ───────────────────────────────────────────────────────────────

export interface NotificationRecord {
  id: number
  recipientId: string
  branchId: string | null
  kind: string
  payload: Record<string, unknown>
  dedupeKey: string | null
  readAtMs: number | null
  createdAtMs: number
}

export interface NotificationRepo {
  /** Dedupe-keyed: the same real-world event must not ring the bell twice. */
  push(record: Omit<NotificationRecord, 'id'>): Promise<void>
  listForRecipient(recipientId: string, unreadOnly: boolean): Promise<NotificationRecord[]>
  markRead(id: number, recipientId: string, atMs: number): Promise<void>
  unreadCount(recipientId: string): Promise<number>
}

// ── Settings (SRS A-4) ────────────────────────────────────────────────────────────────────

export interface SettingsRepo {
  /** Approval ceilings (س52): above this, an expense needs a photographed receipt. */
  receiptRequiredAbove(branchId: string): Promise<Minor | null>
  /** Fixed kWh price for charging cost (G-2 / س64). */
  kwhPriceMinor(): Promise<Minor | null>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, actorId: string): Promise<void>
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

/**
 * One entry in a vehicle's life log (SRS B-2 / س66) — «سجل حياة يجمع كل الأحداث والكلف»: every
 * state change, maintenance, incident, charge, odometer reading and linked cost against one bike,
 * in one timeline. `costMinor` and `expenseId` tie an event to the money it cost.
 */
export type VehicleEventKind = 'state_change' | 'maintenance' | 'incident' | 'charge' | 'odometer_reading'
export interface VehicleEventRecord {
  id: number
  vehicleId: string
  branchId: string
  kind: VehicleEventKind
  occurredAtMs: number
  businessDate: CalendarDate
  odometerKm: number | null
  costMinor: Minor | null
  expenseId: string | null
  shiftId: string | null
  notes: string | null
  createdBy: string | null
}

export interface VehicleEventRepo {
  create(event: Omit<VehicleEventRecord, 'id'>): Promise<VehicleEventRecord>
  /** Newest first, so the timeline reads top-down from the most recent event. */
  listByVehicle(vehicleId: string, limit?: number): Promise<VehicleEventRecord[]>
}

/**
 * Admin-staff attendance (SRS B-4 / س41). «نفس تسجيل الدخول اليومي» — a daily login is the
 * attendance record: one row per user per business date, first-seen fixed, last-seen bumped.
 */
export interface AttendanceRecord {
  userId: string
  branchId: string
  businessDate: CalendarDate
  firstSeenAtMs: number
  lastSeenAtMs: number
}

export interface AttendanceRepo {
  /** Upsert on (user, business date): insert sets first- and last-seen; a repeat bumps last-seen. */
  touch(userId: string, branchId: string, businessDate: CalendarDate, atMs: number): Promise<void>
  listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<AttendanceRecord[]>
}

export interface DirectoryRepo {
  branch(id: string): Promise<BranchRecord | null>
  listBranches(): Promise<BranchRecord[]>
  driver(id: string): Promise<DriverRecord | null>
  vehicle(id: string): Promise<VehicleRecord | null>
  grants(): Promise<RoleGrantRecord[]>
  /**
   * Set one cell of the §3 permission matrix (SRS A-2 requires it be editable data, not code).
   * A `null` scope REMOVES the grant. Authorisation reads this table on every request, and an
   * EMPTY table silently falls back to the hardcoded DEFAULT_GRANTS — so a caller must never be
   * allowed to clear the last row.
   */
  setGrant(roleKey: RoleKey, permissionKey: PermissionKey, scope: Scope | null): Promise<void>

  // ── Fleet management (SRS B) ────────────────────────────────────────────────────────────
  listDrivers(branchId: string): Promise<DriverRecord[]>
  createDriver(driver: DriverRecord): Promise<void>
  updateDriver(driver: DriverRecord): Promise<void>

  listVehicles(branchId: string): Promise<VehicleRecord[]>
  createVehicle(vehicle: VehicleRecord): Promise<void>
  updateVehicle(vehicle: VehicleRecord): Promise<void>

  // ── Geography and the vehicle-numbering scheme ──────────────────────────────────────────
  listGovernorates(): Promise<GovernorateRecord[]>
  createGovernorate(governorate: GovernorateRecord): Promise<void>
  updateGovernorate(governorate: GovernorateRecord): Promise<void>
  createBranch(branch: BranchRecord): Promise<void>
  updateBranch(branch: BranchRecord): Promise<void>

  listVehicleTypes(): Promise<VehicleTypeRecord[]>
  createVehicleType(type: VehicleTypeRecord): Promise<void>
  /**
   * Update a type, restating the `code` of every vehicle of that type IN THE SAME TRANSACTION.
   *
   * The type number is a segment of every one of its vehicles' printed numbers. Changing it
   * without restating them would leave the stored codes quietly wrong — the implementations
   * therefore take the formatter as an argument rather than reaching into the domain, keeping
   * the one true spelling in `formatVehicleNumber` and out of SQL.
   */
  updateVehicleType(
    type: VehicleTypeRecord,
    format: (v: { governorateNo: number; branchNo: number; typeNo: number; machineNo: number }) => string,
  ): Promise<void>

  // ── Batteries (SRS §L seam) ─────────────────────────────────────────────────────────────
  listBatteries(branchId: string): Promise<BatteryRecord[]>
  /** The packs fitted to one bike, in slot order. Its length IS the bike's battery count. */
  listBatteriesForVehicle(vehicleId: string): Promise<BatteryRecord[]>
  battery(id: string): Promise<BatteryRecord | null>
  createBattery(battery: BatteryRecord): Promise<void>
  updateBattery(battery: BatteryRecord): Promise<void>

  createDocument(doc: DocumentRecord): Promise<void>
  listDocuments(owner: { driverId?: string; vehicleId?: string }): Promise<DocumentRecord[]>
  /** Everything expiring on or before `through`, for the morning alert sweep (س37). */
  listExpiringDocuments(branchId: string, through: CalendarDate): Promise<DocumentRecord[]>
}

/** Per-pack BMS readings for a shift (SRS §L seam, evidence for the BR5 gates). */
export interface BatteryReadingRepo {
  /** Replaces the row for (shift, battery, package) — a re-upload corrects, it does not duplicate. */
  upsert(reading: BatteryReadingRecord): Promise<void>
  listByShift(shiftId: string): Promise<BatteryReadingRecord[]>
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, one row per swap per shift. */
export interface BatterySwapRepo {
  create(swap: BatterySwapRecord): Promise<void>
  /** Every swap on a shift, in the order they happened. Length + max seqNo drive the next seqNo. */
  listByShift(shiftId: string): Promise<BatterySwapRecord[]>
}

/**
 * The manager's decisions on a shift (SRS C-7, «سجل قرارات») — every approve, reject and re-shoot
 * request, with a note. Append-only; the review screen reads the log so the history of a shift's
 * gating is visible, and a re-shoot/reject tells the driver WHY.
 */
export interface ShiftDecisionRecord {
  id: number
  shiftId: string
  gate: 'open' | 'close'
  decision: 'approved' | 'rejected' | 'rephoto_requested'
  notes: string | null
  decidedBy: string
  decidedAtMs: number
}

export interface ShiftDecisionRepo {
  record(decision: Omit<ShiftDecisionRecord, 'id'>): Promise<ShiftDecisionRecord>
  /** Newest first, so the log reads top-down from the most recent decision. */
  listByShift(shiftId: string): Promise<ShiftDecisionRecord[]>
}

/** A single GPS fix from the driver's phone while a shift is open (SRS K). Telemetry, not money. */
export interface GpsPingRecord {
  id: number
  shiftId: string
  driverId: string
  branchId: string
  lat: number
  lng: number
  accuracyM: number | null
  /** The phone's own clock (ms). */
  capturedAtMs: number
  /** Server receive time (ms), stamped by the clock — a skewed phone can't rewrite it. */
  receivedAtMs: number
}

export interface GpsPingRepo {
  append(ping: Omit<GpsPingRecord, 'id'>): Promise<void>
  /** The most recent fix per driver in the branch — what the live map draws. */
  latestPerDriverForBranch(branchId: string): Promise<GpsPingRecord[]>
  /** A shift's whole trail, oldest first (for the route view). */
  listForShift(shiftId: string): Promise<GpsPingRecord[]>
}

/** Everything the API is handed at construction. One object, so wiring is explicit. */
export interface Deps {
  clock: Clock
  ids: IdGen
  hasher: PasswordHasher
  cipher: Cipher
  users: UserRepo
  sessions: SessionRepo
  shifts: ShiftRepo
  assignments: AssignmentRepo
  batteryReadings: BatteryReadingRepo
  batterySwaps: BatterySwapRepo
  orders: OrderRepo
  ledger: LedgerRepo
  expenses: ExpenseRepo
  cashCounts: CashCountRepo
  tiers: TierRepo
  notifications: NotificationRepo
  settings: SettingsRepo
  media: MediaRepo
  blobs: BlobStore
  fx: FxRepo
  weekLocks: WeekLockRepo
  audit: AuditRepo
  directory: DirectoryRepo
  vehicleEvents: VehicleEventRepo
  attendance: AttendanceRepo
  decisions: ShiftDecisionRepo
  gps: GpsPingRepo
}
