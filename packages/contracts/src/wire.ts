import { z } from 'zod'
import { MAX_BATTERY_SLOTS, type Minor, formatMinor, hasVisibleText, parseMinor } from '@ash/domain'

/**
 * Wire schemas.
 *
 * ── MONEY ON THE WIRE IS A DECIMAL STRING, NEVER A NUMBER ───────────────────────────────
 * `JSON.stringify` throws on a bigint, and any `z.number()` for money is a silent invitation to
 * IEEE-754. So every money field crosses the boundary as `"1234.56"` and is parsed into `Minor`
 * exactly once, here. `scripts/check-wire-money.mjs` greps for `z.number()` on money-shaped field
 * names so this cannot quietly regress.
 */
/**
 * What a money column can actually hold: PostgreSQL `bigint`, which every `*_minor` column is.
 *
 * The regex alone bounds the SHAPE and not the MAGNITUDE, so `"82296150060611100000226021100101000"`
 * — thirty-five digits, which is what the wallet reader produced from one screenshot — satisfied it,
 * became a perfectly good BigInt, and died at the database as `22003 out of range for type bigint`.
 * That surfaced as an unhandled 500 and the driver got «تعذّر تنفيذ العملية» on a shift whose
 * equation was exactly zero. A number this system cannot store is a bad request, not a server fault,
 * and it has to be refused at the edge where it can still be named.
 */
/**
 * The biggest training sample the wire accepts, in characters of data URL.
 *
 * EXPORTED because the driver must check it BEFORE sending. It did not, and an oversized odometer
 * sample failed `startPackageRequest` validation — so a picture kept for a future model returned 400
 * «البيانات المُدخلة غير صحيحة» and a driver could not start his shift. The server has always had
 * the right rule («a lost sample costs a future model one example; a thrown error costs a driver his
 * shift»); it just never ran, because Zod rejected the whole request first.
 */
export const MAX_OCR_SAMPLE_CHARS = 262_144

/**
 * How many shifts one driver may have on one business date.
 *
 * This is a runaway guard, not a business rule. It used to be 4, enforced on a number the CLIENT
 * supplied — which is where the real bug lived. Now the server derives the number and cancelled
 * shifts keep theirs, so a driver who starts and cancels a few times climbs faster than he works:
 * at 4 he would have been locked out of his own day by his own mistakes.
 */
export const MAX_SHIFTS_PER_DAY = 12

const MINOR_MAX = 9_223_372_036_854_775_807n
const MINOR_MIN = -9_223_372_036_854_775_808n

export const moneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'money must be a decimal string with at most 2 places')
  .transform((s): Minor => parseMinor(s))
  .refine((m) => m >= MINOR_MIN && m <= MINOR_MAX, 'money is larger than this system can store')

/** Physical cash counted at handover cannot be negative; wallet balances may be. */
export const nonnegativeMoneySchema = moneySchema.refine((m) => m >= 0n, 'cash cannot be negative')

/** A real disbursement tranche. Zero means "no tranche" and is represented by an empty array. */
export const positiveMoneySchema = moneySchema.refine((m) => m > 0n, 'tranche must be strictly positive')

/**
 * A reason is evidence, so a string made only from whitespace or invisible Unicode formatting
 * marks is no reason at all. JavaScript's `trim()` deliberately leaves characters such as U+200B
 * ZERO WIDTH SPACE in place; test the Unicode categories explicitly after trimming.
 */
export const nonblankReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(hasVisibleText, 'reason must include a visible character')

/**
 * An ordinary variance reason may be left blank by the manager. The service converts a blank or
 * invisible-only value into its deterministic system audit marker when the variance is nonzero;
 * this wire schema only trims and bounds the optional human input.
 */
const optionalVarianceReasonSchema = z.string().trim().max(500).nullable().default(null)

