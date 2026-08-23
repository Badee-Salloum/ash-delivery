/**
 * A UI-owned lifetime for one evidence-linked cloud read.
 *
 * Provider and API deadlines are necessary but they cannot protect the phone from a fetch whose
 * connection never settles. This task adds the final browser-side deadline and gives the driver an
 * explicit escape hatch. Cancelling aborts the fetch; the caller still owns restoring its last
 * persisted draft state because an in-memory `running` marker must never survive the escape.
 */
export const LINKED_READ_UI_TIMEOUT_MS = 35_000

export type LinkedReadTaskResult<T> =
  | { kind: 'complete'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

export interface LinkedReadTask<T> {
  readonly signal: AbortSignal
  readonly result: Promise<LinkedReadTaskResult<T>>
  /** Idempotent. Returns false when the task had already settled. */
  cancel(): boolean
}

/**
 * Run one request with a hard deadline and an explicit cancel operation.
 *
 * The result promise settles exactly once. A response that arrives after timeout/cancel is ignored,
 * so an older photo can never publish into a replacement generation merely because its socket
 * completed late.
 */
export function createLinkedReadTask<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = LINKED_READ_UI_TIMEOUT_MS,
): LinkedReadTask<T> {
  const controller = new AbortController()
  let active = true
  let resolveResult!: (result: LinkedReadTaskResult<T>) => void
  const result = new Promise<LinkedReadTaskResult<T>>((resolve) => {
    resolveResult = resolve
  })

  const settle = (outcome: LinkedReadTaskResult<T>): boolean => {
    if (!active) return false
    active = false
    clearTimeout(timer)
    if (outcome.kind === 'timeout' || outcome.kind === 'cancelled') {
      // Abort before resolving: abort listeners can synchronously restore the last persisted draft
      // before the UI removes its cover and exposes the manual fields.
      controller.abort(outcome.kind)
    }
    resolveResult(outcome)
    return true
  }

  const timer = setTimeout(() => {
    settle({ kind: 'timeout' })
  }, timeoutMs)

  // Starting on a microtask converts a synchronous throw into the same terminal `failed` outcome
  // as an asynchronously rejected fetch.
  void Promise.resolve()
    .then(() => run(controller.signal))
    .then(
      (value) => settle({ kind: 'complete', value }),
      (error: unknown) => settle({ kind: 'failed', error }),
    )

  return {
    signal: controller.signal,
    result,
    cancel: () => settle({ kind: 'cancelled' }),
  }
}
