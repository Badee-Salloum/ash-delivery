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
        source: 'live_ledger',
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

  const preview = await api.restorationPreview()

  expect(preview.source).toBe('live_ledger')

  expect(fetchMock).toHaveBeenCalledWith('/api/treasury/restoration/preview?branchId=branch-1', {
    method: 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  })
})

it('normalizes the legacy restoration balance field without exposing the old count gate', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        businessDate: '2026-08-31',
        counted: false,
        alreadyRestored: false,
        legs: [
          {
            fundCode: 'office_cash',
            counted: '52030.00',
            receivables: '7970.00',
            position: '60000.00',
            capitalTarget: '60000.00',
            delta: '0.00',
            direction: null,
            amount: '0.00',
            feasible: true,
            refusals: [],
          },
        ],
        netToCompany: '0.00',
        feasible: true,
        refusals: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)

  const preview = await new ApiClient('/api').restorationPreview()

  expect(preview).not.toHaveProperty('counted')
  expect(preview.source).toBeUndefined()
  expect(preview.legs[0]).toMatchObject({ officeBalance: '52030.00' })
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

it('sends the client-owned key on company-fund moves, treasury deposits and withdrawals, with the selected branch', async () => {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ balance: '10.00', replayed: false }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')
  const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const posted = (url: string, body: Record<string, unknown>) => [
    url,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ]

  await api.companyFundDeposit('10.00', 'رأس مال', key)
  await api.companyFundWithdraw('10.00', 'مسحوبات', key)
  await api.treasuryDeposit('cash', '10.00', key)
  await api.treasuryWithdraw('wallet', '10.00', 'كييش', 'company_box', key)

  expect(fetchMock.mock.calls).toEqual([
    posted('/api/company-fund/deposit', { idempotencyKey: key, amount: '10.00', reason: 'رأس مال', branchId: 'branch-1' }),
    posted('/api/company-fund/withdraw', { idempotencyKey: key, amount: '10.00', reason: 'مسحوبات', branchId: 'branch-1' }),
    posted('/api/treasury/deposit', { idempotencyKey: key, target: 'cash', amount: '10.00', branchId: 'branch-1' }),
    posted('/api/treasury/withdraw', {
      idempotencyKey: key,
      target: 'wallet',
      amount: '10.00',
      to: 'company_box',
      reason: 'كييش',
      branchId: 'branch-1',
    }),
  ])
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

it('posts a receivable write-off without disguising it as a collection', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'writeoff-1', replayed: false }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')
  api.setBranch('branch-1')
  const body = {
    driverId: 'driver-1',
    channel: 'wallet' as const,
    amount: '125.00',
    reason: 'Approved uncollectible debt',
    idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }

  await api.writeoffReceivable(body)

  expect(fetchMock).toHaveBeenCalledWith('/api/treasury/receivables/writeoffs', {
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

it('previews next-shift funding separately from an ordinary close shortage receivable', async () => {
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
    {
      cashReceivableDeferred: '6000.00',
      walletReceivableDeferred: '1000.00',
      cashShortageReceivable: '400.00',
    },
  )

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shifts/shift-4/settlement?cashReceivableDeferred=6000.00&walletReceivableDeferred=1000.00&cashShortageReceivable=400.00',
    expect.objectContaining({ method: 'GET', credentials: 'include' }),
  )
})

it('normalizes an older settlement response without close-shortage fields instead of crashing review', async () => {
  const legacy = {
    policyCode: 'fixed_40_cash_close_v2_receivable',
    driverRateBps: 4000,
    deliveryFeeTotal: '1000.00',
    fixedDriverShare: '400.00',
    manualDriverShare: '0.00',
    grossDriverShare: '400.00',
    cashDeductionTotal: '0.00',
    baseDriverShare: '400.00',
    expectedTotal: '1800.00',
    actualCash: '1300.00',
    actualWallet: '500.00',
    actualTotal: '1800.00',
    variance: '0.00',
    varianceDirection: 'balanced',
    finalEmployeeCash: '400.00',
    cashClaimToOffice: '900.00',
    walletClaimToOffice: '500.00',
    cashReceivableDeferred: '0.00',
    walletReceivableDeferred: '0.00',
    walletToOffice: '500.00',
    cashToOffice: '900.00',
    walletAction: 'collect',
    walletAmount: '500.00',
    cashAction: 'collect',
    cashAmount: '900.00',
    settlementHash: 'e'.repeat(64),
  }
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(legacy), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const api = new ApiClient('/api')

  await expect(api.shiftSettlement('shift-legacy', undefined, {
    cashReceivableDeferred: '0',
    walletReceivableDeferred: '0',
    cashShortageReceivable: '0',
  })).resolves.toMatchObject({
    maximumCashShortageReceivable: '0.00',
    cashShortageReceivable: '0.00',
    settlementHash: legacy.settlementHash,
  })
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/shifts/shift-legacy/settlement?cashReceivableDeferred=0&walletReceivableDeferred=0&cashShortageReceivable=0',
    expect.objectContaining({ method: 'GET', credentials: 'include' }),
  )
})
