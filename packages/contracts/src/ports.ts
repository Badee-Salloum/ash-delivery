import type {
  CalendarDate,
  Currency,
  FxDay,
  LedgerEvent,
  Minor,
  OrderKind,
  PayMode,
  Posting,
  RoleKey,
  ShiftState,
  Scope,
  PermissionKey,
  RecurrenceKind,
} from '@ash/domain'
import type { CompanyLedgerRepo, CompanyLedgerSource, FinancialLocks } from './company-ledger.ts'
import type { CompanyFinanceRepo } from './company-finance.ts'

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
  /**
   * Minutes past branch-local midnight at which the business day rolls over — 240, i.e. 04:00.
   * A value for the same reason as the offset: entries already written must stay reproducible.
   */
  dayStartMinutes(): number
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
 * Why a read produced nothing. Distinct states, because each wants a different response.
 *
 * The same vocabulary `apps/driver/src/ocr.ts` already uses, and for the reason its header gives:
 * a missing asset, a dead worker, a timeout and a clean read that matched nothing all used to
 * return `null` alike, and the UI could say nothing more useful than "it didn't work".
 */
/**
 * `read_budget_exhausted` is deliberately its OWN reason and not `unavailable`.
 *
 * They mean opposite things to the driver. `unavailable` says the reader could not be reached and
 * the copy tells him to retry; a spent per-shift budget means retrying can never work, and the
 * client hides the retry button for it (`retryable: false`) — so the app told امجد عبدالله to do
 * the one thing it had just made impossible, at 01:35 on 2026-08-25, and his shift never closed.
 * The number he needed was typeable all along; only the message failed him.
 */
export type OcrFailure =
  | 'unavailable'
  | 'timeout'
  | 'no_fields'
  | 'refused'
  | 'wrong_screen'
  | 'read_budget_exhausted'

/**
 * AbortSignal's infrastructure-neutral surface. The contracts package deliberately has no DOM or
 * Node globals; the API passes the platform AbortSignal, which structurally satisfies this port.
 */
export interface OcrAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

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
  /** Literal clock glyphs before AM/PM normalization (for example `١٢:٣٠ ص`). */
  printedTime?: string | null
  value: string | null
  cancelled: boolean
  /** The readers disagreed on a financially destructive classification; keep this row visible. */
  reviewRequired?: boolean
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
  /** Optional deterministic screen geometry; absent readers remain valid. */
  rowIndex?: number
  rowCount?: number
  dateSection?: string | null
  yTop?: number | null
  yBottom?: number | null
}

export type OcrResult =
  | {
      ok: true
      /** Paid provider attempts represented by this cached result. Missing legacy values mean 1. */
      attemptCount?: number
      /** A readable shape with no authoritative monetary row may use the one explicit retry. */
      retryable?: boolean
      rows: OcrRow[]
      /** Labelled non-money values — odometer km, battery percent, cycle count. */
      fields: Readonly<Record<string, string | null>>
      /** The provider's answer verbatim, kept so the D-3 baseline stays reconstructible. */
      raw: unknown
    }
  | {
      ok: false
      /** Paid provider attempts represented by this cached result. Missing legacy values mean 1. */
      attemptCount?: number
      reason: OcrFailure
      /**
       * What the provider actually said, redacted and capped — never shown to a driver.
       *
       * `reason` is a vocabulary the UI can translate; this is the sentence an engineer needs at
       * 3 a.m. It rides into `ocr_reads.result` jsonb with no migration, so a failure is still
       * legible days later. Its most important job is distinguishing a completion truncated by its
       * token ceiling from a screen that genuinely had nothing on it: both are `no_fields`.
       */
      detail?: string
    }

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
  /** Includes model/config plus the field-specific prompt and validation versions. */
  cacheSignature(field: OcrField): string
  read(request: {
    field: OcrField
    bytes: Uint8Array
    mimeType: string
    /**
     * The API's request-lifecycle ceiling. Adapters still own their provider-specific timeout,
     * but must also stop network work when the caller can no longer wait for the result.
     */
    signal?: OcrAbortSignal
  }): Promise<OcrReading>
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
  /**
   * Where the branch is, for «التفقّد». Null until someone sets it — a branch with no fence has no
   * check-in to fail, rather than every round failing against a default point in the ocean.
   */
  lat: number | null
  lng: number | null
  checkinRadiusM: number
  /**
   * `branch` for an operating branch. `company` for the ONE HQ row that holds the company ledger
   * («صندوق الشركة», USD and SYP — migration 0066). Immutable. The HQ row is never listed as a branch,
   * never created or edited through the branch screens, and never addressable by a branch permission.
   */
  kind: BranchKind
}

export type BranchKind = 'branch' | 'company'

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
  /** Driver evidence was unavailable/incomplete; the manager now owes the reading. */
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

export interface DriverAccountProvisionInput {
  user: UserRecord
  driver: DriverRecord
  /** Public registration creates a session; the admin account screen does not. */
  session: SessionRecord | null
  audit: {
    actorId: string | null
    actorKind: 'user' | 'anonymous'
    requestId: string
    occurredAtMs: number
  }
}

export type RegistrationAttemptClaim =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

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
  /** Wallet shift-funding consumed automatically at open without charging office_wallet twice. */
  carriedWalletTranches?: Minor[]
  /** Legacy projection: cash retained as funding auto-consumed when this driver opens his next shift. */
  /**
   * «الحسم» pending on this shift: a positive charge against the employee's close settlement.
   *
   * Lives here rather than in `shift_settlements` because it is set DURING review, before any
   * snapshot exists. It is frozen into the settlement at approval like every other close figure.
   */
  managerCharge: Minor
  /** Audited reason for the pending charge. Required by the database whenever the amount is non-zero. */
  managerChargeReason: string | null
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
  /**
   * Lower bound of the operation window — the driver's confirmation, not the manager's approval.
   *
   * Separate from `openApprovedAt` because the two answer different questions. `openApprovedAt` is
   * an audit fact about WHO authorised the shift and WHEN, and it must never move. This is the
   * instant from which the driver's deliveries count, and the owner moved it on 2026-08-31 because
   * the approval routinely arrived hours after the driver had started working.
   *
   * A settled shift keeps the bound it was judged by, so the amendment cannot reach backwards.
   */
  windowOpensAt: string | null
  /** Manager who approved the initial open. Never replaced by resume/review decisions. */
  openApprovedBy: string | null
  /** Driver's most recent close-package submission instant. */
  submittedAt: string | null
  equationDiff: Minor | null
  cashDiff: Minor | null
  walletDiff: Minor | null
  ordersHash: string | null
  approvedBy: string | null
  /**
   * When the close was approved.
   *
   * The column has existed since migration 0005 and no code path ever wrote it — `approved_by` was
   * set on all 112 approved production shifts and `approved_at` on none of them, because the field
   * was missing from this record and so the UPDATE below could not carry it. Anything that needed
   * the instant had to reach for `shift_settlements.confirmed_at` instead.
   *
   * Rows approved before this fix stay null; they are not backfilled, because the settlement
   * snapshot already holds their true confirmation instant and inventing one here would be worse
   * than an honest gap.
   */
  approvedAt: string | null
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
  /** Additive provenance for conservative operation-window inference. */
  windowBasis?: OperationWindowBasis | null
  positionEvidence?: CloseDraftPositionEvidence | null
  observationId?: string | null
  closeDraftReviewReasons?: CloseDraftReviewReason[]
  /** Stable server draft identity; null on operations predating durable close drafts. */
  closeDraftClientKey?: string | null
  /**
   * A manager declared that this row is not a delivery at all — a reading of something that never
   * happened, not a real job left uncounted.
   *
   * DISTINCT from `included: false`, which is an accounting decision about a delivery that did
   * happen. The database forces a removed row to also be excluded, so no money path had to learn a
   * second rule; what removal adds is the MEANING and the report to the general manager. Set and
   * cleared together with `removedBy` and `removalReason`, all three or none.
   */
  removedAt?: string | null
  removedBy?: string | null
  removalReason?: string | null
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

