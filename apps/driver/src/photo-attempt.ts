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
}

export type PhotoAttemptPhase = 'selection' | 'upload_retry'

export function nextPhotoAttempt<FileLike>(previousId: number, file: FileLike): PhotoAttempt<FileLike> {
  return { id: previousId + 1, file }
}

export function isCurrentPhotoAttempt<FileLike>(
  current: PhotoAttempt<FileLike> | null,
  candidate: PhotoAttempt<FileLike>,
): boolean {
  return current === candidate
}

/** Execute the only policy distinction: a selection reads + uploads; an upload retry only uploads. */
export async function executePhotoAttempt<FileLike>(
  attempt: PhotoAttempt<FileLike>,
  phase: PhotoAttemptPhase,
  actions: {
    startReaders(attempt: PhotoAttempt<FileLike>): void
    upload(attempt: PhotoAttempt<FileLike>): void | Promise<void>
  },
): Promise<void> {
  if (phase === 'selection') actions.startReaders(attempt)
  await actions.upload(attempt)
}
