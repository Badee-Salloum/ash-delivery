import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { BRANCH, type Harness, TINY_JPEG, makeHarness, sypStr } from './harness.ts'

let h: Harness
let manager: string
let categoryId: string

beforeEach(async () => {
  h = await makeHarness()
  manager = await h.loginAs('manager')
  const admin = await h.loginAs('sysadmin')
  const category = await h.app.inject({
    method: 'POST',
    url: '/expense-categories',
    headers: { cookie: h.cookie(admin) },
    payload: { code: 'rent', nameAr: 'إيجارات' },
  })
  categoryId = category.json().id
})

afterEach(async () => h.app.close())

const createTemplate = async (overrides: Record<string, unknown> = {}) => {
  const payload = {
    idempotencyKey: crypto.randomUUID(),
    title: 'إيجار المكتب',
    categoryId,
    costCenterKind: 'general',
    vehicleId: null,
    channel: 'office_cash',
    amount: sypStr(300_000),
    scheduleKind: 'monthly_first',
    weekday: null,
    intervalDays: null,
    startsOn: '2026-06-01',
    endsOn: null,
    ...overrides,
  }
  return {
    payload,
    response: await h.app.inject({
      method: 'POST', url: '/recurring-expenses', headers: { cookie: h.cookie(manager) }, payload,
    }),
  }
}

describe('recurring expense templates and due read', () => {
  it('creates an idempotent template and computes dues without inserting occurrence rows', async () => {
    const { payload, response } = await createTemplate()
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ title: 'إيجار المكتب', amount: '300000.00', active: true })

    const retry = await h.app.inject({
      method: 'POST', url: '/recurring-expenses', headers: { cookie: h.cookie(manager) }, payload,
    })
    expect(retry.statusCode).toBe(200)
    expect(h.deps.recurringExpenses.templates.size).toBe(1)

    const due = await h.app.inject({ method: 'GET', url: '/recurring-expenses/due', headers: { cookie: h.cookie(manager) } })
    expect(due.statusCode, due.body).toBe(200)
    expect(due.json().due.map((row: { dueDate: string }) => row.dueDate)).toEqual(['2026-06-01', '2026-07-01'])
    expect(due.json().due[0].status).toBe('overdue')
    expect(h.deps.recurringExpenses.occurrences.size).toBe(0)
  })

  it('supports all three schedule shapes and rejects a mismatched shape at the edge', async () => {
    expect((await createTemplate({
      idempotencyKey: crypto.randomUUID(), title: 'راتب أسبوعي', scheduleKind: 'weekly',
      weekday: 2, intervalDays: null, startsOn: '2026-07-01',
    })).response.statusCode).toBe(201)
    expect((await createTemplate({
      idempotencyKey: crypto.randomUUID(), title: 'إنترنت', scheduleKind: 'every_n_days',
      weekday: null, intervalDays: 10, startsOn: '2026-07-01',
    })).response.statusCode).toBe(201)
    expect((await createTemplate({
      idempotencyKey: crypto.randomUUID(), scheduleKind: 'weekly', weekday: null, intervalDays: 7,
    })).response.statusCode).toBe(400)
  })

  it('deactivates only with a reason and leaves older unresolved dues visible', async () => {
    const { response } = await createTemplate()
    const id = response.json().id as string
    const emptyReason = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/deactivate`, headers: { cookie: h.cookie(manager) },
      payload: { reason: '   ' },
    })
    expect(emptyReason.statusCode).toBe(400)

    const stopped = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/deactivate`, headers: { cookie: h.cookie(manager) },
      payload: { reason: 'انتهى العقد' },
    })
    expect(stopped.statusCode, stopped.body).toBe(200)
    expect(stopped.json()).toMatchObject({ active: false, deactivatedOn: '2026-07-21', deactivationReason: 'انتهى العقد' })
    const due = await h.app.inject({ method: 'GET', url: '/recurring-expenses/due', headers: { cookie: h.cookie(manager) } })
    expect(due.json().due.map((row: { dueDate: string }) => row.dueDate)).toEqual(['2026-06-01', '2026-07-01'])
  })

  it('keeps branch authorization server-side', async () => {
    const driver = await h.loginAs('driver1')
    const denied = await h.app.inject({
      method: 'POST', url: '/recurring-expenses', headers: { cookie: h.cookie(driver) },
      payload: (await createTemplate()).payload,
    })
    expect(denied.statusCode).toBe(403)
  })
})