export const serializeMoney = (m: Minor): string => formatMinor(m)

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const realCalendarDateSchema = calendarDateSchema.refine((value) => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}, 'expected a real calendar date')
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
  /**
   * ACCEPTED AND IGNORED. The server derives the shift number — see `ShiftRepo.nextShiftNo`.
   *
   * It stays on the wire so a driver running a cached bundle that still sends `1` is not rejected
   * by the very deploy that fixes his problem.
   */
  shiftNo: z.number().int().min(1).max(MAX_SHIFTS_PER_DAY).optional(),
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
  /**
   * The dashboard as the reader saw it — TRAINING DATA, deliberately not evidence.
   *
   * A wider region than the fee strips on purpose: this reader's failure is not a misread digit but
   * a wrong CHOICE of number (it answered 200 for 6948), so a tight crop would preserve the mistake.
   * 256 KB ceiling; the prepared image is typically 15–40 KB.
   */
  odometerStrip: z.string().max(MAX_OCR_SAMPLE_CHARS).nullable().default(null),
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
  /**
   * `refused` is its own answer, and losing it was throwing away the best training signal there is.
   *
   * A row the reader SAW and declined to price used to arrive as `manual` with a null baseline —
   * indistinguishable from a fee somebody typed from memory. Those two are opposites: a refusal is a
   * hard glyph, at real phone scale, with a human's correct answer about to be attached to it. That
   * is the example a classifier learns most from, and it was being discarded at the wire.
   */
  source: z.enum(['manual', 'ocr', 'refused']).default('manual'),
  feeOcr: moneySchema.nullable().default(null),
  /**
   * The fee's own pixels as a PNG data URL — TRAINING DATA, deliberately not evidence.
   *
   * The evidence screenshot is compressed to ~300 KB / 1280 px / quality 0.4 before upload, which at
   * twelve by sixteen pixels a glyph destroys the strokes a model would learn from. This is cut
   * losslessly from what the reader was handed, and holds the amount and nothing else — no address,
   * no name, no map pin — so it carries none of the privacy weight the screenshot does.
   * Bounded at 64 KB; a real strip is about 2 KB.
   */
  feeStrip: z.string().max(65536).nullable().default(null),
  included: z.boolean().default(true),
  /** `yallago` (their delivery) or `manual` (a job the branch took itself). */
  kind: z.enum(['yallago', 'manual']).default('yallago'),
  /**
   * Manual orders only — the agreed split, as money (a decimal string, never a JSON number: a share
   * must not pass through IEEE-754 on its way in). The server refuses a manual order whose two
   * shares do not add up to its fee exactly, which is what keeps the ledger able to close.
   */
  driverShare: nonnegativeMoneySchema.nullable().default(null),
  companyShare: nonnegativeMoneySchema.nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
  /** Start, end, and any stops between. Empty for a Yallago order. */
  points: z.array(orderPointRequest).max(20).default([]),
  /**
   * Checked at close. `false` keeps the order with the shift but takes it out of BR1, the tier
   * band and the ledger — the screenshots overlap and show previous days, so a read list always
   * contains rows that are not this shift's.
   */
  /**
   * How much of this fee reached the WALLET, measured off «سجل المدفوعات». Money, so it crosses as
   * a decimal string — never a JSON number. `null` means unmeasured and the pay mode decides.
   */
  walletAmount: moneySchema.nullable().default(null),
  /** «HH:MM» off the dashboard: what a log row is paired to. */
  occurredMinute: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (00:00-23:59)')
    .nullable()
    .default(null),
})

/**
 * A manager correcting a closing figure at the review. Every field optional: he sends the one he is
 * fixing and leaves the rest alone. Money as decimal strings, never JSON numbers.
 */
export const closeFiguresRequest = z.object({
  odometerKm: z.number().int().min(0).nullable().default(null),
  odometerAnomalyConfirmed: z.boolean().default(false),
  cashDeclared: nonnegativeMoneySchema.nullable().default(null),
  walletDeclared: moneySchema.nullable().default(null),
})

/** «HH:MM» as read off a screenshot. `''` on a movement means the clock was not legible. */
const minuteSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (00:00-23:59)')
/** «YYYY-MM-DD», the day PRINTED on the screen — already local, never converted. */
const isoDateSchema = realCalendarDateSchema

/** Server-derived classification against the immutable open/close instants. */
export const operationWindowStatusSchema = z.enum([
  'in_window',
  'pre_open',
  'post_close',
  'open_minute_boundary',
  'close_minute_boundary',
  'unknown',
])

