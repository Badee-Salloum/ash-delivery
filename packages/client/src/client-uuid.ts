/** The small Web Crypto surface needed by browsers that predate `crypto.randomUUID()`. */
export interface ClientUuidCrypto {
  randomUUID?: (() => string) | undefined
  getRandomValues?: (<T extends Uint8Array>(values: T) => T) | undefined
}

/**
 * Mint a browser-local RFC 4122 v4 identifier without requiring the relatively new
 * `crypto.randomUUID()` API. Cheap Android WebViews have supported `getRandomValues()` for much
 * longer; an old phone must not fail before an evidence upload merely because this convenience
 * method is missing.
 */
export function clientUuid(source: ClientUuidCrypto | null = globalThis.crypto): string {
  if (!source) throw new Error('secure_random_unavailable')
  if (typeof source.randomUUID === 'function') {
    try {
      return source.randomUUID()
    } catch {
      // Partial WebViews have shipped a present-but-broken convenience method; use the older API.
    }
  }
  if (typeof source.getRandomValues !== 'function') throw new Error('secure_random_unavailable')

  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}
