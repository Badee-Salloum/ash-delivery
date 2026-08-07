import { z } from 'zod'
import { MAX_BATTERY_SLOTS, type Minor, formatMinor, parseMinor } from '@ash/domain'

/**
 * Wire schemas.
 *
 * ── MONEY ON THE WIRE IS A DECIMAL STRING, NEVER A NUMBER ───────────────────────────────
 * `JSON.stringify` throws on a bigint, and any `z.number()` for money is a silent invitation to
 * IEEE-754. So every money field crosses the boundary as `"1234.56"` and is parsed into `Minor`
 * exactly once, here. `scripts/check-wire-money.mjs` greps for `z.number()` on money-shaped field
 * names so this cannot quietly regress.
 */
export const moneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'money must be a decimal string with at most 2 places')
  .transform((s): Minor => parseMinor(s))

export const serializeMoney = (m: Minor): string => formatMinor(m)

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const uuidSchema = z.string().min(1)

export const payModeSchema = z.enum(['cash', 'electronic', 'free'])

// ── Auth ──────────────────────────────────────────────────────────────────────────────────

/**
 * A username as it can actually be typed back.
 *
 * This exists because of a real account nobody could log into. It was created as `Ali_Dandah` with
 * the ARABIC KASRA (U+0650) in front of it — what Shift+A produces while the Arabic keyboard layout
 * is on. The mark is invisible and zero-width, so the username looked correct in every list in the
 * admin, but the login lookup is an exact match: the name on the screen and the name in the
 * database were different strings, and the account could never even reach its password check.
 *
 * In an Arabic-first product where every operator switches layouts all day, this will happen again.
 * So: NFKC first, so compatibility forms settle; then drop combining marks (`\p{M}` — the stray
 * kasra, fatha, shadda) and format characters (`\p{Cf}` — zero-width joiners, RTL/LTR marks, BOM),
 * none of which a person can see or reproduce; then trim.
 *
 * Deliberately NOT case folding. Lower-casing here would let two existing accounts collide, and
 * quietly changing which account a name resolves to is not something authentication should do.
 */
export const normalizeUsername = (raw: string): string => raw.normalize('NFKC').replace(/[\p{M}\p{Cf}]/gu, '').trim()

export const loginRequest = z.object({
  // Normalised on the way in, so an invisible mark the operator cannot see — and cannot delete,
  // because backspace over a zero-width character looks like nothing happening — is not the reason
  // a correct password is refused.
  username: z.string().min(1).max(64).transform(normalizeUsername),
  password: z.string().min(1).max(256),
})

export const loginResponse = z.object({
  userId: z.string(),
  roleKey: z.string(),
  branchId: z.string().nullable(),
  fullNameAr: z.string(),
  expiresAt: z.number(),
})

// ── Shifts ────────────────────────────────────────────────────────────────────────────────

export const createShiftRequest = z.object({
  driverId: uuidSchema,
  vehicleId: uuidSchema,
  shiftNo: z.number().int().min(1).max(4),
})

export const startPackageRequest = z.object({
  odometerKm: z.number().int().min(0),
  // Nullable on purpose. A blank field used to reach the server as `Number('') === 0`, so "the
  // driver did not answer" was indistinguishable from "the pack is flat". The gate refuses null.
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  // SRS D-3 baselines: what `readDashboard` OCR'd before the driver confirmed/edited. Plain scaled
  // integers (not money), so `z.number()` is correct — the wire-money guard only bars it on money names.
  // `.default(null)` (not `.optional()`) so the field is always present — null when OCR did not run.
  odometerKmOcr: z.number().int().min(0).nullable().default(null),
  batteryPercentOcr: z.number().int().min(0).max(100).nullable().default(null),
})

/**
 * One point on a manual order's route. `label` is what a human would say — «مطعم الشام، شارع بغداد»
 * — and is always required; the pin is optional, because most jobs are described by name and nobody
 * should be forced onto a map to record one. `lat`/`lng` are plain numbers: coordinates, not money.
 */
export const orderPointRequest = z.object({
  role: z.enum(['start', 'stop', 'end']),
  label: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90).nullable().default(null),
  lng: z.number().min(-180).max(180).nullable().default(null),
})

