import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, type Harness, makeHarness } from './harness.ts'

let h: Harness
let gm: string
const DRAFT_BRANCH = '30000000-0000-4000-8000-000000000101'
const base = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: crypto.randomUUID(), type: 'expense',
  occurredOn: '2025-08-15', description: 'original paper receipt awaiting accounting review',
  currency: 'SYP_NEW', amount: '5100000.00', ...overrides })
const headers = (token = gm) => ({ cookie: h.cookie(token) })
const post = (payload: Record<string, unknown>, token = gm) => h.app.inject({ method: 'POST',
  url: '/company/historical-drafts', headers: headers(token), payload })
const patch = (draftId: string, payload: Record<string, unknown>, token = gm) => h.app.inject({ method: 'PATCH',
  url: `/company/historical-drafts/${draftId}`, headers: headers(token), payload })
const get = (url = '/company/historical-drafts', token = gm) => h.app.inject({ method: 'GET', url, headers: headers(token) })
const financialState = async () => structuredClone({
  entries: h.deps.ledger.entries, ledger: h.deps.companyLedger.snapshot(),
  finance: { debts: await h.deps.companyFinance.listDebts(COMPANY_BRANCH), assets: await h.deps.companyFinance.listAssets(COMPANY_BRANCH) },
  assets: h.deps.existingAssets.snapshot(), expenses: h.deps.expenses.rows, incomes: h.deps.incomes.rows,
  fx: await h.deps.fx.list(), owners: (await get('/company/owner-payments')).json(),
  balances: await Promise.all([[COMPANY_BRANCH, 'company_cash:SYP_NEW'], [COMPANY_BRANCH, 'company_cash:USD'],
    [BRANCH, 'office_cash'], [BRANCH, 'office_wallet'], [BRANCH, 'company_box']]
    .map(([branch, fund]) => h.deps.ledger.fundBalance(branch!, fund!))),
})