/**
 * Advisory hint that two scans of one list share rows. Read-only: it changes no money, no
 * inclusion, and no order. Cause codes come straight from the domain; the UI resolves the strings.
 */
export const scanOverlapCauseSchema = z.enum([
  'scan_overlap_suffix_prefix',
  'scan_overlap_amount_only',
  'scan_overlap_direction_ambiguous',
])

export const scanOverlapPairCauseSchema = z.enum([
  'scan_overlap_pair_amount_agrees',
  'scan_overlap_pair_minute_agrees',
  'scan_overlap_pair_route_agrees',
])

const scanDuplicateHintPageSchema = z.object({
  slot: z.string().min(1).max(64),
  mediaId: z.string().min(1).max(64),
})

export const scanDuplicateHintOperationRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('order'),
    providerOrderNo: z.string().min(1).max(160),
    observationId: z.string().min(1).max(64),
    rowIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal('cash_deduction'),
    id: z.string().min(1).max(64),
    observationId: z.string().min(1).max(64),
    rowIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal('unmatched_row'),
    observationId: z.string().min(1).max(64),
    rowIndex: z.number().int(),
  }),
])

export const scanDuplicateHintSchema = z.object({
  earlier: scanDuplicateHintPageSchema,
  later: scanDuplicateHintPageSchema,
  length: z.number().int().positive(),
  causes: z.array(scanOverlapCauseSchema),
  pairs: z.array(z.object({
    earlier: scanDuplicateHintOperationRefSchema,
    later: scanDuplicateHintOperationRefSchema,
    causes: z.array(scanOverlapPairCauseSchema),
  })),
})

export type ScanDuplicateHintWire = z.infer<typeof scanDuplicateHintSchema>

