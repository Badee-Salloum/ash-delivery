// Leave 250 ms for the local/network round trip so a count becomes visible *within* the promised
// eight seconds instead of merely starting its request at the eight-second boundary.
export const WORKING_NOW_POLL_MS = 7_750
export const WORKING_NOW_REQUEST_TIMEOUT_MS = 7_500

export interface WorkingNowSnapshot {
  asOf: string
  drivers: number
  vehicles: number
}

interface WorkingNowPollingOptions {
  load(signal: AbortSignal): Promise<WorkingNowSnapshot>
  onSnapshot(snapshot: WorkingNowSnapshot): void
  onUnavailable(error: unknown): void
  intervalMs?: number
  timeoutMs?: number
}

/**
 * Start one immediate, lightweight working-count read and refresh it on a fixed interval.
 *
 * The caller owns the last valid snapshot. A failed read only calls `onUnavailable`, which lets
 * the dashboard mark that snapshot stale instead of replacing a real count with a false zero.
 * Cleanup also suppresses a late response from the previously selected branch.
 */
export function startWorkingNowPolling({
  load,
  onSnapshot,
  onUnavailable,
  intervalMs = WORKING_NOW_POLL_MS,
  timeoutMs = WORKING_NOW_REQUEST_TIMEOUT_MS,
}: WorkingNowPollingOptions): () => void {
  let active = true
  let inFlight = false
  let currentController: AbortController | null = null

  const refresh = (): void => {
    if (!active || inFlight) return
    inFlight = true
    const controller = new AbortController()
    currentController = controller
    let timeout: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error('working-now request timed out'))
      }, timeoutMs)
    })
    void Promise.race([load(controller.signal), deadline])
      .then((snapshot) => {
        if (active) onSnapshot(snapshot)
      })
      .catch((error: unknown) => {
        if (active) onUnavailable(error)
      })
      .finally(() => {
        clearTimeout(timeout)
        if (currentController === controller) {
          currentController = null
          inFlight = false
        }
      })
  }

  refresh()
  const timer = setInterval(refresh, intervalMs)

  return () => {
    active = false
    currentController?.abort()
    clearInterval(timer)
  }
}
