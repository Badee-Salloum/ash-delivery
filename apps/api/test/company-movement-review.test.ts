import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, VEHICLE_TYPE, type Harness, makeHarness, sypStr } from './harness.ts'

let h: Harness
let gm: string
let categoryId: string
const request = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>, token = gm) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, ...(payload === undefined ? {} : { payload }) })
const historical = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(), type: 'expense', occurredOn: '2025-02-10', currency: 'SYP_NEW',
  amount: '20.00', categoryId, description: 'recorded historical payment', ...overrides,
})
const createCorrection = (targetId: string, values: Record<string, unknown>, expectedVersion = 1) =>
  request('POST', '/company/movement-corrections', { idempotencyKey: crypto.randomUUID(), targetId,
    expectedVersion, reason: 'corrected after checking source receipt', values })
const confirm = (id: string, expectedVersion = 1, key = crypto.randomUUID()) =>
  request('POST', `/company/movement-corrections/${id}/confirm`, { idempotencyKey: key, expectedVersion, acknowledgeCashEffect: true })

beforeEach(async () => {
  h = await makeHarness()
  gm = await h.loginAs('gm')
  categoryId = crypto.randomUUID()
  await h.deps.expenses.createCategory({ id: categoryId, code: `REVIEW-${categoryId}`, nameAr: 'مصروف موثق', active: true })
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('historical evidence and explicitly reviewed intake', () => {
  it('generates the audit identity while retaining a separate safe UUID retry', async () => {
    const body = historical()
    const first = await request('POST', '/company/historical-movements', body)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ externalReference: `HQ-HIST-${body.idempotencyKey}`,
      pockets: { SYP_NEW: '-20.00', USD: '0.00' }, metadata: { occurredPrecision: 'day', receiptReference: null } })
    expect((await request('POST', '/company/historical-movements', body)).json().replayed).toBe(true)
    expect((await request('POST', '/company/historical-movements', { ...body, amount: '21.00' })).statusCode).toBe(409)
    expect(await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).toHaveLength(1)
  })

  it('replays the same UUID on the next business day without reconstructing the original posting day or FX receipt', async () => {
    const body = historical({ currency: 'USD', amount: '10.00', historicalRate: '165.25', rateBasis: 'estimated' })
    const first = await request('POST', '/company/historical-movements', body)
    expect(first.statusCode, first.body).toBe(201)
    const originalEntry = structuredClone(h.deps.ledger.entries[0])
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const missingTodayFx = vi.spyOn(h.deps.fx, 'idFor').mockRejectedValue(new Error('today FX must not be needed to replay'))
    const replay = await request('POST', '/company/historical-movements', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, externalReference: first.json().externalReference,
      command: { id: body.idempotencyKey, businessDate: '2026-07-21', sypMinorPerUsd: '16525' } })
    expect(missingTodayFx).not.toHaveBeenCalled()
    expect(h.deps.ledger.entries).toEqual([originalEntry])
    expect((await request('POST', '/company/historical-movements', { ...body, amount: '11.00' })).json().error)
      .toBe('idempotency_key_conflict')
    const admin = await h.loginAs('sysadmin')
    expect((await request('POST', '/company/historical-movements', body, admin)).json().error).toBe('idempotency_key_conflict')
  })

  it('returns the original historical receipt after its period and the retry period are sealed, but still blocks a new posting', async () => {
    const body = historical({ externalReference: 'CLOSED-SOURCE-RECEIPT' })
    const first = await request('POST', '/company/historical-movements', body)
    expect(first.statusCode, first.body).toBe(201)
    for (const weekStartDate of ['2026-07-19', '2026-07-26']) {
      const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate,
        weekEndDate: weekStartDate === '2026-07-19' ? '2026-07-25' : '2026-08-01', closedAtMs: null, closedBy: null })
      await h.deps.weekLocks.seal(week.id, first.json().command.createdBy, h.deps.clock.nowMs())
    }
    h.deps.clock.advance(7 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const replay = await request('POST', '/company/historical-movements', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, command: { businessDate: '2026-07-21' } })
    const byReceipt = await request('POST', '/company/historical-movements', { ...body,
      idempotencyKey: crypto.randomUUID(), externalReference: first.json().externalReference })
    expect(byReceipt.statusCode, byReceipt.body).toBe(200)
    expect(byReceipt.json()).toMatchObject({ replayed: true, command: { id: body.idempotencyKey, businessDate: '2026-07-21' } })
    const newMovement = await request('POST', '/company/historical-movements', { ...body,
      idempotencyKey: crypto.randomUUID(), externalReference: 'NEW-CLOSED-SOURCE' })
    expect(newMovement.statusCode, newMovement.body).toBe(409)
    expect(newMovement.json().error).toBe('week_locked')
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('keeps owner funding outside both cash boxes, retains month precision and estimated frozen FX', async () => {
    const first = await request('POST', '/company/historical-movements', historical({ currency: 'USD', amount: '10.00',
      historicalRate: '165.25', rateBasis: 'estimated', paidFrom: 'owner_outside', occurredOn: '2025-06-01',
      occurredPrecision: 'month', occurredMonth: '2025-06', sourceUnit: 'USD', receiptReference: 'OWNER-INV-9' }))
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ pockets: { SYP_NEW: '0.00', USD: '0.00' },
      command: { paidFrom: 'owner_outside', sypMinorPerUsd: '16525', businessDate: '2026-07-21' },
      metadata: { occurredPrecision: 'month', occurredMonth: '2025-06', rateBasis: 'estimated' } })
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cash')).toBe(0n)
    const list = await request('GET', '/company/historical-movements?from=2025-06-15&to=2025-06-30&externalReference=OWNER-INV')
    expect(list.json().movements).toHaveLength(1)
    expect(list.json().movements[0].metadata.occurredPrecision).toBe('month')
    const owners = await request('GET', '/company/owner-payments?from=2025-06-15&to=2025-06-30')
    expect(owners.json()).toMatchObject({ totals: { SYP_NEW: '0.00', USD: '10.00' } })
  })

  it('requires a canonical month anchor and does not turn an estimated rate into a documented one on replay', async () => {
    const invalid = await request('POST', '/company/historical-movements', historical({ occurredPrecision: 'month',
      occurredMonth: '2025-06', occurredOn: '2025-06-12' }))
    expect(invalid.statusCode).toBe(400)
    const body = historical({ currency: 'USD', historicalRate: '100.00', rateBasis: 'estimated' })
    expect((await request('POST', '/company/historical-movements', body)).statusCode).toBe(201)
    expect((await request('POST', '/company/historical-movements', { ...body, rateBasis: 'documented' })).statusCode).toBe(409)
  })

  it('backfills a nonempty live book only under a reviewed range, without zeroing or reopening the past', async () => {
    const deposit = await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(),
      currency: 'SYP_NEW', amount: '100.00', reason: 'normal live book opening' })
    expect(deposit.statusCode).toBe(201)
    expect((await request('POST', '/company/historical-movements', historical())).json().error).toBe('historical_opening_balance_nonzero')
    const sessionBody = { idempotencyKey: crypto.randomUUID(), from: '2025-01-01', to: '2025-12-31',
      reason: 'missing paper rows only', reconciliationNote: 'checked row identities, overlap and recorded source currency units',
      reviewedSourceUnits: true, reviewedExistingEntries: true }
    const manager = await h.loginAs('manager')
    expect((await request('POST', '/company/historical-intake-sessions', sessionBody, manager)).statusCode).toBe(403)
    const created = await request('POST', '/company/historical-intake-sessions', sessionBody)
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().session.baselinePockets).toEqual({ SYP_NEW: '100.00', USD: '0.00' })
    expect((await request('POST', '/company/historical-intake-sessions', sessionBody)).json().replayed).toBe(true)
    const firstBody = historical({ intakeSessionId: sessionBody.idempotencyKey, occurredOn: '2025-02-15' })
    const first = await request('POST', '/company/historical-movements', firstBody)
    expect(first.statusCode, first.body).toBe(201)
    expect((await request('POST', '/company/historical-movements', historical({ intakeSessionId: sessionBody.idempotencyKey,
      occurredOn: '2025-01-02' }))).statusCode).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(6000n)
    expect(first.json().command.businessDate).toBe('2026-07-21')
    expect((await request('POST', '/company/historical-movements', historical({ intakeSessionId: sessionBody.idempotencyKey,
      occurredOn: '2024-12-31' }))).json().error).toBe('historical_intake_outside_range')
    expect((await request('PUT', `/company/historical-intake-sessions/${sessionBody.idempotencyKey}/close`,
      { reason: 'all missing rows reviewed' })).statusCode).toBe(200)
    expect((await request('POST', '/company/historical-movements', historical({ intakeSessionId: sessionBody.idempotencyKey }))).json().error)
      .toBe('historical_intake_session_invalid')
    // Losing the original receipt is still a replay after closure, not a second import.
    expect((await request('POST', '/company/historical-movements', firstBody)).json().replayed).toBe(true)
  })

  it('restates the financial day only inside a reviewed intake, keeping the supplied USD rate', async () => {
    const body = historical({ type: 'deposit', categoryId: undefined, amount: '5.00',
      occurredOn: '2026-07-20', currency: 'USD', historicalRate: '133.00',
      description: 'historical cash on its actual financial day', postingMode: 'financial_day' })
    const refused = await request('POST', '/company/historical-movements', body)
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toBe('historical_financial_day_requires_reconciliation')
    const sessionId = crypto.randomUUID()
    const session = await request('POST', '/company/historical-intake-sessions', {
      idempotencyKey: sessionId, from: '2026-07-20', to: '2026-07-20',
      reason: 'source book reconciled to existing entries',
      reconciliationNote: 'verified exact source identity, old-lira conversion and branch overlaps',
      reviewedSourceUnits: true, reviewedExistingEntries: true,
    })
    expect(session.statusCode, session.body).toBe(201)
    const posted = await request('POST', '/company/historical-movements', { ...body, intakeSessionId: sessionId })
    expect(posted.statusCode, posted.body).toBe(201)
    expect(posted.json().command).toMatchObject({
      occurredOn: '2026-07-20', businessDate: '2026-07-20', sypMinorPerUsd: '13300',
    })
    const entry = await h.deps.ledger.findEntryById(posted.json().command.journalEntryId)
    expect(entry).toMatchObject({ businessDate: '2026-07-20', postingDate: '2026-07-20', sypMinorPerUsd: 13300n })
    const priorDay = await request('GET', '/company/reports?from=2026-07-20&to=2026-07-20&view=as_booked&dateBasis=posting')
    expect(priorDay.statusCode, priorDay.body).toBe(200)
    expect(priorDay.json().rows.some((row: { originalEntryId: number }) => row.originalEntryId === entry!.id)).toBe(true)
    const replay = await request('POST', '/company/historical-movements', { ...body, intakeSessionId: sessionId })
    expect(replay.statusCode).toBe(200)
    expect(replay.json().replayed).toBe(true)
  })
})