const cashDeductionRequest = z.object({
  /** Stable across overlapping OCR pages and retries. */
  operationKey: z.string().min(1).max(160),
  /** Positive magnitude; the source screen's minus sign describes this operation kind. */
  amount: moneySchema.refine((v) => v > 0n, 'cash deduction must be positive'),
  occurredMinute: minuteSchema.nullable().default(null),
  occurredDate: isoDateSchema.nullable().default(null),
  source: z.enum(['manual', 'ocr', 'refused']).default('manual'),
  amountOcr: moneySchema.refine((v) => v > 0n, 'OCR deduction must be positive').nullable().default(null),
  amountStrip: z.string().max(65536).nullable().default(null),
  pointA: z.string().max(200).nullable().default(null),
  pointB: z.string().max(200).nullable().default(null),
})

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
        source: z.enum(['manual', 'ocr', 'refused']).default('manual'),
        feeOcr: moneySchema.nullable().default(null),
        feeStrip: z.string().max(65536).nullable().default(null),
        included: z.boolean().default(true),
        walletAmount: moneySchema.nullable().default(null),
        occurredMinute: minuteSchema.nullable().default(null),
        // The day the SCREEN says, which is not always the shift's day: the list scrolls back.
        occurredDate: isoDateSchema.nullable().default(null),
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
  cashDeductions: z.array(cashDeductionRequest).max(400).default([]),
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
        /**
         * The fee, corrected by the manager.
         *
         * He is the one verifying against the cash in his hand, and until now his only move against
         * a fee he disbelieved was to exclude the whole delivery — throwing away a real order to
         * fix one wrong number. Correcting it also turns the stored value from «what the driver
         * typed» into «what a manager verified», which is a materially better label for the OCR
         * training samples that join it.
         *
         * Every change is already attributed: the `audit_shift_orders` trigger writes before/after
         * with the actor from the transaction GUC, and the edit moves `orders_hash`, so the
         * staleness guard forces a fresh review before the ledger can be posted.
         *
         * Refused below zero. `moneySchema` allows a sign because `walletAmount` genuinely needs
         * one, but a delivery fee does not: a negative fee flips Yallago's 20% cut into a credit
         * and lets BR1 be satisfied by arithmetic that describes nothing that happened. (The
         * driver's own `addOrderRequest.fee` may still be negative for cached-PWA compatibility;
         * the service stores that sign as a positive cash-deduction magnitude, never as an order.)
         */
        fee: moneySchema.refine((v) => v >= 0n, 'fee cannot be negative').optional(),
        occurredMinute: minuteSchema.nullable().optional(),
        occurredDate: isoDateSchema.nullable().optional(),
        /**
         * Required by the service whenever inclusion or timing is changed, and the ONLY record of
         * why a delivery fee entered or left BR1. `nonblankReasonSchema` rather than a bare trim:
         * an Arabic-first UI routinely carries invisible bidi marks through copy-paste, and
         * `'‏'.trim()` is truthy — so a reason nobody can read used to be an audit trail.
         */
        reason: nonblankReasonSchema.optional(),
      }),
    )
    .max(400)
    .default([]),
  cashDeductions: z
    .array(
      z.object({
        id: z.string().min(1),
        included: z.boolean().optional(),
        occurredMinute: minuteSchema.nullable().optional(),
        occurredDate: isoDateSchema.nullable().optional(),
        /** Same reasoning as the order decision reason above. */
        reason: nonblankReasonSchema,
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
  /** Optimistic close-draft identity. Required by the service once a durable draft exists. */
  draftRevision: z.number().int().min(0).optional(),
  draftHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /**
   * Explicitly hand incomplete fitted-pack evidence to the manager instead of keeping the driver
   * clocked in. Complete end-pack readings/evidence remain untouched. Cached clients that omit
   * this flag retain the stricter historical gate.
   */
  deferMissingBatteryEvidenceToManager: z.boolean().default(false),
  odometerKm: z.number().int().min(0),
  /** What the end reader produced before the driver's confirmation. Evidence, not a gate. */
  odometerKmOcr: z.number().int().min(0).nullable().catch(null).default(null),
  /** Explicit acknowledgement when the end value is below the opening value. */
  odometerAnomalyConfirmed: z.boolean().default(false),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  cashDeclared: nonnegativeMoneySchema,
  walletDeclared: moneySchema,
  /**
   * SRS D-3 baseline: what `readWallet` OCR'd off the close wallet screenshot before the driver
   * confirmed. Money, so it crosses as a decimal string via `moneySchema` — never a JSON number.
   *
   * `.catch(null)` — and ONLY here. This field is EVIDENCE, not money: nothing in BR1 reads it, no
   * ledger line derives from it, and its whole job is to show the manager «the reader said X, the
   * driver confirmed Y». An unusable reading is therefore no reading, which the rest of this system
   * already spells `null`. The alternative is what happened in production: a misread baseline
   * refused the request and a shift balancing to exactly 0.00 could not be handed over, because a
   * cosmetic field disagreed. The driver PWA is cached and updates late, so an old build must still
   * be able to close a correct shift.
   *
   * Every OTHER money field stays strict. `cashDeclared`, `walletDeclared`, fees, floats and top-ups
   * are what the equation is made of — silently turning one of those into null would be inventing a
   * number, which is the one thing this system must never do.
   */
  walletDeclaredOcr: moneySchema.nullable().catch(null).default(null),
  /** The wallet screen as the reader saw it — training data, same rules as `odometerStrip`. */
  walletStrip: z.string().max(MAX_OCR_SAMPLE_CHARS).nullable().default(null),
  /** The closing dashboard as the reader saw it. */
  odometerStrip: z.string().max(MAX_OCR_SAMPLE_CHARS).nullable().default(null),
})

const closeDraftFiguresPatch = z.object({
  odometerKm: z.number().int().min(0).nullable().optional(),
  odometerAnomalyConfirmed: z.boolean().optional(),
  cashDeclared: nonnegativeMoneySchema.nullable().optional(),
  walletDeclared: moneySchema.nullable().optional(),
}).strict()

const closeDraftClientOrder = z.object({
  clientKey: z.string().min(1).max(160),
  providerOrderNo: z.string().max(64),
  payMode: payModeSchema,
  fee: nonnegativeMoneySchema.nullable(),
  occurredMinute: minuteSchema.nullable().default(null),
  occurredDate: isoDateSchema.nullable().default(null),
  pointA: z.string().max(200).nullable().default(null),
  pointB: z.string().max(200).nullable().default(null),
  source: z.literal('manual').default('manual'),
})

const closeDraftRowEdit = z
  .object({
    clientKey: z.string().min(1).max(160),
    kind: z.enum(['order', 'cash_deduction', 'movement']),
    fee: nonnegativeMoneySchema.nullable().optional(),
    amount: moneySchema.refine((v) => v > 0n, 'cash deduction must be positive').nullable().optional(),
    occurredMinute: minuteSchema.nullable().optional(),
    occurredDate: isoDateSchema.nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    ambiguous: z.boolean().optional(),
  })
  .strict()
  .superRefine((edit, ctx) => {
    if (edit.kind === 'order' && (edit.amount !== undefined || edit.notes !== undefined || edit.ambiguous !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'unsupported order edit field' })
    }
    if (edit.kind === 'cash_deduction' &&
        (edit.fee !== undefined || edit.notes !== undefined || edit.ambiguous !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'unsupported cash-deduction edit field' })
    }
    if (edit.kind === 'movement' && (edit.fee !== undefined || edit.occurredDate !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'unsupported movement edit field' })
    }
  })

