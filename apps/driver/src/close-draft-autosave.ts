export const CLOSE_DRAFT_SAVE_DELAYS_MS = [600, 1_200, 3_000, 7_000] as const

export type CloseDraftSaveRunResult<S, C> =
  | { kind: 'saved'; value: S; attempts: number }
  | { kind: 'conflict'; value: C; attempts: number }
  | { kind: 'failed'; error: unknown; attempts: number }
  | { kind: 'cancelled'; attempts: number }

/**
 * One bounded autosave cycle for one immutable dirty fingerprint. A changed fingerprint cancels the
 * cycle through `isCurrent`; its replacement starts a fresh backoff instead of retrying stale input.
 */
export async function runCloseDraftSaveWithRetry<S, C>(input: {
  save(): Promise<S>
  conflictValue(error: unknown): C | null
  isCurrent(): boolean
  onTransientFailure?(error: unknown, attempt: number): void
  delaysMs?: readonly number[]
  wait?(milliseconds: number): Promise<void>
}): Promise<CloseDraftSaveRunResult<S, C>> {
  const delays = input.delaysMs ?? CLOSE_DRAFT_SAVE_DELAYS_MS
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)))
  let lastError: unknown = new Error('close_draft_save_not_attempted')

  for (let index = 0; index < delays.length; index += 1) {
    await wait(delays[index]!)
    if (!input.isCurrent()) return { kind: 'cancelled', attempts: index }
    try {
      const value = await input.save()
      if (!input.isCurrent()) return { kind: 'cancelled', attempts: index + 1 }
      return { kind: 'saved', value, attempts: index + 1 }
    } catch (error) {
      if (!input.isCurrent()) return { kind: 'cancelled', attempts: index + 1 }
      const conflict = input.conflictValue(error)
      if (conflict !== null) return { kind: 'conflict', value: conflict, attempts: index + 1 }
      lastError = error
      input.onTransientFailure?.(error, index + 1)
    }
  }
  return { kind: 'failed', error: lastError, attempts: delays.length }
}
