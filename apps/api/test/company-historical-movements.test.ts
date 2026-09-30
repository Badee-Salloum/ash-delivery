import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPANY_BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

let h: Harness
let gm: string
let expenseCategoryId: string
let incomeCategoryId: string

const post = async (payload: Record<string, unknown>, token = gm) => h.app.inject({
  method: 'POST',
  url: '/company/historical-movements',
  headers: { cookie: h.cookie(token) },
  payload,
})

const get = async (url: string, token = gm) => h.app.inject({
  method: 'GET',
  url,
  headers: { cookie: h.cookie(token) },
})

const historical = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(),
  externalReference: `HIST-${crypto.randomUUID()}`,
  type: 'deposit',
  occurredOn: '2025-01-10',
  description: 'opening cash from paper book',
  currency: 'SYP_NEW',
  amount: sypStr(100),
  ...overrides,
})

beforeEach(async () => {
  h = await makeHarness()
  gm = await h.loginAs('gm')
  expenseCategoryId = crypto.randomUUID()
  incomeCategoryId = crypto.randomUUID()
  await h.deps.expenses.createCategory({ id: expenseCategoryId, code: `HIST-EXP-${expenseCategoryId}`, nameAr: 'مصروف قديم', active: true })
  await h.deps.incomes.createCategory({ id: incomeCategoryId, code: `HIST-INC-${incomeCategoryId}`, nameAr: 'دخل قديم', active: true })
})

afterEach(async () => h.app.close())

