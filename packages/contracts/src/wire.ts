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
  /** SRS C-5: several tranches per day are legitimate, so this is a list, not a scalar. */
  floatTranches: z.array(moneySchema).min(0),
  topupTranches: z.array(moneySchema).min(0),
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

export const approveCloseRequest = z.object({
  /** The hash the manager actually reviewed. Re-checked inside the approval transaction. */
  reviewedOrdersHash: z.string().min(1),
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
