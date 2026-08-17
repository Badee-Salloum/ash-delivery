import { createHash } from 'node:crypto'
import type { CloseDraftView, Deps, EvidencePackage, MediaRecord, ShiftRecord } from '@ash/contracts'
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

const packageIsEditable = (state: ShiftRecord['state'], pkg: EvidencePackage): boolean =>
  pkg === 'start' ? state === 'draft' : state === 'open' || state === 'suspended'

function requireEditablePackage(shift: ShiftRecord, pkg: EvidencePackage): void {
  if (!packageIsEditable(shift.state, pkg)) {
    throw new ServiceError(409, 'shift_not_editable', { package: pkg, state: shift.state })
  }
}

function rethrowMediaMutation(error: unknown): never {
  const code = (error as { code?: string }).code
  if (code === 'MEDIA_PACKAGE_NOT_EDITABLE') throw new ServiceError(409, 'shift_not_editable')
  if (code === 'MEDIA_ATTACHMENT_CHANGED') throw new ServiceError(409, 'evidence_attachment_changed')
  if (code === 'MEDIA_BRANCH_MISMATCH') throw new ServiceError(409, 'evidence_branch_mismatch')
  if (code === 'MEDIA_REUSE_PROVENANCE_MISMATCH') {
    throw new ServiceError(409, 'evidence_reuse_provenance_mismatch')
  }
  if (code === 'MEDIA_ALREADY_ATTACHED') {
    const detail = error as { sourcePackage?: string; sourceSlot?: string }
    throw new ServiceError(409, 'evidence_already_attached', {
      sourcePackage: detail.sourcePackage ?? null,
      sourceSlot: detail.sourceSlot ?? null,
    })
  }
  if (code === 'MEDIA_HISTORY_NOT_FOUND') throw new ServiceError(404, 'evidence_attachment_history_not_found')
  if (code === 'MEDIA_HISTORY_CURRENT') throw new ServiceError(409, 'evidence_attachment_already_current')
  throw error
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
  /** Driver explicitly accepted an old/reused-image warning before attaching it. */
  staleAcknowledged?: boolean
  /** Required to replace an occupied slot with different bytes. */
  replaceConfirmed?: boolean
  /** Optimistic identity of the occupied generation; null/undefined means the caller saw an empty slot. */
  expectedAttachmentToken?: string | null
  /** Optional end-screen validator, called only after every non-mutating confirmation preflight. */
  beforeAttach?: (media: MediaRecord) => Promise<void>
  /** Run the small attachment mutation in the shift-close UOW after slow validation has finished. */
  runCommit?: <T>(work: (transactionDeps: Deps) => Promise<T>) => Promise<T>
  /** Re-check the optimistic draft while the shift lock is held, before the attachment changes. */
  beforeCommit?: (transactionDeps: Deps) => Promise<void>
  /** Advance the draft generation in the same transaction as the attachment. */
  afterAttach?: (transactionDeps: Deps) => Promise<CloseDraftView>
}

/**
 * Remove a photo from a slot — «حذف الصورة».
 *
 * The driver picked the wrong screenshot, or photographed one page twice. Until now his only move
 * was to upload a different image OVER it, which works for a mistake but not for a surplus: an
 * extra dashboard page he cannot remove leaves a tile he must fill with something.
 *
 * WHAT MAKES THIS SAFE rather than a hole in the evidence rules: it removes the LINK, not the
 * bytes, and the BR5 gates read the links. So a driver who deletes a required photo immediately
 * fails his own gate — `startPackageGaps` / `endPackageGaps` recompute from `listSlots` — and
 * cannot submit until he uploads another. He cannot delete his way past a requirement.
 *
 * REFUSED ONCE THE SHIFT IS OUT OF HIS HANDS. After `driver_submit_end` the manager is looking at
 * this evidence to approve money; letting the driver pull a photo out from under that review is
 * not a UX decision, it is an audit one.
 */
export async function deleteEvidence(
  deps: Deps,
  input: {
    shiftId: string
    package: EvidencePackage
    slot: string
    deletedBy: string | null
    expectedAttachmentToken?: string
  },
): Promise<{ slotsNow: string[] }> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')

  requireEditablePackage(shift, input.package)

  if (!ALL_SLOTS[input.package].includes(input.slot)) {
    throw new ServiceError(422, 'unknown_evidence_slot', { slot: input.slot })
  }

  try {
    await deps.media.detach(input.shiftId, input.package, input.slot, input.deletedBy, input.expectedAttachmentToken)
  } catch (error) {
    rethrowMediaMutation(error)
  }
  const slots = await deps.media.listSlots(input.shiftId)
  return { slotsNow: slots.filter((s) => s.package === input.package).map((s) => s.slot) }
}

