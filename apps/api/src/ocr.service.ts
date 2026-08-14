import type { Deps, OcrField, OcrReadRecord, OcrResult } from '@ash/contracts'
import { ServiceError } from './shifts.service.ts'
import { MAX_UPLOAD_BYTES, sha256Of, sniffImageType } from './media.service.ts'

/**
 * Paid cloud OCR is an optional prefill limb. Malformed requests are 4xx, but an upstream failure
 * is always `{ ok: false }` in a 200 response and can never block shift handover.
 *
 * Cache identity includes the reader's model/config/prompt/validation signature, so a changed
 * reader never serves an answer produced by an older one.
 */

export const OCR_FIELDS_TUPLE = ['orders', 'payments_log', 'wallet', 'odometer', 'bms'] as const
export const OCR_FIELDS: readonly OcrField[] = OCR_FIELDS_TUPLE

/** Below the function ceiling, but above every configured logical-read/pass timeout. */
const OCR_ATTEMPT_LEASE_MS = 55_000
const OCR_RUNNING_INITIAL_POLL_MS = 500
const OCR_RUNNING_MAX_POLL_MS = 3_000
const OCR_RUNNING_MAX_WAIT_MS = 50_000

export interface ReadInput {
  shiftId: string
  field: OcrField
  bytes: Uint8Array
  requestedBy: string
  /** Zero disables the cap. */
  maxReadsPerShift: number
  /** Only an explicit user action may consume the single second attempt. */
  retryFailed?: boolean
}

export interface ReadOutput {
  result: OcrResult
  /** True when this request did not own a billed logical OCR attempt. */
  cached: boolean
  /** Whether this exact cache identity can still consume its one explicit second attempt. */
  retryable: boolean
  reads: { used: number; max: number }
}

export async function readScreen(deps: Deps, input: ReadInput): Promise<ReadOutput> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  if (!OCR_FIELDS.includes(input.field)) throw new ServiceError(422, 'unknown_ocr_field', { field: input.field })

  if (input.bytes.length === 0) throw new ServiceError(422, 'empty_upload')
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ServiceError(413, 'upload_too_large', { bytes: input.bytes.length, max: MAX_UPLOAD_BYTES })
  }
  const mimeType = sniffImageType(input.bytes)
  if (!mimeType) throw new ServiceError(415, 'not_an_image')

  const sha256 = sha256Of(input.bytes)
  const cacheSignature = deps.ocr.cacheSignature(input.field)

  // The kill switch does no cache mutation and spends nothing.
  if (!deps.ocr.available) {
    const used = await deps.ocrReads.countBilledForShift(input.shiftId)
    return unavailable(input, used)
  }

  const claim = async (retryFailed = input.retryFailed === true) =>
    await deps.ocrReads.claimReadAttempt({
      id: deps.ids.uuid(),
      branchId: shift.branchId,
      requestingShiftId: input.shiftId,
      field: input.field,
      sha256,
      byteSize: input.bytes.length,
      model: deps.ocr.model,
      cacheSignature,
      createdAt: deps.clock.nowMs(),
      createdBy: input.requestedBy,
      reservationId: deps.ids.uuid(),
      // Infrastructure leases use wall time. Test/business clocks are intentionally frozen in
      // several suites and must not make a dead reservation immortal.
      nowMs: Date.now(),
      leaseMs: OCR_ATTEMPT_LEASE_MS,
      retryFailed,
      maxReadsPerShift: input.maxReadsPerShift,
    })

  const current = await claim()
  if (current.kind === 'cached') return cachedOutput(input, current.record.result, current.used)
  if (current.kind === 'capped') return unavailable(input, current.used)

  if (current.kind === 'running') {
    const finished = await waitForRunningRead(
      deps,
      shift.branchId,
      sha256,
      input.field,
      cacheSignature,
      current.leaseRemainingMs,
    )
    if (finished) {
      const used = await deps.ocrReads.countBilledForShift(input.shiftId)
      return cachedOutput(input, finished.result, used)
    }

    // Re-check exactly once without retry authority. If the repository's clock says the lease
    // expired, this atomically makes that exact attempt terminal. If it is still running (clock
    // granularity, timer jitter, or our 50s function-margin bound), do not spin and do not start
    // attempt two inside this already-aged request; a later request will observe/expire it.
    const refreshed = await claim(false)
    if (refreshed.kind === 'cached') return cachedOutput(input, refreshed.record.result, refreshed.used)
    return unavailable(input, refreshed.used, true)
  }

  const startedAt = Date.now()
  let reading
  try {
    reading = await deps.ocr.read({ field: input.field, bytes: input.bytes, mimeType })
  } catch {
    // The port promises not to throw, but a future adapter bug still must release the lease.
    reading = {
      result: { ok: false as const, reason: 'unavailable' as const },
      usage: { tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - startedAt },
    }
  }

  const result = safeFieldResult(input.field, reading.result)
  const completed = await deps.ocrReads.completeReadAttempt({
    branchId: shift.branchId,
    field: input.field,
    sha256,
    cacheSignature,
    reservationId: current.record.reservationId!,
    result,
    usage: reading.usage,
  })
  const finalRead = completed ?? (await deps.ocrReads.findBySha(shift.branchId, sha256, input.field, cacheSignature))
  const used = await deps.ocrReads.countBilledForShift(input.shiftId)
  return {
    result: safeFieldResult(input.field, finalRead?.result ?? result),
    cached: false,
    retryable: canRetry(finalRead?.result ?? result),
    reads: { used, max: input.maxReadsPerShift },
  }
}

async function waitForRunningRead(
  deps: Deps,
  branchId: string,
  sha256: string,
  field: OcrField,
  cacheSignature: string,
  leaseRemainingMs: number,
): Promise<OcrReadRecord | null> {
  const deadline = Date.now() + Math.min(Math.max(0, leaseRemainingMs), OCR_RUNNING_MAX_WAIT_MS)
  let pollMs = OCR_RUNNING_INITIAL_POLL_MS
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    await delay(Math.min(pollMs, Math.max(1, remaining)))
    const current = await deps.ocrReads.findBySha(branchId, sha256, field, cacheSignature)
    if (current?.state === 'complete') return current
    pollMs = Math.min(pollMs * 2, OCR_RUNNING_MAX_POLL_MS)
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A wallet screen has exactly one live balance; never let a status-bar number win by position. */
function safeFieldResult(field: OcrField, result: OcrResult): OcrResult {
  if (field !== 'wallet' || !result.ok) return result
  if (result.rows.length !== 1 || result.rows[0]?.cancelled || result.rows[0]?.value === null) {
    return { ok: false, reason: 'no_fields' }
  }
  return result
}

function cachedOutput(input: ReadInput, result: OcrResult, used: number): ReadOutput {
  return {
    result: safeFieldResult(input.field, result),
    cached: true,
    retryable: canRetry(result),
    reads: { used, max: input.maxReadsPerShift },
  }
}

function unavailable(input: ReadInput, used: number, cached = false): ReadOutput {
  return {
    result: { ok: false, reason: 'unavailable' },
    cached,
    retryable: false,
    reads: { used, max: input.maxReadsPerShift },
  }
}

function canRetry(result: OcrResult): boolean {
  const attemptCount = result.attemptCount ?? 1
  return attemptCount < 2 && (!result.ok || result.retryable === true)
}
