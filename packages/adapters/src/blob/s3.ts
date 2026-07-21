import { createHash, createHmac } from 'node:crypto'
import type { BlobStore } from '@ash/contracts'

/**
 * S3-compatible blob storage, signed with SigV4 over `fetch`.
 *
 * No AWS SDK: the SDK is ~15 MB and pulls a large dependency tree for what is, at this scale,
 * three HTTP verbs. This talks to anything S3-compatible — Backblaze B2, Cloudflare R2, Hetzner
 * Object Storage, MinIO, or AWS itself — which also keeps the platform free of a US-cloud
 * dependency that sanctions could sever.
 */
export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Path-style is what most non-AWS S3 implementations expect. */
  forcePathStyle?: boolean
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest()

export class S3BlobStore implements BlobStore {
  readonly durable = true
  private readonly config: S3Config

  constructor(config: S3Config) {
    this.config = config
  }

  private urlFor(key: string): { url: string; host: string; path: string } {
    const endpoint = new URL(this.config.endpoint)
    const pathStyle = this.config.forcePathStyle ?? true
    if (pathStyle) {
      const path = `/${this.config.bucket}/${key}`
      return { url: `${endpoint.origin}${path}`, host: endpoint.host, path }
    }
    const host = `${this.config.bucket}.${endpoint.host}`
    return { url: `${endpoint.protocol}//${host}/${key}`, host, path: `/${key}` }
  }

  /** AWS SigV4. Deliberately explicit — a signing bug is a silent 403 at 2am. */
  private sign(
    method: string,
    key: string,
    payload: Uint8Array | string,
    extraHeaders: Record<string, string>,
    nowIso: string,
  ): { url: string; headers: Record<string, string> } {
    const { url, host, path } = this.urlFor(key)
    const amzDate = nowIso.replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256Hex(payload)

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    }
    const signedHeaderNames = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h] ?? headers[h.toLowerCase()]}\n`).join('')
    const signedHeaders = signedHeaderNames.join(';')

    const canonicalRequest = [
      method,
      path.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/'),
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    )
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`
    return { url, headers }
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const { url, headers } = this.sign('PUT', key, bytes, { 'content-type': contentType }, new Date().toISOString())
    const res = await fetch(url, { method: 'PUT', headers, body: bytes })
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { url, headers } = this.sign('GET', key, '', {}, new Date().toISOString())
    const res = await fetch(url, { method: 'GET', headers })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    const { url, headers } = this.sign('HEAD', key, '', {}, new Date().toISOString())
    const res = await fetch(url, { method: 'HEAD', headers })
    if (res.status === 404) return false
    if (!res.ok && res.status !== 200) throw new Error(`S3 HEAD ${key} failed: ${res.status}`)
    return res.ok
  }
}
