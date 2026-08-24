import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClient,
  type CloudOcrResponse,
  acknowledgeStaleEvidencePath,
  evidenceUploadHeaders,
  readInCloud,
} from '../src/api.ts'

afterEach(() => vi.unstubAllGlobals())

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])

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

    await expect(readInCloud(api, 'shift-1', 'odometer', new Blob([JPEG]))).resolves.toBe(response)
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
      readInCloud(api, 'shift-1', 'orders', new Blob([JPEG]), true),
    ).resolves.toBe(response)
    expect(putBytes).toHaveBeenCalledWith(
      '/shifts/shift-1/ocr/orders',
      expect.any(Uint8Array),
      expect.any(String),
      { 'x-ash-orders-time-consensus': 'close-draft-v1', 'x-ocr-retry': 'true' },
      'POST',
    )
  })

  it('uses null only when no structured response arrives', async () => {
    const api = { putBytes: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ApiClient
    await expect(readInCloud(api, 'shift-1', 'odometer', new Blob([JPEG]))).resolves.toBeNull()
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

it('adds the selected branch exactly once to the restoration preview read', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        businessDate: '2026-08-15',
        counted: true,
        alreadyRestored: false,
        legs: [],
        netToCompany: '0.00',
        feasible: true,
        refusals: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')

  await api.restorationPreview()

  expect(fetchMock).toHaveBeenCalledWith('/api/treasury/restoration/preview?branchId=branch-1', {
    method: 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  })
})

it('publishes both restoration targets and their audited reason in one branch-scoped PUT', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      businessDate: '2026-08-23',
      cashTarget: '50000.00',
      walletTarget: '10000.00',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')

  await api.updateCapitalTargets('50000.00', '10000.00', 'owner decision')

  expect(fetchMock).toHaveBeenCalledWith('/api/treasury/capital-targets', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cashTarget: '50000.00',
      walletTarget: '10000.00',
      reason: 'owner decision',
      branchId: 'branch-1',
    }),
  })
})

it('sends the client-owned expense idempotency key with the selected branch', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'expense-1', amount: '25.00' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')
  const body = {
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    categoryId: 'fuel',
    costCenterKind: 'general' as const,
    vehicleId: null,
    amount: '25.00',
    description: 'Charging electricity',
  }

  await api.createExpense(body)

  expect(fetchMock).toHaveBeenCalledWith('/api/expenses', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, branchId: 'branch-1' }),
  })
})

it('scopes receivable balances and history to the selected branch', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ drivers: [], grandTotal: '0.00' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')

  await api.receivables()
  await api.receivableEvents('driver 1')

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/treasury/receivables?branchId=branch-1', {
    method: 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  })
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/treasury/receivables/events?driverId=driver%201&branchId=branch-1',
    {
      method: 'GET',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    },
  )
})

it('posts a direct receivable event with its client key and selected branch', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'event-1', replayed: false }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')
  const body = {
    driverId: 'driver-1',
    receivableKind: 'ordinary' as const,
    channel: 'cash' as const,
    direction: 'create' as const,
    amount: '250.00',
    reason: 'Cash handed to the driver',
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }

  await api.createReceivableEvent(body)

  expect(fetchMock).toHaveBeenCalledWith('/api/treasury/receivables/events', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, branchId: 'branch-1' }),
  })
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

it('reads live shift funding and sends both reviewed open-approval balances including zero', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'shift-1',
        shiftFunding: { cash: '12500.00', wallet: '0.00' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'shift-1', state: 'open' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')

  const review = await api.shiftReview<{ id: string }>('shift-1', { cache: 'no-store' })
  expect(review.shiftFunding).toEqual({ cash: '12500.00', wallet: '0.00' })
  const body = {
    floatTranches: [],
    topupTranches: [],
    carriedTranches: [review.shiftFunding.cash],
    carriedWalletTranches: [],
  }
  await api.approveOpenShift('shift-1', body)

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/shifts/shift-1/review', {
    method: 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  })
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/shifts/shift-1/approve-open', {
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
      'x-ash-orders-time-consensus': 'close-draft-v1',
    },
    body: JSON.stringify(body),
  })
})

it('reads a linked close-draft attachment with the current time-consensus capability', async () => {
  const response = { draft: {}, read: {}, rows: [], fields: {} }
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  const body = {
    expectedRevision: 7,
    mediaId: 'media-2',
    attachmentToken: 'attachment-2',
    field: 'orders' as const,
    retryFailed: true,
  }

  await api.readCloseDraftAttachment('shift-1', 'dashboard_2', body)

  expect(fetchMock).toHaveBeenCalledWith('/api/shifts/shift-1/close-draft/media/dashboard_2/read', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-ash-orders-time-consensus': 'close-draft-v1',
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

it('previews a close settlement with separate cash and wallet receivable deferrals', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ settlementHash: 'd'.repeat(64) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')

  await api.shiftSettlement(
    'shift-4',
    undefined,
    { cashReceivableDeferred: '6000.00', walletReceivableDeferred: '1000.00' },
  )

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shifts/shift-4/settlement?cashReceivableDeferred=6000.00&walletReceivableDeferred=1000.00',
    expect.objectContaining({ method: 'GET', credentials: 'include' }),
  )
})