const closeDraftClientDeduction = z.object({
  clientKey: z.string().min(1).max(160),
  operationKey: z.string().min(1).max(160),
  amount: moneySchema.refine((v) => v > 0n, 'cash deduction must be positive').nullable(),
  occurredMinute: minuteSchema.nullable().default(null),
  occurredDate: isoDateSchema.nullable().default(null),
  pointA: z.string().max(200).nullable().default(null),
  pointB: z.string().max(200).nullable().default(null),
  source: z.literal('manual').default('manual'),
})

const closeDraftClientMovement = z.object({
  clientKey: z.string().min(1).max(160),
  amount: moneySchema,
  occurredMinute: minuteSchema.nullable().default(null),
  role: movementRole.default('unmatched'),
  providerOrderNo: z.string().max(64).nullable().default(null),
  ambiguous: z.boolean().default(false),
  notes: z.string().max(2000).nullable().default(null),
  source: z.literal('manual').default('manual'),
})

/** Human-editable close state only; read identities, evidence links and window basis are server-owned. */
export const patchCloseDraftRequest = z.object({
  expectedRevision: z.number().int().min(0),
  figures: closeDraftFiguresPatch.optional(),
  operations: z
    .object({
      manualOrders: z.array(closeDraftClientOrder).max(400).optional(),
      manualCashDeductions: z.array(closeDraftClientDeduction).max(400).optional(),
      manualMovements: z.array(closeDraftClientMovement).max(400).optional(),
      rowEdits: z.array(closeDraftRowEdit).max(400).optional(),
    })
    .optional(),
})

export const linkedCloseDraftReadRequest = z.object({
  expectedRevision: z.number().int().min(0),
  mediaId: z.string().min(1),
  attachmentToken: z.string().min(1),
  field: z.enum(['orders', 'payments_log', 'wallet', 'odometer', 'bms']),
  retryFailed: z.boolean().default(false),
})

export const restoreCloseDraftAttachmentRequest = z.object({
  expectedRevision: z.number().int().min(0),
  expectedAttachmentToken: z.string().min(1).nullable(),
  reason: z.string().trim().min(1).max(500),
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
  floatTranches: z.array(positiveMoneySchema).max(32_767),
  topupTranches: z.array(positiveMoneySchema).max(32_767),
  /**
   * «الذمة المرحّلة» — cash the driver already holds from an earlier shift, consumed here.
   *
   * The office hands over only the difference, so this is not new money leaving the box. It is the
   * exact cash balance shown in the manager's review, expressed as one positive tranche or an
   * explicit empty array for zero. An omitted field from an older client therefore asserts a
   * reviewed balance of zero; the service compares that zero without treating it as a wildcard.
   */
  carriedTranches: z.array(positiveMoneySchema).max(32_767).default([]),
  /** Exact reviewed wallet shift-funding balance; an empty array explicitly binds approval to zero. */
  carriedWalletTranches: z.array(positiveMoneySchema).max(32_767).default([]),
})

