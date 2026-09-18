import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

let h: Harness
let gm: string

const post = async (url: string, payload: Record<string, unknown>, token = gm) => h.app.inject({
  method: 'POST',
  url,
  headers: { cookie: h.cookie(token) },
  payload,
})

beforeEach(async () => {
  h = await makeHarness()
  gm = await h.loginAs('gm')
})

afterEach(async () => h.app.close())

describe('company ledger commands', () => {
  it('is company-manager only, dual-currency, idempotent, and exposes its movement receipt', async () => {
    const manager = await h.loginAs('manager')
    const denied = await post('/company/deposits', {
      idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: sypStr(10), reason: 'seed',
    }, manager)
    expect(denied.statusCode).toBe(403)

    const key = crypto.randomUUID()
    const body = { idempotencyKey: key, currency: 'USD', amount: '50.00', reason: 'USD opening' }
    const first = await post('/company/deposits', body)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ replayed: false, balance: '50.00' })
    expect(first.json().command.sypMinorPerUsd).toBe('13000')

    const replay = await post('/company/deposits', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, balance: '50.00' })
    const conflict = await post('/company/deposits', { ...body, amount: '51.00' })
    expect(conflict.statusCode).toBe(409)

    const overview = await h.app.inject({ method: 'GET', url: '/company/overview', headers: { cookie: h.cookie(gm) } })
    expect(overview.statusCode, overview.body).toBe(200)
    expect(overview.json().pockets).toMatchObject({ USD: '50.00', SYP_NEW: '0.00' })
    const movements = await h.app.inject({ method: 'GET', url: '/company/movements', headers: { cookie: h.cookie(gm) } })
    expect(movements.statusCode, movements.body).toBe(200)
    expect(movements.json().movements).toHaveLength(1)
    expect(movements.json().movements[0].command).toMatchObject({ id: key, kind: 'deposit', amount: '50.00' })
  })

  it('records both actual exchange amounts and reverses the exact command once', async () => {
    await post('/company/deposits', {
      idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '100.00', reason: 'seed',
    })
    const exchangeId = crypto.randomUUID()
    const exchange = await post('/company/exchanges', {
      idempotencyKey: exchangeId,
      fromCurrency: 'USD',
      fromAmount: '25.00',
      toCurrency: 'SYP_NEW',
      toAmount: sypStr(3_250),
      reason: 'cash exchange',
    })
    expect(exchange.statusCode, exchange.body).toBe(201)
    expect(exchange.json().command).toMatchObject({ sypMinorPerUsd: '13000', fromAmount: '25.00', toAmount: '3250.00' })

    const reverse = await post('/company/reversals', {
      idempotencyKey: crypto.randomUUID(), targetId: exchangeId, reason: 'exchange entered twice',
    })
    expect(reverse.statusCode, reverse.body).toBe(201)
    expect(reverse.json().command).toMatchObject({ kind: 'reversal', targetId: exchangeId })
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(10_000n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
  })
})