beforeEach(async () => {
  h = await makeHarness({ companyHistoricalPostingEnabled: false })
  h.deps.directory.branches.set(DRAFT_BRANCH, { ...h.deps.directory.branches.get(BRANCH)!, id: DRAFT_BRANCH, code: 'DRAFT-DAM' })
  gm = await h.loginAs('gm')
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('administrative historical draft staging', () => {
  it('requires GM or system admin for reads and writes even if a lower role receives the permission', async () => {
    const admin = await h.loginAs('sysadmin'), manager = await h.loginAs('manager')
    // A non-empty custom matrix replaces the harness's fallback defaults.
    await h.deps.directory.setGrant('general_manager', 'company_fund.manage', 'all')
    await h.deps.directory.setGrant('system_admin', 'company_fund.manage', 'all')
    await h.deps.directory.setGrant('branch_manager', 'company_fund.manage', 'all')
    const denied = await post(base(), manager)
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ error: 'forbidden', detail: { reason: 'historical_roles_only' } })
    expect((await get(undefined, manager)).statusCode).toBe(403)
    const saved = await post(base(), admin)
    expect(saved.statusCode, saved.body).toBe(201)
    expect(saved.json().draft).toMatchObject({ status: 'draft', createdBy: 'u-sa', updatedBy: 'u-sa', version: 1 })
    expect((await patch(saved.json().draft.id, base({ expectedVersion: 1 }), manager)).statusCode).toBe(403)
    expect((await h.app.inject({ method: 'GET', url: '/company/historical-drafts' })).statusCode).toBe(401)
  })

  it('stores all nine evidence types, explicit owner source and frozen rates without any financial effects', async () => {
    const before = await financialState(), fxLookup = vi.spyOn(h.deps.fx, 'idFor').mockRejectedValue(new Error('drafts must not consult daily FX'))
    const cases = [base({ type: 'deposit', account: 'opening' }), base({ type: 'withdrawal' }),
      base({ paidFrom: 'owner_outside', sourceUnit: 'old Syrian pounds', occurredPrecision: 'month', occurredMonth: '2025-06', occurredOn: '2025-06-01' }),
      base({ type: 'income' }), base({ type: 'exchange', currency: undefined, amount: undefined,
        fromCurrency: 'SYP_NEW', fromAmount: '9310000.00', toCurrency: 'USD', toAmount: '700.00' }),
      base({ type: 'branch_receipt', branchId: DRAFT_BRANCH }), base({ type: 'branch_payment', branchId: DRAFT_BRANCH, paidFrom: 'owner_outside' }),
      base({ type: 'asset_payment', paidFrom: 'owner_outside', currency: 'USD', amount: '12000.00', historicalRate: '13300.00', rateBasis: 'estimated' }),
      base({ type: 'refund', receiptReference: 'return of prior branch funds' })]
    const drafts = []
    for (const input of cases) {
      const result = await post(input)
      expect(result.statusCode, result.body).toBe(201)
      drafts.push(result.json().draft)
    }
    expect(drafts[2].payload).toMatchObject({ paidFrom: 'owner_outside', occurredPrecision: 'month', occurredMonth: '2025-06', sourceUnit: 'old Syrian pounds', categoryId: null })
    expect(drafts[4].payload).toMatchObject({ fromAmount: '9310000.00', toAmount: '700.00', historicalRate: null, sypMinorPerUsd: '1330000' })
    expect(drafts[7].payload).toMatchObject({ account: null, amount: '12000.00', historicalRate: '13300.00', sypMinorPerUsd: '1330000', rateBasis: 'estimated', assetId: null })
    expect(fxLookup).not.toHaveBeenCalled()
    expect(await financialState()).toEqual(before)
    const listed = await get()
    expect(listed.json().drafts).toHaveLength(9)
    expect(listed.json()).not.toHaveProperty('postingEnabled')
  })

  it('rejects negative, zero, incomplete and inconsistent source/date/currency/branch evidence', async () => {
    const invalid = [base({ amount: '-1.00' }), base({ amount: '0.00' }), base({ occurredOn: '1999-12-31' }),
      base({ occurredOn: '2026-07-22' }), base({ occurredOn: '2025-02-30' }), base({ description: '\u200B' }),
      base({ currency: 'USD' }), base({ historicalRate: '100.00' }), base({ occurredPrecision: 'month', occurredMonth: '2025-08' }),
      base({ occurredMonth: '2025-08' }), base({ type: 'deposit', paidFrom: 'owner_outside' }),
      base({ type: 'branch_receipt' }), base({ type: 'branch_payment', branchId: COMPANY_BRANCH }),
      base({ type: 'branch_receipt', branchId: 'missing-branch' }), base({ type: 'refund', paidFrom: 'owner_outside' }),
      base({ type: 'branch_receipt', branchId: '30000000-0000-4000-8000-000000000999' }),
      base({ type: 'asset_payment', assetId: crypto.randomUUID() }), base({ assetId: crypto.randomUUID() }),
      base({ account: 'opening' }), base({ type: 'asset_payment', categoryId: crypto.randomUUID() }),
      base({ categoryId: crypto.randomUUID() }), base({ type: 'exchange', currency: undefined, amount: undefined,
        fromCurrency: 'USD', fromAmount: '1.00', toCurrency: 'USD', toAmount: '2.00' }),
      base({ intakeSessionId: crypto.randomUUID() }), base({ externalReference: 'a', receiptReference: 'b' })]
    for (const input of invalid) {
      const result = await post(input)
      expect([400, 422], result.body).toContain(result.statusCode)
    }
    expect((await get()).json().drafts).toEqual([])
    expect(h.deps.ledger.entries).toEqual([])
  })

  it('preserves all attributed versions and replays the original exact result after later edits', async () => {
    const original = base({ idempotencyKey: crypto.randomUUID().toUpperCase(), receiptReference: 'paper-7' })
    const first = await post(original), draftId = first.json().draft.id
    expect(first.statusCode).toBe(201)
    const edit = base({ expectedVersion: 1, amount: '5200000.00', paidFrom: 'owner_outside' })
    const updated = await patch(draftId, edit)
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json().draft).toMatchObject({ version: 2, payload: { amount: '5200000.00', paidFrom: 'owner_outside' } })
    const replay = await post(original)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual({ ...first.json(), replayed: true })
    const editReplay = await patch(draftId, edit)
    expect(editReplay.json()).toEqual({ ...updated.json(), replayed: true })
    const latest = await get(`/company/historical-drafts/${draftId}`)
    expect(latest.json().draft.version).toBe(2)
    expect(latest.json().draft.revisions.map((row: { version: number }) => row.version)).toEqual([1, 2])
    expect((await post({ ...original, amount: '99.00' })).json().error).toBe('idempotency_key_conflict')
    const admin = await h.loginAs('sysadmin')
    expect((await post(original, admin)).json().error).toBe('idempotency_key_conflict')
    const second = await post(base())
    expect((await patch(second.json().draft.id, edit)).json().error).toBe('idempotency_key_conflict')
  })

  it('serializes duplicate UUID creation and competing optimistic edits without duplicate revisions', async () => {
    const input = base()
    const results = await Promise.all([post(input), post(input), post(input)])
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 200, 201])
    const draftId = results[0]!.json().draft.id
    const edits = await Promise.all([patch(draftId, base({ expectedVersion: 1, amount: '1.00' })),
      patch(draftId, base({ expectedVersion: 1, amount: '2.00' }))])
    expect(edits.map(row => row.statusCode).sort()).toEqual([200, 409])
    expect(edits.find(row => row.statusCode === 409)!.json().error).toBe('historical_draft_version_conflict')
    expect((await get()).json().drafts).toHaveLength(1)
    expect((await get(`/company/historical-drafts/${draftId}`)).json().draft.revisions).toHaveLength(2)
  })

  it('rolls identity and revision back on a late write failure and permits the exact request to retry', async () => {
    const input = base(), create = h.deps.companyHistoricalDrafts.create.bind(h.deps.companyHistoricalDrafts)
    const failedCreate = vi.spyOn(h.deps.companyHistoricalDrafts, 'create').mockImplementationOnce(async (...args) => {
      await create(...args); throw new Error('failure after inserting first revision')
    })
    expect((await post(input)).statusCode).toBe(500)
    expect(h.deps.companyHistoricalDrafts.identities.size).toBe(0)
    expect(h.deps.companyHistoricalDrafts.revisions.size).toBe(0)
    failedCreate.mockRestore()
    const saved = await post(input)
    expect(saved.statusCode).toBe(201)
    const edit = base({ expectedVersion: 1, amount: '99.00' }), append = h.deps.companyHistoricalDrafts.append.bind(h.deps.companyHistoricalDrafts)
    const failedAppend = vi.spyOn(h.deps.companyHistoricalDrafts, 'append').mockImplementationOnce(async (...args) => {
      await append(...args); throw new Error('failure after inserting revision')
    })
    expect((await patch(saved.json().draft.id, edit)).statusCode).toBe(500)
    expect((await get(`/company/historical-drafts/${saved.json().draft.id}`)).json().draft.version).toBe(1)
    failedAppend.mockRestore()
    expect((await patch(saved.json().draft.id, edit)).statusCode).toBe(200)
    expect(h.deps.ledger.entries).toEqual([])
  })

  it('can preserve closed-period evidence without posting or providing approval/delete endpoints', async () => {
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25', closedBy: null, closedAtMs: null })
    await h.deps.weekLocks.seal(week.id, 'u-gm', h.deps.clock.nowMs())
    const saved = await post(base({ occurredOn: '2026-07-20' }))
    expect(saved.statusCode, saved.body).toBe(201)
    expect(saved.json().draft.status).toBe('draft')
    const url = `/company/historical-drafts/${saved.json().draft.id}`
    expect((await h.app.inject({ method: 'POST', url: `${url}/confirm`, headers: headers(), payload: {} })).statusCode).toBe(404)
    expect((await h.app.inject({ method: 'DELETE', url, headers: headers() })).statusCode).toBe(404)
    expect(h.deps.ledger.entries).toEqual([])
  })

  it('accepts optional classification without inventing it and validates supplied category evidence', async () => {
    const unknownDeposit = await post(base({ type: 'deposit' }))
    expect(unknownDeposit.statusCode).toBe(201)
    expect(unknownDeposit.json().draft.payload.account).toBeNull()
    const ownerDeposit = await post(base({ type: 'deposit', account: 'owner_funding' }))
    expect(ownerDeposit.json().draft.payload.account).toBe('owner_funding')
    const categoryId = crypto.randomUUID()
    await h.deps.expenses.createCategory({ id: categoryId, code: 'DRAFT-EXP', nameAr: 'مصروف قديم', active: true })
    const classified = await post(base({ categoryId }))
    expect(classified.statusCode).toBe(201)
    expect(classified.json().draft.payload.categoryId).toBe(categoryId)
    const unclassified = await post(base())
    expect(unclassified.json().draft.payload.categoryId).toBeNull()
    expect((await post(base({ type: 'income', categoryId }))).statusCode).toBe(422)
    expect(h.deps.expenses.rows.size).toBe(0)
  })
})
