import type { Deps, OcrField, OcrResult } from '@ash/contracts'
import { ServiceError } from './shifts.service.ts'
import { MAX_UPLOAD_BYTES, sha256Of, sniffImageType } from './media.service.ts'

/**
 * Reading a driver's screenshot with a paid vision model.
 *
 * This endpoint exists because the EVIDENCE photo cannot be read. `PhotoSlot` uploads a copy
 * compressed to 1280 px at quality 0.4 — migration 0019 calls that compression "the single largest
 * accuracy lever in the whole feature" — and every accuracy number we have was measured on
 * originals. So the phone sends the larger image here, gets numbers back, and uploads the small one
 * as evidence separately. Two requests, two different pictures, on purpose.
 *
 * THE ONE RULE THIS FILE ENFORCES ABOVE ALL OTHERS: a read that fails is a read that returns
 * `{ ok: false }`. It is never a non-2xx, never an exception the driver's screen has to handle, and
 * never anything that can stop a shift being handed over. `wire.ts:322-337` carries the incident —
 * a misread baseline refused a request and a shift balancing to exactly 0.00 could not be closed
 * because a cosmetic field disagreed. Only the checks that mean "this request is malformed" throw.
 *
 * WHAT IS AUTHORITATIVE. The cloud reading prefills the driver's field and lands in `feeOcr` /
 * `odometerKmOcr` / `walletDeclaredOcr` as the D-3 baseline, so the manager's «OCR → confirmed»
 * delta describes the reader that actually made the suggestion. The on-device reader keeps running
 * and keeps its answer beside the strip, because a strip with no reading beside it is not training
 * data — it is an unlabelled image.
 */

/**
 * A tuple, not a `readonly OcrField[]`, because `z.enum()` needs the literal members to build the
 * route's parameter schema. `OCR_FIELDS` is the same list for `includes()` checks.
 */
export const OCR_FIELDS_TUPLE = ['orders', 'payments_log', 'wallet', 'odometer', 'bms'] as const
export const OCR_FIELDS: readonly OcrField[] = OCR_FIELDS_TUPLE

export interface ReadInput {
  shiftId: string
  field: OcrField
  bytes: Uint8Array
  requestedBy: string
  /** From config. Zero disables the cap entirely, which is not a mode we ship. */
  maxReadsPerShift: number
}

export interface ReadOutput {
  result: OcrResult
  /** True when these exact pixels had been read before and nothing was billed. */
  cached: boolean
  /** How many billed reads this shift has now used, and its ceiling. Shown to nobody; logged. */
  reads: { used: number; max: number }
}

export async function readScreen(deps: Deps, input: ReadInput): Promise<ReadOutput> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  if (!OCR_FIELDS.includes(input.field)) throw new ServiceError(422, 'unknown_ocr_field', { field: input.field })

  // Malformed input throws; an unreadable IMAGE does not. A client that posts an empty body or a
  // PDF has a bug, and a 4xx is how it finds out.
  if (input.bytes.length === 0) throw new ServiceError(422, 'empty_upload')
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ServiceError(413, 'upload_too_large', { bytes: input.bytes.length, max: MAX_UPLOAD_BYTES })
  }
  const mimeType = sniffImageType(input.bytes)
  if (!mimeType) throw new ServiceError(415, 'not_an_image')

  const sha256 = sha256Of(input.bytes)

  // ── 1. Have we already paid for these exact pixels? ──────────────────────────────────────
  //
  // Before the cap, deliberately. A cache hit costs nothing, so it must not consume a driver's
  // budget — capping cache hits would punish him for the network being bad on the retry.
  const cachedRead = await deps.ocrReads.findBySha(shift.branchId, sha256, input.field)
  if (cachedRead) {
    const used = await deps.ocrReads.countBilledForShift(input.shiftId)
    return {
      result: safeFieldResult(input.field, cachedRead.result),
      cached: true,
      reads: { used, max: input.maxReadsPerShift },
    }
  }

  // ── 2. Is the reader even switched on? ───────────────────────────────────────────────────
  //
  // `OCR_DRIVER=none` is the kill switch and the default. `unavailable` is exactly what the phone
  // needs to hear: it means "use your own reader", which it still has.
  if (!deps.ocr.available) {
    return { result: { ok: false, reason: 'unavailable' }, cached: false, reads: { used: 0, max: input.maxReadsPerShift } }
  }

  // ── 3. The cap. ──────────────────────────────────────────────────────────────────────────
  //
  // A runaway guard, not a business rule. Past it the driver has the on-device reader and a
  // keyboard, which is where he was a week ago — so this refuses spending, never work.
  const used = await deps.ocrReads.countBilledForShift(input.shiftId)
  if (used >= input.maxReadsPerShift) {
    return {
      result: { ok: false, reason: 'unavailable' },
      cached: false,
      reads: { used, max: input.maxReadsPerShift },
    }
  }

  // ── 4. Ask. ──────────────────────────────────────────────────────────────────────────────
  const reading = await deps.ocr.read({ field: input.field, bytes: input.bytes, mimeType })
  const result = safeFieldResult(input.field, reading.result)

  /*
   * FAILURES ARE STORED TOO, and that is the point rather than an oversight.
   *
   * A timeout that is not recorded is a timeout that will be paid for again on the next retry, and
   * again after that. The row is the receipt; `{"ok":false,"reason":"timeout"}` is a perfectly good
   * thing for a receipt to say.
   *
   * The write is awaited, not fired and forgotten. On Vercel the instance can be frozen the moment
   * the response is sent, so a `void` here would drop the very record that stops us paying twice.
   */
  await deps.ocrReads.put({
    id: deps.ids.uuid(),
    branchId: shift.branchId,
    shiftId: input.shiftId,
    field: input.field,
    sha256,
    byteSize: input.bytes.length,
    model: deps.ocr.model,
    result,
    tokensIn: reading.usage.tokensIn,
    tokensOut: reading.usage.tokensOut,
    latencyMs: reading.usage.latencyMs,
    createdAt: deps.clock.nowMs(),
    createdBy: input.requestedBy,
  })

  return { result, cached: false, reads: { used: used + 1, max: input.maxReadsPerShift } }
}

/**
 * The wallet screen contains exactly one balance. Never let a provider that echoed a status-bar
 * number or a payment row make the phone's "take the first row" policy choose arbitrarily.
 * OpenAI's adapter already requires 2/3 AI agreement; this boundary pins the invariant for every
 * future provider and for scripted/conformance readers too.
 */
function safeFieldResult(field: OcrField, result: OcrResult): OcrResult {
  if (field !== 'wallet' || !result.ok) return result
  if (result.rows.length !== 1 || result.rows[0]?.cancelled || result.rows[0]?.value === null) {
    return { ok: false, reason: 'no_fields' }
  }
  return result
}
