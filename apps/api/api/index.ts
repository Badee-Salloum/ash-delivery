import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { buildDeps } from '../src/deps.ts'

/**
 * Vercel serverless entry point.
 *
 * Vercel gives each invocation a Node request/response pair, so the Fastify instance is built
 * once per warm instance and then fed requests directly. `app.ready()` must have resolved before
 * the first `emit`, which is why the whole thing hangs off a memoised promise rather than being
 * constructed per request.
 *
 * ── THINGS THAT DIFFER FROM THE VPS DEPLOYMENT ──────────────────────────────────────────
 *
 * 1. **The filesystem is ephemeral.** `BLOB_DRIVER=disk` would lose every evidence photo on the
 *    next deploy while the ledger still claimed the shift was photographed. `buildDeps` calls
 *    `assertDurableBlobStore`, which refuses to boot production on anything but `s3`.
 *
 * 2. **Connections fan out.** Every warm instance holds its own pool, so `DB_POOL_MAX` must be
 *    small and `DATABASE_URL` must be Neon's **pooled** endpoint (the `-pooler` host). Pointing
 *    at the direct endpoint exhausts Postgres under modest concurrency.
 *
 * 3. **Migrations do not run here.** A serverless function must never migrate: concurrent cold
 *    starts would race, and a failed migration would be invisible behind a 500. Run
 *    `pnpm --filter @ash/api migrate` from CI as a deploy step.
 *
 * 4. **No graceful SIGTERM.** The platform may freeze an instance mid-request, which is another
 *    reason approval posting is idempotent on (shift_id, event_type, occurrence_key): a retried
 *    request after a frozen instance must not double-post.
 */

let appPromise: Promise<FastifyInstance> | null = null

async function getApp(): Promise<FastifyInstance> {
  appPromise ??= (async () => {
    const config = loadConfig()
    const { deps } = await buildDeps(config)
    const app = await buildApp({ deps, logger: true, splitGate: config.BR1_SPLIT_GATE })
    await app.ready()
    return app
  })()
  return appPromise
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp()
  app.server.emit('request', req, res)
}
