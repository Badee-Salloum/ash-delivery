import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalDiskBlobStore, NonDurableBlobStoreError, assertDurableBlobStore } from '../src/blob/disk.ts'
import { MemoryBlobStore } from '../src/memory/media.ts'
import { S3BlobStore } from '../src/blob/s3.ts'
import { VercelBlobStore } from '../src/blob/vercel.ts'

const root = mkdtempSync(join(tmpdir(), 'ash-blob-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('LocalDiskBlobStore', () => {
  const store = new LocalDiskBlobStore(root)

  it('round-trips bytes exactly', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x42])
    await store.put('ab/cd/abcd', bytes, 'image/jpeg')
    expect(await store.exists('ab/cd/abcd')).toBe(true)
    expect(Array.from((await store.get('ab/cd/abcd'))!)).toEqual(Array.from(bytes))
  })

  it('returns null for a missing key rather than throwing', async () => {
    expect(await store.get('no/su/nope')).toBeNull()
    expect(await store.exists('no/su/nope')).toBe(false)
  })

  it('refuses a key that escapes the storage root', async () => {
    // Keys are server-generated hashes today, but a store that only behaves when its caller
    // behaves is one refactor away from being a file-write primitive exposed over HTTP.
    await expect(store.put('../../escape', new Uint8Array([1]), 'image/jpeg')).rejects.toThrow(/escapes/)
    await expect(store.get('../../../etc/passwd')).rejects.toThrow(/escapes/)
  })

  it('overwrites atomically', async () => {
    await store.put('aa/bb/x', new Uint8Array([1, 2, 3]), 'image/jpeg')
    await store.put('aa/bb/x', new Uint8Array([9]), 'image/jpeg')
    expect(Array.from((await store.get('aa/bb/x'))!)).toEqual([9])
  })
})

describe('the durability guard', () => {
  it('lets any store through outside production', () => {
    expect(() => assertDurableBlobStore(new MemoryBlobStore(), 'development')).not.toThrow()
    expect(() => assertDurableBlobStore(new LocalDiskBlobStore(root), 'test')).not.toThrow()
  })

  it('REFUSES a non-durable store in production', () => {
    // Photos that vanish on redeploy are worse than photos never taken: the shift is already
    // approved and the audit trail points at a file that is gone.
    expect(() => assertDurableBlobStore(new MemoryBlobStore(), 'production')).toThrow(NonDurableBlobStoreError)
    expect(() => assertDurableBlobStore(new LocalDiskBlobStore(root), 'production')).toThrow(
      /non-durable storage in production/,
    )
  })

  it('accepts an S3-compatible store in production', () => {
    const s3 = new S3BlobStore({
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'ash',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    expect(s3.durable).toBe(true)
    expect(() => assertDurableBlobStore(s3, 'production')).not.toThrow()
  })

  it('accepts a Vercel Blob store in production', () => {
    // The put/get/exists round trip against a real private store is proven by a manual spike,
    // not wired into CI (it needs a live BLOB_READ_WRITE_TOKEN). Here we assert the two things
    // that are pure: it declares itself durable, and the boot guard lets it through.
    const vb = new VercelBlobStore({ token: 'vercel_blob_rw_test_token' })
    expect(vb.durable).toBe(true)
    expect(() => assertDurableBlobStore(vb, 'production')).not.toThrow()
  })

  it('refuses to construct without a token — a silent misconfig would 500 on first upload', () => {
    expect(() => new VercelBlobStore({ token: '' })).toThrow(/BLOB_READ_WRITE_TOKEN/)
  })
})
