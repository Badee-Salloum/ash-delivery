import type { FastifyInstance } from 'fastify'

export interface OperationalBucket {
  minute: string
  route: string
  method: string
  status: number
  cause: string
  count: number
  durationMs: number
  maxDurationMs: number
  slowCount: number
}

/** No request URL, body, headers, actor, image transcript or coordinates enter this sink. */
export interface OperationalDiagnostics {
  record(sample: Omit<OperationalBucket, 'minute' | 'count' | 'maxDurationMs' | 'slowCount'>): Promise<void>
  flush(force?: boolean): Promise<void>
  /** Wait only for an already-started write before a serverless invocation can be frozen. */
  settled(): Promise<void>
}

export class BufferedOperationalDiagnostics implements OperationalDiagnostics {
  private buckets = new Map<string, OperationalBucket>()
  private lastFlush: number
  private flushing = false
  private nextAttempt = 0
  private pending: Promise<void> | null = null
  private readonly write: (buckets: OperationalBucket[]) => Promise<void>
  private readonly now: () => number
  private readonly warn: () => void
  constructor(
    write: (buckets: OperationalBucket[]) => Promise<void>,
    now: () => number = Date.now,
    warn: () => void = () => console.warn('operational_diagnostics_write_failed'),
  ) {
    this.write = write
    this.now = now
    this.warn = warn
    this.lastFlush = now()
  }

  async record(sample: Omit<OperationalBucket, 'minute' | 'count' | 'maxDurationMs' | 'slowCount'>): Promise<void> {
    const minute = new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString()
    const key = JSON.stringify([minute, sample.route, sample.method, sample.status, sample.cause])
    const durationMs = Number.isFinite(sample.durationMs) ? Math.max(0, Math.round(sample.durationMs)) : 0
    const old = this.buckets.get(key)
    this.buckets.set(key, { ...sample, minute, count: (old?.count ?? 0) + 1,
      durationMs: (old?.durationMs ?? 0) + durationMs,
      maxDurationMs: Math.max(old?.maxDurationMs ?? 0, durationMs),
      slowCount: (old?.slowCount ?? 0) + (durationMs >= 3_000 ? 1 : 0) })
    // Bound warm-instance memory. A cold/frozen instance may lose an unflushed success tail;
    // errors and slow requests flush immediately, unless the diagnostic store itself is down.
    if (this.buckets.size > 200) this.buckets.delete(this.buckets.keys().next().value!)
    if (sample.status >= 400 || durationMs >= 3_000 || this.now() - this.lastFlush >= 60_000) await this.flush()
  }

  async flush(force = false): Promise<void> {
    if (this.flushing || (!force && this.now() < this.nextAttempt) || this.buckets.size === 0) return
    this.flushing = true
    const batch = [...this.buckets.values()]
    this.buckets.clear()
    this.lastFlush = this.now()
    try {
      this.pending = this.write(batch)
      await this.pending
      // An error storm must not become one extra database write per failing HTTP request.
      this.nextAttempt = this.now() + 5_000
    } catch {
      // The commit outcome may be unknown. Never replay an uncertain increment (double counts).
      // Availability and truthful coverage beat diagnostics silently blocking financial requests.
      this.nextAttempt = this.now() + 60_000
      this.warn()
    } finally { this.flushing = false; this.pending = null }
  }

  async settled(): Promise<void> { await this.pending?.catch(() => undefined) }
}

export function databaseFailureCause(error: unknown): string {
  if (!error || typeof error !== 'object') return 'application'
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === '55P03') return 'lock_timeout'
  if (code === '57014') return 'statement_timeout'
  if (code === '53300') return 'connections_exhausted'
  if (code === '25P03') return 'idle_transaction_timeout'
  if (typeof code === 'string' && /^08[0-9A-Z]{3}$/.test(code)) return 'connection_error'
  if (message === 'timeout exceeded when trying to connect' || message === 'Connection terminated due to connection timeout') return 'connection_timeout'
  if (typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code)) return `constraint_${code}`
  return 'application'
}

export function installOperationalDiagnostics(app: FastifyInstance, sink: OperationalDiagnostics): void {
  const causes = new WeakMap<object, string>()
  app.addHook('onError', async (request, _reply, error) => { causes.set(request, databaseFailureCause(error)) })
  app.addHook('onResponse', async (request, reply) => {
    // This is the registered route TEMPLATE, never request.url (which may contain credentials).
    const route = request.routeOptions.url
    const template = typeof route === 'string' && route.startsWith('/') && route.length <= 180 &&
      /^[A-Za-z0-9_/:.*-]+$/.test(route) ? route : '/unmatched'
    try {
      await sink.record({ route: template, method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(request.method)
        ? request.method : 'OTHER', status: reply.statusCode,
        cause: causes.get(request) ?? (reply.statusCode === 401 ? (template === '/auth/login' ? 'login_rejected' : 'session_required')
          : reply.statusCode === 403 ? 'permission_denied' : reply.statusCode >= 400 ? 'http_refusal' : 'none'),
        durationMs: reply.elapsedTime })
    } catch { app.log.warn('operational_diagnostics_observe_failed') }
  })
  app.addHook('onClose', async () => { await sink.flush(true).catch(() => undefined) })
}