export const addOrderRequest = z.object({
  providerOrderNo: z.string().min(1).max(64),
  payMode: payModeSchema,
  fee: moneySchema,
  zone: z.string().max(64).nullable().default(null),
  // SRS D-1/D-3: whether the fee came from the «Recent orders» OCR, and what it read. `feeOcr` is
  // money, so it crosses as a decimal string via `moneySchema` — never a JSON number.
  source: z.enum(['manual', 'ocr']).default('manual'),
  feeOcr: moneySchema.nullable().default(null),
  /** `yallago` (their delivery) or `manual` (a job the branch took itself). */
  kind: z.enum(['yallago', 'manual']).default('yallago'),
  /**
   * Manual orders only — the agreed split, as money (a decimal string, never a JSON number: a share
   * must not pass through IEEE-754 on its way in). The server refuses a manual order whose two
   * shares do not add up to its fee exactly, which is what keeps the ledger able to close.
   */
  driverShare: moneySchema.nullable().default(null),
  companyShare: moneySchema.nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
  /** Start, end, and any stops between. Empty for a Yallago order. */
  points: z.array(orderPointRequest).max(20).default([]),
  /**
   * Checked at close. `false` keeps the order with the shift but takes it out of BR1, the tier
   * band and the ledger — the screenshots overlap and show previous days, so a read list always
   * contains rows that are not this shift's.
   */
  included: z.boolean().default(true),
  /**
   * How much of this fee reached the WALLET, measured off «سجل المدفوعات». Money, so it crosses as
   * a decimal string — never a JSON number. `null` means unmeasured and the pay mode decides.
   */
  walletAmount: moneySchema.nullable().default(null),
  /** «HH:MM» off the dashboard: what a log row is paired to. */
  occurredMinute: z
    .string()
    .regex(/^[0-2]\d:[0-5]\d$/)
    .nullable()
    .default(null),
})

/**
 * A manager correcting a closing figure at the review. Every field optional: he sends the one he is
 * fixing and leaves the rest alone. Money as decimal strings, never JSON numbers.
 */
export const closeFiguresRequest = z.object({
  odometerKm: z.number().int().min(0).nullable().default(null),
  cashDeclared: moneySchema.nullable().default(null),
  walletDeclared: moneySchema.nullable().default(null),
})

/** «HH:MM» as read off a screenshot. `''` on a movement means the clock was not legible. */
const minuteSchema = z.string().regex(/^[0-2]\d:[0-5]\d$/)

const movementRole = z.enum(['yalago_cut', 'order_credit', 'unmatched'])

/**
 * The driver's whole operations list: what he delivered, and what his wallet did.
 *
 * Submitted more than once — he re-reads an overlapping page, or steps back into the close to add a
 * delivery he forgot — so the server upserts the orders and merges the movements rather than
 * inserting. `amount` is SIGNED money and crosses as a decimal string, never a JSON number.
 */
export const operationsRequest = z.object({
  orders: z
    .array(
      z.object({
        providerOrderNo: z.string().min(1).max(64),
        payMode: payModeSchema,
        fee: moneySchema,
        zone: z.string().max(64).nullable().default(null),
        source: z.enum(['manual', 'ocr']).default('manual'),
        feeOcr: moneySchema.nullable().default(null),
        included: z.boolean().default(true),
        walletAmount: moneySchema.nullable().default(null),
        occurredMinute: minuteSchema.nullable().default(null),
        /**
         * Where it went: «A» the pickup, «B» the dropoff.
         *
         * The orders screen carries NO order number, so the value, the clock and this route are
         * everything an order actually is — and the route is the only part of it a human reading
         * the review can recognise as a real delivery.
         */
        pointA: z.string().max(200).nullable().default(null),
        pointB: z.string().max(200).nullable().default(null),
      }),
    )
    .max(400)
    .default([]),
  movements: z
    .array(
      z.object({
        amount: moneySchema,
        occurredMinute: z.union([minuteSchema, z.literal('')]).default(''),
        role: movementRole.default('unmatched'),
        /** The order this belongs to, by its number — resolved to an id server-side. */
        providerOrderNo: z.string().max(64).nullable().default(null),
        ambiguous: z.boolean().default(false),
        included: z.boolean().default(true),
        notes: z.string().max(2000).nullable().default(null),
      }),
    )
    .max(400)
    .default([]),
})