/** The evidence that justified an operation's window classification. */
export type OperationWindowBasis = 'printed_time' | 'screen_position' | 'manager'

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
  windowBasis?: OperationWindowBasis | null
  positionEvidence?: CloseDraftPositionEvidence | null
  observationId?: string | null
  closeDraftReviewReasons?: CloseDraftReviewReason[]
  closeDraftClientKey?: string | null
  /** Same meaning as on an order: read as something that never happened. See `ShiftOrderRecord`. */
  removedAt?: string | null
  removedBy?: string | null
  removalReason?: string | null
}

/**
 * One append-only entry in the register the system admin reads.
 *
 * Denormalised on purpose. The screen answers «what was removed, from whose shift, for how much»
 * without joining four tables, and it must keep answering after a shift is voided and its rows are
 * gone — a register that dies with the thing it records is not a register.
 */
export interface OperationRemovalRecord {
  id: string
  kind: 'removed' | 'restored'
  operationKind: 'order' | 'cash_deduction'
  operationId: string
  /** The provider order number, or the deduction id — whichever a human would recognise. */
  operationRef: string
  shiftId: string
  branchId: string
  businessDate: string
  driverId: string | null
  amount: Minor
  reason: string
  evidenceSlot: string | null
  evidenceMediaId: string | null
  actedBy: string
  actedAtMs: number
}

export interface OperationRemovalRepo {
  append(entry: Omit<OperationRemovalRecord, 'id' | 'actedAtMs'> & { actedAtMs: number }): Promise<OperationRemovalRecord>
  /** Newest first. `branchId` narrows to one branch; omitted means every branch. */
  list(filter: { branchId?: string | undefined; limit: number }): Promise<OperationRemovalRecord[]>
}

/** What a captured payment-log movement appears to be; retained for archival review/matching. */
export type WalletMovementRole = 'yalago_cut' | 'order_credit' | 'unmatched'

/**
 * One archival row of «سجل المدفوعات». It is preserved for evidence, OCR training and
 * manager inspection, but does not change BR1, order totals, tiers, shares or ledger postings.
 * Roles remain useful metadata for a future reconciliation workflow without asserting money now.
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
  /**
   * The SYP-minor-per-USD rate frozen on an entry with a USD line (0066), and `null` on every other
   * entry — every branch entry among them. Never re-read from `fx_days`, which is corrected in place.
   */
  sypMinorPerUsd: bigint | null
  weekLockId: number | null
  reason: string | null
  createdBy: string
  /** Actual database insertion instant, distinct from the accounting business date. */
  createdAtMs: number
  /** `currency` is the FUND's — a line has no currency of its own (0066). */
  lines: Array<{ fundCode: string; side: 'D' | 'C'; amount: Minor; currency: Currency; role?: string }>
}

export type TreasuryMovementChannel = 'cash' | 'wallet'
export type TreasuryMovementFlow = 'in' | 'out' | 'internal'

export interface TreasuryMovementFilter {
  from: CalendarDate
  to: CalendarDate
  eventType?: LedgerEvent
  channel?: TreasuryMovementChannel
  flow?: TreasuryMovementFlow
  actorId?: string
  query?: string
  beforeId?: number
  limit: number
}

