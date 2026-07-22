import { z } from 'zod'
import { type Minor, formatMinor, parseMinor } from '@ash/domain'

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

export const loginRequest = z.object({
  username: z.string().min(1).max(64),
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
  batteryPercent: z.number().int().min(0).max(100),
})

export const addOrderRequest = z.object({
  providerOrderNo: z.string().min(1).max(64),
  payMode: payModeSchema,
  fee: moneySchema,
  zone: z.string().max(64).nullable().default(null),
})

export const endPackageRequest = z.object({
  odometerKm: z.number().int().min(0),
  batteryPercent: z.number().int().min(0).max(100),
  cashDeclared: moneySchema,
  walletDeclared: moneySchema,
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

// ── Fleet (SRS B) ─────────────────────────────────────────────────────────────────────────

export const createDriverRequest = z.object({
  code: z.string().min(1).max(32),
  fullNameAr: z.string().min(1).max(120),
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
  username: z.string().min(3).max(40),
  password: z.string().min(8).max(200),
  roleKey: z.enum(['driver', 'branch_manager', 'system_admin', 'general_manager', 'accountant']),
  fullNameAr: z.string().min(1).max(120),
  // Required for a branch-scoped role (driver, branch_manager); ignored for global roles.
  branchId: z.string().optional(),
})

export const updateDriverRequest = z.object({
  fullNameAr: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
})

export const createVehicleRequest = z.object({
  code: z.string().min(1).max(32),
  vehicleTypeId: z.string().min(1),
})

export const updateVehicleRequest = z.object({
  /** «جاهزة/تشحن/صيانة/متوقفة» — only a `ready` vehicle may start a shift. */
  state: z.enum(['ready', 'charging', 'maintenance', 'stopped']).optional(),
  active: z.boolean().optional(),
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

export const closeWeekRequest = z.object({
  closeDate: calendarDateSchema,
})

export type LoginRequest = z.infer<typeof loginRequest>
export type CreateShiftRequest = z.infer<typeof createShiftRequest>
export type StartPackageRequest = z.infer<typeof startPackageRequest>
export type AddOrderRequest = z.infer<typeof addOrderRequest>
export type EndPackageRequest = z.infer<typeof endPackageRequest>
export type ApproveOpenRequest = z.infer<typeof approveOpenRequest>
