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

import type { OcrField, OcrReadRecord, OcrReadRepo, OcrReader, OcrReading, OcrResult } from '@ash/contracts'

export class MemoryOcrReader implements OcrReader {
  readonly available = false
  readonly model = 'none'

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

  async findBySha(branchId: string, sha256: string, field: OcrField): Promise<OcrReadRecord | null> {
    return this.rows.find((r) => r.branchId === branchId && r.sha256 === sha256 && r.field === field) ?? null
  }

  async put(record: OcrReadRecord): Promise<OcrReadRecord> {
    const existing = await this.findBySha(record.branchId, record.sha256, record.field)
    // Mirrors the Postgres unique index, which upserts DO NOTHING. Two racing reads of the same
    // pixels must settle on one row, not two.
    if (existing) return existing
    this.rows.push(record)
    return record
  }

  async countBilledForShift(shiftId: string): Promise<number> {
    return this.rows.filter((r) => r.shiftId === shiftId).length
  }
}
