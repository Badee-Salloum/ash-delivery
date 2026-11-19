import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/api.ts'

afterEach(() => vi.unstubAllGlobals())

const income = {
  idempotencyKey: 'income-once', categoryId: 'other-income', channel: 'office_cash' as const,
  amount: '4500', description: 'Local branch registration test',
}
const advance = {
  ...income, idempotencyKey: 'advance-once', categoryId: 'fuel',
  partyName: 'Local test', costCenterKind: 'general' as const,
}

for (const kind of ['income', 'advance'] as const) {
  it(`${kind} registration uses the general manager's selected branch and follows branch changes`, async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ApiClient('/api')
    const body = kind === 'income' ? income : advance
    const create = (branchId?: string) => kind === 'income'
      ? api.createIncome({ ...income, ...(branchId ? { branchId } : {}) })
      : api.createAdvance({ ...advance, ...(branchId ? { branchId } : {}) })

    api.setBranch('damascus')
    await create()
    api.setBranch('second-branch')
    await create()
    await create('explicit-branch')
    api.setBranch(null)
    await create() // A branch manager's own session supplies the branch on the server.

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(4).fill(`/api/${kind === 'income' ? 'incomes' : 'advances'}`))
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { ...body, branchId: 'damascus' },
      { ...body, branchId: 'second-branch' },
      { ...body, branchId: 'explicit-branch' },
      body,
    ])
    expect(body).not.toHaveProperty('branchId')
  })
}