describe('paying and skipping due occurrences', () => {
  it('pays through the ordinary expense recipe exactly once', async () => {
    const { response } = await createTemplate()
    const id = response.json().id as string
    const key = crypto.randomUUID()
    const payload = {
      idempotencyKey: key,
      amount: sypStr(300_000),
      businessDate: '2026-07-21',
      reason: null,
      receiptMediaId: null,
    }
    const first = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-01/pay`,
      headers: { cookie: h.cookie(manager) }, payload,
    })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().expense).toMatchObject({ id: key, amount: '300000.00', businessDate: '2026-07-21' })
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(-30_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, fundCodeOf({ kind: 'cost_center', costCenterId: `general:${BRANCH}` }))).toBe(30_000_000n)

    const replay = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-01/pay`,
      headers: { cookie: h.cookie(manager) }, payload,
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().replayed).toBe(true)
    expect(h.deps.expenses.rows.size).toBe(1)
    expect(h.deps.ledger.entries).toHaveLength(1)

    const second = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-01/pay`,
      headers: { cookie: h.cookie(manager) },
      payload: { ...payload, idempotencyKey: crypto.randomUUID() },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('recurring_expense_already_resolved')
  })

  it('replays a committed payment before a newly closed week is revalidated', async () => {
    const { response } = await createTemplate({
      startsOn: '2026-07-21', scheduleKind: 'weekly', weekday: 2, intervalDays: null,
    })
    const id = response.json().id as string
    const payload = {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(300_000),
      reason: null,
      receiptMediaId: null,
    }
    const first = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-21/pay`,
      headers: { cookie: h.cookie(manager) }, payload,
    })
    expect(first.statusCode, first.body).toBe(201)

    const lock = await h.deps.weekLocks.create({
      branchId: BRANCH,
      weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25',
      closedAtMs: null,
      closedBy: null,
    })
    await h.deps.weekLocks.seal(lock.id, 'u-sa', h.deps.clock.nowMs())

    const replay = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-21/pay`,
      headers: { cookie: h.cookie(manager) }, payload,
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, expense: { id: payload.idempotencyKey } })
    expect(h.deps.expenses.rows.size).toBe(1)
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('requires a written reason when changing the amount', async () => {
    const { response } = await createTemplate()
    const id = response.json().id as string
    const missing = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-01/pay`,
      headers: { cookie: h.cookie(manager) },
      payload: { idempotencyKey: crypto.randomUUID(), amount: sypStr(250_000), reason: null, receiptMediaId: null },
    })
    expect(missing.statusCode).toBe(422)
    expect(missing.json().error).toBe('recurring_expense_adjustment_reason_required')
  })

  it('records a reasoned skip and removes it from the computed due list', async () => {
    const { response } = await createTemplate()
    const id = response.json().id as string
    const skipped = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-07-01/skip`,
      headers: { cookie: h.cookie(manager) }, payload: { reason: 'أعفانا المالك' },
    })
    expect(skipped.statusCode, skipped.body).toBe(201)
    expect(skipped.json()).toMatchObject({ status: 'skipped', reason: 'أعفانا المالك' })
    const due = await h.app.inject({ method: 'GET', url: '/recurring-expenses/due', headers: { cookie: h.cookie(manager) } })
    expect(due.json().due.map((row: { dueDate: string }) => row.dueDate)).toEqual(['2026-06-01'])
  })

  it('does not allow paying or skipping a future occurrence', async () => {
    const { response } = await createTemplate({ startsOn: '2026-08-01' })
    const id = response.json().id as string
    const paid = await h.app.inject({
      method: 'POST', url: `/recurring-expenses/${id}/occurrences/2026-08-01/pay`,
      headers: { cookie: h.cookie(manager) },
      payload: { idempotencyKey: crypto.randomUUID(), amount: sypStr(300_000), reason: null, receiptMediaId: null },
    })
    expect(paid.statusCode).toBe(409)
    expect(paid.json().error).toBe('recurring_expense_not_due')
  })
})

describe('non-shift receipt upload', () => {
  it('stores content-addressed image bytes and lets an expense satisfy its ceiling', async () => {
    await h.deps.settings.set('expense.receipt_required_above_minor', '1000000', 'u-sa')
    const uploaded = await h.app.inject({
      method: 'POST', url: '/media/receipts', headers: { cookie: h.cookie(manager), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    const mediaId = uploaded.json().mediaId as string

    const expense = await h.app.inject({
      method: 'POST', url: '/expenses', headers: { cookie: h.cookie(manager) },
      payload: {
        idempotencyKey: crypto.randomUUID(), categoryId, costCenterKind: 'general', vehicleId: null,
        amount: sypStr(25_000), description: 'إيصال مرفق', receiptMediaId: mediaId,
      },
    })
    expect(expense.statusCode, expense.body).toBe(201)

    const retry = await h.app.inject({
      method: 'POST', url: '/media/receipts', headers: { cookie: h.cookie(manager), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toMatchObject({ mediaId, deduped: true })
  })

  it('rejects non-images and cross-branch receipt ids', async () => {
    const bad = await h.app.inject({
      method: 'POST', url: '/media/receipts', headers: { cookie: h.cookie(manager), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not an image'),
    })
    expect(bad.statusCode).toBe(415)
  })
})