/** The manager changing what counts, during the review. Everything is optional: a patch, not a put. */
export const reviseOperationsRequest = z.object({
  orders: z
    .array(
      z.object({
        providerOrderNo: z.string().min(1).max(64),
        included: z.boolean().optional(),
        walletAmount: moneySchema.nullable().optional(),
      }),
    )
    .max(400)
    .default([]),
  movements: z
    .array(
      z.object({
        id: z.string().min(1),
        included: z.boolean().optional(),
        role: movementRole.optional(),
        // `null` is a real instruction — «belongs to no order» — so this is nullable AND optional.
        providerOrderNo: z.string().max(64).nullable().optional(),
        ambiguous: z.boolean().optional(),
      }),
    )
    .max(400)
    .default([]),
})

export const endPackageRequest = z.object({
  odometerKm: z.number().int().min(0),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  cashDeclared: moneySchema,
  walletDeclared: moneySchema,
  // SRS D-3 baseline: what `readWallet` OCR'd off the close wallet screenshot before the driver
  // confirmed. Money, so it crosses as a decimal string via `moneySchema` — never a JSON number.
  walletDeclaredOcr: moneySchema.nullable().default(null),
})

/**
 * Evidence upload. The photo itself is the request BODY (raw bytes); everything else is a
 * header or a path param, so a 300 KB image is never base64-inflated by 33% over a phone
 * connection.
 */
export const uploadEvidenceParams = z.object({
  id: z.string().min(1),
  package: z.enum(['start', 'end']),
  slot: z.string().min(1).max(32),
})

/**
 * The manager records the cash float and wallet top-up at open-approval — the driver no longer
 * enters them (they are the branch's money, disbursed by the manager). SRS C-5: several tranches
 * per day are legitimate, so each is a list, not a scalar.
 */
export const approveOpenRequest = z.object({
  floatTranches: z.array(moneySchema).min(0),
  topupTranches: z.array(moneySchema).min(0),
})

export const approveCloseRequest = z.object({
  /** The hash the manager actually reviewed. Re-checked inside the approval transaction. */
  reviewedOrdersHash: z.string().min(1),
})

/** Upper-level force-close of a stuck shift: a reason + whatever end figures the admin actually has. */
export const forceCloseRequest = z.object({
  reason: z.string().min(1).max(500),
  odometerKm: z.number().int().min(0).nullable().default(null),
  cashDeclared: moneySchema.nullable().default(null),
  walletDeclared: moneySchema.nullable().default(null),
})

/**
 * A second (or later) cash-float or wallet top-up disbursed mid-day (SRS C-5). Money the branch
 * hands the driver after open-approval, posted as one more tranche under its own occurrence key.
 */
export const addTrancheRequest = z.object({
  kind: z.enum(['float', 'topup']),
  amount: moneySchema,
})

/**
 * One live GPS fix from the driver's phone while a shift is open (SRS K). lat/lng/accuracy are plain
 * numbers — coordinates, not money — so `z.number()` is correct here.
 */
export const gpsPingRequest = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).nullable().default(null),
  /** The phone's own clock in ms; the server stamps its own receive time. */
  capturedAtMs: z.number().int(),
})

// ── Fleet (SRS B) ─────────────────────────────────────────────────────────────────────────

/** A driver's profile fields (B-1). `nationalId` is plaintext in transit (HTTPS); stored encrypted. */
export const driverProfileFields = {
  fullNameEn: z.string().max(120).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  hiredOn: calendarDateSchema.nullable().optional(),
  nationalId: z.string().max(64).nullable().optional(),
}

export const createDriverRequest = z.object({
  code: z.string().min(1).max(32),
  fullNameAr: z.string().min(1).max(120),
  ...driverProfileFields,
})

/** Organisation-wide roles have no branch of their own, so writes may name one explicitly. */
export const branchTarget = z.object({ branchId: z.string().optional() })

// ── Accounts (SRS A-2) ────────────────────────────────────────────────────────────────────

/**
 * Edit an account. Every field is optional — only what is sent changes. `username` is absent on
 * purpose: it is the login identity, not a profile field. A `password` here is a reset.
 */
export const updateUserRequest = z.object({
  fullNameAr: z.string().min(1).max(120).optional(),
  roleKey: z.enum(['driver', 'branch_manager', 'system_admin', 'general_manager', 'accountant']).optional(),
  branchId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
})

