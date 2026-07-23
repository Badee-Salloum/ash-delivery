import { createHash } from 'node:crypto'
import type { Deps, EvidencePackage, MediaRecord } from '@ash/contracts'
import { ALL_END_SLOTS, ALL_START_SLOTS } from '@ash/domain'
import { ServiceError } from './shifts.service.ts'

/**
 * Photo evidence (SRS C-6).
 *
 * The rules that make an upload *evidence* rather than a picture:
 *
 *  1. **Content-addressed.** The key is the sha256 of the bytes, so the same photo retried after
 *     a dropped Wi-Fi connection dedupes server-side instead of storing twice. Uploads over
 *     office Wi-Fi on a cheap Android will be retried; that is designed for, not hoped against.
 *  2. **The server's receipt time is authoritative.** The phone's `clientTakenAt` is recorded
 *     as a claim, and a large gap between the two is surfaced to the branch manager.
 *  3. **The slot list is derived from what actually arrived**, so the BR5 gates read reality.
 *  4. **Magic-byte sniffing, not the declared MIME type.** A client can say anything.
 */

/** ~300 KB is the SRS §7 target after client-side compression; 8 MB is the hard reject. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export const TARGET_COMPRESSED_BYTES = 400 * 1024

/**
 * Every slot an upload MAY carry — deliberately wider than what a given shift REQUIRES.
 *
 * These were the same list, which worked only while every bike was identical. A one-pack bike
 * does not require `bms_2`, but the vocabulary must still contain it, or a two-pack bike's second
 * screenshot would be rejected as an unknown slot. Requirement is per-shift and lives in the
 * domain gate; acceptance is the vocabulary, and lives here.
 */
const ALL_SLOTS: Record<EvidencePackage, readonly string[]> = {
  start: ALL_START_SLOTS,
  end: ALL_END_SLOTS,
}

/** Magic bytes. The declared Content-Type is a client assertion and is not trusted. */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** `ab/cd/abcdef…` — fans out across directories so one folder never holds a million files. */
export const storageKeyFor = (sha256: string): string => `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`

export interface UploadInput {
  shiftId: string
  package: EvidencePackage
  slot: string
  bytes: Uint8Array
  clientTakenAtMs: number | null
  uploadedBy: string
}

export interface UploadResult {
  media: MediaRecord
  deduped: boolean
  /** Server receipt minus the phone's claim. Large values are worth a manager's attention. */
  clockSkewMs: number | null
  slotsNow: string[]
}

export async function uploadEvidence(deps: Deps, input: UploadInput): Promise<UploadResult> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')

  const allowed = ALL_SLOTS[input.package]
  if (!allowed.includes(input.slot)) {
    throw new ServiceError(422, 'unknown_evidence_slot', { slot: input.slot, allowed })
  }

  if (input.bytes.length === 0) throw new ServiceError(422, 'empty_upload')
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ServiceError(413, 'upload_too_large', { bytes: input.bytes.length, max: MAX_UPLOAD_BYTES })
  }

  const mimeType = sniffImageType(input.bytes)
  if (!mimeType) throw new ServiceError(415, 'not_an_image')

  const sha256 = sha256Of(input.bytes)
  const storageKey = storageKeyFor(sha256)
  const receivedAtMs = deps.clock.nowMs()

  // Write the blob before the row: a blob with no row is harmless garbage, a row with no blob
  // is a broken evidence link the manager cannot open.
  if (!(await deps.blobs.exists(storageKey))) {
    await deps.blobs.put(storageKey, input.bytes, mimeType)
  }

  const existing = await deps.media.findBySha(shift.branchId, sha256)
  const media = await deps.media.put(
    existing ?? {
      id: deps.ids.uuid(),
      branchId: shift.branchId,
      sha256,
      byteSize: input.bytes.length,
      mimeType,
      storageKey,
      clientTakenAtMs: input.clientTakenAtMs,
      receivedAtMs,
      uploadedBy: input.uploadedBy,
    },
  )

  await deps.media.attach(input.shiftId, input.package, input.slot, media.id)

  const refreshed = await deps.shifts.findById(input.shiftId)
  return {
    media,
    deduped: existing !== null,
    clockSkewMs: input.clientTakenAtMs === null ? null : receivedAtMs - input.clientTakenAtMs,
    slotsNow: input.package === 'start' ? (refreshed?.mediaSlotsStart ?? []) : (refreshed?.mediaSlotsEnd ?? []),
  }
}

export async function readEvidence(deps: Deps, mediaId: string): Promise<{ media: MediaRecord; bytes: Uint8Array }> {
  const media = await deps.media.findById(mediaId)
  if (!media) throw new ServiceError(404, 'media_not_found')
  const bytes = await deps.blobs.get(media.storageKey)
  if (!bytes) throw new ServiceError(410, 'media_blob_missing')
  return { media, bytes }
}
