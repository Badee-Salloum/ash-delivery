import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { BlobStore } from '@ash/contracts'

/**
 * Blob storage on a local filesystem.
 *
 * Correct on a VPS with a mounted volume. **Wrong on any serverless host** — Vercel's filesystem
 * is ephemeral and per-invocation, so evidence written here vanishes on the next deploy while the
 * ledger keeps claiming the shift was photographed. `durable` is false for exactly that reason,
 * and `assertDurableBlobStore()` refuses to boot production against it.
 */
export class LocalDiskBlobStore implements BlobStore {
  readonly durable = false
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * Resolve a key under the root, refusing anything that escapes it.
   *
   * Keys are server-generated sha256 hashes today, so traversal is not reachable — but a store
   * that only behaves when its caller behaves is one refactor away from being a file-write
   * primitive exposed over HTTP.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key))
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`blob key escapes the storage root: ${key}`)
    }
    return full
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    // Write to a temp file and rename: a crash mid-write must not leave a truncated photo that
    // looks present to `exists()` but decodes to nothing.
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.pathFor(key))
  }
}

/** A store is durable when a redeploy cannot lose what was written. */
export interface MaybeDurable {
  durable?: boolean
}

export class NonDurableBlobStoreError extends Error {}

/**
 * Refuse to start production against storage that loses evidence on redeploy.
 *
 * Photos that vanish are worse than photos that were never taken: the shift is already approved,
 * the ledger already posted, and the audit trail points at a file that is gone. Failing at boot
 * is the only honest response.
 */
export function assertDurableBlobStore(store: BlobStore & MaybeDurable, nodeEnv: string): void {
  if (nodeEnv !== 'production') return
  if (store.durable !== true) {
    throw new NonDurableBlobStoreError(
      'refusing to start: BLOB_DRIVER resolves to non-durable storage in production. ' +
        'Evidence photos would be lost on redeploy while the ledger still claims the shift was ' +
        'photographed. Configure S3-compatible or Vercel Blob storage.',
    )
  }
}
