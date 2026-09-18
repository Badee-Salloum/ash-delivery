import type { CloseDraftAttachmentRead, CloseDraftReadResponse } from '@ash/client'

/**
 * Did the server finish reading this battery slot, and if not, why?
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE EXPRESSION. The end-package battery reader used to ask
 * `response.read.status`. The API has never returned a top-level `read` — both return sites give
 * `{draft, rows, fields}` — so that expression threw a TypeError on every read, the surrounding
 * task wrapper turned the throw into a failed read, and the percentage the reader had already
 * found was never offered to the driver. It went unnoticed because the CLIENT TYPE DECLARED THE
 * FIELD, so the compiler had no reason to object, and the only test over this path matched source
 * text without executing it.
 *
 * The cost was twelve days: end-package readings sourced from OCR were zero every day from
 * 2026-08-14 to 2026-08-26 while start-package reads — which take a different path — kept working.
 * Every closing charge was retyped by hand and every closing cycle count was lost.
 *
 * The read genuinely lives on the attachment, per slot (`draft.attachments[].read`), which is where
 * this looks. It is total by construction: a decision function that can throw returns the driver to
 * exactly the failure it exists to prevent.
 */

export type LinkedBmsReadFailureReason =
  | 'unavailable'
  | 'timeout'
  | 'no_fields'
  | 'refused'
  | 'wrong_screen'
  | 'read_budget_exhausted'

export type LinkedBmsReadState =
  | { readonly complete: true; readonly read: CloseDraftAttachmentRead }
  | { readonly complete: false; readonly reason: LinkedBmsReadFailureReason }

const UNAVAILABLE = { complete: false, reason: 'unavailable' } as const

export function linkedBmsReadState(
  response: CloseDraftReadResponse | null,
  slot: string,
): LinkedBmsReadState {
  const attachments = response?.draft?.attachments
  if (!Array.isArray(attachments)) return UNAVAILABLE

  const read = attachments.find((attachment) => attachment?.slot === slot)?.read
  if (!read) return UNAVAILABLE
  if (read.status === 'complete') return { complete: true, read }

  // A terminal failure names itself; anything still in flight is not a failure the driver can act
  // on, so it reports as unavailable and stays retryable.
  return { complete: false, reason: read.failure ?? 'unavailable' }
}
