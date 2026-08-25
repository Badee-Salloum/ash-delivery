import type { CloseDraftAttachment } from '@ash/client'

/**
 * A response that was started against an older close-draft revision must never rewind the screen.
 * Equal revisions are still useful: a GET can carry the same canonical snapshot while local human
 * edits are overlaid again by the caller.
 */
export function isStaleCloseDraftView(
  currentRevision: number | null,
  incomingRevision: number,
): boolean {
  return currentRevision !== null && incomingRevision < currentRevision
}

const isLocalPendingRead = (attachment: CloseDraftAttachment): boolean =>
  attachment.read?.status === 'running' && attachment.read.readId.startsWith('pending-')

const isNewerTerminalRead = (
  local: CloseDraftAttachment,
  canonical: CloseDraftAttachment,
): boolean =>
  (canonical.read?.status === 'complete' || canonical.read?.status === 'failed') &&
  canonical.read.attempts > (local.read?.attempts ?? -1)

/**
 * Keep the browser request's ownership marker across unrelated canonical saves.
 *
 * Autosave can advance the draft revision while an OCR request is still in flight. Its response
 * may legitimately contain the same attachment with no read yet (or the server's running read),
 * but replacing `pending-*` there would orphan the in-flight response. A replacement generation
 * or a terminal server read from a strictly later attempt is authoritative and deliberately wins.
 * Equal-attempt terminal state is the result that existed before this retry started; an unrelated
 * autosave can legitimately return it and must not orphan the newer browser request.
 */
export function preservePendingCloseDraftReads(
  current: Readonly<Record<string, CloseDraftAttachment>>,
  incoming: Readonly<Record<string, CloseDraftAttachment>>,
): Readonly<Record<string, CloseDraftAttachment>> {
  let merged: Record<string, CloseDraftAttachment> | null = null
  for (const [slot, local] of Object.entries(current)) {
    if (!isLocalPendingRead(local)) continue
    const canonical = incoming[slot]
    if (
      !canonical ||
      canonical.attachmentToken !== local.attachmentToken ||
      isNewerTerminalRead(local, canonical)
    ) continue
    merged ??= { ...incoming }
    merged[slot] = { ...canonical, read: local.read }
  }
  return merged ?? incoming
}

/** Exact request ownership fence used by completion, failure and cancellation paths. */
export function ownsPendingCloseDraftRead(
  attachments: Readonly<Record<string, CloseDraftAttachment>>,
  slot: string,
  attachmentToken: string,
  pendingReadId: string,
): boolean {
  const owned = attachments[slot]
  return owned?.attachmentToken === attachmentToken && owned.read?.readId === pendingReadId
}
