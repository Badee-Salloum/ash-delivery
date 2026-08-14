import type {
  CalendarDate,
  FxDay,
  Minor,
  OrderKind,
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

/** Which screen is being read. Each one parses differently; none of them is a generic "document". */
export type OcrField = 'orders' | 'payments_log' | 'wallet' | 'odometer' | 'bms'

/**
 * Why a read produced nothing. Four states, not one, because each wants a different response.
 *
 * The same vocabulary `apps/driver/src/ocr.ts` already uses, and for the reason its header gives:
 * a missing asset, a dead worker, a timeout and a clean read that matched nothing all used to
 * return `null` alike, and the UI could say nothing more useful than "it didn't work".
 */
export type OcrFailure = 'unavailable' | 'timeout' | 'no_fields' | 'refused'

/**
 * One money row as the reader saw it.
 *
 * `printed` is transcription and `value` is arithmetic, and they are separate fields because they
 * are separate skills — a model that reads «−١٬١٥٥٫٦٥» correctly can still hand back `-115565`.
 * Both are STRINGS: a JSON number here would round the money before it ever reached `Minor`, and
 * `check-wire-money.mjs` fails the build on the attempt.
 */
export interface OcrRow {
  printed: string
  value: string | null
  cancelled: boolean
  /** 24-hour `HH:MM`. */
  time: string | null
  /**
   * The two ends of the delivery, as printed. Pickup then dropoff.
   *
   * Asked for because when the on-device reader finds nothing, the cloud's rows have to stand on
   * their own — and a row's identity in the merge is (day, minute, route). Without the route the
   * same delivery read by each reader keys differently and is counted twice.
   *
   * NO ADDITIONAL PRIVACY COST, which is the only reason this is acceptable: the entire screenshot
   * — addresses, business names, GPS pairs and Plus Codes — is already in the request body. Asking
   * the model to type back what it can already see exposes nothing new.
   */
  pointA: string | null
  pointB: string | null
  /**
   * `YYYY-MM-DD`, from the nearest date header ABOVE this row — not from today's clock.
   *
   * A screen can carry MORE THAN ONE header: one corpus screenshot runs «Friday, August 7» for its
   * top row and «Thursday, August 6» for the rest. Get this wrong and every fee is right while
   * every order lands on the wrong day, which is exactly how a shift's orders end up on a
   * neighbouring business date.
   */
  dateIso: string | null
}

export type OcrResult =
  | {
      ok: true
      rows: OcrRow[]
      /** Labelled non-money values — odometer km, battery percent, cycle count. */
      fields: Readonly<Record<string, string | null>>
      /** The provider's answer verbatim, kept so the D-3 baseline stays reconstructible. */
      raw: unknown
    }
  | { ok: false; reason: OcrFailure }

/**
 * A cloud vision model reading a driver's screenshot.
 *
 * `available` is false when no provider is configured, and it mirrors `Cipher.available` for the
 * same reason: "not configured" is a legitimate state a caller must CHECK, not an exception. With
 * no reader the driver app falls back to the on-device one and nothing above this line changes.
 *
 * `read` never throws for an upstream failure — a timeout, a 500 and a refusal all come back as
 * `{ ok: false }`. That is not politeness: `wire.ts`'s `walletDeclaredOcr` carries the incident
 * where a misread baseline refused a request and a shift balancing to exactly 0.00 could not be
 * handed over because a cosmetic field disagreed. An OCR limb must never be able to fail a money
 * limb.
 */
export interface OcrReader {
  readonly available: boolean
  /** The model actually in use, recorded beside every reading so a run is self-describing. */
  readonly model: string
  read(request: { field: OcrField; bytes: Uint8Array; mimeType: string }): Promise<OcrReading>
}

/** What `read` returns: the result, plus what it cost. There is no other cost meter in this API. */
export interface OcrReading {
  result: OcrResult
  usage: { tokensIn: number; tokensOut: number; latencyMs: number }
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
  /** IANA zone used for this branch's printed operation dates/minutes. */
  timezone: string
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
  /**
   * The number painted on the pack — «الرقم التمييزي» for a battery.
   *
   * `serialNo` and `bmsMac` come off the BMS phone app: long, OCR-transcribed, and legible only by
   * pairing over Bluetooth. Neither is any use to somebody holding two packs at a charging shelf,
   * and packs are the expensive consumable that moves between machines — a swap recorded against
   * the wrong pack puts one battery's history on another. Same rules as the vehicle's: nullable,
   * not unique, never joined on.
   */
  groundNo: string | null
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
  source: 'ocr' | 'manual' | 'manager'
  /** The driver cannot read this pack on his own phone; the manager owes the reading. */
  unavailable: boolean
  /**
   * OCR output belonging to this exact submitted reading generation. A replacement submission
   * replaces this value too; `null` explicitly clears a baseline that belongs to an older photo.
   */
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
  /**
   * The number painted on the machine — «الرقم التمييزي على الأرض».
   *
   * Neither `code` nor `plateNo` is what a driver can read in the yard: `code` describes where the
   * bike sits in the fleet and nobody paints it on a mudguard, and an electric motorbike in Damascus
   * often has no plate at all. This is the marking the branch actually puts on its machines and the
   * one a driver is given when he is sent to take a particular bike.
   *
   * Nullable and NOT unique, deliberately: a human marking that has not been applied yet is honestly
   * described by `null`, and a uniqueness refusal at the moment a manager records a real bike only
   * teaches him to type something false to get past it. `code` stays the identity the system joins on.
   */
  groundNo: string | null
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
   * ذمم consumed at OPEN — cash the driver already held from a previous shift.
   *
   * DISJOINT from `floatTranches`, and it must stay so: both are summed into the closing cash, so
   * an amount appearing in each would be returned twice and leave the office over by that much.
   * The repo loads them from separate `float_tranches.kind` values for exactly this reason.
   */
  carriedTranches: Minor[]
  /** «يبقى ذمة على السائق» — what the manager left with him at close. Zero for every older shift. */
  keptAsReceivable: Minor
  /** «يُعاد للسائق» — the share he kept out of the cash in his hands (owner decision f). */
  driverSharePaid: Minor
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
  /** Pre-correction OCR end-odometer value. Null when the close reader did not run. */
  odoEndOcr: number | null
  /** Driver/manager explicitly accepted an end reading below the opening odometer. */
  odoEndAnomalyConfirmedAt: string | null
  /** Actor who accepted that anomaly; null exactly when `odoEndAnomalyConfirmedAt` is null. */
  odoEndAnomalyConfirmedBy: string | null
  batteryStartOcr: number | null
  endWalletDeclaredOcr: Minor | null
  driverConfirmedAt: string | null
  /** The one manager-approved instant at which this shift first became operational. */
  openApprovedAt: string | null
  /** Manager who approved the initial open. Never replaced by resume/review decisions. */
  openApprovedBy: string | null
  /** Driver's most recent close-package submission instant. */
  submittedAt: string | null
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
  /** `yallago` (their delivery — 20% cut, day's tier band) or `manual` (a job the branch took). */
  kind: OrderKind
  /**
   * Manual orders only, and `driverShare + companyShare === fee` exactly. NULL on a Yallago order,
   * whose split is a property of the DAY's band and is computed at approval rather than stored —
   * storing it per order would fight the true-up that restates earlier shifts (BR4, decision #6).
   */
  driverShare: Minor | null
  companyShare: Minor | null
  notes: string | null
  /** Who entered it. A manual order is a manager's act; a Yallago one comes off the driver's scan. */
  createdBy: string | null
  /** The route: start, any stops, end. Empty for a Yallago order. */
  points: readonly OrderPointRecord[]
  /**
   * Checked at close. `false` keeps the row with the shift and shows it to everyone, but takes it
   * out of BR1, the tier band and the ledger — data, not money. Screenshots overlap and show
   * previous days, so a read list always contains rows that are not this shift's.
   */
  included: boolean
  /**
   * How much of this fee reached the WALLET, measured off «سجل المدفوعات». `null` means nobody
   * measured it and the pay mode decides, exactly as before the log was ever read.
   */
  walletAmount: Minor | null
  /** «HH:MM» off the dashboard — what a log row is paired to. `null` when the clock was illegible. */
  occurredMinute: string | null
  /**
   * The DAY the order screen says it happened («الخميس, ٦ أغسطس»), as `YYYY-MM-DD`.
   *
   * Not the shift's day: «الطلبات الحديثة» scrolls back through previous days, so a list read at
   * close routinely contains yesterday's orders. `null` when no header was legible — the day
   * number is Arabic-Indic and is only accepted when the weekday printed beside it agrees.
   */
  occurredDate: string | null
  /** Position of the printed operation time relative to the shift's approved-open/close window. */
  windowStatus: OperationWindowStatus
  /** Required by the service when a manager changes whether this row counts. */
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
}

/**
 * A minute-only screenshot cannot order a row within either boundary minute. Boundary states are
 * therefore distinct from the certain in/out states and remain included while visibly flagged.
 */
export type OperationWindowStatus =
  | 'in_window'
  | 'pre_open'
  | 'post_close'
  | 'open_minute_boundary'
  | 'close_minute_boundary'
  | 'unknown'

export type CashDeductionSource = 'ocr' | 'manual'

/**
 * A positive cash deduction read from the provider's operations screen.
 *
 * `amount` is a magnitude: cash deductions are never represented by a negative money value. The
 * direction lives in the record type, which prevents a double-negation at BR1/ledger boundaries.
 */
export interface CashDeductionRecord {
  id: string
  shiftId: string
  /** Stable identity supplied by the source; unique only within one shift. */
  operationKey: string
  amount: Minor
  occurredDate: CalendarDate | null
  occurredMinute: string | null
  source: CashDeductionSource
  /** What OCR proposed before correction; null for manual/refused reads. */
  amountOcr: Minor | null
  pointA: string | null
  pointB: string | null
  included: boolean
  windowStatus: OperationWindowStatus
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdBy: string | null
}

/** What a movement IS, which decides how BR1 may use it. See `WalletMovementRecord.role`. */
export type WalletMovementRole = 'yalago_cut' | 'order_credit' | 'unmatched'

/**
 * One row of «سجل المدفوعات» — what the wallet actually did, as opposed to what the orders imply.
 *
 * The three roles are disjoint and that is the whole defence against counting money twice:
 * `yalago_cut` never enters BR1 (the equation derives the cut from the fee, because the 80% block
 * is a residual); `order_credit` becomes its order's `walletAmount` and is already inside the
 * order's arithmetic; only `unmatched` rows are summed into BR1's `walletAdjustments`.
 */
export interface WalletMovementRecord {
  id: string
  shiftId: string
  /** SIGNED: negative left the wallet, positive arrived. A movement, not a balance. */
  amount: Minor
  /** «HH:MM», or '' when the row's clock was not legible. */
  occurredMinute: string
  /** Ordinal among rows sharing (shift, minute, amount) — assigned server-side, never by a client. */
  seq: number
  orderId: string | null
  role: WalletMovementRole
  /** Nobody has yet said whether a credit at an order's minute belongs to that order. */
  ambiguous: boolean
  included: boolean
  source: 'ocr' | 'manual'
  mediaId: string | null
  notes: string | null
  createdBy: string | null
}

/** A movement as it arrives from a screenshot, before the server gives it an identity. */
export interface WalletMovementInput {
  amount: Minor
  occurredMinute: string
  orderId?: string | null
  role?: WalletMovementRole
  ambiguous?: boolean
  included?: boolean
  source?: 'ocr' | 'manual'
  mediaId?: string | null
  notes?: string | null
  createdBy?: string | null
}

/** One point on a manual order's route. The written place is required; the map pin is optional. */
export interface OrderPointRecord {
  role: 'start' | 'stop' | 'end'
  label: string
  lat: number | null
  lng: number | null
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
  create(shift: ShiftRecord, actorId: string | null): Promise<void>
  findById(id: string): Promise<ShiftRecord | null>
  /** `actorId` is the current mutation actor, never inferred from an earlier approval. */
  update(shift: ShiftRecord, actorId: string | null): Promise<void>
  listLiveForDriver(driverId: string): Promise<ShiftRecord[]>
  listLiveForVehicle(vehicleId: string): Promise<ShiftRecord[]>
  /**
   * Has this bike ever carried a shift, live or long finished?
   *
   * The question a delete has to ask. `listLiveForVehicle` answers "is it busy now", which is a
   * different thing: a bike that finished twenty approved shifts last month is not busy and must
   * still never be deleted — `shifts.vehicle_id` is NOT NULL with no cascade, and the money hangs
   * off those rows.
   */
  existsForVehicle(vehicleId: string): Promise<boolean>
  /** Every shift currently out working in the branch, across dates — one may have opened yesterday
   *  and never closed. Backs the live map: only a driver on a live shift belongs on it. */
  listLiveForBranch(branchId: string): Promise<ShiftRecord[]>
  /**
   * Every shift in the branch waiting for the manager to decide, across dates.
   *
   * Deliberately date-independent, for the same reason `listLiveForBranch` is: "what is waiting for
   * me" is not a question about today. The queue used the date-filtered read, so a close submitted
   * before midnight and approved after it disappeared from the only screen that shows it — still
   * `pending_review`, its money still unposted, and invisible.
   */
  listAwaitingDecisionForBranch(branchId: string): Promise<ShiftRecord[]>
  /**
   * Remove a shift that never opened. Only legal for `draft` / `awaiting_open_approval`, which
   * have posted nothing to the ledger — it is how a mistakenly started shift releases the bike and
   * the driver it would otherwise hold hostage. The audit trigger records the deletion.
   */
  delete(id: string, actorId: string | null): Promise<void>
  listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
  /**
   * Every shift in a DATE RANGE — what a week close has to look at.
   *
   * The close used to call `listByBranchAndDate(branchId, start)`, a single-DAY query, so
   * `unapprovedShiftCount` only ever saw the week's Sunday and Monday-to-Saturday were invisible.
   * A week sealed with a shift still in review; approving it afterwards posted entries into the
   * sealed week carrying `week_lock_id = NULL`, permanently unlockable — `fin_seal_week` cannot
   * be re-run, because `week_locks_no_reopen` refuses to re-stamp `closed_at`.
   */
  listByBranchAndDateRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ShiftRecord[]>
  listApprovedForDriverOnDate(driverId: string, businessDate: CalendarDate): Promise<ShiftRecord[]>
  /**
   * The next free shift number for this driver on this business date.
   *
   * THE CLIENT MUST NEVER PICK THIS. `shifts_no_uq` is `UNIQUE (driver_id, business_date,
   * shift_no)`, and the driver's app hard-coded `1` — so the moment a driver's first shift of the
   * day reached any state `canOpenShift` does not consider live (`cancelled`, `closed`,
   * `approved`), his second shift of the day collided with a row he could not see and the
   * duplicate-key error surfaced as a bare 500. Measured in production on 2026-08-12: five
   * identical failures, one blocked driver, and an owner whose own book records four to six
   * shifts a day.
   *
   * It counts EVERY state, not the live ones. A cancelled shift keeps its number — that is what
   * the unique constraint means, and reusing it would collide all over again.
   */
  nextShiftNo(driverId: string, businessDate: CalendarDate): Promise<number>
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
  create(order: ShiftOrderRecord, actorId: string | null): Promise<void>
  /**
   * Keep the fee's own pixels beside what the reader made of them — a training sample.
   *
   * The classifier has ~500 glyphs behind it, transcribed by one person, and adding 25 more
   * screenshots by hand measurably made it WORSE. What it has never had is volume from the phones
   * in use, and that arrives free with every shift: the driver corrects, the manager approves, and
   * that figure is ground truth verified by two people.
   *
   * Best-effort by contract. A sample is research material, and failing to keep one must never cost
   * a driver his order — callers swallow the error.
   */
  recordOcrSample(shiftOrderId: string, source: 'ocr' | 'refused', stripPng: Uint8Array): Promise<void>
  /**
   * The same thing for the readings that belong to a SHIFT rather than an order — the wallet
   * balance, the payments log, the odometer.
   *
   * `kind` is the name of a code path, not a foreign key. The odometer's strip is deliberately a
   * WIDER region than the others: its reader does not misread digits, it reads the wrong number on
   * the dashboard, so a narrow crop would faithfully preserve the mistake.
   *
   * Best-effort by contract, exactly like the fee one: a lost sample costs a future model one
   * example; a thrown error costs a driver his shift.
   */
  recordShiftOcrSample(input: {
    shiftId: string
    package: 'start' | 'end'
    kind: 'wallet' | 'odometer'
    source: 'ocr' | 'refused'
    stripPng: Uint8Array
  }): Promise<void>
  /**
   * Every sample of a kind, for the training export. Read-only and deliberately unjoined: the
   * ground truth is fetched separately from the owning row, so this table can never disagree with
   * the money.
   */
  listOcrSamples(kind: 'fee' | 'wallet' | 'odometer'): Promise<
    Array<{
      id: string
      kind: string
      shiftOrderId: string | null
      shiftId: string | null
      package: string | null
      source: 'ocr' | 'refused'
      stripPng: Uint8Array
    }>
  >
  /**
   * Update the mutable fields of an order that is already stored — the checkbox, the measured
   * wallet amount, the fee, the pay mode, the minute.
   *
   * The driver submits his whole list, and overlapping screenshots mean he submits rows the server
   * already holds. Without this every re-read was a 409 on `provider_order_no` (globally unique)
   * and an already-sent row could never be corrected at all; the only remedy was a manager adding
   * a compensating order. Identity — the shift and the order number — is never changed here.
   */
  update(order: ShiftOrderRecord, actorId: string | null): Promise<void>
  /**
   * Replace an order's route — «A» the pickup, «B» the dropoff.
   *
   * Separate from `update` because the route is a child table, and because it is written under a
   * different rule: `update` overwrites what a human may correct, while the route is BACKFILLED
   * only onto orders that have none. An order stored before the reader could read routes is the
   * case this exists for; a route a manager has already fixed must survive a re-read.
   */
  replacePoints(orderId: string, points: readonly OrderPointRecord[], actorId: string | null): Promise<void>
  listByShift(shiftId: string): Promise<ShiftOrderRecord[]>
  findByProviderNo(providerOrderNo: string): Promise<ShiftOrderRecord | null>
  delete(id: string, actorId: string | null): Promise<void>
}

export interface CashDeductionRepo {
  create(deduction: CashDeductionRecord, actorId: string | null): Promise<void>
  /** Mutable evidence/decision fields; id, shift and operation key remain the identity. */
  update(deduction: CashDeductionRecord, actorId: string | null): Promise<void>
  listByShift(shiftId: string): Promise<CashDeductionRecord[]>
  findByOperationKey(shiftId: string, operationKey: string): Promise<CashDeductionRecord | null>
  delete(id: string, actorId: string | null): Promise<void>
}

export interface OperationWindowReclassificationResult {
  orders: number
  cashDeductions: number
}

/**
 * A deliberately narrow mutation port: implementations derive both window edges and every result
 * from stored data. Callers can request a refresh for a shift, but cannot choose an inclusion.
 */
export interface OperationWindowRepo {
  reclassify(shiftId: string, actorId: string | null): Promise<OperationWindowReclassificationResult>
}

/** One driver operations submission, committed as a single all-or-nothing unit. */
export interface OperationBatch {
  orderCreates: readonly ShiftOrderRecord[]
  orderUpdates: readonly {
    record: ShiftOrderRecord
    /** Decision version read while constructing the batch; prevents overwriting a racing manager. */
    expectedDecidedAt: string | null
  }[]
  orderPointReplacements: readonly {
    orderId: string
    points: readonly OrderPointRecord[]
  }[]
  cashDeductionCreates: readonly CashDeductionRecord[]
  cashDeductionUpdates: readonly {
    record: CashDeductionRecord
    expectedDecidedAt: string | null
  }[]
  /**
   * A signed provider row has exactly one representation. Implementations enforce these intents
   * after locking the shift, including against an opposite-kind row that appeared concurrently.
   * A manager-reviewed opposite row makes the batch stale instead of being deleted.
   */
  legacyKindTransitions?: readonly {
    providerOrderNo: string
    targetKind: 'order' | 'cash_deduction'
    /** Opposite row observed while preparing the batch; NULL means none existed. */
    expectedOppositeId: string | null
    /** Optimistic manager-decision version. Driver sign flips only accept the undecided NULL state. */
    expectedOppositeDecidedAt: string | null
  }[]
  movements: readonly WalletMovementInput[]
}

export interface OperationBatchResult {
  insertedMovements: WalletMovementRecord[]
}

export interface OperationBatchRepo {
  /** No OCR samples, blobs, or network work belongs inside this transaction. */
  apply(
    shiftId: string,
    batch: OperationBatch,
    actorId: string | null,
  ): Promise<OperationBatchResult>
}

export interface WalletMovementRepo {
  listByShift(shiftId: string): Promise<WalletMovementRecord[]>
  /**
   * Merge a page of freshly-read movements into what the shift already holds.
   *
   * Two screenshots of one scrolling log overlap, so the same rows arrive twice and re-uploading a
   * page must add nothing. Implementations count what already exists per `(minute, amount)` and
   * insert only the SURPLUS, numbering it from there — so a second page contributes exactly its
   * genuinely new rows. Returns what was inserted.
   */
  merge(
    shiftId: string,
    movements: readonly WalletMovementInput[],
    actorId: string | null,
  ): Promise<WalletMovementRecord[]>
  /** Change what a movement IS, or whether it counts. Never its amount — that is what was read. */
  update(
    id: string,
    patch: { role?: WalletMovementRole; orderId?: string | null; included?: boolean; ambiguous?: boolean },
    actorId: string | null,
  ): Promise<void>
  deleteByShift(shiftId: string, actorId: string | null): Promise<void>
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
  /**
   * Every fund whose code starts with `prefix`, and its balance.
   *
   * «الترميم» needs Σ الذمم against each box, and receivables are per driver — `driver_receivable_cash:<id>`
   * — so there is no single code to ask for. Answered in ONE query rather than a lookup per driver,
   * because this runs on the evening screen with a manager waiting.
   */
  balancesByPrefix(branchId: string, prefix: string): Promise<Record<string, bigint>>
}

// ── «رأس مال المكتب» and «الترميم» (owner decision 10) ────────────────────────────────────

export interface OfficeCapitalTargetRepo {
  /**
   * The targets in force on a date, per box.
   *
   * MUST filter `status IN ('active','superseded')`, never 'active' alone: publishing a successor
   * would otherwise make every historical day resolve to nothing and silently restate the profit
   * of every ترميم already run. Same trap CLAUDE.md records for tier resolution.
   */
  resolve(branchId: string, businessDate: CalendarDate): Promise<Partial<Record<'office_cash' | 'office_wallet', Minor>>>
  upsert(row: {
    branchId: string
    fundCode: 'office_cash' | 'office_wallet'
    target: Minor
    effectiveFrom: CalendarDate
    createdBy: string
    note: string | null
  }): Promise<void>
}

export interface RestorationRecord {
  branchId: string
  businessDate: CalendarDate
  cashCountId: string
  plan: unknown
  /** SIGNED: positive is «كييش», negative is «شحن من الصندوق». */
  netToCompany: Minor
  reason: string
  performedBy: string
}

export interface RestorationRepo {
  /** Throws `{ code: 'DUPLICATE_RESTORATION' }` on a second run for the same branch and day. */
  create(row: RestorationRecord): Promise<void>
  find(branchId: string, businessDate: CalendarDate): Promise<RestorationRecord | null>
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
  /** Changes on every real slot replacement; preserved by an exact retry of the same attachment. */
  attachmentToken: string
  /** Server time at which these bytes were most recently attached to this slot. */
  attachedAtMs: number
  /** Shift containing an earlier attachment of these bytes; may equal this shift for another slot. */
  reusedFromShiftId: string | null
  staleAcknowledgedAtMs: number | null
  staleAcknowledgedBy: string | null
}

export interface MediaRepo {
  /** Content-addressed: an existing sha256 returns the stored record instead of duplicating. */
  put(record: MediaRecord): Promise<MediaRecord>
  findBySha(branchId: string, sha256: string): Promise<MediaRecord | null>
  findById(id: string): Promise<MediaRecord | null>
  /** One photo per (shift, package, slot): re-shooting replaces rather than accumulating. */
  attach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    mediaId: string,
    metadata: { actorId: string | null; attachedAtMs?: number; reusedFromShiftId?: string | null },
  ): Promise<void>
  /** An authorized uploader explicitly accepts a reused/old attachment after reviewing the warning. */
  acknowledgeStale(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    expectedMediaId: string,
    expectedAttachmentToken: string,
    acknowledgedBy: string,
    acknowledgedAtMs: number,
  ): Promise<void>
  /**
   * Unhook a photo from a slot. The `media` row and its bytes are NOT deleted.
   *
   * Deliberate: media is content-addressed and shared — the same photograph uploaded to two slots
   * is one row — so deleting the blob would blank a slot nobody asked about. What the driver means
   * by "remove this picture" is that this SLOT no longer holds it, and that is exactly what the
   * BR5 gate reads. The orphaned bytes are cheap and a retention job can sweep them.
   */
  detach(shiftId: string, pkg: EvidencePackage, slot: string, actorId: string | null): Promise<void>
  listSlots(shiftId: string): Promise<AttachedSlot[]>
}