export const settlementVarianceDirectionSchema = z.enum(['surplus', 'shortage', 'balanced'])
export const settlementWalletActionSchema = z.enum(['collect', 'fund', 'none'])
export const settlementCashActionSchema = z.enum(['collect', 'pay', 'none'])
export const settlementPolicySchema = z.enum([
  'fixed_40_cash_close_v1',
  'fixed_40_cash_close_v2_receivable',
])

/** Money in an API RESPONSE: validated decimal text which deliberately stays text. */
export const settlementMoneyStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'money must be a decimal string with at most 2 places')
  .refine((s) => {
    try {
      const value = parseMinor(s)
      return value >= MINOR_MIN && value <= MINOR_MAX
    } catch {
      return false
    }
  }, 'money is larger than this system can store')

/** Live branch+driver shift funding included in the manager's locked review snapshot. */
export const shiftFundingPreviewSchema = z.object({
  cash: settlementMoneyStringSchema,
  wallet: settlementMoneyStringSchema,
})

/** The decision-complete settlement preview returned to the manager. */
export const shiftSettlementViewSchema = z.object({
  policyCode: settlementPolicySchema,
  driverRateBps: z.literal(4_000),
  deliveryFeeTotal: settlementMoneyStringSchema,
  fixedDriverShare: settlementMoneyStringSchema,
  manualDriverShare: settlementMoneyStringSchema,
  grossDriverShare: settlementMoneyStringSchema,
  cashDeductionTotal: settlementMoneyStringSchema,
  baseDriverShare: settlementMoneyStringSchema,
  expectedTotal: settlementMoneyStringSchema,
  actualCash: settlementMoneyStringSchema,
  actualWallet: settlementMoneyStringSchema,
  actualTotal: settlementMoneyStringSchema,
  variance: settlementMoneyStringSchema,
  varianceDirection: settlementVarianceDirectionSchema,
  finalEmployeeCash: settlementMoneyStringSchema,
  cashClaimToOffice: settlementMoneyStringSchema,
  walletClaimToOffice: settlementMoneyStringSchema,
  cashReceivableDeferred: settlementMoneyStringSchema,
  walletReceivableDeferred: settlementMoneyStringSchema,
  walletToOffice: settlementMoneyStringSchema,
  cashToOffice: settlementMoneyStringSchema,
  walletAction: settlementWalletActionSchema,
  walletAmount: settlementMoneyStringSchema,
  cashAction: settlementCashActionSchema,
  cashAmount: settlementMoneyStringSchema,
  settlementHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
})

/**
 * Strict confirmation shape for the fixed policy. The approve request below keeps these fields
 * optional/defaulted so an old client receives a named service refusal rather than a Zod 400; the
 * approval service validates this strict schema before it can post or persist the snapshot.
 */
export const fixedSettlementConfirmationSchema = z.object({
  reviewedSettlementHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
  walletTransferConfirmed: z.literal(true),
  cashSettlementConfirmed: z.literal(true),
  varianceReason: optionalVarianceReasonSchema,
})

export const approveCloseRequest = z.object({
  /** The hash the manager actually reviewed. Re-checked inside the approval transaction. */
  reviewedOrdersHash: z.string().min(1),
  /** Legacy field: cash kept with the driver as funding auto-consumed by his next shift. */
  keepAsReceivable: moneySchema.optional(),
  /**
   * «يُعاد للسائق» — pay his share tonight out of the cash in his hands (owner decision f).
   *
   * Kept only to identify an obsolete client choice. Do not default an omitted field to `false`:
   * the fixed-policy request deliberately omits this legacy switch, while an explicitly sent false
   * must remain distinguishable so the service can refuse the old leave-as-payable workflow.
   */
  payShareNow: z.boolean().optional(),
  /** Legacy-named positive collections retained as funding auto-consumed by the next shift. */
  cashReceivableDeferred: nonnegativeMoneySchema.optional(),
  walletReceivableDeferred: nonnegativeMoneySchema.optional(),
  /** Fixed-policy preview hash. Optional on the wire solely for a controlled old-client refusal. */
  reviewedSettlementHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest').optional(),
  /** Both physical actions must be explicitly confirmed before the service persists a settlement. */
  walletTransferConfirmed: z.boolean().default(false),
  cashSettlementConfirmed: z.boolean().default(false),
  /** Optional human context; a nonzero variance always receives a nonblank server audit marker. */
  varianceReason: optionalVarianceReasonSchema,
})

