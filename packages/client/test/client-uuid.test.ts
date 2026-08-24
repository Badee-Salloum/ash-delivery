import { describe, expect, it } from 'vitest'
import { clientUuid, type ClientUuidCrypto } from '../src/client-uuid.ts'

describe('clientUuid', () => {
  it('uses randomUUID when the browser provides it', () => {
    const source: ClientUuidCrypto = {
      randomUUID: () => 'native-id',
    }
    expect(clientUuid(source)).toBe('native-id')
  })

  it('falls back to getRandomValues with RFC 4122 version and variant bits', () => {
    const source: ClientUuidCrypto = {
      getRandomValues: (values) => {
        values.fill(0)
        return values
      },
    }
    expect(clientUuid(source)).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('falls back when a partial WebView exposes a broken randomUUID method', () => {
    const source: ClientUuidCrypto = {
      randomUUID: () => { throw new Error('not implemented') },
      getRandomValues: (values) => {
        values.fill(0)
        return values
      },
    }
    expect(clientUuid(source)).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('names a browser with no Web Crypto instead of throwing an opaque property error', () => {
    expect(() => clientUuid(null)).toThrow('secure_random_unavailable')
  })
})
