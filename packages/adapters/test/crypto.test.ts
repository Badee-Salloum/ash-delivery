import { describe, expect, it } from 'vitest'
import { EncryptionUnavailableError, cipherFromKey, makeCipher, nullCipher, parseEncryptionKey } from '../src/crypto.ts'

/**
 * The `Cipher` port (AES-256-GCM), the encryption at rest behind a driver's national ID.
 *
 * What matters: a round-trip returns exactly what went in; a key is required (no silent plaintext);
 * a tampered blob or the wrong key is REJECTED, not quietly mis-decrypted — that is the whole point
 * of an authenticated cipher.
 */

const KEY_A = Buffer.alloc(32, 0x11)
const KEY_B = Buffer.alloc(32, 0x22)

describe('AES-256-GCM cipher', () => {
  it('round-trips a value unchanged', () => {
    const c = makeCipher(KEY_A)
    const blob = c.encrypt('١١٠١٠٢٣٤٥٦') // Arabic-Indic digits — UTF-8, not just ASCII
    expect(c.decrypt(blob)).toBe('١١٠١٠٢٣٤٥٦')
  })

  it('produces different ciphertext each time (random IV), and both decrypt', () => {
    const c = makeCipher(KEY_A)
    const a = Buffer.from(c.encrypt('12345'))
    const b = Buffer.from(c.encrypt('12345'))
    expect(a.equals(b)).toBe(false)
    expect(c.decrypt(a)).toBe('12345')
    expect(c.decrypt(b)).toBe('12345')
  })

  it('refuses a blob decrypted under the wrong key', () => {
    const blob = makeCipher(KEY_A).encrypt('secret')
    expect(() => makeCipher(KEY_B).decrypt(blob)).toThrow()
  })

  it('refuses a tampered blob', () => {
    const c = makeCipher(KEY_A)
    const blob = Buffer.from(c.encrypt('secret'))
    const last = blob.length - 1
    blob[last] = blob[last]! ^ 0xff // flip a ciphertext bit
    expect(() => c.decrypt(blob)).toThrow()
  })

  it('is marked available', () => {
    expect(makeCipher(KEY_A).available).toBe(true)
  })
})

describe('no key configured', () => {
  it('nullCipher refuses to encrypt and reports unavailable', () => {
    const c = nullCipher()
    expect(c.available).toBe(false)
    expect(() => c.encrypt('x')).toThrow(EncryptionUnavailableError)
  })

  it('cipherFromKey(undefined) is a null cipher', () => {
    expect(cipherFromKey(undefined).available).toBe(false)
    expect(cipherFromKey('').available).toBe(false)
  })
})

describe('parseEncryptionKey', () => {
  it('accepts 64 hex chars and base64 for 32 bytes', () => {
    expect(parseEncryptionKey('a'.repeat(64))?.length).toBe(32)
    expect(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'))?.length).toBe(32)
  })

  it('returns null when unset', () => {
    expect(parseEncryptionKey(undefined)).toBeNull()
    expect(parseEncryptionKey(null)).toBeNull()
  })

  it('throws on a present-but-wrong-length key rather than truncating', () => {
    expect(() => parseEncryptionKey('deadbeef')).toThrow(/32 bytes/)
  })

  it('cipherFromKey builds a working cipher from a hex key', () => {
    const c = cipherFromKey('b'.repeat(64))
    expect(c.available).toBe(true)
    expect(c.decrypt(c.encrypt('42'))).toBe('42')
  })
})
