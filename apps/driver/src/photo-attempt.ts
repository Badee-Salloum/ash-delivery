/**
 * One gallery selection owns one reader attempt, even when its evidence upload is retried.
 *
 * Upload and OCR deliberately have different retry lifecycles. A failed upload is idempotent and
 * should be retried with the bytes already in hand; starting the readers again for that same tap
 * creates two concurrent AI requests whose terminal events can arrive out of order. The attempt id
 * also gives the caller a cheap ownership check before applying late upload side effects.
 */
export interface PhotoAttempt<FileLike> {
  readonly id: number
  readonly file: FileLike
  /** Internal once-bit: an upload retry may start readers, but never twice for one generation. */
  readersStarted: boolean
}

export type PhotoAttemptPhase = 'selection' | 'upload_retry'

/**
 * What to do with an upload the SERVER ACCEPTED, split three ways.
 *
 * The three are not the same question, and treating them as one is what caused the bug this
 * function exists to prevent. A driver who picks a second photo while the first is still uploading
 * leaves the first PUT to land on a slot that is no longer on screen. The old code returned at that
 * point — before telling the parent anything — so the server held a photo the client could not see,
 * the start gate went on demanding «صورة العداد», and the only way out was discarding the shift.
 *
 * Evidence the server holds is a FACT and must always be reported. Which attempt owns the tile, and
 * which may move the close-draft revision, are questions about the newest selection only.
 */
export interface AcceptedUploadPlan {
  /** The server holds these bytes; the slot IS filled. True even for a superseded attempt. */
  readonly notifyAttached: boolean
  /** Paint the tile and start this attempt's readers. Only the newest selection may. */
  readonly ownsUi: boolean
  /**
   * Advance the close-draft revision. Only the newest selection may: rewinding a revision to a
   * superseded generation would trade a stuck gate for a corrupted draft, which is worse.
   */
  readonly advanceDraft: boolean
}

export function planAcceptedUpload<FileLike>(
  current: PhotoAttempt<FileLike> | null,
  attempt: PhotoAttempt<FileLike>,
): AcceptedUploadPlan {
  const owns = isCurrentPhotoAttempt(current, attempt)
  return { notifyAttached: true, ownsUi: owns, advanceDraft: owns }
}

export function nextPhotoAttempt<FileLike>(previousId: number, file: FileLike): PhotoAttempt<FileLike> {
  return { id: previousId + 1, file, readersStarted: false }
}

export function isCurrentPhotoAttempt<FileLike>(
  current: PhotoAttempt<FileLike> | null,
  candidate: PhotoAttempt<FileLike>,
): boolean {
  return current === candidate
}

/**
 * Accept evidence first, then read that accepted generation exactly once.
 *
 * An upload retry is allowed to start the readers when the first upload never reached the server.
 * It is not allowed to start them again after a successful upload. This is the critical distinction
 * from the old "read first, upload second" flow that could materialise operations with no evidence.
 */
export async function executePhotoAttempt<FileLike>(
  attempt: PhotoAttempt<FileLike>,
  _phase: PhotoAttemptPhase,
  actions: {
    startReaders(attempt: PhotoAttempt<FileLike>): void | Promise<void>
    upload(attempt: PhotoAttempt<FileLike>): boolean | Promise<boolean>
  },
): Promise<void> {
  const accepted = await actions.upload(attempt)
  if (!accepted || attempt.readersStarted) return
  attempt.readersStarted = true
  await actions.startReaders(attempt)
}