export interface TreasuryMovementPage {
  entries: JournalEntryRecord[]
  nextBeforeId: number | null
  /** Facets are range-scoped but deliberately ignore the other active filters. */
  eventTypes: LedgerEvent[]
  actorIds: string[]
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

/** Atomic driver identity creation plus the database-backed public registration throttle. */
export interface DriverAccountProvisioningRepo {
  claimRegistrationAttempt(input: {
    addressHash: string
    attemptedAtMs: number
    limit: number
    windowMs: number
  }): Promise<RegistrationAttemptClaim>
  provision(input: DriverAccountProvisionInput): Promise<void>
}

export type ShiftBreakEndReason = 'driver_resumed' | 'manager_suspended' | 'manager_voided' | 'manager_force_closed'

/** One pause within an operational shift. Milliseconds use the server clock. */
export interface ShiftBreakRecord {
  id: string
  shiftId: string
  startedAtMs: number
  endedAtMs: number | null
  endReason: ShiftBreakEndReason | null
  /** Global allowance captured when this break began. */
  limitMinutes: number
  /** Completed pauses before this one; makes later setting changes non-retroactive. */
  consumedBeforeMs: number
  /** Stored on end; active rows are projected with the current server time. */
  overLimitMs: number
}

export interface ShiftBreakRepo {
  findById(id: string): Promise<ShiftBreakRecord | null>
  listByShift(shiftId: string): Promise<ShiftBreakRecord[]>
  listByShiftIds(shiftIds: readonly string[]): Promise<ShiftBreakRecord[]>
  create(record: ShiftBreakRecord, actorId: string): Promise<void>
  end(id: string, endedAtMs: number, reason: ShiftBreakEndReason, overLimitMs: number, actorId: string): Promise<void>
}

export interface ShiftRepo {
  create(shift: ShiftRecord, actorId: string | null): Promise<void>
  findById(id: string): Promise<ShiftRecord | null>
  /** `actorId` is the current mutation actor, never inferred from an earlier approval. */
  update(shift: ShiftRecord, actorId: string | null): Promise<void>
  /**
   * Distinct drivers and vehicles that are working right now in one branch.
   *
   * This deliberately means exactly `open`: a suspended shift still occupies its assignment but
   * is not currently working, and draft/review/terminal states are excluded. The query is
   * date-independent so an overnight shift remains visible until its end package is submitted.
   */
  countOpenActorsForBranch(branchId: string): Promise<{ drivers: number; vehicles: number }>
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
  /** Full vehicle timeline rows, branch-scoped and ordered oldest first (P6). */
  listByVehicle(branchId: string, vehicleId: string, from: CalendarDate, to: CalendarDate): Promise<ShiftRecord[]>
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
  /**
   * P2 — every shift of the branch with `business_date` in the inclusive range, EVERY state,
   * reduced to its timing and odometer. What the shifts summary judges patterns from: loading
   * whole `ShiftRecord`s (tranches, media) for a year of shifts would be most of the cost.
   * Ordered by business date, then shift number, then id.
   */
  listTimingBetween(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ShiftTimingRecord[]>
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

/**
 * One manager authorization for one driver on one custom business date.
 *
 * The time window is represented as minutes after local midnight. Both ends are inclusive: a
 * driver confirming at exactly 08:00 or 10:00 matches an 08:00â€“10:00 rule. Money is the ordinary
 * opening cash float / wallet top-up and therefore uses the same bigint-minor representation as a
 * manual open approval.
 *
 * Rules are immutable once created. `active = false` revokes an unused rule; consumption records
 * the shift that exercised the advance approval instead of deleting the authorization evidence.
 */
export interface PreapprovedShiftRuleRecord {
  id: string
  branchId: string
  driverId: string
  businessDate: CalendarDate
  windowStartMinute: number
  windowEndMinute: number
  cashFloat: Minor
  walletTopup: Minor
  active: boolean
  authorizedBy: string
  /** Authorization identity is snapshotted when the rule is signed. */
  authorizedByRole: RoleKey
  authorizedByBranchId: string | null
  createdAtMs: number
  consumedByShiftId: string | null
  consumedAtMs: number | null
}

export interface PreapprovedShiftRuleRepo {
  /** All dates in one manager command commit together or not at all. */
  createMany(rules: readonly PreapprovedShiftRuleRecord[]): Promise<void>
  listByBranch(branchId: string): Promise<PreapprovedShiftRuleRecord[]>
  findById(id: string): Promise<PreapprovedShiftRuleRecord | null>
  /**
   * Read the matching authorization without consuming it so the service can run every manager gate
   * before money moves. Active, unconsumed overlapping rules are forbidden at storage time.
   */
  findMatching(input: {
    branchId: string
    driverId: string
    businessDate: CalendarDate
    localMinute: number
  }): Promise<PreapprovedShiftRuleRecord | null>
  /** Atomically consume this still-active rule for this shift; null means it was revoked or won. */
  consume(id: string, shiftId: string, consumedAtMs: number): Promise<PreapprovedShiftRuleRecord | null>
  /** Revoke an unused rule. A consumed authorization is immutable and returns null. */
  deactivate(id: string, actorId: string): Promise<PreapprovedShiftRuleRecord | null>
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
  /** Resolve a reporting batch in one read; rows remain grouped by their `shiftId`. */
  listByShiftIds(shiftIds: readonly string[]): Promise<ShiftOrderRecord[]>
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
  /** Server-only capability for atomically materializing one exact durable close draft. */
  closeDraftMaterialization?: {
    revision: number
    draftHash: string
  }
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
   * Remove an OCR edge-card duplicate while keeping the richer sighting.
   *
   * The complete expected row is an optimistic version. A deletion is valid only while every
   * accounting, evidence, ownership and decision field still matches what the service inspected;
   * otherwise the whole batch is stale. This is deliberately narrower than a generic deduction
   * delete: ordinary money rows remain permanent evidence and manager-reviewed rows can never be
   * healed away by a late driver submission.
   */
  cashDeductionDeletes?: readonly {
    expected: CashDeductionRecord
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
      /**
       * The rate frozen on the entry. REQUIRED, and `null` for everything that is not a USD company
       * entry, so no caller can forget to decide. The database refuses a USD line without it and a
       * rate without a USD line (0066); the memory adapter mirrors both.
       */
      sypMinorPerUsd: bigint | null
      createdBy: string
      reason?: string
    },
  ): Promise<JournalEntryRecord[]>
  listByShift(shiftId: string): Promise<JournalEntryRecord[]>
  listByWeek(branchId: string, weekStartDate: CalendarDate): Promise<JournalEntryRecord[]>
  /** Signed movements touching either office box, newest first and cursor-paged. */
  listTreasuryMovements(branchId: string, filter: TreasuryMovementFilter): Promise<TreasuryMovementPage>
  /**
   * The one shift-less entry stored under `(branchId, eventType, occurrenceKey)`, or null.
   *
   * `post()` answers a replay with an empty array and nothing else, which is right for a retry and
   * useless to a command that must tell «the same request again» (200, the original receipt) from
   * «this key with different money» (409). A command whose only record IS its journal entry —
   * صندوق الشركة, a treasury deposit — reads the receipt through this. Same key the idempotency
   * index uses (0017), so there is at most one row to find.
   */
  findStandaloneEntry(
    branchId: string,
    eventType: JournalEntryRecord['eventType'],
    occurrenceKey: string,
  ): Promise<JournalEntryRecord | null>
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

/**
 * One statement-snapshot of the branch assets that make up working capital.
 *
 * `office*` and `receivables*` are the position the nightly restoration already uses. Active
 * custody is deliberately separate: it is cash/wallet that left those office funds when a shift
 * opened but is still company capital while the driver holds it. Only a shift with the immutable
 * open marker and a financially-live state contributes custody.
 */
export interface TreasuryPositionRecord {
  officeCash: Minor
  officeWallet: Minor
  receivablesCash: Minor
  receivablesWallet: Minor
  /**
   * Σ السلف outstanding against each box (owner decision 17).
   *
   * Its own pair rather than folded into `receivables*`, because the Treasury screen labels
   * `receivables` «الذمم» and a manager reading an advance as driver debt is a lie the numbers
   * would never reveal. Counted as capital for the same reason a ذمة is: the money is still the
   * company's, it is simply not in the drawer tonight.
   */
  advancesCash: Minor
  advancesWallet: Minor
  activeCustodyCash: Minor
  activeCustodyWallet: Minor
  activeShiftCount: number
  /** Preserve the existing per-fund receivable integrity check inside the atomic read. */
  negativeReceivableFundCode: string | null
}

/** Cross-table read model: funds/journal lines and financially-open shifts in one snapshot. */
export interface TreasuryPositionSource {
  readCurrent(branchId: string): Promise<TreasuryPositionRecord>
}

// ── P2: the range read model behind the time filter ───────────────────────────────────────
//
// `/dashboard/profit` and `/dashboard/treasury` used to walk the ledger one financial week at a
// time (up to 520 reads for a ten-year window) and total the lines in the route. This port
// answers the same question with ONE aggregate between two business dates. The route still owns
// the go-live clamp and the profit classification (`classifyProfitLine`); the source owns only
// what needs the database: the grouped lines, the driver share, and the company-fund flows.

/** The widest range the source is ever asked for — ten years and change. A route answers 400 above it. */
export const LEDGER_RANGE_MAX_DAYS = 3653

/**
 * One aggregated group of journal lines. Only the funds `isRangeReportLine` keeps are present,
 * in `compareLedgerRangeLines` order, so both adapters return identical arrays.
 */
export interface LedgerRangeLine {
  businessDate: CalendarDate
  eventType: Posting['eventType']
  fundCode: string
  role: string | null
  side: 'D' | 'C'
  /**
   * `funds.currency` — every branch fund is `SYP_NEW` today. Carried as a grouping dimension so a
   * multi-currency ledger (the HQ company fund, C1/C6) can reuse this shape without a second
   * aggregate; frozen FX rates belong to that ledger's own entries, not to this read.
   */
  currency: string
  /** Σ amount of the group, positive, minor units. */
  amount: Minor
  /** How many journal lines the group summarises. */
  lineCount: number
}

/** «كييش» (`kaish`) and «شحن من الصندوق» (`shahn`) per business date, signed as the treasury sheet shows them. */
export interface LedgerRangeTreasuryDay {
  businessDate: CalendarDate
  kaish: Minor
  shahn: Minor
}

export interface LedgerRangeRecord {
  from: CalendarDate
  to: CalendarDate
  lines: LedgerRangeLine[]
  /**
   * Σ `shift_settlements.base_driver_share` over every shift with ANY journal entry in the range —
   * the net earned share after cash deductions, before the closing variance. Exactly the set the
   * week-walking profit route summed.
   */
  settledDriverShare: Minor
  /**
   * The legacy fallback, as `/dashboard/profit` always read it: shift-less legacy share lines plus,
   * for each touched shift WITHOUT a settlement, its in-range `share_split`/deduction lines.
   */
  legacyDriverShare: Minor
  /** Company-fund flows classified by `treasuryRoleOf`, oldest first; a day appears once it has one. */
  treasuryDays: LedgerRangeTreasuryDay[]
}

export interface LedgerRangeSource {
  /** Inclusive business-date range, `from <= to`, at most `LEDGER_RANGE_MAX_DAYS` days. */
  readRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<LedgerRangeRecord>
  /** The earliest `business_date` any journal entry of the branch carries, or null for an empty ledger. */
  firstActivityDate(branchId: string): Promise<CalendarDate | null>
}

/**
 * Just enough of a shift to judge WHEN it ran and on what — no tranches, no media, no money.
 *
 * `windowOpensAt` already applies the fallback the rest of the system uses (the manager's open
 * approval for a shift opened before `window_opens_at` existed).
 */
export interface ShiftTimingRecord {
  id: string
  branchId: string
  driverId: string
  vehicleId: string
  shiftNo: number
  businessDate: CalendarDate
  state: ShiftState
  windowOpensAt: string | null
  submittedAt: string | null
  odoStart: number | null
  odoEnd: number | null
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
  /**
   * Historical schema-v2 restorations are backed by an immutable sealed cash count. Schema v3
   * snapshots the live office ledger instead, so it deliberately has no cash-count identity.
   * The plan's schemaVersion is the durable discriminator; keeping this nullable lets old facts
   * remain readable without inventing evidence for new ledger-backed restorations.
   */
  cashCountId: string | null
  plan: unknown
  /** SIGNED: positive is «كييش», negative is «شحن من الصندوق». */
  netToCompany: Minor
  reason: string
  performedBy: string
  /**
   * Which run of that business day this was, from 1.
   *
   * الترميم used to be once a day, and the owner asked for it «متاح دوما» after finding the button
   * gone at 02:27 — the business day starts at 04:00, so he was still inside a day already restored
   * that morning while a full day's takings sat in the boxes. The run number is what keeps each
   * run's ledger occurrence key distinct, so repetition can never become double posting.
   */
  runNo: number
}

export interface RestorationRepo {
  /**
   * Throws `{ code: 'DUPLICATE_RESTORATION' }` when that run number is already taken. Returns the
   * row's id — the company mirror of each of the run's journals names it (C2).
   */
  create(row: RestorationRecord): Promise<number>
  /** The LATEST run of that day, or null. Callers wanting the count use `runsOnDay`. */
  find(branchId: string, businessDate: CalendarDate): Promise<RestorationRecord | null>
  /** How many runs that business date already holds. The next run is this plus one. */
  runsOnDay(branchId: string, businessDate: CalendarDate): Promise<number>
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
    metadata: {
      actorId: string | null
      attachedAtMs?: number
      reusedFromShiftId?: string | null
      expectedAttachmentToken?: string | null
    },
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
  detach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    actorId: string | null,
    expectedAttachmentToken?: string,
  ): Promise<void>
  listSlots(shiftId: string): Promise<AttachedSlot[]>
  /** Append-only attachment generations, newest first. */
  listAttachmentHistory(shiftId: string): Promise<AttachmentHistoryRecord[]>
  /** `lock` is used only inside an existing UOW and serializes the media's attachment history. */
  latestAttachmentForMedia(
    mediaId: string,
    options?: { lock?: boolean },
  ): Promise<AttachmentHistoryRecord | null>
  /** Re-attach historical immutable bytes as a new generation after optimistic checks. */
  restoreAttachment(input: {
    shiftId: string
    historyId: string
    expectedCurrentAttachmentToken: string | null
    actorId: string
    reason: string
    attachedAtMs: number
  }): Promise<AttachedSlot>
}

export interface AttachmentHistoryRecord {
  id: string
  shiftId: string
  package: EvidencePackage
  slot: string
  mediaId: string
  attachmentToken: string
  attachedAtMs: number
  reusedFromShiftId: string | null
}

export type CloseDraftReadStatus = 'idle' | 'running' | 'complete' | 'failed'

export interface CloseDraftReadRecord {
  readId: string
  status: CloseDraftReadStatus
  field: OcrField
  failure: OcrFailure | null
  attempts: number
  /** Orders-page diagnostics: source rows and the accounting rows they produced. */
  rowCount?: number
  ordersCount?: number
  deductionsCount?: number
  cancelledCount?: number
}

export interface CloseDraftAttachment {
  package: 'end'
  slot: string
  mediaId: string
  attachmentToken: string
  attachedAtMs: number
  attachedAt: string
  read: CloseDraftReadRecord | null
}

export interface CloseDraftObservationSource {
  mediaId: string
  attachmentToken: string
  slot: string
}

export interface CloseDraftPositionEvidence {
  /** Zero-based top-to-bottom row ordinal within exactly one screenshot. */
  rowIndex: number
  rowCount: number
  /** Normalized 0..1 vertical bounds produced by deterministic image geometry. */
  yTop: number | null
  yBottom: number | null
  /** Inclusive local date+minute bound (`YYYY-MM-DD HH:MM`), never a fabricated exact clock. */
  lowerInstant: string | null
  upperInstant: string | null
  anchorObservationIds: string[]
}

export interface CloseDraftSighting {
  kind: 'order' | 'cash_deduction' | 'movement'
  readId: string
  observationId: string
  rowIndex: number
  dateSection: string | null
  evidence: CloseDraftObservationSource
  /** Normalized immutable result for this one page; used when another page generation is removed. */
  value: string | null
  /** Literal clock printed on the screenshot. AM/PM is retained; matching normalizes it separately. */
  printedTime?: string | null
  occurredMinute: string | null
  occurredDate: string | null
  included: boolean
  reviewReasons: CloseDraftReviewReason[]
  pointA: string | null
  pointB: string | null
  windowBasis: OperationWindowBasis | null
  position: CloseDraftPositionEvidence | null
}

export type CloseDraftReviewReason =
  | 'missing_money'
  | 'missing_time'
  | 'reader_conflict'
  | 'time_conflict'
  | 'cancelled_conflict'
  | 'human_time_edit'
  | 'human_money_edit'
  | 'evidence_removed'

export interface CloseDraftOrder {
  clientKey: string
  /** Server-only overlap key; null for human-created rows. */
  matchKey: string | null
  /**
   * The same identity in the shape it had before it was canonicalised, carried on freshly scanned
   * rows only. It exists so a retake of a draft saved before that change still merges rather than
   * duplicating; nothing stored needs migrating, and it can be dropped once no such draft is open.
   */
  legacyMatchKey?: string | null
  providerOrderNo: string
  payMode: PayMode
  fee: string | null
  feeOcr: string | null
  feeRefused: boolean
  reviewRequired: boolean
  reviewReasons: CloseDraftReviewReason[]
  included: boolean
  occurredMinute: string | null
  occurredDate: string | null
  pointA: string | null
  pointB: string | null
  source: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId: string | null
  observationId: string | null
  rowIndex: number | null
  dateSection: string | null
  evidence: CloseDraftObservationSource | null
  windowBasis: OperationWindowBasis | null
  position: CloseDraftPositionEvidence | null
  /** Every active page that independently supports this canonical operation. */
  sightings: CloseDraftSighting[]
}

export interface CloseDraftCashDeduction {
  clientKey: string
  matchKey: string | null
  /** The pre-canonicalisation shape of the same identity; see `CloseDraftOrder`. */
  legacyMatchKey?: string | null
  operationKey: string
  amount: string | null
  amountOcr: string | null
  reviewRequired: boolean
  reviewReasons: CloseDraftReviewReason[]
  included: boolean
  occurredMinute: string | null
  occurredDate: string | null
  pointA: string | null
  pointB: string | null
  source: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId: string | null
  observationId: string | null
  rowIndex: number | null
  dateSection: string | null
  evidence: CloseDraftObservationSource | null
  windowBasis: OperationWindowBasis | null
  position: CloseDraftPositionEvidence | null
  sightings: CloseDraftSighting[]
}

export interface CloseDraftMovement {
  clientKey: string
  matchKey: string | null
  /** The pre-canonicalisation shape of the same identity; see `CloseDraftOrder`. */
  legacyMatchKey?: string | null
  amount: string
  occurredMinute: string | null
  role: WalletMovementRole
  providerOrderNo: string | null
  ambiguous: boolean
  included: boolean
  notes: string | null
  source: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId: string | null
  observationId: string | null
  rowIndex: number | null
  dateSection: string | null
  evidence: CloseDraftObservationSource | null
  sightings: CloseDraftSighting[]
}

export interface CloseDraftFigures {
  odometerKm: number | null
  odometerKmOcr: number | null
  odometerAnomalyConfirmed: boolean
  batteryPercent: number | null
  cashDeclared: string | null
  walletDeclared: string | null
  walletDeclaredOcr: string | null
}

export interface CloseDraftData {
  figures: CloseDraftFigures
  operations: {
    orders: CloseDraftOrder[]
    cashDeductions: CloseDraftCashDeduction[]
    movements: CloseDraftMovement[]
  }
  /** Latest read per current attachment token; old generations remain in attachment history. */
  reads: Record<string, CloseDraftReadRecord>
  /** Current evidence generations included in the draft hash; keyed by end-package slot. */
  evidence: Record<string, { mediaId: string; attachmentToken: string; attachedAtMs: number }>
}

export interface CloseDraftRecord {
  shiftId: string
  revision: number
  draftHash: string
  data: CloseDraftData
  updatedAtMs: number
  updatedBy: string
  submittedAtMs: number | null
}

export interface CloseDraftView {
  shiftId: string
  revision: number
  draftHash: string
  updatedAt: string
  submittedAt: string | null
  restored: boolean
  figures: CloseDraftFigures
  attachments: CloseDraftAttachment[]
  operations: CloseDraftData['operations']
}

export interface CloseDraftRepo {
  findByShift(shiftId: string): Promise<CloseDraftRecord | null>
  /** Create revision 0, or return the row another request created first. */
  getOrCreate(input: Omit<CloseDraftRecord, 'revision'>): Promise<CloseDraftRecord>
  /** Compare-and-swap. Null means the expected revision/hash was stale. */
  update(input: {
    shiftId: string
    expectedRevision: number
    data: CloseDraftData
    draftHash: string
    updatedAtMs: number
    updatedBy: string
  }): Promise<CloseDraftRecord | null>
  /** Called only inside the close UOW; exact retries return the already-submitted row. */
  markSubmitted(input: {
    shiftId: string
    expectedRevision: number
    expectedDraftHash: string
    submittedAtMs: number
    updatedBy: string
  }): Promise<CloseDraftRecord | null>
  /** Re-open the same immutable content after an audited manager rejection/rephoto transition. */
  reopen(input: {
    shiftId: string
    updatedAtMs: number
    updatedBy: string
  }): Promise<CloseDraftRecord | null>
  /** Atomically verifies the live attachment, appends one immutable read/observation set and CASes the draft. */
  saveRead(input: {
    shiftId: string
    expectedRevision: number
    mediaId: string
    attachmentToken: string
    slot: string
    read: CloseDraftReadRecord
    /**
     * The caller explicitly asked to re-read an attachment that already read to completion — a
     * reader/prompt upgrade, not the accidental repeat the idempotency rule exists to absorb.
     * Without it, a second complete read for the same page is refused.
     */
    replacesCompletedRead?: boolean
    observations: Array<{
      id: string
      rowIndex: number
      rowCount: number
      dateSection: string | null
      yTop: number | null
      yBottom: number | null
      row: OcrRow
    }>
    data: CloseDraftData
    draftHash: string
    updatedAtMs: number
    updatedBy: string
  }): Promise<CloseDraftRecord | null>
  /**
   * Every immutable row sighting for one shift, ordered by `(attachmentToken, rowIndex)`.
   *
   * Read-only: this is the provenance the manager review reads to spot two scans of one list that
   * overlap. It never feeds money — orders and deductions keep their own canonical rows.
   */
  listObservationsByShift(shiftId: string): Promise<CloseDraftObservationRecord[]>
}

/** One scanned row exactly as a reader saw it, bound to the page generation it came from. */
export interface CloseDraftObservationRecord {
  id: string
  readId: string
  shiftId: string
  mediaId: string
  /** The evidence generation. A retaken photo rotates it, so rows never merge across retakes. */
  attachmentToken: string
  slot: string
  field: OcrField
  rowIndex: number
  rowCount: number
  dateSection: string | null
  yTop: number | null
  yBottom: number | null
  row: OcrRow
  createdAtMs: number
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
  /** Versioned reader identity; old prompt/validation results never satisfy a new signature. */
  cacheSignature: string
  state: 'running' | 'complete'
  result: OcrResult
  /** Present only while one process owns the paid logical OCR attempt. */
  reservationId: string | null
  reservedAt: number | null
  reservedAttempt: 1 | 2 | null
  /** The shift charged for attempt two; attempt one is owned by `shiftId`. */
  retryShiftId: string | null
  retryCreatedAt: number | null
  retryCreatedBy: string | null
  tokensIn: number
  tokensOut: number
  latencyMs: number
  createdAt: number
  createdBy: string
}

export interface OcrReadClaimInput {
  id: string
  branchId: string
  requestingShiftId: string
  field: OcrField
  sha256: string
  byteSize: number
  model: string
  cacheSignature: string
  createdAt: number
  createdBy: string
  reservationId: string
  nowMs: number
  leaseMs: number
  retryFailed: boolean
  /** Zero disables the cap. */
  maxReadsPerShift: number
}

export type OcrReadClaim =
  | { kind: 'call'; record: OcrReadRecord; attempt: 1 | 2; used: number }
  | { kind: 'cached'; record: OcrReadRecord; used: number }
  /** Remaining lease duration calculated by the repository's authoritative clock. */
  | { kind: 'running'; record: OcrReadRecord; used: number; leaseRemainingMs: number }
  | { kind: 'capped'; record: OcrReadRecord | null; used: number }

export interface OcrReadCompletion {
  branchId: string
  field: OcrField
  sha256: string
  cacheSignature: string
  reservationId: string
  result: OcrResult
  usage: { tokensIn: number; tokensOut: number; latencyMs: number }
}

/**
 * Every cloud read, kept for three jobs at once: the dedupe cache, the per-shift cap, and the only
 * record of what this feature costs.
 *
 * The cache is not an optimisation. A driver who retakes the same screenshot, or a client that
 * retries after a timeout, would otherwise pay twice for bytes we have already read — and at three
 * cents a call with a hundred bikes that is the difference between a line item and a problem.
 *
 * `countBilledForShift` counts the attempts represented by each row. A normal cache hit costs
 * nothing, while the one explicitly requested retry of a failed read counts as a second attempt.
 */
export interface OcrReadRepo {
  findBySha(branchId: string, sha256: string, field: OcrField, cacheSignature: string): Promise<OcrReadRecord | null>
  /** Atomically returns cache/running/cap, or reserves exactly one paid logical OCR attempt. */
  claimReadAttempt(input: OcrReadClaimInput): Promise<OcrReadClaim>
  /** Completes only the matching live reservation and atomically aggregates its telemetry. */
  completeReadAttempt(input: OcrReadCompletion): Promise<OcrReadRecord | null>
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
  /**
   * WHICH BOX paid — a physical fact, never a ledger fund.
   *
   * Every row predating migration 0059 is `office_cash` by construction: the recipe could credit
   * nothing else.
   */
  channel: 'office_cash' | 'office_wallet'
  amount: Minor
  businessDate: CalendarDate
  description: string
  /** Required above the configured ceiling (G-3 / س52). */
  receiptMediaId: string | null
  journalEntryId: number | null
  /**
   * Set only when this expense is a «سلفة» finally recognised as spent (owner decision 17).
   *
   * Such a row is an expense with NO same-day cash outflow — the money left the box weeks ago — so
   * it has to be able to say so to anyone reconciling today's expenses against today's office
   * credits. A partial unique index also makes a SECOND conversion of one advance impossible in
   * the schema rather than only in a route check.
   */
  advanceId: string | null
  createdBy: string
}

// ── «المدخول المباشر» — direct income (owner request, 2026-08-28) ────────────────────────────
//
// The mirror of an expense: money arriving at the branch that is not a delivery fee. Kept as its
// own entity rather than a signed expense, because SRS G defines an expense as «كل ليرة تخرج» and
// generalising that would make «الصرفيات» correct only while every reader remembers to filter.

export interface IncomeCategoryRecord {
  id: string
  code: string
  nameAr: string
  active: boolean
}

export interface IncomeRecord {
  id: string
  branchId: string
  categoryId: string
  /**
   * WHICH BOX received the money — a physical fact, not a ledger fund.
   *
   * The operator never names a fund: `fundRefFromCode`'s default clause turns any unrecognised
   * string into `cost_center:<code>`, a look-alike account no profit reader sums and no error is
   * raised about.
   */
  channel: 'office_cash' | 'office_wallet'
  amount: Minor
  businessDate: CalendarDate
  description: string
  evidenceMediaId: string | null
  /** NOT NULL in the schema, unlike an expense's: an income without its journal cannot exist. */
  journalEntryId: number
  createdBy: string
}

export interface IncomeRepo {
  listCategories(): Promise<IncomeCategoryRecord[]>
  createCategory(category: IncomeCategoryRecord): Promise<void>
  /** Lookup by the client-owned income UUID, which is also its idempotency key. */
  get(id: string): Promise<IncomeRecord | null>
  create(income: IncomeRecord): Promise<void>
  listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<IncomeRecord[]>
}

// ── «السلفة» — an expense that must come back (owner decision 17) ────────────────────────────
//
// «هوي صرفية دفعت لكنها يجب ان ترد كاملة». Recorded from the Expenses screen with a category, a
// description and a receipt, because it becomes an ordinary صرفية if it is never repaid. Read from
// the Treasury screen, because while it is outstanding it is still office capital.
//
// THE ADVANCE IS THE UNIT, NOT THE PARTY. The party is free text by the owner's own choice — a
// driver, a workshop, a landlord — so it has no id, and every balance is per advance. Nothing
// financial keys on a name, which is why two spellings of one name can neither merge two people's
// debts nor split one person's.

export interface AdvanceRecord {
  /** The client-owned UUID: identity, idempotency key, and the journal's occurrence key. */
  id: string
  branchId: string
  /** Whoever the manager wrote on the line. */
  partyName: string
  /** Normalised `partyName`, for search and grouping in the UI ONLY. No money depends on it. */
  partyKey: string
  /** The classification a conversion will file it under if it is never repaid. */
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  /**
   * Set when this advance was reclassified from that driver's «ذمة» instead of paid out of a box.
   *
   * The credit leg is then his receivable fund, no money moved, and office capital is unchanged —
   * the same debt, filed differently.
   */
  sourceDriverId: string | null
  /**
   * WHICH BOX paid — a physical fact. The operator never names a ledger fund.
   *
   * For a reclassified receivable this is INHERITED from the debt, never chosen: a debt owed in
   * cash stays owed in cash, so a later repayment lands in the box it was always owed to.
   */
  channel: 'office_cash' | 'office_wallet'
  amount: Minor
  businessDate: CalendarDate
  description: string
  receiptMediaId: string | null
  /** NOT NULL in the schema, unlike an expense's: an advance without its journal cannot exist. */
  journalEntryId: number
  createdBy: string
}

export interface AdvanceEventRecord {
  id: string
  advanceId: string
  branchId: string
  /** Money coming back, or the company declaring that it never will. */
  kind: 'repayment' | 'conversion'
  amount: Minor
  businessDate: CalendarDate
  reason: string
  /** The ordinary `expenses` row a conversion writes; null for a repayment. */
  expenseId: string | null
  journalEntryId: number
  createdBy: string
}

/**
 * One advance and what it still owes.
 *
 * `outstanding` is read from the advance's OWN ledger fund, not computed from the event rows: the
 * fund is the record, and a second arithmetic would be one more thing to keep in step with it.
 */
export interface AdvanceOutstandingRecord {
  advance: AdvanceRecord
  outstanding: Minor
  repaid: Minor
  converted: Minor
}

export interface AdvanceRepo {
  /** Lookup by the client-owned advance UUID, which is also its idempotency key. */
  get(id: string): Promise<AdvanceRecord | null>
  create(advance: AdvanceRecord): Promise<void>
  listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<AdvanceRecord[]>
  /** Everything still owed to the branch — what the Treasury card renders. */
  listOutstanding(branchId: string): Promise<AdvanceOutstandingRecord[]>
  /** Distinct party names already used at this branch, for the UI's autocomplete. */
  listParties(branchId: string): Promise<Array<{ partyName: string; partyKey: string }>>
  getEvent(id: string): Promise<AdvanceEventRecord | null>
  createEvent(event: AdvanceEventRecord): Promise<void>
  listEvents(advanceId: string): Promise<AdvanceEventRecord[]>
}

export interface ExpenseRepo {
  listCategories(): Promise<ExpenseCategoryRecord[]>
  createCategory(category: ExpenseCategoryRecord): Promise<void>
  /** Lookup by the client-owned expense UUID, which is also its idempotency key. */
  get(id: string): Promise<ExpenseRecord | null>
  create(expense: ExpenseRecord): Promise<void>
  listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]>
  /** Company/branch expenses explicitly attributed to one vehicle in the inclusive period. */
  listByVehicle(branchId: string, vehicleId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]>
  /** Per-cost-centre totals — G-1's «تُغذي ربحية كل محور». */
  totalsByCostCenter(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Array<{ costCenterKind: string; vehicleId: string | null; total: Minor }>>
}

// ── Branch recurring expenses (finance redesign P4) ──────────────────────────────────────

export interface RecurringExpenseTemplateRecord {
  /** Client-owned UUID: identity and create-retry key. */
  id: string
  branchId: string
  /** C6: omitted by pre-C6 callers means an operating-branch template. */
  templateKind?: 'branch' | 'company'
  /** Branch templates are always SYP; company templates preserve their purchase currency. */
  currency?: Currency
  title: string
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general' | 'asset'
  vehicleId: string | null
  assetId?: string | null
  channel: 'office_cash' | 'office_wallet' | null
  paidFrom?: 'pocket' | 'reserve' | 'owner_outside' | null
  amount: Minor
  scheduleKind: RecurrenceKind
  weekday: number | null
  intervalDays: number | null
  startsOn: CalendarDate
  endsOn: CalendarDate | null
  active: boolean
  /** The first business date no longer generated after a reasoned deactivation. */
  deactivatedOn: CalendarDate | null
  deactivatedAtMs: number | null
  deactivatedBy: string | null
  deactivationReason: string | null
  createdBy: string
  createdAtMs: number
  updatedBy: string
  updatedAtMs: number
}

export interface RecurringExpenseOccurrenceRecord {
  id: string
  templateId: string
  branchId: string
  dueDate: CalendarDate
  status: 'paid' | 'skipped'
  /** An ordinary ledger-backed expense when paid; null only for a skip. */
  expenseId: string | null
  /** C6 company payment; exactly one expense reference is set for a paid occurrence. */
  companyExpenseId?: string | null
  /** Required for a skip and whenever the paid amount differs from the template. */
  reason: string | null
  actedBy: string
  actedAtMs: number
}

export interface RecurringExpenseRepo {
  getTemplate(id: string): Promise<RecurringExpenseTemplateRecord | null>
  listTemplates(branchId: string, includeInactive?: boolean): Promise<RecurringExpenseTemplateRecord[]>
  createTemplate(template: RecurringExpenseTemplateRecord): Promise<void>
  updateTemplate(template: RecurringExpenseTemplateRecord): Promise<void>
  getOccurrence(templateId: string, dueDate: CalendarDate): Promise<RecurringExpenseOccurrenceRecord | null>
  listOccurrences(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<RecurringExpenseOccurrenceRecord[]>
  /** Number of already-resolved dates before `before`; due reads subtract it from generated dates. */
  countOccurrencesBefore(templateId: string, before: CalendarDate): Promise<number>
  createOccurrence(occurrence: RecurringExpenseOccurrenceRecord): Promise<void>
}

// â”€â”€ Direct receivable commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReceivableEventRecord {
  id: string
  branchId: string
  driverId: string
  receivableKind: 'ordinary' | 'shift_funding'
  channel: 'cash' | 'wallet'
  direction: 'create' | 'collect'
  amount: Minor
  businessDate: CalendarDate
  reason: string
  /**
   * What this row IS, as opposed to what it does to the ledger.
   *
   * A `correction` restates a balance that was recorded wrongly; nothing physically moved. Without
   * this distinction the driver's history reads «تحصيل ٥٠٠» — money came back — for an event where
   * no money came back, which is the exact lie the ledger exists to prevent. A `writeoff` also
   * moves no money, but recognises a real debt as a loss through its dedicated cost centre. A
   * `command` is the only intent here that reports a physical advance or collection.
   */
  intent: 'command' | 'correction' | 'writeoff'
  /** Corrections and write-offs: what the balance read, and its resulting balance. */
  priorBalance: Minor | null
  targetBalance: Minor | null
  idempotencyKey: string
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

export interface ReceivableEventRepo {
  findByIdempotencyKey(branchId: string, idempotencyKey: string): Promise<ReceivableEventRecord | null>
  create(event: ReceivableEventRecord): Promise<void>
  listByBranchAndDriver(
    branchId: string,
    driverId?: string,
  ): Promise<ReceivableEventRecord[]>
}

/**
 * Repositories that may participate in one financial write transaction.
 *
 * This starts with expenses, whose row and journal must never split. Keeping the unit generic
 * lets later treasury/receivable commands join the same boundary without inventing a second
 * transaction abstraction.
 */
export interface FinancialTransactionDeps {
  ledger: LedgerRepo
  expenses: ExpenseRepo
  recurringExpenses: RecurringExpenseRepo
  incomes: IncomeRepo
  advances: AdvanceRepo
  receivableEvents: ReceivableEventRepo
  /** Restoration reads its sealed evidence and capital targets inside the same branch lock. */
  cashCounts: CashCountRepo
  capitalTargets: OfficeCapitalTargetRepo
  /** The immutable fact and its journal entries must commit or roll back together. */
  restorations: RestorationRepo
  /** «صندوق الشركة» commands, cutovers and mirrors (C2) — written beside their journal entries. */
  companyLedger: CompanyLedgerRepo
  /** Company debts, fixed assets and depreciation facts (C3–C5). */
  companyFinance: CompanyFinanceRepo
  /** Further financial locks in the same namespace; see `lockBranchThenCompany`. */
  locks: FinancialLocks
}

export interface FinancialUnitOfWorkInput {
  /** Stable business-operation key; implementations serialize concurrent retries on it. */
  lockKey: string
  actorId: string | null
  requestId?: string | null
}

export interface FinancialUnitOfWork {
  run<T>(
    input: FinancialUnitOfWorkInput,
    work: (deps: FinancialTransactionDeps) => Promise<T>,
  ): Promise<T>
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
  /**
   * `active` until a recount supersedes it or someone withdraws it. Exactly one active count per
   * branch per business date; the others stay readable with their proof intact.
   */
  status: CashCountStatus
  /** The count that replaced this one. Set only on `superseded`. */
  supersededById: string | null
  closedAtMs: number | null
  closedBy: string | null
  closedReason: string | null
}

export type CashCountStatus = 'active' | 'superseded' | 'cancelled'

export interface CashCountRepo {
  /**
   * Returns the persisted identity. PostgreSQL owns the BIGINT id; callers must not assume the
   * client-generated placeholder survived, and audit/restoration must reference this returned id.
   */
  create(count: CashCountRecord): Promise<CashCountRecord>
  /**
   * The ACTIVE count for that day, or null.
   *
   * Never a superseded or cancelled one. The restoration reconciles against whatever this returns,
   * and the go-live gate treats it as proof the boxes were counted — a dead count in either place
   * is money moved on figures nobody stands behind.
   */
  find(branchId: string, businessDate: CalendarDate): Promise<CashCountRecord | null>
  /** Days with an ACTIVE count. A withdrawn count must not let a financial week seal. */
  listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]>
  /**
   * Replace the active count for a day with a fresh one, in a single transaction.
   *
   * Two steps that must not separate: a crash between them would leave the day with two active
   * counts (which the partial unique index refuses) or none (which strands the restoration).
   */
  supersede(input: {
    priorId: string
    replacement: CashCountRecord
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord>
  /** Withdraw the active count, leaving the day uncounted until the underlying error is fixed. */
  cancel(input: {
    id: string
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord | null>
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

// ── «التفقّد» — manager check-in rounds ────────────────────────────────────────────────────

/** One round a named user is expected to answer, in minutes past branch-local midnight. */
export interface CheckInWindowRecord {
  id: string
  branchId: string
  userId: string
  atMinute: number
  toleranceMinutes: number
  active: boolean
  label: string | null
  createdBy: string
}

/** Where somebody was, and what that meant for the round it answered. Append-only. */
export interface CheckInRecord {
  id: string
  branchId: string
  userId: string
  businessDate: CalendarDate
  capturedAtMs: number
  lat: number
  lng: number
  accuracyM: number | null
  windowId: string | null
  distanceM: number
  insideArea: boolean
  minutesFromTarget: number | null
  verdict: 'on_time' | 'outside_window' | 'outside_area' | 'outside_both'
  note: string | null
}

export interface CheckInRepo {
  listWindows(branchId: string, userId?: string): Promise<CheckInWindowRecord[]>
  createWindow(window: CheckInWindowRecord): Promise<CheckInWindowRecord>
  /** Retiring a round keeps its history: `active` goes false, the row stays. */
  deactivateWindow(id: string): Promise<boolean>
  record(checkIn: CheckInRecord): Promise<CheckInRecord>
  listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<CheckInRecord[]>
  listByUserAndDate(userId: string, businessDate: CalendarDate): Promise<CheckInRecord[]>
}

export interface DirectoryRepo {
  branch(id: string): Promise<BranchRecord | null>
  /** Operating branches only (`kind = 'branch'`). The company (HQ) row is never a branch to pick. */
  listBranches(): Promise<BranchRecord[]>
  /** The single company (HQ) row that holds «صندوق الشركة», or null before it exists. */
  companyBranch(): Promise<BranchRecord | null>
  /**
   * Where the branch is, for «التفقّد». A null point means no fence — and therefore no round any
   * manager can fail, which is the right behaviour for a branch nobody has placed on the map yet.
   */
  setBranchLocation(
    id: string,
    location: { lat: number | null; lng: number | null; checkinRadiusM: number },
  ): Promise<BranchRecord | null>
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
  listByShiftIds(shiftIds: readonly string[]): Promise<BatteryReadingRecord[]>
  /** Has this pack ever been read? Asked before a delete — a pack with readings is evidence. */
  existsForBattery(batteryId: string): Promise<boolean>
}

/** The mid-shift battery-swap event log (SRS §L seam). Append-only, one row per swap per shift. */
export interface BatterySwapRepo {
  create(swap: BatterySwapRecord): Promise<void>
  /** Every swap on a shift, in the order they happened. Length + max seqNo drive the next seqNo. */
  listByShift(shiftId: string): Promise<BatterySwapRecord[]>
  listByShiftIds(shiftIds: readonly string[]): Promise<BatterySwapRecord[]>
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
  decision: 'approved' | 'rejected' | 'rephoto_requested' | 'force_close_prepared' | 'force_cancelled'
  notes: string | null
  decidedBy: string
  decidedAtMs: number
}

export interface ShiftDecisionRepo {
  record(decision: Omit<ShiftDecisionRecord, 'id'>): Promise<ShiftDecisionRecord>
  /** Newest first, so the log reads top-down from the most recent decision. */
  listByShift(shiftId: string): Promise<ShiftDecisionRecord[]>
}

// ── Immutable shift settlement snapshot ───────────────────────────────────────────────────

/**
 * The cash-close policy currently authorised by the owner.
 *
 * This is deliberately versioned rather than named merely `fixed_40`: a future policy can coexist
 * with old, immutable settlement snapshots without silently changing what their figures mean.
 */
export const FIXED_CASH_SETTLEMENT_POLICY_V1 = 'fixed_40_cash_close_v1' as const
export const FIXED_CASH_SETTLEMENT_POLICY = 'fixed_40_cash_close_v2_receivable' as const
export const FIXED_DRIVER_RATE_BPS = 4_000 as const

export type ShiftSettlementPolicy =
  | typeof FIXED_CASH_SETTLEMENT_POLICY_V1
  | typeof FIXED_CASH_SETTLEMENT_POLICY
export type SettlementVarianceDirection = 'surplus' | 'shortage' | 'balanced'
export type SettlementWalletAction = 'collect' | 'fund' | 'none'
export type SettlementCashAction = 'collect' | 'pay' | 'none'

/**
 * The immutable, manager-confirmed answer to «what was collected from this employee at close?».
 *
 * Amounts ending in `ToOffice` are SIGNED: positive means the office receives value, negative
 * means the office supplies it. The matching action + positive amount are stored as well because a
 * branch manager must never be asked to interpret a negative monetary figure at the counter.
 */
export interface ShiftSettlementRecord {
  id: number
  shiftId: string
  branchId: string
  driverId: string
  businessDate: CalendarDate
  policyCode: ShiftSettlementPolicy
  driverRateBps: typeof FIXED_DRIVER_RATE_BPS
  deliveryFeeTotal: Minor
  fixedDriverShare: Minor
  manualDriverShare: Minor
  grossDriverShare: Minor
  cashDeductionTotal: Minor
  /** Signed share after cash deductions, before the closing variance. */
  baseDriverShare: Minor
  expectedTotal: Minor
  actualCash: Minor
  actualWallet: Minor
  actualTotal: Minor
  /** `actualTotal - expectedTotal`, signed. */
  variance: Minor
  varianceDirection: SettlementVarianceDirection
  /**
   * Signed final cash: positive is kept/paid to the employee; negative is due from him at close.
   */
  finalEmployeeCash: Minor
  /** Signed cash claim before any manager-confirmed deferral. */
  cashClaimToOffice: Minor
  /** Signed wallet claim before any manager-confirmed deferral. */
  walletClaimToOffice: Minor
  /** Legacy-named positive cash amount retained as automatically consumed next-shift funding. */
  cashReceivableDeferred: Minor
  /** Legacy-named positive wallet amount retained as automatically consumed next-shift funding. */
  walletReceivableDeferred: Minor
  /** Frozen upper bound reviewed by the manager for the current-shift ordinary receivable. */
  maximumCashShortageReceivable: Minor
  /** Unpaid current-shift shortage retained as an ordinary cash receivable. */
  cashShortageReceivable: Minor
  /** Physical signed wallet movement after deferral. */
  walletToOffice: Minor
  /** Physical signed cash movement after deferral. */
  cashToOffice: Minor
  walletAction: SettlementWalletAction
  walletAmount: Minor
  cashAction: SettlementCashAction
  cashAmount: Minor
  /**
   * «الحسم» as frozen at approval: charged to the employee, credited to `other_income`.
   *
   * Reduces `finalEmployeeCash` and raises `cashClaimToOffice`. Deliberately does NOT reduce
   * `baseDriverShare` — the driver earned his share and paid the charge out of it, so the journal
   * names the money as income instead of quietly swelling the office cash box.
   */
  managerCharge: Minor
  reviewedOrdersHash: string
  /** sha256 over the complete canonical snapshot, including shift identity and policy. */
  settlementHash: string
  walletTransferConfirmed: boolean
  cashSettlementConfirmed: boolean
  confirmedBy: string
  confirmedAtMs: number
  /** Required when `variance !== 0`; nullable for a balanced close. */
  varianceReason: string | null
}

export type NewShiftSettlementRecord = Omit<ShiftSettlementRecord, 'id'>

export interface ShiftSettlementRepo {
  /**
   * Insert once as part of the close unit of work that advances the shift to a terminal state.
   * An exact hash replay of the resulting terminal settlement returns the existing row; any
   * different second snapshot is rejected because an approved financial settlement is corrected
   * by a new journal event, never rewritten in place.
   */
  create(record: NewShiftSettlementRecord): Promise<ShiftSettlementRecord>
  findByShift(shiftId: string): Promise<ShiftSettlementRecord | null>
  /** Resolve a reporting batch in one read; missing IDs are absent and each stored row appears once. */
  listByShiftIds(shiftIds: readonly string[]): Promise<ShiftSettlementRecord[]>
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
  /** Which capture layer produced it. See the 0063 column comment. */
  source: GpsPingSource
}

export type GpsPingSource = 'phone_fg' | 'phone_bg' | 'tracker'

export interface GpsPingRepo {
  append(ping: Omit<GpsPingRecord, 'id'>): Promise<void>
  /**
   * Insert a buffered run in one statement, ignoring fixes already stored.
   *
   * `(shift_id, captured_at)` is a natural key — two fixes at the same millisecond on one shift are
   * physically meaningless — so a retried batch costs nothing and cannot duplicate a trail. Returns
   * how many were actually new, which is what the route reports back so a client can log rather
   * than guess.
   */
  appendMany(pings: readonly Omit<GpsPingRecord, 'id'>[]): Promise<{ inserted: number }>
  /**
   * The latest fix for each of the named drivers, for driver-wide history reads.
   *
   * Takes the driver ids so a seek per driver is
   * O(drivers) forever. Its predecessor was `DISTINCT ON (driver_id)` over the whole branch, which
   * does not skip: it reads every tuple the branch has ever written, so it degraded with history.
   * `sinceMs` bounds capture time, since a newly received buffered fix may describe an old position.
   */
  latestForDriversInBranch(
    branchId: string,
    driverIds: readonly string[],
    sinceMs: number,
  ): Promise<GpsPingRecord[]>
  /** Latest captured fix on each named live shift; old-shift late uploads cannot mask it. */
  latestForShiftIds(shiftIds: readonly string[]): Promise<GpsPingRecord[]>
  /**
   * A shift's whole trail, in CAPTURE order.
   *
   * Deliberately not receive order. Once anything buffers, a batch received at 14:00 holding fixes
   * captured 12:00–13:00 sorts after fixes captured at 13:30 that arrived live — the trail zigzags
   * and the summed distance inflates without bound. That number is one a manager acts on.
   */
  listForShift(shiftId: string): Promise<GpsPingRecord[]>
  /** Resolve all trails in one reporting read, capture-ordered within each shift. */
  listByShiftIds(shiftIds: readonly string[]): Promise<GpsPingRecord[]>
  /** How many fixes a shift has stored. Guards one wedged handset from filling the table. */
  countForShift(shiftId: string): Promise<number>
}

/**
 * A registered hardware GPS tracker (SRS K-1 — infrastructure only; no device exists yet).
 *
 * A tracker measures a BIKE (a phone measures a driver), so it is fitted to a vehicle at a branch
 * and known by its IMEI. Only the secret's hash is kept. `lastSeenAtMs` is liveness, updated by the
 * ingest seam; registration, binding and deactivation are the audited authority decisions.
 */
export interface TrackerDeviceRecord {
  id: string
  branchId: string
  imei: string
  vehicleId: string | null
  secretHash: string
  label: string
  active: boolean
  lastSeenAtMs: number | null
  createdBy: string
  createdAtMs: number
  updatedAtMs: number
}

export interface TrackerDeviceRepo {
  register(device: TrackerDeviceRecord): Promise<void>
  findByImei(imei: string): Promise<TrackerDeviceRecord | null>
  /** The device that may currently write telemetry for this IMEI — active only. */
  findActiveByImei(imei: string): Promise<TrackerDeviceRecord | null>
  /** Fit the device to a bike (or unfit with null). One active device per bike is enforced in SQL. */
  bindToVehicle(id: string, vehicleId: string | null, actorId: string): Promise<void>
  deactivate(id: string, actorId: string): Promise<void>
  /** A bare liveness touch — deliberately not audited, like the pings themselves. */
  touchLastSeen(id: string, atMs: number): Promise<void>
  listByBranch(branchId: string): Promise<TrackerDeviceRecord[]>
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
  breaks: ShiftBreakRepo
  preapprovedShiftRules: PreapprovedShiftRuleRepo
  orders: OrderRepo
  cashDeductions: CashDeductionRepo
  /** The register a manager's removal is written into, in the same transaction as the removal. */
  operationRemovals: OperationRemovalRepo
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
  settlements: ShiftSettlementRepo
  closeDrafts: CloseDraftRepo
  operationBatches: OperationBatchRepo
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
  driverAccounts: DriverAccountProvisioningRepo
  shifts: ShiftRepo
  breaks: ShiftBreakRepo
  preapprovedShiftRules: PreapprovedShiftRuleRepo
  assignments: AssignmentRepo
  batteryReadings: BatteryReadingRepo
  batterySwaps: BatterySwapRepo
  orders: OrderRepo
  /** Positive cash deductions read from the provider's operation history. */
  cashDeductions: CashDeductionRepo
  /** Append-only record of rows a manager declared were never deliveries. */
  operationRemovals: OperationRemovalRepo
  /** Deterministic, audited refresh of stored operation-window classifications. */
  operationWindows: OperationWindowRepo
  /** Atomic writer for one complete driver operations submission. */
  operationBatches: OperationBatchRepo
  /** «سجل المدفوعات» — what the wallet actually did, beside what the orders imply it should have. */
  movements: WalletMovementRepo
  ledger: LedgerRepo
  /** Atomic statement-snapshot behind the working-capital dashboard. */
  treasuryPosition: TreasuryPositionSource
  /** P2 — one aggregate over a business-date range, behind the time filter. */
  ledgerRange: LedgerRangeSource
  expenses: ExpenseRepo
  recurringExpenses: RecurringExpenseRepo
  incomes: IncomeRepo
  advances: AdvanceRepo
  receivableEvents: ReceivableEventRepo
  /** Atomic boundary for ledger-backed expenses and future treasury/receivable commands. */
  financialUnitOfWork: FinancialUnitOfWork
  cashCounts: CashCountRepo
  /** «رأس مال المكتب» — the fixed target الترميم restores each box to. */
  capitalTargets: OfficeCapitalTargetRepo
  /** «الترميم» — one record per branch per working day. */
  restorations: RestorationRepo
  /** «صندوق الشركة» — the company ledger's command rows, cutovers and mirrors (C2). */
  companyLedger: CompanyLedgerRepo
  /** «صندوق الشركة» — pockets, clearing and movements, each read in one statement (C2). */
  companyLedgerSource: CompanyLedgerSource
  /** Company debts, fixed assets and depreciation (C3–C5). */
  companyFinance: CompanyFinanceRepo
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
  checkIns: CheckInRepo
  decisions: ShiftDecisionRepo
  /** Immutable cash/wallet action the manager confirmed when approving the close. */
  settlements: ShiftSettlementRepo
  /** Revisioned, server-owned recovery state for the driver's closing workflow. */
  closeDrafts: CloseDraftRepo
  gps: GpsPingRepo
  trackerDevices: TrackerDeviceRepo
  /** Atomic close-boundary/review writer; callback work is database-only. */
  closeUnitOfWork: ShiftCloseUnitOfWork
}
