import { parseNonNegativeInteger } from '@ash/client'
import type { OcrFailure } from './ocr.ts'

/** Local and cloud readers run independently; this state must never be inferred from cloud state. */
export type LocalOdometerReadEvent =
  | { status: 'reading' }
  | { status: 'read' }
  | { status: 'failed'; reason: OcrFailure }

type LocalOdometerOutcome =
  | { ok: true; odometer: number | null }
  | { ok: false; reason: OcrFailure }

/** Preserve the reader's real terminal reason; a successful dashboard read without ODO is no-fields. */
export function localOdometerEvent(outcome: LocalOdometerOutcome): LocalOdometerReadEvent {
  if (!outcome.ok) return { status: 'failed', reason: outcome.reason }
  return outcome.odometer === null
    ? { status: 'failed', reason: 'no_fields' }
    : { status: 'read' }
}

export type LocalOdometerFailureCopyKey =
  | 'localOcrTimeout'
  | 'localOcrUnavailable'
  | 'localOcrNoFields'

/** One exhaustive mapping keeps the reason shown on glass identical to the retained event. */
export function localOdometerFailureCopyKey(reason: OcrFailure): LocalOdometerFailureCopyKey {
  if (reason === 'timeout') return 'localOcrTimeout'
  if (reason === 'no_fields') return 'localOcrNoFields'
  return 'localOcrUnavailable'
}

/** A retake replaces machine output, but never silently erases something the driver typed. */
export function odometerValueForRetake(current: string, humanEdited: boolean): string {
  return humanEdited ? current : ''
}

/** Keep the confirmation beside the exact end-reading fields that cross the wire. */
export function endOdometerSubmission(
  value: string,
  ocr: number | null,
  anomalyConfirmed: boolean,
): { odometerKm: number; odometerKmOcr: number | null; odometerAnomalyConfirmed: boolean } | null {
  const odometerKm = parseNonNegativeInteger(value)
  if (odometerKm === null) return null
  return { odometerKm, odometerKmOcr: ocr, odometerAnomalyConfirmed: anomalyConfirmed }
}
