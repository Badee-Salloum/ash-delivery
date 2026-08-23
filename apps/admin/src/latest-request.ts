/**
 * Owns one abortable request generation.
 *
 * React screens use the ticket's `isCurrent` check as well as the AbortSignal: aborting fetch saves
 * the work, while the generation check also protects clients/mocks that resolve after an abort.
 */
export interface LatestRequestTicket {
  signal: AbortSignal
  isCurrent(): boolean
}

export class LatestRequestGuard {
  private generation = 0
  private controller: AbortController | null = null

  next(): LatestRequestTicket {
    this.controller?.abort()
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    return {
      signal: controller.signal,
      isCurrent: () => this.generation === generation && !controller.signal.aborted,
    }
  }

  cancel(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
  }
}
