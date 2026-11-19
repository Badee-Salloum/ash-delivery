import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, OTHER_BRANCH, VEHICLE_ID, makeHarness, type Harness } from './harness.ts'

let h: Harness
let manager: string
let categoryId: string
let otherCategoryId: string
beforeEach(async () => {
  h = await makeHarness()
  manager = await h.loginAs('manager')
  const admin = await h.loginAs('sysadmin')
  const createCategory = async (code: string) => {
    const response = await h.app.inject({ method: 'POST', url: '/expense-categories', headers: { cookie: h.cookie(admin) }, payload: { code, nameAr: code === 'fuel' ? 'بنزين' : 'إيجار' } })
    return response.json().id as string
  }
  categoryId = await createCategory('fuel')
  otherCategoryId = await createCategory('rent')
})
afterEach(async () => { await h.app.close() })

async function create(overrides: Record<string, unknown> = {}) {
  const response = await h.app.inject({ method: 'POST', url: '/expenses', headers: { cookie: h.cookie(manager) }, payload: {
    idempotencyKey: crypto.randomUUID(), categoryId, costCenterKind: 'general', vehicleId: null,
    amount: '10.01', description: 'بنزين 50% للمكتب', businessDate: '2026-07-21', ...overrides,
  } })
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
const get = (query = '', token = manager, path = '/expenses') => h.app.inject({ method: 'GET', url: `${path}${query ? `?${query}` : ''}`, headers: { cookie: h.cookie(token) } })

describe('branch expense filters are real, scoped and read only', () => {
  it('pages newest business dates and same-day posting sequence first, never random UUID order', async () => {
    const first = await create({ idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff', amount: '1.00' })
    const second = await create({ idempotencyKey: '00000000-0000-4000-8000-000000000001', amount: '2.00' })
    const snapshot = structuredClone(h.deps.ledger.entries)
    const page1 = (await get('limit=1&offset=0')).json(), page2 = (await get('limit=1&offset=1')).json()
    expect(page1.expenses[0].id).toBe(second.id)
    expect(page2.expenses[0].id).toBe(first.id)
    expect(page1.total).toBe('3.00'); expect(page2.total).toBe('3.00')
    expect(h.deps.ledger.entries).toEqual(snapshot)
  })
  it('uses an explicit current business day by default and real earliest expense for all history', async () => {
    await h.deps.fx.upsert({ businessDate: '2026-06-01', sypMinorPerUsd: 13300n, provisional: false })
    await create({ businessDate: '2026-06-01', amount: '2.00' })
    await create()
    const today = (await get()).json()
    expect(today.from).toBe('2026-07-21'); expect(today.to).toBe('2026-07-21')
    expect(today.count).toBe(1); expect(today.total).toBe('10.01')
    const all = (await get('all=true')).json()
    expect(all.from).toBe('2026-06-01'); expect(all.count).toBe(2); expect(all.total).toBe('12.01')
    expect(all.currency).toBe('SYP_NEW'); expect(all.earliestBusinessDate).toBe('2026-06-01')
  })

  it('applies each supported filter and combines all of them', async () => {
    const wanted = await create({ costCenterKind: 'vehicle', vehicleId: VEHICLE_ID, channel: 'office_wallet', amount: '10.01', description: 'صيانة موتور' })
    await create({ categoryId: otherCategoryId, costCenterKind: 'branch', amount: '20.99', description: 'إيجار' })
    await create({ amount: '30.00', description: 'صيانة المكتب' })
    const queries = [
      [`categoryId=${otherCategoryId}`, ['20.99']], ['costCenterKind=vehicle', ['10.01']],
      [`vehicleId=${VEHICLE_ID}`, ['10.01']], ['costCenterKind=operating', ['20.99', '30.00']],
      ['channel=office_wallet', ['10.01']], [`q=${encodeURIComponent('موتور')}`, ['10.01']],
      ['minAmount=20.99&maxAmount=20.99', ['20.99']], ['receipt=without', ['10.01', '20.99', '30.00']],
    ] as const
    for (const [query, amounts] of queries) {
      const response = await get(query)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().expenses.map((row: { amount: string }) => row.amount).sort()).toEqual([...amounts].sort())
    }
    const response = await get(`categoryId=${categoryId}&costCenterKind=vehicle&vehicleId=${VEHICLE_ID}&channel=office_wallet&q=${encodeURIComponent('صيانة')}&receipt=without&minAmount=10.01&maxAmount=10.01`)
    expect(response.json().expenses.map((row: { id: string }) => row.id)).toEqual([wanted.id])
    expect(response.json().count).toBe(1); expect(response.json().total).toBe('10.01')
  })

  it('searches literal percent/underscore instead of treating input as wildcards', async () => {
    await create({ description: 'خصم 50% قطع_غيار' })
    await create({ description: 'خصم 50 قطع غيار' })
    expect((await get(`q=${encodeURIComponent('%')}`)).json().count).toBe(1)
    expect((await get(`q=${encodeURIComponent('_')}`)).json().count).toBe(1)
  })

  it('filters receipt existence and never treats an unpaid recurring template as an expense', async () => {
    const row = await create()
    const record = h.deps.expenses.rows.get(row.id)!
    h.deps.expenses.rows.set(row.id, { ...record, receiptMediaId: 'receipt-existing' })
    await create()
    const before = h.deps.ledger.entries.length
    expect((await get('receipt=with')).json().count).toBe(1)
    expect((await get('receipt=without')).json().count).toBe(1)
    expect((await get('all=true', manager, '/expenses/export')).json().count).toBe(2)
    expect(h.deps.ledger.entries).toHaveLength(before)
  })

  it('returns whole-set count and exact total across pagination and a complete export', async () => {
    await create({ amount: '0.01' }); await create({ amount: '10.02' }); await create({ amount: '90071992547409.93' })
    const before = h.deps.ledger.entries.length
    const first = (await get('limit=1&offset=0')).json()
    const second = (await get('limit=1&offset=1')).json()
    expect(first.expenses).toHaveLength(1); expect(second.expenses).toHaveLength(1)
    expect(first.expenses[0].id).not.toBe(second.expenses[0].id)
    expect(first.count).toBe(3); expect(first.total).toBe('90071992547419.96')
    expect(second.total).toBe(first.total)
    const full = (await get('limit=1&offset=1', manager, '/expenses/export')).json()
    expect(full.expenses).toHaveLength(3); expect(full.offset).toBe(0); expect(full.limit).toBeNull()
    expect(full.total).toBe(first.total)
    expect(h.deps.ledger.entries).toHaveLength(before)
  })

  it('keeps inactive categories readable and filterable but refuses new expenses on them', async () => {
    await create()
    h.deps.expenses.categories.set(categoryId, { ...h.deps.expenses.categories.get(categoryId)!, active: false })
    const filtered = await get(`categoryId=${categoryId}`)
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(filtered.json().expenses[0].categoryNameAr).toBe('بنزين')
    expect((await get('includeInactive=true', manager, '/expense-categories')).json().categories.find((category: { id: string }) => category.id === categoryId).active).toBe(false)
    expect((await get('', manager, '/expense-categories')).json().categories.some((category: { id: string }) => category.id === categoryId)).toBe(false)
    const refused = await h.app.inject({ method: 'POST', url: '/expenses', headers: { cookie: h.cookie(manager) }, payload: { idempotencyKey: crypto.randomUUID(), categoryId, costCenterKind: 'general', amount: '1.00', description: 'جديد' } })
    expect(refused.statusCode).toBe(422)
  })

  it.each([
    'from=2026-02-31&to=2026-03-01', 'from=2026-07-22&to=2026-07-21', 'to=2026-07-20',
    'from=not-a-date', 'minAmount=-1', 'minAmount=0.001', 'minAmount=20&maxAmount=10',
    'limit=0', 'limit=201', 'offset=-1', 'categoryId=x&unknown=1', 'currency=USD',
    'channel=owner_outside', 'all=true&from=2026-07-01', `costCenterKind=branch&vehicleId=${VEHICLE_ID}`,
  ])('rejects invalid/unsupported filters rather than ignoring %s', async (query) => {
    const response = await get(query)
    expect(response.statusCode, response.body).toBe(400)
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('preserves branch permissions for list and export and allows scoped organisation-wide reads', async () => {
    await create()
    const gm = await h.loginAs('gm')
    const driver = await h.loginAs('driver1')
    for (const path of ['/expenses', '/expenses/export']) {
      expect((await get(`branchId=${OTHER_BRANCH}`, manager, path)).statusCode).toBe(403)
      expect((await get(`branchId=${BRANCH}`, driver, path)).statusCode).toBe(403)
      const authorised = await get(`branchId=${BRANCH}&costCenterKind=general`, gm, path)
      expect(authorised.statusCode, authorised.body).toBe(200)
      expect(authorised.json().branchId).toBe(BRANCH)
      expect(authorised.json().count).toBe(1)
    }
  })

  it('validates referenced categories and vehicle scope', async () => {
    expect((await get('categoryId=missing')).statusCode).toBe(422)
    expect((await get('vehicleId=missing')).statusCode).toBe(404)
    const vehicle = h.deps.directory.vehicles.get(VEHICLE_ID)!
    h.deps.directory.vehicles.set('other-vehicle', { ...vehicle, id: 'other-vehicle', branchId: OTHER_BRANCH })
    expect((await get('vehicleId=other-vehicle')).statusCode).toBe(422)
  })

  it('labels original recorded totals honestly when a later reversal changes net ledger cost', async () => {
    const recorded = await create({ amount: '10.01' })
    expect(await h.deps.ledger.fundBalance(BRANCH, `cost_center:general:${BRANCH}`)).toBe(1001n)
    const gm = await h.loginAs('gm')
    const reversed = await h.app.inject({ method: 'POST', url: `/journal/${recorded.journalEntryId}/reverse`, headers: { cookie: h.cookie(gm) }, payload: { branchId: BRANCH, reason: 'تصحيح الصرفية' } })
    expect(reversed.statusCode, reversed.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, `cost_center:general:${BRANCH}`)).toBe(0n)
    const result = (await get()).json()
    expect(result.totalBasis).toBe('recorded_expense_rows')
    expect(result.total).toBe('10.01')
    // Read/export do not invent a new financial correction to force totals to match.
    const entries = h.deps.ledger.entries.length
    await get('', manager, '/expenses/export')
    expect(h.deps.ledger.entries).toHaveLength(entries)
  })
})
