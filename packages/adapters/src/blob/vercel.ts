import { BlobNotFoundError, del, head, put } from '@vercel/blob'
import type { BlobStore } from '@ash/contracts'

/**
 * Vercel Blob storage, private access.
 *
 * The natural fit when the API runs on Vercel: durable, no external cloud account, and the token
 * is injected by linking the store to the project. The store is created with **private** access,
 * so a blob URL is not world-readable — every read must carry the `BLOB_READ_WRITE_TOKEN` as a
 * bearer credential. Evidence is therefore never reachable by URL alone; the media route reads it
 * server-side after an RBAC check and streams the bytes, exactly as with the S3 adapter.
 *
 * Why `head()` resolves the URL instead of constructing it: the public host embeds the store id
 * (e.g. `l4nd…​.private.blob.vercel-storage.com`), which changes if the store is ever recreated.
 * Deriving it would bake a value that silently breaks on a re-provision; asking the store is one
 * extra round trip on a cold read path (manager review, audit) and cannot drift.
 */
export interface VercelBlobConfig {
  /** BLOB_READ_WRITE_TOKEN, injected when the Blob store is linked to the project. */
  token: string
}

export class VercelBlobStore implements BlobStore {
  readonly durable = true
  private readonly token: string

  constructor(config: VercelBlobConfig) {
    if (!config.token) throw new Error('VercelBlobStore requires a BLOB_READ_WRITE_TOKEN')
    this.token = config.token
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    // Keys are content-addressed (sha256), so `addRandomSuffix: false` keeps the key exact and
    // `allowOverwrite` makes re-uploading identical evidence a harmless no-op rather than a throw.
    await put(key, Buffer.from(bytes), {
      access: 'private',
      token: this.token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    let url: string
    try {
      url = (await head(key, { token: this.token })).url
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
    // Private blobs 403 without the token; the bearer credential is what authorises the read.
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Vercel Blob GET ${key} failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    try {
      await head(key, { token: this.token })
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /** Not part of the port, but useful for retention jobs and test cleanup. */
  async delete(key: string): Promise<void> {
    await del(key, { token: this.token })
  }
}

/** Robust across SDK versions: match the exported error class or its name. */
function isNotFound(err: unknown): boolean {
  return err instanceof BlobNotFoundError || (err as { name?: string })?.name === 'BlobNotFoundError'
}