describe('ordinary company command retry receipts', () => {
  it('replays an explicit-date USD expense after day FX changes and period closure without rewriting its frozen receipt', async () => {
    expect((await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '100.00', reason: 'live funds' })).statusCode).toBe(201)
    const body = { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '20.00', categoryId,
      occurredOn: '2026-07-20', historicalRate: '130.00', description: 'ordinary cash payment' }
    const first = await request('POST', '/company/expenses', body)
    expect(first.statusCode, first.body).toBe(201)
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25', closedAtMs: null, closedBy: null })
    await h.deps.weekLocks.seal(week.id, first.json().command.createdBy, h.deps.clock.nowMs())
    const sealedEntries = structuredClone(h.deps.ledger.entries)
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    await h.deps.fx.upsert({ businessDate: '2026-07-22', sypMinorPerUsd: 19500n, provisional: false })
    gm = await h.loginAs('gm')
    const todayFx = vi.spyOn(h.deps.fx, 'idFor').mockRejectedValue(new Error('new day FX must not block an immutable receipt'))
    vi.spyOn(h.deps.expenses, 'listCategories').mockResolvedValue([])
    const replay = await request('POST', '/company/expenses', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true,
      command: { businessDate: '2026-07-20', occurredOn: '2026-07-20', sypMinorPerUsd: '13000', amount: '20.00' } })
    expect(todayFx).not.toHaveBeenCalled()
    expect((await request('POST', '/company/expenses', { ...body, amount: '21.00' })).json().error).toBe('idempotency_key_conflict')
    expect((await request('POST', '/company/expenses', { ...body, occurredOn: '2026-07-21' })).json().error).toBe('idempotency_key_conflict')
    expect((await request('POST', '/company/expenses', { ...body, categoryId: crypto.randomUUID() })).json().error).toBe('idempotency_key_conflict')
    expect(h.deps.ledger.entries).toEqual(sealedEntries)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(8000n)
  })

  it('retains the first server-default occurrence date for a deposit whose request omitted its date', async () => {
    const body = { idempotencyKey: crypto.randomUUID(), amount: '100.00', reason: 'date defaults on first submission only' }
    const first = await request('POST', '/company/deposits', body)
    expect(first.statusCode, first.body).toBe(201)
    const originalEntries = structuredClone(h.deps.ledger.entries)
    h.deps.clock.advance(7 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const replay = await request('POST', '/company/deposits', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true,
      command: { occurredOn: '2026-07-21', businessDate: '2026-07-21' }, balance: '100.00' })
    expect((await request('POST', '/company/deposits', { ...body, amount: '101.00' })).json().error).toBe('idempotency_key_conflict')
    expect((await request('POST', '/company/deposits', { ...body, occurredOn: '2026-07-28' })).json().error).toBe('idempotency_key_conflict')
    expect((await request('POST', '/company/deposits', body, await h.loginAs('sysadmin'))).json().error).toBe('idempotency_key_conflict')
    expect(h.deps.ledger.entries).toEqual(originalEntries)
    expect(await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).toHaveLength(1)
  })

  it('replays withdrawal, income, actual-amount exchange and exact reversal after later FX without another journal', async () => {
    expect((await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '100.00', reason: 'fund commands' })).statusCode).toBe(201)
    const withdrawal = { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '20.00', reason: 'cash withdrawal' }
    const incomeCategoryId = crypto.randomUUID()
    await h.deps.incomes.createCategory({ id: incomeCategoryId, code: `RETRY-${incomeCategoryId}`, nameAr: 'دخل', active: true })
    const requests = [
      { url: '/company/withdrawals', body: withdrawal },
      { url: '/company/reversals', body: { idempotencyKey: crypto.randomUUID(), targetId: withdrawal.idempotencyKey, reason: 'exact cash return' } },
      { url: '/company/incomes', body: { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '5.00', categoryId: incomeCategoryId, description: 'normal recorded income' } },
      { url: '/company/exchanges', body: { idempotencyKey: crypto.randomUUID(), fromCurrency: 'USD', fromAmount: '10.00', toCurrency: 'SYP_NEW', toAmount: '1300.00', reason: 'actual exchange' } },
    ]
    for (const row of requests) {
      const first = await request('POST', row.url, row.body)
      expect(first.statusCode, first.body).toBe(201)
    }
    const originalEntries = structuredClone(h.deps.ledger.entries)
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    await h.deps.fx.upsert({ businessDate: '2026-07-22', sypMinorPerUsd: 19500n, provisional: false })
    gm = await h.loginAs('gm')
    for (const row of requests) {
      const replay = await request('POST', row.url, row.body)
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json()).toMatchObject({ replayed: true, command: { businessDate: '2026-07-21', occurredOn: '2026-07-21', sypMinorPerUsd: '13000' } })
    }
    expect(h.deps.ledger.entries).toEqual(originalEntries)
  })
})