/** Create a login account. A driver-role account also gets a linked driver record. */
export const createUserRequest = z.object({
  // Normalised BEFORE the length check, so a name that is only long enough because of invisible
  // marks is refused rather than stored — an account created with one is an account nobody can use.
  username: z
    .string()
    .max(40)
    .transform(normalizeUsername)
    .refine((u) => u.length >= 3, { message: 'username must be at least 3 usable characters' }),
  password: z.string().min(8).max(200),
  roleKey: z.enum(['driver', 'branch_manager', 'system_admin', 'general_manager', 'accountant']),
  fullNameAr: z.string().min(1).max(120),
  // Required for a branch-scoped role (driver, branch_manager); ignored for global roles.
  branchId: z.string().optional(),
})

export const updateDriverRequest = z.object({
  fullNameAr: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  ...driverProfileFields,
})

/**
 * Add a bike.
 *
 * `code` is GONE: the number is «governorate-branch-type-machine», derived from the four
 * components by `formatVehicleNumber`. Letting a caller type it would allow a vehicle whose
 * printed number disagrees with where it actually sits. `machineNo` is optional — omit it and
 * the server takes the lowest free number for that (branch, type).
 */
export const createVehicleRequest = z.object({
  vehicleTypeId: z.string().min(1),
  machineNo: z.number().int().min(1).max(999).optional(),
  plateNo: z.string().max(32).nullable().default(null),
  branchId: z.string().optional(),
})

export const createGovernorateRequest = z.object({
  no: z.number().int().min(1).max(99),
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
})

export const updateGovernorateRequest = z.object({
  no: z.number().int().min(1).max(99).optional(),
  nameAr: z.string().min(1).max(120).optional(),
  nameEn: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
})

export const createBranchRequest = z.object({
  code: z.string().min(1).max(32),
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
  governorateId: z.string().min(1),
  branchNo: z.number().int().min(1).max(99),
})

export const updateBranchRequest = z.object({
  nameAr: z.string().min(1).max(120).optional(),
  nameEn: z.string().min(1).max(120).optional(),
  governorateId: z.string().min(1).optional(),
  branchNo: z.number().int().min(1).max(99).optional(),
})

export const createVehicleTypeRequest = z.object({
  code: z.string().min(1).max(32),
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
  typeNo: z.number().int().min(1).max(99),
  /** Max packs a machine of this type may carry; the ceiling, not the count. Default 2. */
  batterySlots: z.number().int().min(1).max(MAX_BATTERY_SLOTS).default(2),
})

/** Changing `typeNo` restates the printed code of every vehicle of this type. */
export const updateVehicleTypeRequest = z.object({
  nameAr: z.string().min(1).max(120).optional(),
  nameEn: z.string().min(1).max(120).optional(),
  typeNo: z.number().int().min(1).max(99).optional(),
  batterySlots: z.number().int().min(1).max(MAX_BATTERY_SLOTS).optional(),
  active: z.boolean().optional(),
})

// ── Batteries (SRS §L seam) ───────────────────────────────────────────────────────────────

/** Fitting means BOTH a bike and a slot, or neither — a spare sits on the shelf. */
export const createBatteryRequest = z.object({
  serialNo: z.string().max(64).nullable().default(null),
  bmsMac: z.string().max(32).nullable().default(null),
  capacityAh: z.number().int().min(1).max(999),
  vehicleId: z.string().nullable().default(null),
  slotNo: z.number().int().min(1).max(MAX_BATTERY_SLOTS).nullable().default(null),
  /** A profile id from the driver app's BMS_PROFILES; unconstrained so a new one needs no deploy. */
  bmsProfile: z.string().max(32).nullable().default(null),
  branchId: z.string().optional(),
})

export const updateBatteryRequest = z.object({
  serialNo: z.string().max(64).nullable().optional(),
  bmsMac: z.string().max(32).nullable().optional(),
  capacityAh: z.number().int().min(1).max(999).optional(),
  vehicleId: z.string().nullable().optional(),
  slotNo: z.number().int().min(1).max(MAX_BATTERY_SLOTS).nullable().optional(),
  state: z.enum(['ready', 'charging', 'maintenance', 'retired']).optional(),
  bmsProfile: z.string().max(32).nullable().optional(),
  active: z.boolean().optional(),
})

