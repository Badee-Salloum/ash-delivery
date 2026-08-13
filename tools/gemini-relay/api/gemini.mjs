/**
 * A throwaway vision-API relay — the ONLY reason it exists is that Google and OpenAI geo-block Syria.
 *
 * It is a pass-through and nothing more: the benchmark builds the entire upstream request body
 * locally, this attaches the key and forwards it, and the response comes back verbatim. No OCR
 * logic lives here, so it cannot drift from the thing it serves.
 *
 * ── WHY NODE AND NOT EDGE ────────────────────────────────────────────────────────────────────
 * Edge functions run "in the region closest to the incoming request". The incoming request comes
 * from Damascus, so Edge would happily place the call right back inside the geography we are
 * routing around — it would defeat the only purpose of this file. Node functions run in a fixed
 * region (iad1 by default), which is the behaviour we actually need. `regions` is deliberately
 * left unset so Vercel keeps that default.
 *
 * ── WHY maxDuration IS 250 AND NOT 300 ───────────────────────────────────────────────────────
 * Node's built-in fetch (undici) defaults its headers/body timeouts to 300_000 ms. Set this to 300
 * and the caller's socket dies at the same instant the platform gives up, turning a clean 504 into
 * an opaque socket error — with the request already counted against a metered quota. 250 keeps the
 * platform's failure strictly earlier and legible.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────────────────────
 * The upstream is chosen from a FIXED TABLE by a short provider name; the caller never supplies a
 * URL. Without that, the shared secret is the only thing between the internet and arbitrary billed
 * calls on somebody's key — and one of these keys is now attached to a card. Nothing derived from
 * the body is ever logged: that base64 is a delivery company's customer screenshots, and Vercel
 * retains logs.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * The whole allowlist. A provider is a name, a host, a path builder and how its key is presented —
 * never anything the request body can influence.
 */
const PROVIDERS = {
  gemini: {
    env: 'GEMINI_API_KEY',
    list: () => 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    call: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    auth: (key) => ({ 'x-goog-api-key': key }),
  },
  openai: {
    env: 'OPENAI_API_KEY',
    list: () => 'https://api.openai.com/v1/models',
    call: () => 'https://api.openai.com/v1/chat/completions',
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
}

/** Constant-time compare that does not leak length through an early return. */
function secretOk(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong LENGTH is not faster to discover than a wrong VALUE.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export default async function handler(req, res) {
  if (!secretOk(req.headers['x-relay-secret'], process.env.RELAY_SECRET)) {
    return res.status(401).json({ error: 'bad_relay_secret' })
  }

  const wanted = String(req.headers['x-provider'] ?? req.query?.provider ?? 'gemini')
  const p = PROVIDERS[wanted]
  if (!p) return res.status(400).json({ error: 'unknown_provider', known: Object.keys(PROVIDERS) })
  const key = process.env[p.env]
  if (!key) return res.status(500).json({ error: 'relay_missing_key', needs: p.env })

  // Discovery: which models does this key actually have? Costs no completion quota, and a console's
  // display name ("Gemini 3.6 Flash") is not the API id.
  if (req.method === 'GET') {
    const r = await fetch(p.list(), { headers: p.auth(key) })
    const text = await r.text()
    return res.status(r.status).setHeader('content-type', r.headers.get('content-type') ?? 'application/json').send(text)
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'body_must_be_json' })

  // The model is a bare id chosen by the caller, but the PATH is built here — a caller cannot
  // smuggle a different host, a different API version, or a different endpoint through it.
  const model = String(body.model ?? '').replace(/[^a-zA-Z0-9._-]/g, '')
  if (!model) return res.status(400).json({ error: 'model_required' })
  const payload = body.request
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'request_required' })

  let upstream
  try {
    upstream = await fetch(p.call(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...p.auth(key) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(230_000),
    })
  } catch (err) {
    // Never echo `err.message` blindly — undici puts the request URL in some errors.
    return res.status(504).json({ error: 'upstream_unreachable', name: err?.name ?? 'Error' })
  }

  const text = await upstream.text()
  // Forwarded VERBATIM, including on 4xx/5xx: a Gemini 429 carries RetryInfo.retryDelay and an
  // OpenAI 429 carries its own headers, which is how the caller learns the real rate limit.
  // Wrapping either in a relay 500 would throw that away.
  res
    .status(upstream.status)
    .setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
    .send(text)
}
