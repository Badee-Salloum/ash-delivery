import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClient,
  type CloudOcrResponse,
  acknowledgeStaleEvidencePath,
  evidenceUploadHeaders,
  readInCloud,
} from '../src/api.ts'

afterEach(() => vi.unstubAllGlobals())

const failedRead = (reason: NonNullable<CloudOcrResponse['reason']>): CloudOcrResponse => ({
  ok: false,
  cached: false,
  retryable: true,
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
    expect(putBytes).toHaveBeenCalledWith(
      '/shifts/shift-1/ocr/odometer',
      expect.any(Uint8Array),
      expect.any(String),
      {},
      'POST',
    )
  })

  it('marks an explicit retry so a cached transient failure is genuinely read again', async () => {
    const response = failedRead('timeout')
    const putBytes = vi.fn().mockResolvedValue(response)
    const api = { putBytes } as unknown as ApiClient

    await expect(
      readInCloud(api, 'shift-1', 'orders', new Blob([new Uint8Array([1])]), true),
    ).resolves.toBe(response)
    expect(putBytes).toHaveBeenCalledWith(
      '/shifts/shift-1/ocr/orders',
      expect.any(Uint8Array),
      expect.any(String),
      { 'x-ash-orders-time-consensus': 'v1', 'x-ocr-retry': 'true' },
      'POST',
    )
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

it('binds close approval to the reviewed settlement and both physical confirmations', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'shift-1', state: 'approved', postings: 8 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  const settlementHash = 'a'.repeat(64)
  const body = {
    reviewedOrdersHash: 'orders-v1',
    reviewedSettlementHash: settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    varianceReason: 'counted with employee',
  }

  await expect(api.approveCloseShift('shift-1', body)).resolves.toMatchObject({ state: 'approved' })
  expect(fetchMock).toHaveBeenCalledWith('/api/shifts/shift-1/approve-close', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
})

it('re-reads an explicit stored dashboard slot with the time-consensus capability', async () => {
  const response = {
    ok: true,
    cached: false,
    retryable: false,
    reads: { used: 2, max: 15 },
    rows: [],
    evidence: {
      package: 'end',
      slot: 'dashboard_2',
      mediaId: 'media-2',
      attachmentToken: 'attachment-2',
    },
    target: { kind: 'order', providerOrderNo: 'order-7', provenanceLinked: false },
    reviewedOrdersHash: 'orders-hash',
    settlementHash: 'settlement-hash',
  }
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  const body = {
    package: 'end' as const,
    slot: 'dashboard_2',
    target: { kind: 'order' as const, providerOrderNo: 'order-7' },
    reason: 'verify the printed midnight time',
  }

  await expect(api.rereadOrderEvidence('shift-1', body)).resolves.toEqual(response)
  expect(fetchMock).toHaveBeenCalledWith('/api/shifts/shift-1/ocr/orders/evidence-reread', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-ash-orders-time-consensus': 'v1',
    },
    body: JSON.stringify(body),
  })
})

it('carries both physical confirmations with exceptional force-close actuals', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'shift-2', state: 'approved', postings: 6 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')

  await api.forceCloseShift('shift-2', {
    reason: 'device lost',
    cashDeclared: '120.00',
    walletDeclared: '30.00',
    reviewedSettlementHash: 'b'.repeat(64),
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
  })

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(JSON.parse(String(init.body))).toMatchObject({
    cashDeclared: '120.00',
    walletDeclared: '30.00',
    reviewedSettlementHash: 'b'.repeat(64),
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
  })
})

it('previews force-close settlement against the entered actual cash and wallet figures', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ settlementHash: 'c'.repeat(64) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')

  await api.shiftSettlement('shift-3', { actualCash: '120.00', actualWallet: '30.50' })

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shifts/shift-3/settlement?actualCash=120.00&actualWallet=30.50',
    expect.objectContaining({ method: 'GET', credentials: 'include' }),
  )
})
