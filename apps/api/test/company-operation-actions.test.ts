import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, VEHICLE_ID, makeHarness, type Harness } from './harness.ts'

let h: Harness, gm: string, categoryId: string
const id = () => crypto.randomUUID()
const post = (url: string, payload: Record<string, unknown>, token = gm) => h.app.inject({ method: 'POST', url, payload, headers: { cookie: h.cookie(token) } })
const get = async (url: string) => {
  const res = await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(gm) } })
  expect(res.statusCode, res.body).toBe(200); return res.json()
}
const create = async (kind: string, values: Record<string, unknown>) => {
  const res = await post(`/company/${kind}`, { idempotencyKey: id(), ...values })
  expect(res.statusCode, res.body).toBe(201); return res.json().command
}
const change = (command: { id: string; journalEntryId: number }, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: id(), expectedEntryId: command.journalEntryId, action: 'delete', reason: 'Confirmed isolated test change', ...extra,
})
beforeEach(async () => {
  h = await makeHarness(); gm = await h.loginAs('gm'); categoryId = id()
  await h.deps.expenses.createCategory({ id: categoryId, code: categoryId, nameAr: 'Test expense', active: true })
  for (const currency of ['SYP_NEW', 'USD']) await create('deposits', { currency, amount: '10000.00', reason: 'Test seed' })
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('atomic company operation edits and deletions', () => {
  for (const kind of ['deposits', 'withdrawals', 'incomes', 'exchanges']) {
    it(`edits ${kind} once, removes old current rows and retains both journals`, async () => {
      const exchange = kind === 'exchanges', income = kind === 'incomes'
      if (income) await h.deps.incomes.createCategory({ id: categoryId, code: categoryId, nameAr: 'Income', active: true })
      const command = await create(kind, exchange ? { fromCurrency: 'USD', fromAmount: '2.00', toCurrency: 'SYP_NEW', toAmount: '260.00', reason: 'Before exchange' }
        : { currency: 'SYP_NEW', amount: '10.00', ...(income ? { categoryId, description: 'Before income' } : { reason: 'Before move' }) })
      const payload = change(command, { action: 'edit', values: { ...(exchange ? { fromAmount: '3.00', toAmount: '420.00' } : { amount: '20.00' }), description: 'Changed operation' } })
      const before = structuredClone(h.deps.ledger.entries), url = `/company/operations/${command.id}/actions`
      const result = await post(url, payload); expect(result.statusCode, result.body).toBe(201)
      expect((await post(url, payload)).statusCode).toBe(200)
      expect((await post(url, { ...payload, reason: 'Different retry' })).statusCode).toBe(409)
      const after = h.deps.ledger.entries
      expect(after).toHaveLength(before.length + 2); expect(after.slice(0, before.length)).toEqual(before)
      const current = await get('/company/reports?all=true&view=current_corrected')
      expect(current.rows.some((row: { activeCommandId: string }) => row.activeCommandId === command.id)).toBe(false)
      const replacement = result.json().change.replacementId
      expect(current.rows.find((row: { activeCommandId: string }) => row.activeCommandId === replacement)).toMatchObject({ description: 'Changed operation', ...(exchange ? { fromAmount: '3.00', toAmount: '420.00', sypMinorPerUsd: '14000' } : { netAmount: '20.00' }) })
      const movements = await get('/company/movements?from=2000-01-01&to=2026-07-21')
      expect(movements.effectiveMovements.some((row: { command: { id: string } | null }) => row.command?.id === command.id)).toBe(false)
      const audit = await get('/company/reports?all=true&view=as_booked&dateBasis=posting')
      expect(audit.rows.some((row: { activeCommandId: string }) => row.activeCommandId === command.id)).toBe(true)
      expect(after.filter(row => row.branchId === BRANCH)).toHaveLength(0)
    })
  }
  it('deletes a personal withdrawal from owner totals, ledger, overview and current report across day boundaries', async () => {
    const command = await create('withdrawals', { currency: 'USD', amount: '960.00', reason: 'Owner personal drawing' })
    h.deps.clock.advance(86400000); gm = await h.loginAs('gm')
    const payload = change(command), url = `/company/operations/${command.id}/actions`
    expect((await post(url, payload)).statusCode).toBe(201)
    expect((await get('/company/owner-withdrawals')).totals.USD).toBe('0.00')
    const overview = await get('/company/overview?from=2026-07-21&to=2026-07-21')
    expect(overview.period.USD.withdrawals).toBe('0.00')
    expect((await get('/company/reports?all=true&view=current_corrected')).rows.some((row: { canonicalCommandId: string }) => row.canonicalCommandId === command.id)).toBe(false)
    expect((await post(url, payload)).statusCode).toBe(200)
    expect((await post(url, change(command))).statusCode).toBe(409)
  })
  it('rechecks stale targets, RBAC, future dates, unsupported fields and insufficient funds without writes', async () => {
    const command = await create('deposits', { currency: 'SYP_NEW', amount: '10.00', reason: 'Original' })
    const url = `/company/operations/${command.id}/actions`, before = structuredClone(h.deps.ledger.entries)
    expect((await post(url, change(command, { expectedEntryId: 99999 }))).statusCode).toBe(409)
    const manager = await h.loginAs('manager')
    expect((await post(url, change(command), manager)).statusCode).toBe(403)
    expect((await post(url, change(command, { action: 'edit', values: { occurredOn: '2026-07-22' } }))).statusCode).toBe(422)
    expect((await post(url, change(command, { action: 'edit', values: { fromAmount: '2.00' } }))).statusCode).toBe(422)
    expect((await post(url, change(command, { action: 'edit', values: { currency: 'USD' } }))).statusCode).toBe(422)
    expect(h.deps.ledger.entries).toEqual(before)
    const seed = (await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).find(row => row.kind === 'deposit' && row.currency === 'SYP_NEW')!
    await create('withdrawals', { currency: 'SYP_NEW', amount: '10000.00', reason: 'Spent seed' })
    const guarded = structuredClone(h.deps.ledger.entries)
    expect((await post(`/company/operations/${seed.id}/actions`, change(seed))).statusCode).toBe(422)
    expect(h.deps.ledger.entries).toEqual(guarded)
  })
  it('rolls back the reversal when replacement or receipt persistence fails', async () => {
    const command = await create('withdrawals', { currency: 'SYP_NEW', amount: '10.00', reason: 'Before' })
    const before = structuredClone(h.deps.ledger.entries), metadata = structuredClone(h.deps.companyMovementReview.metadata)
    vi.spyOn(h.deps.companyMovementReview, 'createMetadata').mockRejectedValueOnce(new Error('Test failure'))
    expect((await post(`/company/operations/${command.id}/actions`, change(command, { action: 'edit', values: { amount: '12.00' } }))).statusCode).toBe(500)
    expect(h.deps.ledger.entries).toEqual(before); expect(h.deps.companyMovementReview.metadata).toEqual(metadata)
  })
  it('serializes conflicting actions: exactly one can cancel an active target', async () => {
    const command = await create('withdrawals', { currency: 'SYP_NEW', amount: '10.00', reason: 'Before' })
    const result = await Promise.all([post(`/company/operations/${command.id}/actions`, change(command)), post(`/company/operations/${command.id}/actions`, change(command))])
    expect(result.map(row => row.statusCode).sort()).toEqual([201, 409])
  })
  it('deletes linked expense allocations and cancels stale schedules in the same transaction', async () => {
    const vehicleId = id(), assetId = id()
    h.deps.directory.vehicles.set(vehicleId, { ...(await h.deps.directory.vehicle(VEHICLE_ID))!, id: vehicleId, code: 'Disposable' })
    expect((await post('/company/existing-assets', { idempotencyKey: assetId, vehicleId, name: 'Motor', price: '1000.00', currency: 'SYP_NEW', useStartedOn: '2026-07-01' })).statusCode).toBe(201)
    const payment = await create('expenses', { currency: 'SYP_NEW', amount: '100.00', paidFrom: 'owner_outside', categoryId, description: 'Motor payment',
      existingAssetPayment: { assetId, expectedVersion: 1, expectedPaymentVersion: 0, acknowledgedNewExpense: true } })
    const root = `/company/existing-assets/${assetId}/payments`
    expect((await post(`${root}/schedule`, { idempotencyKey: id(), expectedVersion: 1, expectedPaymentVersion: 1,
      reason: 'Supplier schedule', supplier: 'Test supplier', installmentAmount: '100.00', firstDueOn: '2026-07-21', recurrence: 'monthly', reminderDays: 3 })).statusCode).toBe(201)
    const remove = { idempotencyKey: id(), targetId: payment.id, reason: 'Payment canceled' }
    expect((await post('/company/reversals', remove)).statusCode).toBe(201)
    expect((await post('/company/reversals', remove)).statusCode).toBe(200)
    const view = await get(root)
    expect(view).toMatchObject({ totalPaid: '0.00', remaining: '1000.00', payments: [], installments: [], reminderCount: 0 })
    expect(view.history.map((row: { kind: string }) => row.kind)).toEqual(['link', 'schedule', 'unlink', 'cancel_schedule'])
    expect((await get('/company/owner-payments')).totals.SYP_NEW).toBe('0.00')
  })
  it('refreshes linked expense source evidence after correction and rejects reductions below explicit allocations atomically', async () => {
    const vehicleId = id(), assetId = id()
    h.deps.directory.vehicles.set(vehicleId, { ...(await h.deps.directory.vehicle(VEHICLE_ID))!, id: vehicleId, code: 'Linked' })
    expect((await post('/company/existing-assets', { idempotencyKey: assetId, vehicleId, name: 'Motor', price: '1000.00', currency: 'SYP_NEW', useStartedOn: '2026-07-01' })).statusCode).toBe(201)
    const payment = await create('expenses', { currency: 'SYP_NEW', amount: '100.00', paidFrom: 'owner_outside', categoryId, description: 'Motor payment',
      existingAssetPayment: { assetId, expectedVersion: 1, expectedPaymentVersion: 0, acknowledgedNewExpense: true } })
    const correct = async (amount: string, expectedVersion: number) => {
      const draft = await post('/company/movement-corrections', { idempotencyKey: id(), targetId: payment.id, expectedVersion,
        reason: 'Source correction', values: { amount, description: 'Updated payment description' } })
      expect(draft.statusCode, draft.body).toBe(201)
      return post(`/company/movement-corrections/${draft.json().correction.id}/confirm`, { idempotencyKey: id(), expectedVersion: 1, acknowledgeCashEffect: true })
    }
    expect((await correct('120.00', 1)).statusCode).toBe(200)
    const root = `/company/existing-assets/${assetId}/payments`, feed = await get(root)
    expect(feed).toMatchObject({ totalPaid: '100.00', remaining: '900.00', status: 'documented' })
    expect(feed.payments[0]).toMatchObject({ needsReview: false, data: { description: 'Updated payment description', amount: '100.00' } })
    expect(feed.sources[0].available).toBe('20.00')
    const before = structuredClone(h.deps.ledger.entries), links = structuredClone(await h.deps.existingAssets.paymentEvents(COMPANY_BRANCH))
    const refused = await correct('80.00', 2)
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error).toBe('company_operation_payment_reallocation_required')
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.existingAssets.paymentEvents(COMPANY_BRANCH)).toEqual(links)
    expect((await get('/company/owner-payments')).totals.SYP_NEW).toBe('120.00')
  })
  it('uses one canonical report identity across repeated edits and keeps the original posting day', async () => {
    const command = await create('withdrawals', { currency: 'SYP_NEW', amount: '10.00', reason: 'Original' })
    h.deps.clock.advance(86400000); gm = await h.loginAs('gm')
    const first = await post(`/company/operations/${command.id}/actions`, change(command, { action: 'edit', values: { amount: '20.00' } }))
    expect(first.statusCode).toBe(201)
    const active = (await h.deps.companyLedger.findCommand(first.json().change.replacementId))!
    const second = await post(`/company/operations/${active.id}/actions`, change(active, { action: 'edit', values: { amount: '30.00' } }))
    expect(second.statusCode).toBe(201)
    const report = await get('/company/reports?from=2026-07-21&to=2026-07-21&view=current_corrected&dateBasis=posting')
    const row = report.rows.find((item: { canonicalCommandId: string }) => item.canonicalCommandId === command.id)
    expect(row).toMatchObject({ grossAmount: '30.00', version: 3, postingDate: '2026-07-21', latestPostingDate: '2026-07-22' })
    expect(row.relatedEntryIds).toHaveLength(5)
    expect(report.rows.filter((item: { kind: string }) => item.kind === 'withdrawal')).toHaveLength(1)
  })
  it('resolves calendar repositories before holding a financial connection', async () => {
    const command = await create('withdrawals', { currency: 'SYP_NEW', amount: '10.00', reason: 'Original' })
    let inside = false
    const run = h.deps.financialUnitOfWork.run.bind(h.deps.financialUnitOfWork)
    vi.spyOn(h.deps.financialUnitOfWork, 'run').mockImplementation((input, work) => run(input, async tx => {
      inside = true; try { return await work(tx) } finally { inside = false }
    }))
    for (const [repo, method] of [[h.deps.fx, 'idFor'], [h.deps.weekLocks, 'listClosedStarts']] as const) {
      const original = repo[method as keyof typeof repo] as (...args: never[]) => Promise<unknown>
      vi.spyOn(repo as object, method as never).mockImplementation(((...args: never[]) => {
        expect(inside, 'calendar read borrowed an extra connection inside the financial lock').toBe(false)
        return original.apply(repo, args)
      }) as never)
    }
    expect((await post(`/company/operations/${command.id}/actions`, change(command))).statusCode).toBe(201)
  })
})