/**
 * One pack's BMS reading, as read off the app screenshot.
 *
 * Scaled INTEGERS, never floats: millivolts, deci-amp-hours, deci-Celsius. `ocrRaw` carries what
 * the OCR itself produced before the driver touched anything, so SRS D-3's "log the manual edit
 * WITH its difference from the OCR reading" stays computable later rather than only at typing time.
 */
/** The BMS quantities alone, without the pack id — shared by shift readings and swap readings. */
export const batteryReadingFields = z.object({
  percent: z.number().int().min(0).max(100).nullable().default(null),
  packMillivolts: z.number().int().min(0).max(2_000_000).nullable().default(null),
  cycleCount: z.number().int().min(0).max(100_000).nullable().default(null),
  remainCapacityDah: z.number().int().min(0).max(100_000).nullable().default(null),
  fullCapacityDah: z.number().int().min(0).max(100_000).nullable().default(null),
  mosTempDc: z.number().int().min(-500).max(2_000).nullable().default(null),
  t1Dc: z.number().int().min(-500).max(2_000).nullable().default(null),
  t2Dc: z.number().int().min(-500).max(2_000).nullable().default(null),
  source: z.enum(['ocr', 'manual']).default('manual'),
  ocrRaw: z.unknown().optional(),
})

export type BatteryReadingFields = z.infer<typeof batteryReadingFields>

export const batteryReadingRequest = batteryReadingFields.extend({
  batteryId: z.string().min(1),
})

export const putBatteryReadingsRequest = z.object({
  package: z.enum(['start', 'end']),
  readings: z.array(batteryReadingRequest).min(1).max(MAX_BATTERY_SLOTS),
})

/**
 * A mid-shift battery swap (SRS §L seam): at a charging stop the driver takes the pack off `slotNo`
 * and fits `inBatteryId` (a charged spare). Both packs' BMS readings are captured — the outgoing
 * pack's final state and the incoming pack's first — so per-pack health history is unbroken.
 */
export const batterySwapRequest = z.object({
  slotNo: z.number().int().min(1).max(MAX_BATTERY_SLOTS),
  inBatteryId: z.string().min(1),
  outReading: batteryReadingFields,
  inReading: batteryReadingFields,
})

export const updateVehicleRequest = z.object({
  /** «جاهزة/تشحن/صيانة/متوقفة» — only a `ready` vehicle may start a shift. */
  state: z.enum(['ready', 'charging', 'maintenance', 'stopped']).optional(),
  active: z.boolean().optional(),
})

/**
 * Binding a bike to a driver for one business date (SRS B-3).
 *
 * `businessDate` is optional and defaults to today: the manager assigning for the morning is the
 * common case, and making him retype the date is how the wrong date gets typed.
 */
export const createAssignmentRequest = z.object({
  driverId: z.string().min(1),
  vehicleId: z.string().min(1),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shiftNo: z.number().int().min(1).max(9).default(1),
  branchId: z.string().optional(),
})

export const createDocumentRequest = z.object({
  ownerKind: z.enum(['driver', 'vehicle']),
  driverId: z.string().nullable().default(null),
  vehicleId: z.string().nullable().default(null),
  /** SRS B-1: driving licence, national ID, criminal record; B-2: registration, insurance. */
  kind: z.enum(['driving_licence', 'national_id', 'criminal_record', 'registration', 'insurance']),
  issuedOn: calendarDateSchema.nullable().default(null),
  expiresOn: calendarDateSchema.nullable().default(null),
  mediaId: z.string().nullable().default(null),
})

/**
 * A manually recorded vehicle life-log event (SRS B-2 / س66). `state_change` is NOT here — that
 * kind is written automatically when a vehicle's state moves, never typed by hand. `cost` is an
 * optional decimal-string amount (money on the wire is never a number).
 */
export const createVehicleEventRequest = z.object({
  kind: z.enum(['maintenance', 'incident', 'charge', 'odometer_reading']),
  odometerKm: z.number().int().nonnegative().nullable().default(null),
  cost: moneySchema.nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
})

// ── Expenses (SRS G) ──────────────────────────────────────────────────────────────────────

export const createExpenseCategoryRequest = z.object({
  code: z.string().min(1).max(32),
  nameAr: z.string().min(1).max(120),
})

