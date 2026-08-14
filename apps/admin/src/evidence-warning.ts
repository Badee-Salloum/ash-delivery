import { type PhotoAge, photoAge } from '@ash/client'

/** The provenance fields the manager receives for the attachment currently occupying a slot. */
export interface EvidenceAttachmentMeta {
  clientTakenAt?: string | null
  /** First receipt of these immutable bytes. Kept only as a staggered-API fallback. */
  receivedAt?: string | null
  /** Authoritative time these bytes were attached to this shift/slot. */
  attachedAt?: string | null
  reusedFromShiftId?: string | null
  staleAcknowledgedAt?: string | null
  staleAcknowledgedBy?: string | null
}

export interface EvidenceReviewWarning {
  age: PhotoAge
  attachedAt: string | null
  reusedFromShiftId: string | null
  /** Both halves are required: a timestamp without an actor is not a valid acknowledgement. */
  acknowledged: boolean
  acknowledgedAt: string | null
}

/**
 * Describe the CURRENT attachment, not the media blob's first upload.
 *
 * Deduplication means the same bytes can have a very old `receivedAt` and a new `attachedAt` (or
 * the reverse relative to the phone timestamp). Comparing capture time with first receipt made a
 * reused image look fresh on the manager screen. New APIs always send `attachedAt`; the fallback
 * keeps the admin usable during a staggered rollout without weakening the new calculation.
 */
export function evidenceReviewWarning(meta: EvidenceAttachmentMeta): EvidenceReviewWarning {
  const attachedAt = meta.attachedAt ?? meta.receivedAt ?? null
  const acknowledgedAt = meta.staleAcknowledgedAt ?? null
  return {
    age: photoAge(meta.clientTakenAt ?? null, attachedAt),
    attachedAt,
    reusedFromShiftId: meta.reusedFromShiftId ?? null,
    acknowledged:
      acknowledgedAt !== null &&
      meta.staleAcknowledgedBy !== null &&
      meta.staleAcknowledgedBy !== undefined,
    acknowledgedAt,
  }
}