const forceCloseBaseRequest = z.object({
  reason: nonblankReasonSchema,
  odometerKm: z.number().int().min(0).nullable().default(null),
  odometerAnomalyConfirmed: z.boolean().default(false),
  /** Force-close still settles real money: both reviewed actual balances are mandatory. */
  cashDeclared: nonnegativeMoneySchema,
  walletDeclared: moneySchema,
})

/**
 * Phase one claims the close boundary and persists the manager-counted figures. It deliberately has
 * no transfer confirmations: no wallet/cash action may be performed against a pre-boundary preview.
 */
export const prepareForceCloseRequest = forceCloseBaseRequest.extend({
  prepareOnly: z.literal(true),
})

/** Phase two posts only the exact final preview and both physical confirmations. */
export const commitForceCloseRequest = forceCloseBaseRequest.extend({
  prepareOnly: z.literal(false).optional(),
  reviewedSettlementHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest'),
  walletTransferConfirmed: z.literal(true),
  cashSettlementConfirmed: z.literal(true),
  cashReceivableDeferred: nonnegativeMoneySchema.optional(),
  walletReceivableDeferred: nonnegativeMoneySchema.optional(),
})

/** Upper-level force-close is an explicit prepare-then-settle protocol. */
export const forceCloseRequest = z.union([prepareForceCloseRequest, commitForceCloseRequest])

/**
 * A second (or later) cash-float or wallet top-up disbursed mid-day (SRS C-5). Money the branch
 * hands the driver after open-approval, posted as one more tranche under its own occurrence key.
 */
export const addTrancheRequest = z.object({
  kind: z.enum(['float', 'topup']),
  amount: positiveMoneySchema,
  /**
   * ONE KEY PER INTENDED DISBURSEMENT, minted by the client before it first sends.
   *
   * Without it the server derived the ledger's occurrence key from `tranches.length + 1`, so a
   * SEQUENTIAL retry — the manager tapping twice on a slow office connection, or the app retrying
   * a timed-out request — was not a replay at all: it was tranche #2. Two entries, twice the cash
   * out of `office_cash`, and BR1 then expecting the driver to return money he never received,
   * which makes the shift unclosable.
   *
   * Kept optional at the parser only so an older admin receives the named
   * `428 admin_update_required` service response instead of an opaque schema error. The service
   * never derives an ordinal fallback, and the supported admin console always sends this key.
   */
  occurrenceKey: z.string().trim().min(1).max(64).optional(),
})

/**
 * Correct an overstated office-funded wallet top-up on a financially open shift.
 *
 * Both totals are supplied so a manager cannot overwrite a tranche added after the screen was
 * loaded. Increases remain ordinary `/tranche` disbursements; this command only returns a positive
 * difference from the driver's wallet to the office wallet as a visible correction.
 */
export const adjustWalletTopupRequest = z.object({
  expectedCurrentTotal: nonnegativeMoneySchema,
  targetTotal: nonnegativeMoneySchema,
  occurrenceKey: z.string().trim().min(1).max(64),
  reason: nonblankReasonSchema,
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
  /** «الرقم التمييزي على الأرض» — what is marked on the machine, as a driver reads it in the yard. */
  groundNo: z.string().max(32).nullable().default(null),
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
  /** «الرقم التمييزي» — what is marked on the pack, as staff read it at the shelf. */
  groundNo: z.string().max(32).nullable().default(null),
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
  /** Correctable, and an explicit null is the honest record of a pack carrying no legible number. */
  groundNo: z.string().max(32).nullable().optional(),
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
  /**
   * Who produced this figure. `manager` is NOT `manual`: a value the branch manager took on his own
   * device, after the driver's phone could not, is a different fact from one the driver typed, and
   * the two must not be distinguishable only by reading the audit log.
   */
  source: z.enum(['ocr', 'manual', 'manager']).default('manual'),
  /**
   * «تطبيق البطارية لا يعمل على جهازي».
   *
   * The driver declaring that this pack cannot be read on his phone at all. It unblocks HIM — the
   * gate stops demanding a screenshot he is incapable of taking — and blocks the MANAGER, who
   * cannot approve the shift until he has read the pack himself. Evidence moved, never waived.
   */
  unavailable: z.boolean().default(false),
  ocrRaw: z.unknown().optional(),
})

