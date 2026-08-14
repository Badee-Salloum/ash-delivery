/**
 * The fakes: a reader that is switched off, and one that answers from a script.
 *
 * `MemoryOcrReader` reports `available: false` and refuses every read. That is the DEFAULT state of
 * the system — `OCR_DRIVER` defaults to `none` — and it is what every existing test gets for free
 * when `ocr` joins `Deps`, so nothing that passes today starts making network calls.
 *
 * `ScriptedOcrReader` is the one tests reach for when they need the cloud to have said something.
 * It counts its calls, which is how the dedupe test proves a cache hit never reached the provider.
 */

import type {
  OcrField,
  OcrReadClaim,
  OcrReadClaimInput,
  OcrReadCompletion,
  OcrReadRecord,
  OcrReadRepo,
  OcrReader,
  OcrReading,
  OcrResult,
} from '@ash/contracts'

export class MemoryOcrReader implements OcrReader {
  readonly available = false
  readonly model = 'none'

  cacheSignature(field: OcrField): string {
    return `none-v1:${field}`
  }

  async read(): Promise<OcrReading> {
    return { result: { ok: false, reason: 'unavailable' }, usage: { tokensIn: 0, tokensOut: 0, latencyMs: 0 } }
  }
}

export class ScriptedOcrReader implements OcrReader {
  readonly available = true
  readonly model = 'scripted'
  /** How many times the provider was actually reached. The dedupe test asserts on this. */
  calls = 0
  private readonly answers: OcrResult[]

  constructor(answers: OcrResult[]) {
    this.answers = answers
  }

  cacheSignature(field: OcrField): string {
    return `scripted-v1:${field}`
  }

  async read(): Promise<OcrReading> {
    const result = this.answers[Math.min(this.calls, this.answers.length - 1)] ?? {
      ok: false as const,
      reason: 'no_fields' as const,
    }
    this.calls += 1
    return { result, usage: { tokensIn: 100, tokensOut: 50, latencyMs: 1 } }
  }
}

export class MemoryOcrReadRepo implements OcrReadRepo {
  private readonly rows: OcrReadRecord[] = []

  async findBySha(
    branchId: string,
    sha256: string,
    field: OcrField,
    cacheSignature: string,
  ): Promise<OcrReadRecord | null> {
    return (
      this.rows.find(
        (r) =>
          r.branchId === branchId &&
          r.sha256 === sha256 &&
          r.field === field &&
          r.cacheSignature === cacheSignature,
      ) ?? null
    )
  }

  async claimReadAttempt(input: OcrReadClaimInput): Promise<OcrReadClaim> {
    // There is deliberately no await before this method mutates `rows`: one JS turn is the memory
    // adapter's identity lock and requesting-shift cap lock.
    let index = this.rows.findIndex(
      (r) =>
        r.branchId === input.branchId &&
        r.sha256 === input.sha256 &&
        r.field === input.field &&
        r.cacheSignature === input.cacheSignature,
    )
    let existing = index < 0 ? undefined : this.rows[index]

    if (existing?.state === 'running') {
      const expiresAt = (existing.reservedAt ?? 0) + input.leaseMs
      if (input.nowMs < expiresAt) {
        return {
          kind: 'running',
          record: existing,
          used: this.billedForShift(input.requestingShiftId),
          leaseRemainingMs: expiresAt - input.nowMs,
        }
      }

      // The process died or exceeded the lease. That paid attempt becomes terminal timeout; it is
      // never called again under the same attempt number.
      const attempt = existing.reservedAttempt ?? 1
      existing = {
        ...existing,
        state: 'complete',
        result: { ok: false, reason: 'timeout', attemptCount: attempt },
        reservationId: null,
        reservedAt: null,
        reservedAttempt: null,
      }
      this.rows[index] = existing
    }

    let attempt: 1 | 2
    if (existing) {
      const attempts = existing.result.attemptCount ?? 1
      const retryable = !existing.result.ok || existing.result.retryable === true
      if (!retryable || !input.retryFailed || attempts >= 2) {
        return { kind: 'cached', record: existing, used: this.billedForShift(input.requestingShiftId) }
      }
      attempt = 2
    } else {
      attempt = 1
    }

    const used = this.billedForShift(input.requestingShiftId)
    if (input.maxReadsPerShift > 0 && used >= input.maxReadsPerShift) {
      return { kind: 'capped', record: existing ?? null, used }
    }

    let claimed: OcrReadRecord
    if (attempt === 1) {
      claimed = {
        id: input.id,
        branchId: input.branchId,
        shiftId: input.requestingShiftId,
        field: input.field,
        sha256: input.sha256,
        byteSize: input.byteSize,
        model: input.model,
        cacheSignature: input.cacheSignature,
        state: 'running',
        result: { ok: false, reason: 'timeout', attemptCount: 1 },
        reservationId: input.reservationId,
        reservedAt: input.nowMs,
        reservedAttempt: 1,
        retryShiftId: null,
        retryCreatedAt: null,
        retryCreatedBy: null,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        createdAt: input.createdAt,
        createdBy: input.createdBy,
      }
      this.rows.push(claimed)
      index = this.rows.length - 1
    } else {
      claimed = {
        ...existing!,
        state: 'running',
        result: { ...existing!.result, attemptCount: 2 },
        reservationId: input.reservationId,
        reservedAt: input.nowMs,
        reservedAttempt: 2,
        retryShiftId: input.requestingShiftId,
        retryCreatedAt: input.nowMs,
        retryCreatedBy: input.createdBy,
      }
      this.rows[index] = claimed
    }
    return { kind: 'call', record: claimed, attempt, used: used + 1 }
  }

  async completeReadAttempt(input: OcrReadCompletion): Promise<OcrReadRecord | null> {
    const index = this.rows.findIndex(
      (r) =>
        r.branchId === input.branchId &&
        r.sha256 === input.sha256 &&
        r.field === input.field &&
        r.cacheSignature === input.cacheSignature,
    )
    const existing = index < 0 ? undefined : this.rows[index]
    if (!existing || existing.state !== 'running' || existing.reservationId !== input.reservationId) return null

    const attempt = existing.reservedAttempt ?? 1
    const completed: OcrReadRecord = {
      ...existing,
      state: 'complete',
      result: { ...input.result, attemptCount: attempt },
      reservationId: null,
      reservedAt: null,
      reservedAttempt: null,
      tokensIn: existing.tokensIn + input.usage.tokensIn,
      tokensOut: existing.tokensOut + input.usage.tokensOut,
      latencyMs: existing.latencyMs + input.usage.latencyMs,
    }
    this.rows[index] = completed
    return completed
  }

  async countBilledForShift(shiftId: string): Promise<number> {
    return this.billedForShift(shiftId)
  }

  private billedForShift(shiftId: string): number {
    return this.rows.reduce((total, row) => {
      // Attempt one never changes owner. Attempt two is charged only to retryShiftId; if that shift
      // is later deleted its FK becomes null rather than silently re-attributing the spend.
      const initial = row.shiftId === shiftId ? 1 : 0
      const retry = row.retryShiftId === shiftId ? 1 : 0
      return total + initial + retry
    }, 0)
  }
}
