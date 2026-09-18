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
    const app = await buildApp({
      deps,
      logger: true,
      splitGate: config.BR1_SPLIT_GATE,
      maxOcrReadsPerShift: config.OCR_MAX_READS_PER_SHIFT,
      driverSelfRegistrationEnabled: config.DRIVER_SELF_REGISTRATION_ENABLED,
    })
    await app.ready()
    return app
  })()
  return appPromise
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp()

  // Why not `app.server.emit('request', req, res)`: the request reaches this function through a
  // Vercel rewrite, and for a body with multi-byte UTF-8 (all our Arabic names) the delivered
  // byte length disagrees with the Content-Length header — Fastify's stream reader then rejects it
  // with "Request body size did not match Content-Length" and every Arabic POST 500s while ASCII
  // ones pass. So we buffer the body ourselves and hand it to Fastify via inject() with a length
  // it computes from the actual bytes. Responses at this scale are small (JSON, ≤300 KB images).
  // Vercel's `@vercel/node` already parses JSON/urlencoded bodies with the correct encoding and
  // hands them back on `req.body`. Re-reading the raw stream instead corrupts multi-byte UTF-8
  // (Arabic names came back as `????`) AND disagrees with Content-Length. So prefer the pre-parsed
  // body; only fall back to buffering the stream for content types Vercel leaves raw (binary
  // uploads). Handing inject a value it owns keeps body and Content-Length consistent by design.
  const parsedBody = (req as IncomingMessage & { body?: unknown }).body
  let payload: unknown
  if (parsedBody !== undefined && parsedBody !== null && parsedBody !== '') {
    payload = parsedBody
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    payload = raw.length > 0 ? raw : undefined
  }

  const headers = { ...req.headers }
  delete headers['content-length'] // let inject size the body from the value above
  delete headers['transfer-encoding']

  const response = await app.inject({
    method: (req.method ?? 'GET') as never,
    url: req.url ?? '/',
    headers: headers as never,
    payload: payload as never,
  })

  res.statusCode = response.statusCode
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) res.setHeader(key, value as string | string[])
  }
  res.end(response.rawPayload)
}
