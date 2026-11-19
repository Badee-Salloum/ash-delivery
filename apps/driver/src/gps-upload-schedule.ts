/** Upload backoff only; capture and durable outbox retention continue independently. */
export class GpsUploadSchedule {
  private failures = 0
  private nextAt = 0
  blocked = false

  canSend(now: number): boolean { return !this.blocked && now >= this.nextAt }

  succeeded(): void {
    this.failures = 0
    this.nextAt = 0
  }

  failed(error: unknown, now: number, random = Math.random()): void {
    const status = (error as { status?: number } | null)?.status
    // Re-authentication/remount may resume this queue; never delete points on an HTTP refusal.
    if (status === 401 || status === 403 || status === 404 || status === 409) {
      this.blocked = true
      return
    }
    this.failures += 1
    // A bounded delay and jitter prevent every phone retrying a busy API on the same 15s tick.
    const delay = Math.min(300_000, 15_000 * 2 ** Math.min(this.failures - 1, 5))
    this.nextAt = now + Math.round(delay * (1 + Math.max(0, Math.min(1, random)) * 0.2))
  }
}
