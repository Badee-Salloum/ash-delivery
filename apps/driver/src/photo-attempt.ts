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
