/**
 * TOTP (RFC 6238) — the pure parts.
 *
 * SRS §7 and A-1 require 2FA for administrative roles. The domain owns the deterministic pieces:
 * base32 encode/decode, the counter maths, and the constant-time comparison. The HMAC itself is
 * injected, because a hash function is I/O-adjacent (it lives in `node:crypto`) and the domain
 * imports nothing.
 *
 * Time is a VALUE here, never `Date.now()`, so a verification is reproducible and testable at any
 * instant — including the window edges that are the whole reason TOTP has a drift tolerance.
 */

export type HmacSha1 = (key: Uint8Array, message: Uint8Array) => Uint8Array

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, no padding — what authenticator apps expect in an otpauth URI. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(secret: string): Uint8Array {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) throw new RangeError(`invalid base32 character: ${char}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8)
  // 64-bit big-endian. Counters fit comfortably in the low 48 bits for any real timestamp.
  let n = counter
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  return buf
}

/** The code for a specific counter. Exposed for testing against RFC vectors. */
export function totpForCounter(secret: Uint8Array, counter: number, hmac: HmacSha1): string {
  const digest = hmac(secret, counterBytes(counter))
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0')
}

/** The code for a wall-clock instant. */
export function totpAt(secretBase32: string, epochMs: number, hmac: HmacSha1): string {
  const counter = Math.floor(epochMs / 1000 / TOTP_PERIOD_SECONDS)
  return totpForCounter(base32Decode(secretBase32), counter, hmac)
}

/**
 * Verify a submitted code, allowing ±`window` periods of clock drift between the server and the
 * phone. `window: 1` (±30 s) is the usual, and forgiving enough for a cheap Android whose clock
 * is a little off.
 *
 * Comparison is constant-time: a length-independent early return would leak, over many attempts,
 * how many leading digits were right.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  epochMs: number,
  hmac: HmacSha1,
  window = 1,
): boolean {
  if (!/^\d{6}$/.test(submitted)) return false
  const secret = base32Decode(secretBase32)
  const counter = Math.floor(epochMs / 1000 / TOTP_PERIOD_SECONDS)
  let ok = false
  for (let w = -window; w <= window; w++) {
    // No early break — every candidate is checked so the running time does not reveal which
    // window matched.
    if (constantTimeEquals(totpForCounter(secret, counter + w, hmac), submitted)) ok = true
  }
  return ok
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Which roles must present a second factor (SRS §7 — administrative roles). */
export const ADMIN_ROLES = ['branch_manager', 'system_admin', 'general_manager'] as const
export function requires2fa(roleKey: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(roleKey)
}
