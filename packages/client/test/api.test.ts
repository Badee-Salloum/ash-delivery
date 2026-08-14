import { describe, expect, it, vi } from 'vitest'
import {
  type ApiClient,
  type CloudOcrResponse,
  acknowledgeStaleEvidencePath,
  evidenceUploadHeaders,
  readInCloud,
} from '../src/api.ts'

const failedRead = (reason: NonNullable<CloudOcrResponse['reason']>): CloudOcrResponse => ({
  ok: false,
  cached: false,
  reads: { used: 1, max: 20 },
  rows: [],
  fields: {},
  reason,
})

describe('cloud OCR transport', () => {
  it('preserves a structured server failure and its retryable reason', async () => {
    const response = failedRead('timeout')
    const putBytes = vi.fn().mockResolvedValue(response)
    const api = { putBytes } as unknown as ApiClient

    await expect(readInCloud(api, 'shift-1', 'odometer', new Blob([new Uint8Array([1])]))).resolves.toBe(response)
  })

  it('uses null only when no structured response arrives', async () => {
    const api = { putBytes: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ApiClient
    await expect(readInCloud(api, 'shift-1', 'odometer', new Blob([new Uint8Array([1])]))).resolves.toBeNull()
  })
})

it('builds the explicit stale-evidence acknowledgement route', () => {
  expect(acknowledgeStaleEvidencePath('shift-1', 'end', 'dashboard_2')).toBe(
    '/shifts/shift-1/media/end/dashboard_2/acknowledge-stale',
  )
})

it('sends explicit stale acknowledgement beside a real file timestamp', () => {
  expect(evidenceUploadHeaders(1234, true)).toEqual({
    'x-client-taken-at': '1234',
    'x-stale-evidence-acknowledged': 'true',
  })
  expect(evidenceUploadHeaders(null, false)).toEqual({})
})