export interface UploadResult {
  media: MediaRecord
  deduped: boolean
  /** Server receipt minus the phone's claim. Large values are worth a manager's attention. */
  clockSkewMs: number | null
  slotsNow: string[]
  reusedFromShiftId: string | null
  attachmentToken: string
  staleAcknowledged: boolean
  draft?: CloseDraftView
}

export async function restoreEvidence(
  deps: Deps,
  input: {
    shiftId: string
    historyId: string
    expectedCurrentAttachmentToken: string | null
    actorId: string
    reason: string
  },
) {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  try {
    return await deps.media.restoreAttachment({
      ...input,
      attachedAtMs: deps.clock.nowMs(),
    })
  } catch (error) {
    rethrowMediaMutation(error)
  }
}

export async function uploadEvidence(deps: Deps, input: UploadInput): Promise<UploadResult> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')

  requireEditablePackage(shift, input.package)

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

  const beforeSlots = await deps.media.listSlots(input.shiftId)
  const currentSlot = beforeSlots.find((slot) => slot.package === input.package && slot.slot === input.slot)
  const duplicateSlot = beforeSlots.find(
    (slot) =>
      slot.mediaId === media.id &&
      (slot.package !== input.package || slot.slot !== input.slot),
  )
  if (duplicateSlot) {
    throw new ServiceError(409, 'evidence_already_attached', {
      sourcePackage: duplicateSlot.package,
      sourceSlot: duplicateSlot.slot,
      currentAttachment: currentSlot ?? null,
    })
  }
  const exactRetry = currentSlot?.mediaId === media.id
  if (!exactRetry && currentSlot) {
    if (input.expectedAttachmentToken !== currentSlot.attachmentToken) {
      throw new ServiceError(409, 'evidence_attachment_changed', { currentAttachment: currentSlot })
    }
    if (input.replaceConfirmed !== true) {
      throw new ServiceError(409, 'evidence_replacement_confirmation_required', {
        sourcePackage: currentSlot.package,
        sourceSlot: currentSlot.slot,
        currentAttachment: currentSlot,
      })
    }
  }
  if (!exactRetry && !currentSlot && input.expectedAttachmentToken != null) {
    throw new ServiceError(409, 'evidence_attachment_changed', { currentAttachment: null })
  }

  const prior = exactRetry ? null : await deps.media.latestAttachmentForMedia(media.id)
  const stale = media.clientTakenAtMs != null && receivedAtMs - media.clientTakenAtMs >= 30 * 60_000
  if (!exactRetry && input.staleAcknowledged !== true && (stale || prior !== null)) {
    throw new ServiceError(409, 'stale_evidence_confirmation_required', {
      sourcePackage: prior?.package ?? null,
      sourceSlot: prior?.slot ?? null,
      reusedFromShiftId: prior?.shiftId ?? null,
      currentAttachment: currentSlot ?? null,
      stale,
    })
  }

  if (!exactRetry) await input.beforeAttach?.(media)

  const commitMutation = async (commitDeps: Deps): Promise<UploadResult> => {
    await input.beforeCommit?.(commitDeps)
    const committedPrior = exactRetry
      ? null
      : await commitDeps.media.latestAttachmentForMedia(media.id, { lock: true })
    if (!exactRetry && (committedPrior?.id ?? null) !== (prior?.id ?? null)) {
      // The slow screen classifier ran after the user's confirmation. A newly appended reuse
      // generation changes what was confirmed, so fail before touching the occupied slot. The next
      // request will show the new source and can carry a fresh acknowledgement.
      throw new ServiceError(409, 'stale_evidence_confirmation_required', {
        sourcePackage: committedPrior?.package ?? null,
        sourceSlot: committedPrior?.slot ?? null,
        reusedFromShiftId: committedPrior?.shiftId ?? null,
        currentAttachment: currentSlot ?? null,
        stale,
        confirmationStale: true,
      })
    }
    try {
      await commitDeps.media.attach(input.shiftId, input.package, input.slot, media.id, {
      actorId: input.uploadedBy,
      attachedAtMs: receivedAtMs,
      reusedFromShiftId: committedPrior?.shiftId ?? null,
      expectedAttachmentToken: input.expectedAttachmentToken === undefined
        ? (exactRetry ? currentSlot!.attachmentToken : null)
        : input.expectedAttachmentToken,
      })
    } catch (error) {
      rethrowMediaMutation(error)
    }

    // Compatibility with cached PWAs that persist a BMS OCR result immediately before its upload.
    const bmsMatch = /^bms_([1-9]\d*)$/.exec(input.slot)
    if (bmsMatch) {
      const slotNo = Number(bmsMatch[1])
      const battery = (await commitDeps.directory.listBatteriesForVehicle(shift.vehicleId)).find(
        (candidate) => candidate.slotNo === slotNo,
      )
      if (battery) {
        const pending = (await commitDeps.batteryReadings.listByShift(shift.id)).find(
          (reading) =>
            reading.package === input.package &&
            reading.batteryId === battery.id &&
            reading.mediaId === null &&
            reading.source !== 'manager' &&
            !reading.unavailable,
        )
        if (pending) await commitDeps.batteryReadings.upsert({ ...pending, mediaId: media.id })
      }
    }
    let attached = (await commitDeps.media.listSlots(input.shiftId)).find(
      (s) => s.package === input.package && s.slot === input.slot,
    )
    if (!attached) throw new Error(`evidence attachment ${input.shiftId}/${input.package}/${input.slot} disappeared`)
    const attachedStale = media.clientTakenAtMs != null && attached.attachedAtMs - media.clientTakenAtMs >= 30 * 60_000
    // Acknowledgement is meaningful only after the server has observed the warning condition.
    if (input.staleAcknowledged === true && (attachedStale || attached.reusedFromShiftId != null)) {
      try {
        await commitDeps.media.acknowledgeStale(
          input.shiftId,
          input.package,
          input.slot,
          media.id,
          attached.attachmentToken,
          input.uploadedBy,
          receivedAtMs,
        )
      } catch (error) {
        rethrowMediaMutation(error)
      }
      attached = (await commitDeps.media.listSlots(input.shiftId)).find(
        (s) => s.package === input.package && s.slot === input.slot,
      )
      if (!attached) throw new Error(`evidence attachment ${input.shiftId}/${input.package}/${input.slot} disappeared`)
    }

    const draft = await input.afterAttach?.(commitDeps)
    const refreshed = await commitDeps.shifts.findById(input.shiftId)
    return {
      media,
      deduped: existing !== null,
      clockSkewMs: input.clientTakenAtMs === null ? null : receivedAtMs - input.clientTakenAtMs,
      slotsNow: input.package === 'start' ? (refreshed?.mediaSlotsStart ?? []) : (refreshed?.mediaSlotsEnd ?? []),
      reusedFromShiftId: attached.reusedFromShiftId ?? null,
      attachmentToken: attached.attachmentToken,
      staleAcknowledged: attached.staleAcknowledgedAtMs != null,
      ...(draft === undefined ? {} : { draft }),
    }
  }
  return input.runCommit ? input.runCommit(commitMutation) : commitMutation(deps)
}

