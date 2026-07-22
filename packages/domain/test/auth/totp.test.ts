import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLES,
  base32Decode,
  base32Encode,
  constantTimeEquals,
  requires2fa,
  totpForCounter,
  verifyTotp,
} from '../../src/auth/totp.ts'

// The one place a real HMAC is supplied. In production the API injects the same from node:crypto.
const hmac = (key: Uint8Array, msg: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha1', Buffer.from(key)).update(Buffer.from(msg)).digest())

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 128, 64, 255, 33])
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes))
  })

  it('decodes a known base32 vector to the right bytes', () => {
    // "Hello!" in ASCII is 48 65 6c 6c 6f 21, which base32-encodes to JBSWY3DPEE======.
    expect(Array.from(base32Decode('JBSWY3DPEE'))).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21])
    expect(base32Encode(new TextEncoder().encode('Hello!'))).toBe('JBSWY3DPEE')
  })

  it('rejects an invalid character', () => {
    expect(() => base32Decode('01890!')).toThrow(RangeError)
  })
})

describe('TOTP against the RFC 6238 vectors', () => {
  // RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" with SHA-1.
  const secret = new TextEncoder().encode('12345678901234567890')

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at t=%i produces %s', (unixSeconds, expected) => {
    const counter = Math.floor(unixSeconds / 30)
    expect(totpForCounter(secret, counter, hmac)).toBe(expected)
  })
})

describe('verifyTotp', () => {
  const secretB32 = base32Encode(new TextEncoder().encode('a-real-enough-secret-32-bytes!!!'))
  const at = (ms: number) => {
    const counter = Math.floor(ms / 1000 / 30)
    return totpForCounter(base32Decode(secretB32), counter, hmac)
  }

  it('accepts the current code', () => {
    const now = 1_784_000_000_000
    expect(verifyTotp(secretB32, at(now), now, hmac)).toBe(true)
  })

  it('accepts a code from the adjacent window (phone clock drift)', () => {
    const now = 1_784_000_000_000
    const prev = now - 30_000
    expect(verifyTotp(secretB32, at(prev), now, hmac, 1)).toBe(true)
  })

  it('rejects a code two windows out', () => {
    const now = 1_784_000_000_000
    expect(verifyTotp(secretB32, at(now - 90_000), now, hmac, 1)).toBe(false)
  })

  it('rejects a malformed code without hashing', () => {
    expect(verifyTotp(secretB32, '12', 0, hmac)).toBe(false)
    expect(verifyTotp(secretB32, 'abcdef', 0, hmac)).toBe(false)
  })
})

describe('constant-time comparison', () => {
  it('is true only for equal strings', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true)
    expect(constantTimeEquals('123456', '123457')).toBe(false)
    expect(constantTimeEquals('123456', '12345')).toBe(false)
  })
})

describe('which roles need a second factor (SRS §7)', () => {
  it('the three admin roles do; the driver does not', () => {
    expect(ADMIN_ROLES).toEqual(['branch_manager', 'system_admin', 'general_manager'])
    expect(requires2fa('system_admin')).toBe(true)
    expect(requires2fa('branch_manager')).toBe(true)
    expect(requires2fa('general_manager')).toBe(true)
    expect(requires2fa('driver')).toBe(false)
    expect(requires2fa('accountant')).toBe(false)
  })
})
