import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { BRANCH, type Harness, OTHER_BRANCH, TINY_JPEG, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Expenses (SRS §G) — «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة لمركز كلفتها».
 *
 * The rule that matters: an expense and its ledger posting are one act. A row in a table that no
 * balance sheet knows about is not an expense, it is a note.
 */

let h: Harness
let categoryId: string

beforeEach(async () => {
  h = await makeHarness()
  const admin = await h.loginAs('sysadmin')
  const res = await h.app.inject({
    method: 'POST',
    url: '/expense-categories',
    headers: { cookie: h.cookie(admin) },
    payload: { code: 'fuel', nameAr: 'كهرباء الشحن' },
  })
  categoryId = res.json().id
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const expense = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(),
  categoryId,
  costCenterKind: 'general',
  vehicleId: null,
  amount: sypStr(25_000),
  description: 'كهرباء شحن',
  ...over,
})

describe('recording an expense', () => {
  it('posts to the ledger in the same act as recording the row', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/expenses', expense())
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().amount).toBe('25000.00')
    expect(res.json().journalEntryId).not.toBeNull()

    // Cash left the office; the cost centre carries it.
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(-2_500_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, fundCodeOf({ kind: 'cost_center', costCenterId: `general:${BRANCH}` }))).toBe(
      2_500_000n,
    )
  })

  it('every expense posting balances', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/expenses', expense())
    for (const entry of h.deps.ledger.entries) {
      let d = 0n
      let c = 0n
      for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
      expect(d).toBe(c)
    }
  })

  it('attributes a vehicle expense to that vehicle’s cost centre (G-1, G-2)', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/expenses', {
      ...expense({ costCenterKind: 'vehicle', vehicleId: VEHICLE_ID, amount: sypStr(4_000) }),
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(
      await h.deps.ledger.fundBalance(BRANCH, fundCodeOf({ kind: 'cost_center', costCenterId: VEHICLE_ID })),
    ).toBe(400_000n)
  })

  it('refuses a vehicle cost centre with no vehicle, and a vehicle on any other kind', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/expenses', expense({ costCenterKind: 'vehicle' }))).json().error).toBe(
      'cost_center_vehicle_mismatch',
    )
    expect(
      (await post(manager, '/expenses', expense({ costCenterKind: 'branch', vehicleId: VEHICLE_ID }))).json().error,
    ).toBe('cost_center_vehicle_mismatch')
  })

  it('refuses a vehicle belonging to another branch', async () => {
    const manager = await h.loginAs('manager')
    h.deps.directory.vehicles.set('veh-aleppo', {
      id: 'veh-aleppo', branchId: OTHER_BRANCH, vehicleTypeId: 'e_motorbike', machineNo: 9, plateNo: null,
      groundNo: null,
      code: 'ALP-1', state: 'ready', active: true,
    })
    const res = await post(manager, '/expenses', expense({ costCenterKind: 'vehicle', vehicleId: 'veh-aleppo' }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('vehicle_in_another_branch')
  })

  it('refuses an unknown category rather than posting into the void', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/expenses', expense({ categoryId: 'no-such-category' }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('unknown_expense_category')
  })

  it.each(['0', '0.00', '-0.01', '-250.00'])('rejects non-positive amount %s at the request boundary', async (amount) => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/expenses', expense({ amount }))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
    expect(h.deps.expenses.rows.size).toBe(0)
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('returns an exact lost-response retry without adding another row or journal', async () => {
    const manager = await h.loginAs('manager')
    const key = crypto.randomUUID()
    const payload = expense({ idempotencyKey: key })

    const first = await post(manager, '/expenses', payload)
    const retry = await post(manager, '/expenses', payload)

    expect(first.statusCode, first.body).toBe(201)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toEqual(first.json())
    expect(h.deps.expenses.rows.size).toBe(1)
    expect(h.deps.ledger.entries.filter((entry) => entry.occurrenceKey === key)).toHaveLength(1)
  })

  it('rejects reuse of an expense key with a different immutable payload', async () => {
    const manager = await h.loginAs('manager')
    const key = crypto.randomUUID()
    expect((await post(manager, '/expenses', expense({ idempotencyKey: key }))).statusCode).toBe(201)

    const conflict = await post(manager, '/expenses', expense({ idempotencyKey: key, amount: sypStr(30_000) }))
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toBe('idempotency_key_conflict')
    expect(h.deps.expenses.rows.size).toBe(1)
    expect(h.deps.ledger.entries.filter((entry) => entry.occurrenceKey === key)).toHaveLength(1)
  })

  it('serializes concurrent exact retries into one expense and one journal', async () => {
    const manager = await h.loginAs('manager')
    const key = crypto.randomUUID()
    const payload = expense({ idempotencyKey: key })

    const replies = await Promise.all([
      post(manager, '/expenses', payload),
      post(manager, '/expenses', payload),
    ])

    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 201])
    expect(h.deps.expenses.rows.size).toBe(1)
    expect(h.deps.ledger.entries.filter((entry) => entry.occurrenceKey === key)).toHaveLength(1)
  })

  it('rolls the journal back when creating the expense row fails', async () => {
    const manager = await h.loginAs('manager')
    const create = h.deps.expenses.create.bind(h.deps.expenses)
    h.deps.expenses.create = async () => {
      throw new Error('simulated expense row failure')
    }

    const failed = await post(manager, '/expenses', expense())
    h.deps.expenses.create = create

    expect(failed.statusCode).toBe(500)
    expect(h.deps.expenses.rows.size).toBe(0)
    expect(h.deps.ledger.entries).toHaveLength(0)
  })
})

