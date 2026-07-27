import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Cipher } from '@ash/contracts'

/**
 * Authenticated encryption at rest (the `Cipher` port), AES-256-GCM.
 *
 * Used for the PII the schema marks encrypted — a driver's national ID today. The key never
 * leaves the server and is supplied out of band (the `ENCRYPTION_KEY` env var); losing it means
 * the ciphertext is unrecoverable, which is the point.
 *
 * Stored blob layout: `[1 version byte][12-byte IV][16-byte GCM tag][ciphertext]`. The version
 * byte buys algorithm agility later without a data migration; the random IV per message means the
 * same national ID never encrypts to the same bytes twice.
 */

const VERSION = 0x01
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const HEADER = 1 + IV_LEN + TAG_LEN

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('encryption unavailable: no ENCRYPTION_KEY configured')
    this.name = 'EncryptionUnavailableError'
  }
}

/**
 * Parse `ENCRYPTION_KEY` into a 32-byte key, or null when unset. Accepts 64 hex characters or
 * base64 that decodes to 32 bytes. A key that is present but the wrong length is a hard error:
 * silently truncating it would encrypt PII under a key nobody chose.
 */
export function parseEncryptionKey(raw: string | undefined | null): Buffer | null {
  if (!raw) return null
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== KEY_LEN) {
    throw new Error(`ENCRYPTION_KEY must be ${KEY_LEN} bytes — 64 hex chars or base64 for 32 bytes; got ${key.length}`)
  }
  return key
}

export function makeCipher(key: Buffer): Cipher {
  if (key.length !== KEY_LEN) throw new Error(`cipher key must be ${KEY_LEN} bytes`)
  return {
    available: true,
    encrypt(plaintext: string): Uint8Array {
      const iv = randomBytes(IV_LEN)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), enc])
    },
    decrypt(blob: Uint8Array): string {
      const buf = Buffer.from(blob)
      if (buf.length < HEADER || buf[0] !== VERSION) throw new Error('unrecognised ciphertext')
      const iv = buf.subarray(1, 1 + IV_LEN)
      const tag = buf.subarray(1 + IV_LEN, HEADER)
      const d = createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(buf.subarray(HEADER)), d.final()]).toString('utf8')
    },
  }
}

/** For when no key is configured: refuses to encrypt, and has nothing it can decrypt. */
export function nullCipher(): Cipher {
  return {
    available: false,
    encrypt(): Uint8Array {
      throw new EncryptionUnavailableError()
    },
    decrypt(): string {
      throw new EncryptionUnavailableError()
    },
  }
}

/** Build a cipher from a raw key string (the env var). Absent/empty → a null cipher. */
export function cipherFromKey(raw: string | undefined | null): Cipher {
  const key = parseEncryptionKey(raw)
  return key ? makeCipher(key) : nullCipher()
}

/**
 * A fixed-key cipher for the in-memory adapter (tests, local dev without a real key). NOT for
 * production — the key is in the source. Real deployments build their cipher from `ENCRYPTION_KEY`.
 */
export const memoryCipher = (): Cipher => makeCipher(Buffer.alloc(KEY_LEN, 0x2a))