describe('company branch reconciliation projection', () => {
  async function reviewedRestoration(cashAmount = 60_000, walletAmount = 10_000) {
    await h.app.close()
    h = await makeHarness({ companyRestorationReviewEnabled: true })
    gm = await h.loginAs('gm')
    const manager = await h.loginAs('manager')
    const admin = await h.loginAs('sysadmin')
    const cutover = await request('POST', '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'reviewed cutover' }, admin)
    expect(cutover.statusCode, cutover.body).toBe(201)
    const targets = await request('PUT', '/treasury/capital-targets', { cashTarget: sypStr(10_000),
      walletTarget: sypStr(10_000), reason: 'capital targets' }, manager)
    expect(targets.statusCode, targets.body).toBe(200)
    for (const [fundCode, amount] of [['office_cash', cashAmount], ['office_wallet', walletAmount]] as const) {
      if (amount === 0) continue
      const added = await request('POST', '/journal/manual', { reason: `seed ${fundCode}`, lines: [
        { fundCode, side: 'D', amount: sypStr(amount) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(amount) },
      ] }, manager)
      expect(added.statusCode, added.body).toBe(201)
    }
    const restored = await request('POST', '/treasury/restoration', { idempotencyKey: crypto.randomUUID(), reason: 'actual branch restoration' }, manager)
    expect(restored.statusCode, restored.body).toBe(201)
    return restored.json().proposalId as string
  }
  async function branchProjection() {
    const response = await request('GET', '/company/overview?from=2025-01-01&to=2025-01-02')
    expect(response.statusCode, response.body).toBe(200)
    return response.json().branches.find((row: { branchId: string }) => row.branchId === BRANCH)
  }

  it('explains pending actual branch restoration, distinguishes an overridden confirmation, then marks the corrected matching legs', async () => {
    const proposalId = await reviewedRestoration()
    const source = (await h.deps.companyRestorationReviews.get(proposalId))!.legs[0]!
    expect(await branchProjection()).toMatchObject({ companyBox: '50000.00', clearing: '0.00',
      pendingRestorationDifference: '50000.00', unexplainedDifference: '0.00', balanced: false,
      settlementStatus: 'waiting_review', pendingReviewCount: 1, confirmedVarianceCount: 0 })
    const adjusted = await request('POST', `/company/restoration-reviews/${proposalId}/confirm`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 0, confirmedLegs: [{ sourceEntryId: source.sourceEntryId, amount: '40000.00' }],
      reason: 'confirmed actual smaller cash receipt',
    })
    expect(adjusted.statusCode, adjusted.body).toBe(201)
    expect(await branchProjection()).toMatchObject({ companyBox: '50000.00', clearing: '-40000.00',
      pendingRestorationDifference: '10000.00', unexplainedDifference: '0.00', balanced: false,
      settlementStatus: 'variance', pendingReviewCount: 0, confirmedVarianceCount: 1 })
    const corrected = await request('POST', `/company/restoration-reviews/${proposalId}/correct`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 1, confirmedLegs: [{ sourceEntryId: source.sourceEntryId, amount: '50000.00' }],
      reason: 'later counted matching receipt',
    })
    expect(corrected.statusCode, corrected.body).toBe(201)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', unexplainedDifference: '0.00',
      balanced: true, settlementStatus: 'matched', pendingReviewCount: 0, confirmedVarianceCount: 0 })
  })

  it('keeps offsetting zero-net legs waiting for actual review and does not hide an unrelated unexplained imbalance', async () => {
    const proposalId = await reviewedRestoration(15_000, 5_000)
    expect(await branchProjection()).toMatchObject({ companyBox: '0.00', clearing: '0.00',
      pendingRestorationDifference: '0.00', balanced: false, settlementStatus: 'waiting_review', pendingReviewCount: 1 })
    const confirmed = await request('POST', `/company/restoration-reviews/${proposalId}/confirm`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 0, reason: 'both offsetting source legs checked',
    })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', balanced: true, settlementStatus: 'matched' })
    const realOverview = await h.deps.companyLedgerSource.readOverview(COMPANY_BRANCH, { from: '2025-01-01', to: '2025-01-02' })
    const inconsistent = structuredClone(realOverview)
    const row = inconsistent.branches.find((item) => item.branchId === BRANCH)!
    row.clearing = (row.clearing + 100n) as typeof row.clearing
    vi.spyOn(h.deps.companyLedgerSource, 'readOverview').mockResolvedValue(inconsistent)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', unexplainedDifference: '1.00',
      balanced: false, settlementStatus: 'variance' })
  })

  it('retains the signed from-company difference and per-leg variances even when their net offsets', async () => {
    const outgoingId = await reviewedRestoration(0, 0)
    expect(await branchProjection()).toMatchObject({ companyBox: '-20000.00', clearing: '0.00',
      pendingRestorationDifference: '-20000.00', balanced: false, settlementStatus: 'waiting_review' })
    const outgoingConfirmed = await request('POST', `/company/restoration-reviews/${outgoingId}/confirm`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 0, reason: 'actual HQ capital funding checked',
    })
    expect(outgoingConfirmed.statusCode, outgoingConfirmed.body).toBe(201)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', balanced: true, settlementStatus: 'matched' })
    const offsettingId = await reviewedRestoration(15_000, 5_000)
    const legs = (await h.deps.companyRestorationReviews.get(offsettingId))!.legs
    const offsettingConfirmed = await request('POST', `/company/restoration-reviews/${offsettingId}/confirm`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 0, reason: 'both actual legs are smaller by the same amount',
      confirmedLegs: legs.map((leg) => ({ sourceEntryId: leg.sourceEntryId, amount: '4000.00' })),
    })
    expect(offsettingConfirmed.statusCode, offsettingConfirmed.body).toBe(201)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', unexplainedDifference: '0.00',
      balanced: false, settlementStatus: 'variance', pendingReviewCount: 0, confirmedVarianceCount: 1 })
  })

  it('preserves the zero-clearing invariant for legacy already-posted mirrors', async () => {
    const admin = await h.loginAs('sysadmin')
    const manager = await h.loginAs('manager')
    expect((await request('POST', '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'legacy cutover' }, admin)).statusCode).toBe(201)
    // This compatibility assertion is for an already-persisted old marker, not a new activation.
    const legacy = (await h.deps.companyLedger.cutoverFor(BRANCH))!
    h.deps.companyLedger.cutovers.set(BRANCH,{ ...legacy,mode: 'cash_opening' })
    expect((await request('POST', '/treasury/restoration', { reason: 'legacy existing restoration' }, manager)).statusCode).toBe(201)
    expect(await branchProjection()).toMatchObject({ pendingRestorationDifference: '0.00', unexplainedDifference: '0.00',
      balanced: true, settlementStatus: 'matched', pendingReviewCount: 0, confirmedVarianceCount: 0 })
  })
})

describe('audited HQ expense corrections', () => {
  it('separates owner-funded expense, actual capital payment and debt payment without counting prices or principal', async () => {
    expect((await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))).statusCode).toBe(201)
    const asset = await request('POST', '/company/assets', { idempotencyKey: crypto.randomUUID(), kind: 'equipment',
      name: 'Previously booked financed asset', currency: 'USD', price: '3600.00', paidNow: '600.00',
      purchasedOn: '2026-07-01', paidFrom: 'owner_outside', description: 'paid six hundred, remainder documented payable',
      financedPartyName: 'Actual vendor' })
    expect(asset.statusCode, asset.body).toBe(201)
    const debtId = asset.json().asset.debtId as string
    const payment = await request('POST', `/company/debts/${debtId}/payments`, { idempotencyKey: crypto.randomUUID(),
      amount: '125.00', source: 'owner_outside', occurredOn: '2026-07-20', reason: 'actual owner-paid installment' })
    expect(payment.statusCode, payment.body).toBe(201)
    const unpaid = await request('POST', '/company/assets', { idempotencyKey: crypto.randomUUID(), kind: 'equipment',
      name: 'Not yet paid asset', currency: 'USD', price: '1200.00', paidNow: '0.00',
      purchasedOn: '2026-07-01', paidFrom: 'owner_outside', description: 'no actual owner payment', financedPartyName: 'Other vendor' })
    expect(unpaid.statusCode, unpaid.body).toBe(201)
    const vehicle = await request('POST', '/vehicles', { branchId: BRANCH, vehicleTypeId: VEHICLE_TYPE,
      groundNo: 'NEUTRAL-OWNER', plateNo: 'UNPAID-CARD' })
    expect(vehicle.statusCode, vehicle.body).toBe(201)
    const neutral = await request('POST', '/company/existing-assets', { idempotencyKey: crypto.randomUUID(),
      vehicleId: vehicle.json().id, name: 'Existing motor neutral card', currency: 'USD', price: '500.00',
      purchasedOn: '2026-07-01', useStartedOn: '2026-07-01', fundingSource: 'owner_outside', description: 'registration is not payment' })
    expect(neutral.statusCode, neutral.body).toBe(201)
    const owners = (await request('GET', '/company/owner-payments')).json()
    expect(owners).toMatchObject({ totals: { SYP_NEW: '20.00', USD: '725.00' }, expenseTotals: { SYP_NEW: '20.00', USD: '0.00' },
      capitalAndDebtTotals: { SYP_NEW: '0.00', USD: '725.00' }, totalsByKind: {
        expense: { SYP_NEW: '20.00', USD: '0.00' }, asset_payment: { SYP_NEW: '0.00', USD: '600.00' },
        debt_payment: { SYP_NEW: '0.00', USD: '125.00' } } })
    expect(owners.payments).toHaveLength(3)
    expect(owners.payments.map((row: { kind: string }) => row.kind).sort()).toEqual(['asset_payment', 'debt_payment', 'expense'])
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(0n)
    const oneDay = (await request('GET', '/company/owner-payments?from=2026-07-20&to=2026-07-20')).json()
    expect(oneDay.totals.USD).toBe('125.00')
    expect(oneDay.payments).toHaveLength(1)
  })

  it('saves a draft without cash effect, then lets the same GM explicitly confirm company→owner correction', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    const originalEntry = structuredClone(h.deps.ledger.entries[0])
    const branchBefore = await h.deps.ledger.fundBalance(BRANCH, 'cash')
    const proposal = await createCorrection(targetId, { amount: '35.00', paidFrom: 'owner_outside' })
    expect(proposal.statusCode, proposal.body).toBe(201)
    expect(proposal.json()).toMatchObject({ correction: { status: 'draft', financial: true },
      impact: { pockets: { SYP_NEW: '20.00', USD: '0.00' }, ownerPayments: { SYP_NEW: '35.00', USD: '0.00' }, branchEffect: 'none' } })
    expect(h.deps.ledger.entries).toHaveLength(1)
    expect((await request('GET', '/company/owner-payments')).json().payments).toHaveLength(0)
    const correctionId = proposal.json().correction.id as string
    const key = crypto.randomUUID()
    const confirmed = await confirm(correctionId, 1, key)
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json()).toMatchObject({ correction: { status: 'confirmed', version: 2 }, pockets: { SYP_NEW: '0.00', USD: '0.00' } })
    expect(h.deps.ledger.entries).toHaveLength(3)
    expect(h.deps.ledger.entries[0]).toEqual(originalEntry)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cash')).toBe(branchBefore)
    expect((await request('GET', '/company/owner-payments')).json().totals.SYP_NEW).toBe('35.00')
    expect((await confirm(correctionId, 1, key)).json().replayed).toBe(true)
    expect(h.deps.ledger.entries).toHaveLength(3)
    const history = await request('GET', `/company/movement-corrections/${correctionId}/history`)
    expect(history.json().history).toHaveLength(2)
    expect(history.json().history[0].status).toBe('draft')
    expect(history.json().history[1].confirmedBy).toBe(original.json().command.createdBy)
  })

  it('corrects the effective replacement on the second edit rather than reversing the original twice', async () => {
    const original = await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))
    const targetId = original.json().command.id as string
    const first = await createCorrection(targetId, { amount: '35.00' })
    expect((await confirm(first.json().correction.id)).statusCode).toBe(200)
    const second = await createCorrection(targetId, { amount: '40.00' }, 2)
    expect(second.statusCode, second.body).toBe(201)
    expect((await confirm(second.json().correction.id)).statusCode).toBe(200)
    const state = (await request('GET', `/company/movements/${targetId}/review`)).json()
    expect(state).toMatchObject({ version: 3, original: { amount: '20.00' }, effective: { amount: '40.00' } })
    expect((await request('GET', '/company/owner-payments')).json()).toMatchObject({ totals: { SYP_NEW: '40.00' } })
    expect((await request('GET', '/company/owner-payments')).json().payments).toHaveLength(1)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'company_correction')).toHaveLength(2)
    expect((await createCorrection(targetId, { amount: '50.00' }, 1)).statusCode).toBe(409)
    const movements = (await request('GET', '/company/movements')).json()
    expect(movements.movements).toHaveLength(5)
    expect(movements.effectiveMovements).toHaveLength(1)
    expect(movements.effectiveMovements[0]).toMatchObject({ version: 3, corrected: true,
      command: { amount: '40.00', paidFrom: 'owner_outside' }, originalCommand: { id: targetId, amount: '20.00' },
      postingEntries: { originalEntryId: original.json().command.journalEntryId } })
    expect(movements.effectiveMovements[0].postingEntries.correctionEntryIds).toHaveLength(4)
  })

  it('rejects a replacement as a fresh correction target and retains one canonical event with exact owner totals', async () => {
    const original = await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))
    const targetId = original.json().command.id as string
    const first = await createCorrection(targetId, { amount: '35.00' })
    const approved = await confirm(first.json().correction.id)
    expect(approved.statusCode, approved.body).toBe(200)
    const replacementId = approved.json().correction.replacementId as string
    const journalCount = h.deps.ledger.entries.length
    const reviewReplacement = await request('GET', `/company/movements/${replacementId}/review`)
    expect(reviewReplacement.statusCode).toBe(409)
    expect(reviewReplacement.json()).toMatchObject({ error: 'company_correction_original_target_required', detail: { originalTargetId: targetId } })
    const nested = await createCorrection(replacementId, { amount: '45.00' })
    expect(nested.statusCode).toBe(409)
    expect(nested.json()).toMatchObject({ error: 'company_correction_original_target_required', detail: { originalTargetId: targetId } })
    expect(h.deps.ledger.entries).toHaveLength(journalCount)
    expect(await h.deps.companyMovementReview.listCorrections(COMPANY_BRANCH)).toHaveLength(1)
    const second = await createCorrection(targetId, { amount: '45.00' }, 2)
    expect(second.statusCode, second.body).toBe(201)
    expect((await confirm(second.json().correction.id)).statusCode).toBe(200)
    const owners = (await request('GET', '/company/owner-payments')).json()
    expect(owners).toMatchObject({ expenseTotals: { SYP_NEW: '45.00' }, totals: { SYP_NEW: '45.00' } })
    expect(owners.payments).toHaveLength(1)
    expect(owners.payments[0].originalId).toBe(targetId)
    const movements = (await request('GET', '/company/movements')).json()
    expect(movements.effectiveMovements).toHaveLength(1)
    expect(movements.effectiveMovements[0]).toMatchObject({ originalCommand: { id: targetId }, command: { amount: '45.00' }, version: 3 })
  })

  it('updates descriptions and evidence metadata without manufacturing a cash refund or a new journal', async () => {
    const original = await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))
    const targetId = original.json().command.id as string
    const draft = await createCorrection(targetId, { description: 'supplier and purpose now verified' })
    expect(draft.json().correction.financial).toBe(false)
    expect((await confirm(draft.json().correction.id)).statusCode).toBe(200)
    expect(h.deps.ledger.entries).toHaveLength(1)
    const state = (await request('GET', `/company/movements/${targetId}/review`)).json()
    expect(state.original.description).toBe('recorded historical payment')
    expect(state.effective.description).toBe('supplier and purpose now verified')
    expect((await request('GET', '/company/owner-payments')).json().totals.SYP_NEW).toBe('20.00')
  })

  it('allows a real negative resulting HQ balance but never a negative movement amount', async () => {
    const original = await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))
    const targetId = original.json().command.id as string
    expect((await createCorrection(targetId, { amount: '-1.00' })).statusCode).toBe(400)
    const draft = await createCorrection(targetId, { amount: '50.00', paidFrom: 'pocket' })
    const result = await confirm(draft.json().correction.id)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().pockets.SYP_NEW).toBe('-50.00')
    expect((await request('GET', '/company/owner-payments')).json().totals.SYP_NEW).toBe('0.00')
  })

  it('keeps request revisions, refuses stale versions and changed UUID retries, and requires explicit acknowledgment', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    const body = { idempotencyKey: crypto.randomUUID(), targetId, expectedVersion: 1,
      reason: 'verified amount', values: { amount: '25.00' } }
    const first = await request('POST', '/company/movement-corrections', body)
    const id = first.json().correction.id as string
    expect((await request('POST', '/company/movement-corrections', body)).json().replayed).toBe(true)
    expect((await request('POST', '/company/movement-corrections', { ...body, values: { amount: '26.00' } })).statusCode).toBe(409)
    const edited = await request('PATCH', `/company/movement-corrections/${id}`, { idempotencyKey: crypto.randomUUID(),
      expectedVersion: 1, reason: 'second checked amount', values: { amount: '30.00' } })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().correction.version).toBe(2)
    const originalReceiptReplay = await request('POST', '/company/movement-corrections', body)
    expect(originalReceiptReplay.json().correction).toMatchObject({ version: 1, values: { amount: '25.00' } })
    expect((await confirm(id, 1)).statusCode).toBe(409)
    expect((await request('POST', `/company/movement-corrections/${id}/confirm`, { idempotencyKey: crypto.randomUUID(),
      expectedVersion: 2, acknowledgeCashEffect: false })).statusCode).toBe(400)
    expect((await confirm(id, 2)).statusCode).toBe(200)
    expect((await request('GET', `/company/movement-corrections/${id}/history`)).json().history).toHaveLength(3)
  })

  it('serializes two confirmations of different proposals against the same effective version', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    const a = await createCorrection(targetId, { amount: '25.00' })
    const b = await createCorrection(targetId, { amount: '30.00' })
    const results = await Promise.all([confirm(a.json().correction.id), confirm(b.json().correction.id)])
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(h.deps.ledger.entries).toHaveLength(3)
    expect((await request('GET', `/company/movements/${targetId}/review`)).json().version).toBe(2)
  })

  it('books a later correction today while preserving a sealed original period and occurrence date', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25', closedAtMs: null, closedBy: null })
    await h.deps.weekLocks.seal(week.id, original.json().command.createdBy, h.deps.clock.nowMs())
    const sealedOriginal = structuredClone(h.deps.ledger.entries[0])
    h.deps.clock.advance(7 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const proposal = await createCorrection(targetId, { amount: '25.00' })
    expect(proposal.statusCode, proposal.body).toBe(201)
    const approved = await confirm(proposal.json().correction.id)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(h.deps.ledger.entries[0]).toEqual(sealedOriginal)
    expect(h.deps.ledger.entries.slice(1).map((entry) => entry.businessDate)).toEqual(['2026-07-28', '2026-07-28'])
    const state = (await request('GET', `/company/movements/${targetId}/review`)).json()
    expect(state.original.businessDate).toBe('2026-07-21')
    expect(state.effective.businessDate).toBe('2026-07-28')
    expect(state.effective.occurredOn).toBe('2025-02-10')
  })

  it('uses current occurrence-based source totals without counting drafts or correction journals twice', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    h.deps.clock.advance(7 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const proposal = await createCorrection(targetId, { amount: '35.00', paidFrom: 'owner_outside' })
    const pending = (await request('GET', '/company/overview?from=2025-01-01&to=2026-07-31')).json()
    expect(pending.period.SYP_NEW).toMatchObject({ expense: '20.00', companyFundedExpense: '20.00', ownerOutsideExpense: '0.00' })
    expect((await confirm(proposal.json().correction.id)).statusCode).toBe(200)
    const oldPeriod = (await request('GET', '/company/overview?from=2026-07-21&to=2026-07-21')).json()
    expect(oldPeriod.period.SYP_NEW).toMatchObject({ expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00' })
    const correctionDay = (await request('GET', '/company/overview?from=2026-07-28&to=2026-07-28')).json()
    expect(correctionDay.period.SYP_NEW).toMatchObject({ expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00' })
    const fullPeriod = (await request('GET', '/company/overview?from=2025-01-01&to=2026-07-31')).json()
    expect(fullPeriod).toMatchObject({ expenseSourceBasis: 'current_corrected_occurrence',
      period: { SYP_NEW: { expense: '35.00', companyFundedExpense: '0.00', ownerOutsideExpense: '35.00', otherBookExpense: '0.00' } } })
    const todayEvents = (await request('GET', '/company/movements')).json()
    expect(todayEvents.movements).toHaveLength(2)
    expect(todayEvents.effectiveMovements).toHaveLength(1)
    expect(todayEvents.effectiveMovements[0]).toMatchObject({ command: { paidFrom: 'owner_outside', amount: '35.00' },
      originalCommand: { id: targetId, businessDate: '2026-07-21' } })
  })

  it('allows a linked-asset draft but blocks financial approval until its dependent accounting is reviewed', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    // Represents an already recognized card linked by immutable source evidence.
    const linked = vi.spyOn(h.deps.existingAssets, 'linkedToOperation').mockResolvedValue([{
      id: crypto.randomUUID(), accountingStatus: 'approved', recognition: null, depreciation: null, sale: null,
    } as never])
    const proposal = await createCorrection(targetId, { amount: '25.00' })
    expect(proposal.statusCode).toBe(201)
    expect(proposal.json().correction.blockingReasons).toContain('linked_asset_review_required')
    const approved = await confirm(proposal.json().correction.id)
    expect(approved.statusCode).toBe(422)
    expect(approved.json().error).toBe('company_correction_linked_review_required')
    expect(h.deps.ledger.entries).toHaveLength(1)
    linked.mockRestore()
    // Description-only review does not rewrite the asset's monetary source.
    const description = await createCorrection(targetId, { description: 'supplier note completed' })
    expect((await confirm(description.json().correction.id)).statusCode).toBe(200)
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('does not let a correction overdraw the depreciation reserve', async () => {
    const original = await request('POST', '/company/historical-movements', historical({ paidFrom: 'owner_outside' }))
    const proposal = await createCorrection(original.json().command.id, { paidFrom: 'reserve' })
    expect(proposal.statusCode).toBe(201)
    const approved = await confirm(proposal.json().correction.id)
    expect(approved.statusCode).toBe(422)
    expect(approved.json()).toMatchObject({ error: 'insufficient_funds', detail: { fundCode: 'depreciation_reserve:SYP_NEW' } })
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('rolls back reversal, replacement, metadata and command facts together when saving the approval fails', async () => {
    const original = await request('POST', '/company/historical-movements', historical())
    const targetId = original.json().command.id as string
    const draft = await createCorrection(targetId, { amount: '35.00', paidFrom: 'owner_outside' })
    const originalSave = h.deps.companyMovementReview.saveCorrection.bind(h.deps.companyMovementReview)
    const failure = vi.spyOn(h.deps.companyMovementReview, 'saveCorrection').mockImplementation(async (row, expected) => {
      if (row.status === 'confirmed') throw new Error('simulated failure after both journals')
      return originalSave(row, expected)
    })
    expect((await confirm(draft.json().correction.id)).statusCode).toBe(500)
    failure.mockRestore()
    expect(h.deps.ledger.entries).toHaveLength(1)
    expect(await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).toHaveLength(1)
    expect(await h.deps.companyMovementReview.getCorrection(draft.json().correction.id)).toMatchObject({ status: 'draft', version: 1 })
    expect((await request('GET', '/company/owner-payments')).json().payments).toHaveLength(0)
    expect((await confirm(draft.json().correction.id)).statusCode).toBe(200)
  })
})