export type BatteryReadingFields = z.infer<typeof batteryReadingFields>

export const batteryReadingRequest = batteryReadingFields.extend({
  batteryId: z.string().min(1),
  /** Optional for cached PWAs; current clients use it to reject a replaced evidence generation. */
  expectedMediaId: z.string().min(1).optional(),
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
  /**
   * The marking on the machine. Correctable, because paint wears off and bikes get re-marked — and
   * an explicit `null` is the honest record of a bike carrying no legible number, not a blank to be
   * confused with "unchanged". Omitting the key leaves it alone; sending null clears it.
   */
  groundNo: z.string().max(32).nullable().optional(),
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

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected a 24-hour local time (HH:MM)')

/**
 * Advance manager authorization for automatic opening on explicitly selected dates.
 *
 * Windows never wrap midnight. The shift's business date is a written local date, so a wrapping
 * window would otherwise make it ambiguous which custom date owns the after-midnight half. A
 * manager who needs both sides can create two explicit date rules instead.
 */
export const createPreapprovedShiftRulesRequest = z
  .object({
    branchId: z.string().min(1).optional(),
    driverId: z.string().min(1),
    dates: z.array(realCalendarDateSchema).min(1).max(62),
    windowStart: localTimeSchema,
    windowEnd: localTimeSchema,
    cashFloat: nonnegativeMoneySchema,
    walletTopup: nonnegativeMoneySchema,
  })
  .superRefine((value, ctx) => {
    if (new Set(value.dates).size !== value.dates.length) {
      ctx.addIssue({ code: 'custom', path: ['dates'], message: 'custom dates must be unique' })
    }
    if (value.windowStart >= value.windowEnd) {
      ctx.addIssue({
        code: 'custom',
        path: ['windowEnd'],
        message: 'window end must be after window start on the same day',
      })
    }
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

const positiveExpenseMoneySchema = moneySchema.refine(
  (amount) => amount > 0n,
  'expense amount must be strictly positive',
)

export const createExpenseRequest = z.object({
  branchId: z.string().optional(),
  /** Client-owned UUID: exact retries reuse it; a new expense must generate a new one. */
  idempotencyKey: z.string().uuid(),
  categoryId: z.string().min(1),
  /** G-1: vehicle / branch / general — these feed per-axis profitability. */
  costCenterKind: z.enum(['vehicle', 'branch', 'general']),
  vehicleId: z.string().nullable().default(null),
  amount: positiveExpenseMoneySchema,
  businessDate: calendarDateSchema.optional(),
  description: z.string().min(1).max(500),
  /** Mandatory above the configured ceiling (G-3 / س52). */
  receiptMediaId: z.string().nullable().default(null),
})

/** Direct debt creation/collection, explicitly outside any shift. */
export const createReceivableEventRequest = z.object({
  branchId: z.string().optional(),
  driverId: z.string().min(1),
  receivableKind: z.enum(['ordinary', 'shift_funding']),
  channel: z.enum(['cash', 'wallet']),
  direction: z.enum(['create', 'collect']),
  amount: positiveMoneySchema,
  reason: nonblankReasonSchema,
  idempotencyKey: z.string().uuid(),
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
export type PatchCloseDraftRequest = z.infer<typeof patchCloseDraftRequest>
export type LinkedCloseDraftReadRequest = z.infer<typeof linkedCloseDraftReadRequest>
export type RestoreCloseDraftAttachmentRequest = z.infer<typeof restoreCloseDraftAttachmentRequest>
export type ApproveOpenRequest = z.infer<typeof approveOpenRequest>
export type CreatePreapprovedShiftRulesRequest = z.infer<typeof createPreapprovedShiftRulesRequest>
export type ShiftFundingPreview = z.infer<typeof shiftFundingPreviewSchema>
