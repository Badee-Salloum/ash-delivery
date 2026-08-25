import type { Deps, OcrField, OcrReading, OcrReadRecord, OcrResult } from '@ash/contracts'
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
/**
 * Leave enough time to durably complete the reservation before Vercel's 60-second function
 * ceiling. BMS is an optional prefill with an immediate manual fallback, so it gets a much
 * shorter UX ceiling than the multi-pass order reader.
 */
const OCR_READ_DEADLINE_MS = 52_000
const BMS_READ_DEADLINE_MS = 30_000

/**
 * Fields whose read is ARCHIVAL, and the headroom kept back from them.
 *
 * «سجل المدفوعات» is optional by rule — CLAUDE.md money rule 7: "Payments Log evidence is optional
 * and archival … its absence never blocks close submission." Yet on 2026-08-24 its four pages ate
 * four of امجد عبدالله's fifteen reads, and the two BMS reads the BR5 gate DOES require were then
 * refused as capped. An optional page must never be able to spend the budget a mandatory one needs.
 *
 * So optional fields see a lower ceiling. The shift's total spend stays bounded by
 * `OCR_MAX_READS_PER_SHIFT`; what changes is who may reach the last few.
 */
const ARCHIVAL_FIELDS: ReadonlySet<OcrField> = new Set<OcrField>(['payments_log'])
const MANDATORY_READ_RESERVE = 8

/** The ceiling THIS field may spend up to, leaving the reserve for the gate's own readings. */
export function effectiveReadCeiling(field: OcrField, maxReadsPerShift: number): number {
  if (maxReadsPerShift <= 0 || !ARCHIVAL_FIELDS.has(field)) return maxReadsPerShift
  return Math.max(1, maxReadsPerShift - MANDATORY_READ_RESERVE)
}

export interface ReadInput {
  shiftId: string
  field: OcrField
  bytes: Uint8Array
  requestedBy: string
  /** Zero disables the cap. */
  maxReadsPerShift: number
  /** Only an explicit user action may consume the single second attempt. */
  retryFailed?: boolean
  /** Internal override for deterministic lifecycle tests; production uses the field deadline. */
  deadlineMs?: number
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
      // The archival fields stop short, so the gate's own readings always have room.
      maxReadsPerShift: effectiveReadCeiling(input.field, input.maxReadsPerShift),
    })

  const current = await claim()
  if (current.kind === 'cached') return cachedOutput(input, current.record.result, current.used)
  if (current.kind === 'capped') return budgetExhausted(input, current.used)

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
    // Deliberately `unavailable`, not the budget reason: another attempt is still in flight or was
    // just expired. Nothing has been spent that the driver could act on.
    if (refreshed.kind === 'capped') return budgetExhausted(input, refreshed.used, true)
    return unavailable(input, refreshed.used, true)
  }

  const reading = await readWithinDeadline(deps, input.field, input.bytes, mimeType, input.deadlineMs)

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

/**
 * The provider adapter has its own fetch timeout, but the API owns the HTTP lifecycle and the OCR
 * reservation. This outer ceiling is intentionally independent: even a future adapter that
 * ignores AbortSignal cannot keep the driver's request open until the platform kills the socket.
 */
async function readWithinDeadline(
  deps: Deps,
  field: OcrField,
  bytes: Uint8Array,
  mimeType: string,
  deadlineOverrideMs?: number,
): Promise<OcrReading> {
  const startedAt = Date.now()
  const deadlineMs = deadlineOverrideMs ?? (field === 'bms' ? BMS_READ_DEADLINE_MS : OCR_READ_DEADLINE_MS)
  const controller = new AbortController()
  let deadlineReached = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<OcrReading>((resolve) => {
    timer = setTimeout(() => {
      deadlineReached = true
      controller.abort(new DOMException(`OCR ${field} deadline exceeded`, 'TimeoutError'))
      resolve(timeoutReading(field, deadlineMs, Date.now() - startedAt))
    }, deadlineMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([
      deps.ocr.read({ field, bytes, mimeType, signal: controller.signal }),
      deadline,
    ])
  } catch {
    // The port promises not to throw. Preserve timeout semantics if it rejected in response to our
    // abort; every other adapter bug is unavailable. Either way, the caller completes the lease.
    return deadlineReached
      ? timeoutReading(field, deadlineMs, Date.now() - startedAt)
      : {
          result: { ok: false, reason: 'unavailable' },
          usage: { tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - startedAt },
        }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function timeoutReading(field: OcrField, deadlineMs: number, latencyMs: number): OcrReading {
  return {
    result: {
      ok: false,
      reason: 'timeout',
      detail: `api deadline ${deadlineMs}ms ${field}`,
    },
    usage: { tokensIn: 0, tokensOut: 0, latencyMs },
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

/**
 * The per-shift budget is spent — which is NOT the reader being unreachable.
 *
 * Both are `retryable: false`, and the driver app hides the retry button for both; but the
 * `unavailable` copy says «أعد المحاولة». Telling a driver to retry while removing the retry
 * button is what stranded امجد عبدالله at 01:35 on 2026-08-25 with two refused BMS reads. This
 * reason has its own sentence, and it points at manual entry — which works.
 */
function budgetExhausted(input: ReadInput, used: number, cached = false): ReadOutput {
  return {
    result: {
      ok: false,
      reason: 'read_budget_exhausted',
      detail: `per-shift read budget spent: ${used}/${input.maxReadsPerShift} (${input.field} ceiling ${effectiveReadCeiling(input.field, input.maxReadsPerShift)})`,
    },
    cached,
    retryable: false,
    reads: { used, max: input.maxReadsPerShift },
  }
}

function canRetry(result: OcrResult): boolean {
  const attemptCount = result.attemptCount ?? 1
  return attemptCount < 2 && (!result.ok || result.retryable === true)
}