export interface OcrReadRecord {
  id: string
  branchId: string
  shiftId: string | null
  field: OcrField
  /** Content address of the bytes SENT — not of the stored evidence, which is a smaller image. */
  sha256: string
  byteSize: number
  model: string
  result: OcrResult
  tokensIn: number
  tokensOut: number
  latencyMs: number
  createdAt: number
  createdBy: string
}

/**
 * Every cloud read, kept for three jobs at once: the dedupe cache, the per-shift cap, and the only
 * record of what this feature costs.
 *
 * The cache is not an optimisation. A driver who retakes the same screenshot, or a client that
 * retries after a timeout, would otherwise pay twice for bytes we have already read — and at three
 * cents a call with a hundred bikes that is the difference between a line item and a problem.
 *
 * `countBilled` deliberately counts ROWS, so a cache hit costs nothing against the cap. Capping
 * cache hits would punish a driver for the network being bad.
 */
export interface OcrReadRepo {
  findBySha(branchId: string, sha256: string, field: OcrField): Promise<OcrReadRecord | null>
  put(record: OcrReadRecord): Promise<OcrReadRecord>
  countBilledForShift(shiftId: string): Promise<number>
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
  /**
   * Remove a vehicle that was never used.
   *
   * Deliberately narrow. A bike that has carried a shift is referenced by rows the ledger and the
   * audit depend on — `shifts.vehicle_id` is NOT NULL with no cascade — so deleting it either fails
   * at the foreign key or, worse, would take money history with it. What a manager actually wants
   * when he says "delete" is one of two different things: get rid of a bike recorded by MISTAKE, or
   * take a real bike out of the fleet. The first is this; the second is `state = 'stopped'` /
   * `active = false`, which keeps the history intact and is what the caller is told to use.
   *
   * Throws `{ code: 'HAS_HISTORY' }` rather than letting a 23503 surface as an internal error.
   */
  deleteVehicle(id: string): Promise<void>

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
  /**
   * Remove a pack that was never read or swapped. Same rule, same reason as `deleteVehicle`: a pack
   * with readings is referenced by `shift_battery_readings` and `battery_swaps`, which are evidence.
   * A worn-out pack is `state = 'retired'`, not a hole in the history.
   */
  deleteBattery(id: string): Promise<void>