describe('the approval ceiling (A-4 / س52, G-3)', () => {
  it('demands a photographed receipt above the configured ceiling', async () => {
    const admin = await h.loginAs('sysadmin')
    const manager = await h.loginAs('manager')
    await h.deps.settings.set('expense.receipt_required_above_minor', '1000000', 'u-sa') // 10,000 SYP
    void admin

    const over = await post(manager, '/expenses', expense({ amount: sypStr(25_000) }))
    expect(over.statusCode).toBe(422)
    expect(over.json().error).toBe('receipt_required')
    expect(over.json().detail.ceiling).toBe('10000.00')

    // Under the ceiling is fine without one.
    expect((await post(manager, '/expenses', expense({ amount: sypStr(5_000) }))).statusCode).toBe(201)
  })

  it('accepts a large expense once a receipt is attached', async () => {
    const manager = await h.loginAs('manager')
    await h.deps.settings.set('expense.receipt_required_above_minor', '1000000', 'u-sa')

    const upload = await h.app.inject({
      method: 'POST',
      url: '/media/receipts',
      headers: { cookie: h.cookie(manager), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })
    expect(upload.statusCode, upload.body).toBe(201)

    const res = await post(manager, '/expenses', expense({
      amount: sypStr(25_000),
      receiptMediaId: upload.json().mediaId,
    }))
    expect(res.statusCode, res.body).toBe(201)
  })

  it('imposes no ceiling when none is configured', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/expenses', expense({ amount: sypStr(999_999) }))).statusCode).toBe(201)
  })
})

describe('who may spend (SRS §3 matrix, as amended by decision 9)', () => {
  it.each([
    ['manager', 201],
    ['gm', 422], // holds expense.write but is org-wide, so must name a branch
    ['sysadmin', 422], // decision 9 granted him expense.write; org-wide, so same branch rule as the GM
    ['driver1', 403], // still no grant, and that floor is what decision 9 does NOT touch
  ])('%s → %i', async (user, expected) => {
    const token = await h.loginAs(user)
    expect((await post(token, '/expenses', expense())).statusCode, user).toBe(expected)
  })

  it('the GM can spend once he names the branch', async () => {
    const gm = await h.loginAs('gm')
    expect((await post(gm, '/expenses', expense({ branchId: BRANCH }))).statusCode).toBe(201)
  })
})

describe('reporting', () => {
  it('totals per cost centre — the basis of per-axis profitability (G-1)', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/expenses', expense({ amount: sypStr(1_000) }))
    await post(manager, '/expenses', expense({ amount: sypStr(2_000) }))
    await post(manager, '/expenses', expense({ costCenterKind: 'vehicle', vehicleId: VEHICLE_ID, amount: sypStr(500) }))

    const res = await get(manager, '/expenses/by-cost-center')
    expect(res.statusCode).toBe(200)
    const totals = res.json().totals as Array<{ costCenterKind: string; total: string }>
    expect(totals.find((t) => t.costCenterKind === 'general')?.total).toBe('3000.00')
    expect(totals.find((t) => t.costCenterKind === 'vehicle')?.total).toBe('500.00')
  })

  it('lists the day’s expenses with a total', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/expenses', expense({ amount: sypStr(1_500) }))
    const res = await get(manager, '/expenses')
    expect(res.json().total).toBe('1500.00')
    expect(res.json().expenses).toHaveLength(1)
  })

  it('a driver cannot read the branch’s spending', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/expenses')).statusCode).toBe(403)
  })
})