describe('company debts, assets, and depreciation', () => {
  it('opens a payable and records payments without allowing overpayment', async () => {
    await post('/company/deposits', {
      idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: sypStr(5_000), reason: 'seed',
    })
    const debtId = crypto.randomUUID()
    const opened = await post('/company/debts', {
      idempotencyKey: debtId,
      direction: 'payable',
      partyName: 'Supplier One',
      currency: 'SYP_NEW',
      principal: sypStr(1_000),
      openedOn: '2026-07-01',
      origin: 'opening',
    })
    expect(opened.statusCode, opened.body).toBe(201)
    expect(opened.json().debt).toMatchObject({ outstanding: sypStr(1_000), partyKey: 'supplier one' })

    const paid = await post(`/company/debts/${debtId}/payments`, {
      idempotencyKey: crypto.randomUUID(), amount: sypStr(400), source: 'pocket', reason: 'instalment',
    })
    expect(paid.statusCode, paid.body).toBe(201)
    expect(paid.json().outstanding).toBe(sypStr(600))
    const tooMuch = await post(`/company/debts/${debtId}/payments`, {
      idempotencyKey: crypto.randomUUID(), amount: sypStr(601), source: 'pocket', reason: 'too much',
    })
    expect(tooMuch.statusCode).toBe(422)
  })

  it('creates a 36-period asset schedule and funds only due depreciation', async () => {
    await post('/company/deposits', {
      idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: sypStr(10_000), reason: 'seed',
    })
    const assetId = crypto.randomUUID()
    const asset = await post('/company/assets', {
      idempotencyKey: assetId,
      kind: 'equipment',
      name: 'Workshop charger',
      currency: 'SYP_NEW',
      price: sypStr(3_600),
      purchasedOn: '2026-06-15',
      paidNow: sypStr(3_600),
      paidFrom: 'pocket',
      description: 'Workshop charger purchase',
    })
    expect(asset.statusCode, asset.body).toBe(201)
    expect(asset.json().asset.schedule).toHaveLength(36)
    expect(asset.json().asset).toMatchObject({ bookValue: sypStr(3_400), depreciationDue: sypStr(200) })

    const preview = await h.app.inject({
      method: 'GET', url: '/company/depreciation?asOfMonth=2026-07-01', headers: { cookie: h.cookie(gm) },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().currencies.SYP_NEW).toMatchObject({ totalDue: sypStr(200), transferAmount: sypStr(200) })

    const transfer = await post('/company/depreciation/transfers', {
      idempotencyKey: crypto.randomUUID(),
      currency: 'SYP_NEW',
      asOfMonth: '2026-07-01',
      expectedAmount: sypStr(200),
      reason: 'June and July depreciation',
    })
    expect(transfer.statusCode, transfer.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'depreciation_reserve:SYP_NEW')).toBe(20_000n)
    const after = await h.app.inject({
      method: 'GET', url: `/company/assets/${assetId}`, headers: { cookie: h.cookie(gm) },
    })
    expect(after.json().depreciationDue).toBe(sypStr(0))
    expect(after.json().bookValue).toBe(sypStr(3_400))
  })

  it('creates one linked payable for a financed asset', async () => {
    const asset = await post('/company/assets', {
      idempotencyKey: crypto.randomUUID(),
      kind: 'property',
      name: 'Storage unit',
      currency: 'USD',
      price: '3600.00',
      purchasedOn: '2026-07-01',
      paidNow: '600.00',
      paidFrom: 'owner_outside',
      description: 'Financed storage unit',
      financedPartyName: 'Property Vendor',
    })
    expect(asset.statusCode, asset.body).toBe(201)
    expect(asset.json().asset.outstanding).toBe('3000.00')
    const debts = await h.app.inject({ method: 'GET', url: '/company/debts', headers: { cookie: h.cookie(gm) } })
    expect(debts.json().debts).toHaveLength(1)
    expect(debts.json().debts[0]).toMatchObject({ origin: 'asset_purchase', outstanding: '3000.00' })
  })
})

describe('company cutover', () => {
  it('moves the branch company-box opening under branch then company locks', async () => {
    const admin = await h.loginAs('sysadmin')
    const legacy = await post('/company-fund/legacy-deposit', {
      idempotencyKey: crypto.randomUUID(), branchId: BRANCH, amount: sypStr(790), reason: 'legacy opening',
    }, admin)
    expect(legacy.statusCode, legacy.body).toBe(201)
    const cutover = await post('/company/cutover', {
      branchId: BRANCH, expectedOpening: sypStr(790), reason: 'approved migration',
    }, admin)
    expect(cutover.statusCode, cutover.body).toBe(201)
    expect(cutover.json()).toMatchObject({ openingAmount: sypStr(790), replayed: false })
    expect(h.deps.financialUnitOfWork.locks.taken).toEqual([
      `receivables:${BRANCH}`,
      `receivables:${COMPANY_BRANCH}`,
    ])
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(79_000n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(-79_000n)

    const funded = await post('/treasury/deposit', {
      idempotencyKey: crypto.randomUUID(), branchId: BRANCH, target: 'cash', amount: sypStr(100),
    })
    expect(funded.statusCode, funded.body).toBe(201)
    const swept = await post('/treasury/withdraw', {
      idempotencyKey: crypto.randomUUID(),
      branchId: BRANCH,
      target: 'cash',
      to: 'company_box',
      amount: sypStr(40),
      reason: 'post-cutover sweep',
    })
    expect(swept.statusCode, swept.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'company_box')).toBe(83_000n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(83_000n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(-83_000n)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(1)
  })
})