describe('historical company-fund movements', () => {
  it('is GM/system-admin only, keeps the actual date, and freezes a supplied USD rate', async () => {
    const manager = await h.loginAs('manager')
    const denied = await post(historical(), manager)
    expect(denied.statusCode).toBe(403)

    const sysadmin = await h.loginAs('sysadmin')
    expect((await get('/company/historical-movements/preflight', sysadmin)).statusCode).toBe(200)

    const preflight = await get('/company/historical-movements/preflight')
    expect(preflight.statusCode).toBe(200)
    expect(preflight.json()).toEqual({ pockets: { SYP_NEW: '0.00', USD: '0.00' }, canStart: true })

    const created = await post(historical({
      type: 'deposit', currency: 'USD', amount: '10.00', historicalRate: '170.00', occurredOn: '2025-02-15',
    }))
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      replayed: false,
      pockets: { SYP_NEW: '0.00', USD: '10.00' },
      command: { kind: 'deposit', occurredOn: '2025-02-15', businessDate: '2026-07-21', sypMinorPerUsd: '17000' },
    })

    const listed = await get('/company/historical-movements?from=2025-02-15&to=2025-02-15&type=deposit')
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().movements).toHaveLength(1)
    expect(listed.json().movements[0]).toMatchObject({
      entry: { businessDate: '2026-07-21', externalReference: created.json().externalReference, sypMinorPerUsd: '17000' },
      command: { occurredOn: '2025-02-15', businessDate: '2026-07-21', kind: 'deposit' },
    })
    expect((await get('/company/historical-movements/preflight')).json().canStart).toBe(false)
  })

  it('records all five movement types with actual exchange amounts and permits an observed negative pocket', async () => {
    const depositSyp = await post(historical({ externalReference: 'BOOK-DEP-SYP' }))
    const depositUsd = await post(historical({
      externalReference: 'BOOK-DEP-USD', type: 'deposit', currency: 'USD', amount: '10.00', historicalRate: '170.00',
    }))
    const expense = await post(historical({
      externalReference: 'BOOK-EXP', type: 'expense', currency: 'SYP_NEW', amount: sypStr(20),
      categoryId: expenseCategoryId, description: 'historical fuel',
    }))
    const income = await post(historical({
      externalReference: 'BOOK-INC', type: 'income', currency: 'SYP_NEW', amount: sypStr(5),
      categoryId: incomeCategoryId, description: 'historical scrap sale',
    }))
    const withdrawal = await post(historical({
      externalReference: 'BOOK-WITH', type: 'withdrawal', currency: 'SYP_NEW', amount: sypStr(10),
      description: 'historical owner draw',
    }))
    const exchange = await post(historical({
      externalReference: 'BOOK-FX', type: 'exchange', currency: undefined, amount: undefined,
      fromCurrency: 'USD', fromAmount: '2.00', toCurrency: 'SYP_NEW', toAmount: sypStr(340),
      description: 'cash conversion',
    }))

    for (const response of [depositSyp, depositUsd, expense, income, withdrawal, exchange]) {
      expect(response.statusCode, response.body).toBe(201)
    }
    expect(exchange.json()).toMatchObject({
      command: { kind: 'exchange', fromAmount: '2.00', toAmount: '340.00', sypMinorPerUsd: '17000' },
      pockets: { SYP_NEW: '415.00', USD: '8.00' },
    })
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(41_500n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(800n)

    const empty = await makeHarness()
    const emptyGm = await empty.loginAs('gm')
    const negativePocket = await empty.app.inject({
      method: 'POST', url: '/company/historical-movements', headers: { cookie: empty.cookie(emptyGm) },
      payload: historical({ type: 'withdrawal', externalReference: 'EMPTY-WITH' }),
    })
    expect(negativePocket.statusCode, negativePocket.body).toBe(201)
    expect(negativePocket.json()).toMatchObject({ pockets: { SYP_NEW: '-100.00', USD: '0.00' } })
    await empty.app.close()

    const negativeAmount = await post(historical({ externalReference: 'NEGATIVE-AMOUNT', amount: '-1.00' }))
    expect(negativeAmount.statusCode).toBe(400)
  })

  it('uses external reference independently from UUID retries and refuses a changed source row', async () => {
    const reference = 'PAPER-ROW-0042'
    const first = await post(historical({ externalReference: reference }))
    expect(first.statusCode, first.body).toBe(201)
    const originalId = first.json().command.id

    const replay = await post(historical({ externalReference: reference }))
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, command: { id: originalId } })

    const conflictingReference = await post(historical({ externalReference: reference, amount: sypStr(101) }))
    expect(conflictingReference.statusCode).toBe(409)
    expect(conflictingReference.json().error).toBe('external_reference_conflict')

    const conflictingUuid = await post(historical({
      idempotencyKey: originalId,
      externalReference: 'PAPER-ROW-0043',
    }))
    expect(conflictingUuid.statusCode).toBe(409)
  })

  it('does not let a matching audit reference bypass a UUID already spent on another movement', async () => {
    const source = historical({
      idempotencyKey: crypto.randomUUID(),
      externalReference: 'UUID-REFERENCE-SOURCE',
      occurredOn: '2025-02-01',
    })
    expect((await post(source)).statusCode).toBe(201)

    const spentUuid = crypto.randomUUID()
    expect((await post(historical({
      idempotencyKey: spentUuid,
      externalReference: 'UUID-REFERENCE-OTHER',
      occurredOn: '2025-02-02',
      amount: sypStr(200),
    }))).statusCode).toBe(201)

    const collision = await post({ ...source, idempotencyKey: spentUuid })
    expect(collision.statusCode).toBe(409)
    expect(collision.json().error).toBe('idempotency_key_conflict')
  })

  it('serializes concurrent source and reversal requests without duplicating journal facts', async () => {
    const sourceReference = 'CONCURRENT-SOURCE-1'
    const source = historical({
      externalReference: sourceReference,
      occurredOn: '2025-04-01',
      amount: sypStr(70),
    })
    const [created, replayed] = await Promise.all([
      post(source),
      post({ ...source, idempotencyKey: crypto.randomUUID() }),
    ])

    expect([created.statusCode, replayed.statusCode].sort()).toEqual([200, 201])
    const original = [created, replayed].find((response) => response.statusCode === 201)!
    const duplicate = [created, replayed].find((response) => response.statusCode === 200)!
    const targetId = original.json().command.id as string
    expect(duplicate.json()).toMatchObject({ replayed: true, command: { id: targetId } })
    expect(h.deps.ledger.entries.filter((entry) => entry.externalReference === sourceReference)).toHaveLength(1)

    const reversal = {
      type: 'reversal',
      targetId,
      occurredOn: '2025-04-02',
      reason: 'the same paper row was submitted twice',
    }
    const [firstReversal, secondReversal] = await Promise.all([
      post({
        ...reversal,
        idempotencyKey: crypto.randomUUID(),
        externalReference: 'CONCURRENT-SOURCE-1-REV-A',
      }),
      post({
        ...reversal,
        idempotencyKey: crypto.randomUUID(),
        externalReference: 'CONCURRENT-SOURCE-1-REV-B',
      }),
    ])

    expect([firstReversal.statusCode, secondReversal.statusCode].sort()).toEqual([201, 409])
    const rejected = [firstReversal, secondReversal].find((response) => response.statusCode === 409)!
    expect(rejected.json().error).toBe('company_command_already_reversed')
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'company_correction')).toHaveLength(1)
    expect((await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).filter((command) => command.kind === 'reversal'))
      .toHaveLength(1)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
  })

  it('enforces the zero opening balance and chronological input under the HQ transaction lock', async () => {
    const ordinary = await h.app.inject({
      method: 'POST', url: '/company/deposits', headers: { cookie: h.cookie(gm) },
      payload: { idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: '1.00', reason: 'ordinary HQ cash' },
    })
    expect(ordinary.statusCode, ordinary.body).toBe(201)
    const blocked = await post(historical({ externalReference: 'MUST-START-ZERO' }))
    expect(blocked.statusCode).toBe(422)
    expect(blocked.json().error).toBe('historical_opening_balance_nonzero')

    const clean = await makeHarness()
    const cleanGm = await clean.loginAs('gm')
    const first = await clean.app.inject({
      method: 'POST', url: '/company/historical-movements', headers: { cookie: clean.cookie(cleanGm) },
      payload: historical({ externalReference: 'ORDER-FIRST', occurredOn: '2025-03-10' }),
    })
    expect(first.statusCode, first.body).toBe(201)
    const outOfOrder = await clean.app.inject({
      method: 'POST', url: '/company/historical-movements', headers: { cookie: clean.cookie(cleanGm) },
      payload: historical({ externalReference: 'ORDER-BEFORE', occurredOn: '2025-03-09' }),
    })
    expect(outOfOrder.statusCode).toBe(422)
    expect(outOfOrder.json().error).toBe('historical_movement_out_of_order')
    await clean.app.close()
  })

  it('reverses only historical facts using a new audit reference and exposes filterable append-only history', async () => {
    const original = await post(historical({ externalReference: 'SOURCE-1', amount: sypStr(50), occurredOn: '2025-03-01' }))
    expect(original.statusCode).toBe(201)
    const targetId = original.json().command.id as string
    const reversal = await post({
      idempotencyKey: crypto.randomUUID(),
      externalReference: 'SOURCE-1-REVERSAL',
      type: 'reversal',
      targetId,
      occurredOn: '2025-03-02',
      reason: 'paper row was duplicated',
    })
    expect(reversal.statusCode, reversal.body).toBe(201)
    expect(reversal.json()).toMatchObject({
      command: { kind: 'reversal', targetId, occurredOn: '2025-03-02', businessDate: '2026-07-21' },
      pockets: { SYP_NEW: '0.00', USD: '0.00' },
    })

    const doubleReverse = await post({
      idempotencyKey: crypto.randomUUID(),
      externalReference: 'SOURCE-1-REVERSAL-2',
      type: 'reversal',
      targetId,
      occurredOn: '2025-03-02',
      reason: 'second correction must fail',
    })
    expect(doubleReverse.statusCode).toBe(409)

    const filtered = await get('/company/historical-movements?from=2025-03-02&to=2025-03-02&type=reversal&externalReference=reversal')
    expect(filtered.statusCode, filtered.body).toBe(200)
    expect(filtered.json().movements).toHaveLength(1)
    expect(filtered.json().movements[0]).toMatchObject({
      entry: { externalReference: 'SOURCE-1-REVERSAL' },
      command: { kind: 'reversal', targetId, occurredOn: '2025-03-02' },
    })
  })

  it('rejects a future/too-old historical date and requires the rate for USD', async () => {
    const future = await post(historical({ occurredOn: '2026-07-22' }))
    expect(future.statusCode).toBe(422)
    const futureRegister = await get('/company/historical-movements?from=2026-07-22')
    expect(futureRegister.statusCode).toBe(422)
    expect(futureRegister.json().error).toBe('invalid_date_range')
    const tooOld = await post(historical({ occurredOn: '1999-12-31' }))
    expect(tooOld.statusCode).toBe(400)
    const invisibleReference = await post(historical({ externalReference: '\u200B' }))
    expect(invisibleReference.statusCode).toBe(400)
    const usdNoRate = await post(historical({ type: 'deposit', currency: 'USD', amount: '1.00' }))
    expect(usdNoRate.statusCode).toBe(400)
  })
})