  createDocument(doc: DocumentRecord): Promise<void>
  listDocuments(owner: { driverId?: string; vehicleId?: string }): Promise<DocumentRecord[]>
  /** Everything expiring on or before `through`, for the morning alert sweep (س37). */
  listExpiringDocuments(branchId: string, through: CalendarDate): Promise<DocumentRecord[]>
}

/** Per-pack BMS readings for a shift (SRS §L seam, evidence for the BR5 gates). */
export interface BatteryReadingRepo {
  /**
   * Replaces the complete row for (shift, battery, package) — including `ocrRaw`. A re-upload
   * corrects rather than duplicates, and may clear an obsolete OCR baseline with `null`.
   */
  upsert(reading: BatteryReadingRecord): Promise<void>
  listByShift(shiftId: string): Promise<BatteryReadingRecord[]>
  /** Has this pack ever been read? Asked before a delete — a pack with readings is evidence. */
  existsForBattery(batteryId: string): Promise<boolean>
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, one row per swap per shift. */
export interface BatterySwapRepo {
  create(swap: BatterySwapRecord): Promise<void>
  /** Every swap on a shift, in the order they happened. Length + max seqNo drive the next seqNo. */
  listByShift(shiftId: string): Promise<BatterySwapRecord[]>
  /** Has this pack been on either side of a swap? Asked before a delete. */
  existsForBattery(batteryId: string): Promise<boolean>
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

/**
 * The repository slice available while a close boundary or approval transaction owns the shift.
 *
 * Keeping this list explicit prevents network/blob/notification work from accidentally being held
 * inside a database transaction. Every PostgreSQL implementation in this slice is rebound to the
 * same connection by `PgShiftCloseUnitOfWork`.
 */
export interface ShiftCloseTransactionDeps {
  shifts: ShiftRepo
  orders: OrderRepo
  cashDeductions: CashDeductionRepo
  operationWindows: OperationWindowRepo
  movements: WalletMovementRepo
  ledger: LedgerRepo
  decisions: ShiftDecisionRepo
  fx: FxRepo
  tiers: TierRepo
  directory: DirectoryRepo
  media: MediaRepo
  batteryReadings: BatteryReadingRepo
  batterySwaps: BatterySwapRepo
  weekLocks: WeekLockRepo
}

export interface ShiftCloseUnitOfWorkInput {
  shiftId: string
  actorId: string | null
  requestId?: string | null
  /** Serialize approvals that contribute to the same driver's day-level tier true-up. */
  serializeDriverDay?: boolean
}

export interface ShiftCloseUnitOfWork {
  run<T>(
    input: ShiftCloseUnitOfWorkInput,
    work: (deps: ShiftCloseTransactionDeps) => Promise<T>,
  ): Promise<T>
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
  /** Positive cash deductions read from the provider's operation history. */
  cashDeductions: CashDeductionRepo
  /** Deterministic, audited refresh of stored operation-window classifications. */
  operationWindows: OperationWindowRepo
  /** Atomic writer for one complete driver operations submission. */
  operationBatches: OperationBatchRepo
  /** «سجل المدفوعات» — what the wallet actually did, beside what the orders imply it should have. */
  movements: WalletMovementRepo
  ledger: LedgerRepo
  expenses: ExpenseRepo
  cashCounts: CashCountRepo
  /** «رأس مال المكتب» — the fixed target الترميم restores each box to. */
  capitalTargets: OfficeCapitalTargetRepo
  /** «الترميم» — one record per branch per working day. */
  restorations: RestorationRepo
  tiers: TierRepo
  notifications: NotificationRepo
  settings: SettingsRepo
  media: MediaRepo
  blobs: BlobStore
  /** The cloud reader. `available: false` when unconfigured — the driver's own reader takes over. */
  ocr: OcrReader
  /** What the cloud reader has already been asked, so the same pixels are never billed twice. */
  ocrReads: OcrReadRepo
  fx: FxRepo
  weekLocks: WeekLockRepo
  audit: AuditRepo
  directory: DirectoryRepo
  vehicleEvents: VehicleEventRepo
  attendance: AttendanceRepo
  decisions: ShiftDecisionRepo
  gps: GpsPingRepo
  /** Atomic close-boundary/review writer; callback work is database-only. */
  closeUnitOfWork: ShiftCloseUnitOfWork
}