export const createExpenseRequest = z.object({
  branchId: z.string().optional(),
  categoryId: z.string().min(1),
  /** G-1: vehicle / branch / general — these feed per-axis profitability. */
  costCenterKind: z.enum(['vehicle', 'branch', 'general']),
  vehicleId: z.string().nullable().default(null),
  amount: moneySchema,
  businessDate: calendarDateSchema.optional(),
  description: z.string().min(1).max(500),
  /** Mandatory above the configured ceiling (G-3 / س52). */
  receiptMediaId: z.string().nullable().default(null),
})

// ── Treasury: daily count and manual entries (SRS E-3, E-5) ───────────────────────────────

export const createCashCountRequest = z.object({
  branchId: z.string().optional(),
  businessDate: calendarDateSchema.optional(),
  lines: z
    .array(
      z.object({
        fundCode: z.string().min(1),
        counted: moneySchema,
        /** Required by the manager when the variance is non-zero; recorded either way. */
        resolution: z.string().max(500).nullable().default(null),
      }),
    )
    .min(1),
  notes: z.string().max(1000).nullable().default(null),
})

export const manualEntryRequest = z.object({
  branchId: z.string().optional(),
  businessDate: calendarDateSchema.optional(),
  /** E-3 / س50: a manual entry without a stated reason is not auditable. */
  reason: z.string().min(1).max(500),
  evidenceMediaId: z.string().nullable().default(null),
  lines: z
    .array(z.object({ fundCode: z.string().min(1), side: z.enum(['D', 'C']), amount: moneySchema }))
    .min(2),
})

// ── Tier admin (SRS F-3…F-6) ───────────────────────────────────────────────────────────────

const bandSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0).nullable(),
  // Upper bound intentionally loose (10000). The domain's validateBands() owns the real rule —
  // driver share may not exceed 80% (Yallago's 20% is fixed) — and returns a 422 that says so.
  driverBps: z.number().int().min(0).max(10000),
})

export const publishTierRequest = z.object({
  basis: z.enum(['orders', 'revenue']).default('orders'),
  mode: z.enum(['whole', 'marginal']).default('whole'),
  vehicleTypeId: z.string().nullable().default(null),
  bands: z.array(bandSchema).min(1),
  effectiveFrom: calendarDateSchema,
})

export const simulateTierRequest = z.object({
  branchId: z.string().optional(),
  basis: z.enum(['orders', 'revenue']).default('orders'),
  mode: z.enum(['whole', 'marginal']).default('whole'),
  bands: z.array(bandSchema).min(1),
  from: calendarDateSchema,
  to: calendarDateSchema,
})

// ── Money admin ───────────────────────────────────────────────────────────────────────────

export const setFxRequest = z.object({
  businessDate: calendarDateSchema,
  /** SYP minor units per USD. 13000 = 130 new SYP/USD. */
  sypMinorPerUsd: z.number().int().positive(),
})

/**
 * General operating constants (SRS A-4). A FIXED set of known keys — never an arbitrary
 * key/value write, which would let a typo create a setting nothing reads. Money crosses as a
 * decimal string (moneySchema) and is stored as minor units, so a large ceiling keeps its
 * precision through JSON. Every field is optional: only what is sent changes.
 */
export const updateSettingsRequest = z.object({
  /** «سقف الإيصال» — above this an expense/manual entry needs a photographed receipt (G-3 / س52). */
  receiptCeilingMinor: moneySchema.optional(),
  /** «سعر الكيلوواط-ساعة» — fixed kWh price for charging cost (G-2 / س64). */
  kwhPriceMinor: moneySchema.optional(),
})

export const closeWeekRequest = z.object({
  closeDate: calendarDateSchema,
  /**
   * Which branch to seal.
   *
   * BR7's close is `week.close`, which the §3 matrix grants to the **system admin only** — and a
   * system admin is organisation-wide, so his session carries no branch. Without this field the
   * close had no branch channel at all and 422'd for the one role allowed to perform it: the
   * financial week could never be sealed through the API.
   */
  branchId: z.string().min(1).optional(),
})

export type LoginRequest = z.infer<typeof loginRequest>
export type CreateShiftRequest = z.infer<typeof createShiftRequest>
export type StartPackageRequest = z.infer<typeof startPackageRequest>
export type AddOrderRequest = z.infer<typeof addOrderRequest>
export type EndPackageRequest = z.infer<typeof endPackageRequest>
export type ApproveOpenRequest = z.infer<typeof approveOpenRequest>