/** Record the driver's explicit acceptance after the server discovers content reuse. */
export async function acknowledgeStaleEvidence(
  deps: Deps,
  input: {
    shiftId: string
    package: EvidencePackage
    slot: string
    mediaId: string
    attachmentToken: string
    acknowledgedBy: string
  },
): Promise<void> {
  const shift = await deps.shifts.findById(input.shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  requireEditablePackage(shift, input.package)
  const attached = (await deps.media.listSlots(input.shiftId)).find(
    (s) => s.package === input.package && s.slot === input.slot,
  )
  if (!attached) throw new ServiceError(404, 'evidence_slot_empty')
  if (attached.mediaId !== input.mediaId || attached.attachmentToken !== input.attachmentToken) {
    throw new ServiceError(409, 'evidence_attachment_changed')
  }
  const media = await deps.media.findById(attached.mediaId)
  const stale = media?.clientTakenAtMs != null && attached.attachedAtMs - media.clientTakenAtMs >= 30 * 60_000
  if (!stale && attached.reusedFromShiftId === null) {
    throw new ServiceError(422, 'evidence_not_stale_or_reused')
  }
  try {
    await deps.media.acknowledgeStale(
      input.shiftId,
      input.package,
      input.slot,
      input.mediaId,
      input.attachmentToken,
      input.acknowledgedBy,
      deps.clock.nowMs(),
    )
  } catch (error) {
    rethrowMediaMutation(error)
  }
}

export async function readEvidence(deps: Deps, mediaId: string): Promise<{ media: MediaRecord; bytes: Uint8Array }> {
  const media = await deps.media.findById(mediaId)
  if (!media) throw new ServiceError(404, 'media_not_found')
  const bytes = await deps.blobs.get(media.storageKey)
  if (!bytes) throw new ServiceError(410, 'media_blob_missing')
  return { media, bytes }
}
