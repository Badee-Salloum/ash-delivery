import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr } from './harness.ts'

/**
 * Historical receivables remain collectible, but the fixed cash-close policy never creates a new
 * one. A carried balance can still fund a later shift and a void still restores it exactly.
 */
let h: Harness
let orderSeq = 0
beforeEach(async () => {
  h = await makeHarness()
  orderSeq = 0
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const receivable = async (): Promise<bigint> =>
  await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)

/** Seed an approved-history balance without pretending the new close policy can create it. */
async function seedHistoricalReceivable(manager: string, amount: number): Promise<void> {
  const response = await post(manager, '/journal/manual', {
    reason: 'migration fixture: approved historical receivable',
    lines: [
      { fundCode: `driver_receivable_cash:${DRIVER_ID}`, side: 'D', amount: sypStr(amount) },
      { fundCode: 'office_cash', side: 'C', amount: sypStr(amount) },
    ],
  })
  expect(response.statusCode, response.body).toBe(201)
}

async function openShift(
  driver: string,
  manager: string,
  input: { floatTranches?: string[]; carriedTranches?: string[] } = {},
): Promise<string> {
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  expect((await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })).statusCode).toBe(200)
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: input.floatTranches ?? [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
    carriedTranches: input.carriedTranches ?? [],
  })
  expect(opened.statusCode, opened.body).toBe(200)
  return id
}

async function submitBalanced(
  driver: string,
  id: string,
  cashAtOpen: number,
): Promise<{ managerHash: string }> {
  orderSeq += 1
  expect((await post(driver, `/shifts/${id}/orders`, {
    providerOrderNo: `R-${orderSeq}`,
    payMode: 'cash',
    fee: sypStr(5_000),
  })).statusCode).toBe(201)
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  const ended = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: null,
    cashDeclared: sypStr(cashAtOpen + 5_000),
    walletDeclared: sypStr(49_000),
  })
  expect(ended.statusCode, ended.body).toBe(200)
  expect(ended.json().br1.difference).toBe('0.00')
  const manager = await h.loginAs('manager')
  return { managerHash: (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string }
}

describe('approved-history receivables under the fixed close policy', () => {
  it('still lists an existing receivable and clears it when carried into a new shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedHistoricalReceivable(manager, 40_000)
    expect(await receivable()).toBe(4_000_000n)

    const list = (await get(manager, `/receivables?branchId=${BRANCH}`)).json()
    expect(list.total).toBe(sypStr(40_000))
    expect(list.drivers[0]).toMatchObject({ driverId: DRIVER_ID, cash: sypStr(40_000) })

    const id = await openShift(driver, manager, {
      floatTranches: [],
      carriedTranches: [sypStr(40_000)],
    })
    expect(await receivable()).toBe(0n)

    const { managerHash } = await submitBalanced(driver, id, 40_000)
    const approved = await approveFixedClose(h, manager, id, managerHash)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(await receivable()).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_wallet:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_share_payable:${DRIVER_ID}`)).toBe(0n)
  })

  it('restores a historical receivable if the shift which consumed it is voided', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedHistoricalReceivable(manager, 40_000)
    const boxBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')

    const id = await openShift(driver, manager, {
      floatTranches: [],
      carriedTranches: [sypStr(40_000)],
    })
    expect(await receivable()).toBe(0n)
    const voided = await post(manager, `/shifts/${id}/void`, { reason: 'shift cancelled' })
    expect(voided.statusCode, voided.body).toBe(200)
    expect(await receivable()).toBe(4_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(boxBefore)
  })

  it('refuses to carry more than the historical balance', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    const id = created.json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 1_000, batteryPercent: 90 })

    const response = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
      carriedTranches: [sypStr(40_000)],
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().error).toBe('carry_exceeds_receivable')
  })

  it('rejects every attempt to create a new receivable or defer the current share', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const { managerHash } = await submitBalanced(driver, id, 100_000)
    const settlement = await get(manager, `/shifts/${id}/settlement`)
    expect(settlement.statusCode, settlement.body).toBe(200)

    for (const legacy of [{ keepAsReceivable: sypStr(1) }, { payShareNow: false }]) {
      const response = await post(manager, `/shifts/${id}/approve-close`, {
        reviewedOrdersHash: managerHash,
        reviewedSettlementHash: settlement.json().settlementHash,
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
        ...legacy,
      })
      expect(response.statusCode, response.body).toBe(422)
      expect(response.json().error).toBe('fixed_cash_settlement_required')
    }
    expect(await receivable()).toBe(0n)
  })
})
