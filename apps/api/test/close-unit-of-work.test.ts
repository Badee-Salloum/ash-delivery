import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { postingsForOpen } from '@ash/domain'
import {
  BRANCH,
  DRIVER_ID,
  type Harness,
  NOW_MS,
  VEHICLE_ID,
  approveFixedClose,
  fixedApprovalPayload,
  makeHarness,
  syp,
  sypStr,
} from './harness.ts'

type Payload = Record<string, unknown>

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (harness: Harness, token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await harness.app.inject({ method: 'POST', url, headers: { cookie: harness.cookie(token) }, payload })
const put = async (harness: Harness, token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await harness.submitEndPackage(token, url.split('/')[2]!, payload)
    : await harness.app.inject({ method: 'PUT', url, headers: { cookie: harness.cookie(token) }, payload })
const del = async (harness: Harness, token: string, url: string): Promise<LightMyRequestResponse> =>
  await harness.app.inject({ method: 'DELETE', url, headers: { cookie: harness.cookie(token) } })
const get = async (harness: Harness, token: string, url: string): Promise<LightMyRequestResponse> =>
  await harness.app.inject({ method: 'GET', url, headers: { cookie: harness.cookie(token) } })

function latch(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function awaitingOpen(harness: Harness, driver: string, vehicleId = VEHICLE_ID): Promise<string> {
  const created = await post(harness, driver, '/shifts', { driverId: DRIVER_ID, vehicleId })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await harness.uploadPhoto(driver, id, 'start', 'odometer')
  const submitted = await put(harness, driver, `/shifts/${id}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  return id
}

async function openShift(harness: Harness, driver: string, manager: string, vehicleId = VEHICLE_ID): Promise<string> {
  const id = await awaitingOpen(harness, driver, vehicleId)
  const opened = await post(harness, manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  expect(opened.statusCode, opened.body).toBe(200)
  return id
}

async function pendingReview(
  harness: Harness,
  driver: string,
  manager: string,
  prefix: string,
  orderCount = 1,
): Promise<string> {
  const id = await openShift(harness, driver, manager)
  harness.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: Array.from({ length: orderCount }, (_, index) => ({
      clientKey: `close-uow-${prefix}-${index + 1}`,
      providerOrderNo: `${prefix}-${index + 1}`,
      payMode: 'cash',
      fee: sypStr(5_000),
      occurredDate: '2026-07-21',
      occurredMinute: `08:${String(index + 1).padStart(2, '0')}`,
    })),
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await harness.uploadPhoto(driver, id, 'end', slot)
  harness.deps.clock.set(NOW_MS + 4 * 60 * 60_000)
  const ended = await put(harness, driver, `/shifts/${id}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: 50,
    cashDeclared: sypStr(100_000 + orderCount * 5_000),
    walletDeclared: sypStr(50_000 - orderCount * 1_000),
  })
  expect(ended.statusCode, ended.body).toBe(200)
  expect(ended.json().br1.difference).toBe(sypStr(0))
  return id
}

async function reviewedHash(harness: Harness, manager: string, shiftId: string): Promise<string> {
  const review = await get(harness, manager, `/shifts/${shiftId}/review`)
  expect(review.statusCode, review.body).toBe(200)
  return review.json().br1.ordersHash as string
}

describe('close unit-of-work rollback', () => {
  it('rolls back close journal, shift state, and decision after a late injected failure', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(h, driver, manager, 'ROLLBACK-CLOSE')
    const hash = await reviewedHash(h, manager, id)
    const approvalPayload = await fixedApprovalPayload(h, manager, id, hash)
    const beforeShift = await h.deps.shifts.findById(id)
    const beforeLedger = await h.deps.ledger.listByShift(id)
    const beforeDecisions = await h.deps.decisions.listByShift(id)

    const originalRecord = h.deps.decisions.record
    h.deps.decisions.record = async (decision) => {
      await originalRecord.call(h.deps.decisions, decision)
      throw new Error('injected after close decision insert')
    }
    try {
      const failed = await post(h, manager, `/shifts/${id}/approve-close`, approvalPayload)
      expect(failed.statusCode, failed.body).toBe(500)
    } finally {
      h.deps.decisions.record = originalRecord
    }

    expect(await h.deps.shifts.findById(id)).toEqual(beforeShift)
    expect(await h.deps.ledger.listByShift(id)).toEqual(beforeLedger)
    expect(await h.deps.decisions.listByShift(id)).toEqual(beforeDecisions)
    expect(await h.deps.settlements.findByShift(id)).toBeNull()
  })

  it('rolls back approve-open money, state, decision, and FX state', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await awaitingOpen(h, driver)
    const before = await h.deps.shifts.findById(id)
    const beforeFx = await h.deps.fx.list()

    const originalRecord = h.deps.decisions.record
    h.deps.decisions.record = async (decision) => {
      await originalRecord.call(h.deps.decisions, decision)
      throw new Error('injected after open decision insert')
    }
    try {
      const failed = await post(h, manager, `/shifts/${id}/approve-open`, {
        floatTranches: [sypStr(100_000)],
        topupTranches: [sypStr(50_000)],
      })
      expect(failed.statusCode, failed.body).toBe(500)
    } finally {
      h.deps.decisions.record = originalRecord
    }

    expect(await h.deps.shifts.findById(id)).toEqual(before)
    expect(await h.deps.ledger.listByShift(id)).toEqual([])
    expect(await h.deps.decisions.listByShift(id)).toEqual([])
    expect(await h.deps.fx.list()).toEqual(beforeFx)
  })

  it('rolls back the close boundary and every row classification after a mid-reclassification failure', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(h, driver, manager)
    const operations = await put(h, driver, `/shifts/${id}/operations`, {
      orders: [{
        providerOrderNo: 'ROLLBACK-ORDER',
        payMode: 'cash',
        fee: sypStr(5_000),
        occurredDate: '2026-07-21',
        occurredMinute: '08:01',
      }],
      cashDeductions: [{
        operationKey: 'ROLLBACK-DEDUCTION',
        amount: sypStr(100),
        occurredDate: '2026-07-21',
        occurredMinute: '08:02',
        source: 'ocr',
        amountOcr: sypStr(100),
      }],
      movements: [],
    })
    expect(operations.statusCode, operations.body).toBe(200)
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    const beforeShift = await h.deps.shifts.findById(id)
    const beforeOrders = await h.deps.orders.listByShift(id)
    const beforeDeductions = await h.deps.cashDeductions.listByShift(id)
    expect(beforeOrders[0]?.windowStatus).toBe('in_window')
    expect(beforeDeductions[0]?.windowStatus).toBe('in_window')

    h.deps.clock.set(NOW_MS + 30_000)
    const originalUpdate = h.deps.cashDeductions.update
    h.deps.cashDeductions.update = async (deduction, actorId) => {
      await originalUpdate.call(h.deps.cashDeductions, deduction, actorId)
      throw new Error('injected after deduction reclassification')
    }
    try {
      const failed = await put(h, driver, `/shifts/${id}/end-package`, {
        odometerKm: 1_040,
        batteryPercent: 50,
        cashDeclared: sypStr(0),
        walletDeclared: sypStr(0),
      })
      expect(failed.statusCode, failed.body).toBe(500)
    } finally {
      h.deps.cashDeductions.update = originalUpdate
    }

    expect(await h.deps.shifts.findById(id)).toEqual(beforeShift)
    expect(await h.deps.orders.listByShift(id)).toEqual(beforeOrders)
    expect(await h.deps.cashDeductions.listByShift(id)).toEqual(beforeDeductions)
  })
})

describe('close unit-of-work concurrency', () => {
  it('makes waiting manager revisions and rephoto requests observe the committed approval', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(h, driver, manager, 'WAITING')
    const hash = await reviewedHash(h, manager, id)
    const approvalPayload = await fixedApprovalPayload(h, manager, id, hash)
    const enteredLedger = latch()
    const releaseLedger = latch()
    const competingRuns = latch()
    let runCount = 0
    let competitorCount = 0

    const originalRun = h.deps.closeUnitOfWork.run.bind(h.deps.closeUnitOfWork)
    h.deps.closeUnitOfWork.run = async (input, work) => {
      runCount += 1
      if (runCount > 1) {
        competitorCount += 1
        if (competitorCount === 2) competingRuns.release()
      }
      return originalRun(input, work)
    }
    const originalPost = h.deps.ledger.post
    let holdFirstPost = true
    h.deps.ledger.post = async (branchId, postings, meta) => {
      if (holdFirstPost) {
        holdFirstPost = false
        enteredLedger.release()
        await releaseLedger.promise
      }
      return originalPost.call(h.deps.ledger, branchId, postings, meta)
    }

    try {
      const approval = post(h, manager, `/shifts/${id}/approve-close`, approvalPayload)
      await enteredLedger.promise
      let revisionFinished = false
      let rephotoFinished = false
      const revision = post(h, manager, `/shifts/${id}/operations/revise`, {
        orders: [{ providerOrderNo: 'WAITING-1', fee: sypStr(6_000) }],
      }).then((response) => {
        revisionFinished = true
        return response
      })
      const rephoto = post(h, manager, `/shifts/${id}/request-rephoto`, { notes: 'late request' }).then((response) => {
        rephotoFinished = true
        return response
      })
      await competingRuns.promise
      expect(revisionFinished).toBe(false)
      expect(rephotoFinished).toBe(false)
      releaseLedger.release()

      const [approved, revised, rephotoed] = await Promise.all([approval, revision, rephoto])
      expect(approved.statusCode, approved.body).toBe(200)
      expect(revised.statusCode, revised.body).toBe(409)
      expect(rephotoed.statusCode, rephotoed.body).not.toBe(200)
    } finally {
      releaseLedger.release()
      h.deps.ledger.post = originalPost
      h.deps.closeUnitOfWork.run = originalRun
    }

    expect((await h.deps.shifts.findById(id))?.state).toBe('approved')
    expect((await h.deps.orders.findByProviderNo('WAITING-1'))?.fee).toBe(500_000n)
    const closeDecisions = (await h.deps.decisions.listByShift(id)).filter((decision) => decision.gate === 'close')
    expect(closeDecisions).toHaveLength(1)
    expect(closeDecisions[0]?.decision).toBe('approved')
  })
})

async function clonePendingShift(harness: Harness, firstId: string, prefix: string): Promise<string> {
  const first = await harness.deps.shifts.findById(firstId)
  if (!first) throw new Error('missing source shift')
  const secondId = `${firstId}-same-day-2`
  await harness.deps.shifts.create({
    ...first,
    id: secondId,
    vehicleId: 'vehicle-2',
    shiftNo: 2,
    approvedBy: null,
    approvedAt: null,
  }, 'u-d1')

  const sourceOrders = await harness.deps.orders.listByShift(firstId)
  for (const [index, order] of sourceOrders.entries()) {
    await harness.deps.orders.create({
      ...order,
      id: `${secondId}-order-${index + 1}`,
      shiftId: secondId,
      providerOrderNo: `${prefix}-${index + 1}`,
    }, 'u-d1')
  }

  for (const slot of (await harness.deps.media.listSlots(firstId)).filter((row) => row.package === 'end')) {
    await harness.deps.media.attach(secondId, 'end', slot.slot, slot.mediaId, {
      actorId: 'u-d1',
      attachedAtMs: harness.deps.clock.nowMs(),
      reusedFromShiftId: firstId,
    })
    const attached = (await harness.deps.media.listSlots(secondId)).find((row) => row.slot === slot.slot)
    if (!attached) throw new Error(`missing cloned ${slot.slot} evidence`)
    await harness.deps.media.acknowledgeStale(
      secondId,
      'end',
      slot.slot,
      attached.mediaId,
      attached.attachmentToken,
      'u-d1',
      harness.deps.clock.nowMs(),
    )
  }

  const fxDayId = await harness.deps.fx.idFor(first.businessDate)
  if (fxDayId === null) throw new Error('missing open FX day')
  await harness.deps.ledger.post(first.branchId, postingsForOpen({
    driverId: first.driverId,
    floatTranches: first.floatTranches,
    carriedTranches: first.carriedTranches,
    topupTranches: first.topupTranches,
    orders: [],
  }), {
    shiftId: secondId,
    businessDate: first.businessDate,
    postingDate: first.businessDate,
    weekStartDate: first.weekStartDate,
    fxDayId,
    createdBy: 'u-bm',
  })
  return secondId
}

async function prepareSameDayPair(harness: Harness): Promise<{ manager: string; ids: [string, string]; hashes: [string, string] }> {
  const driver = await harness.loginAs('driver1')
  const manager = await harness.loginAs('manager')
  const first = await pendingReview(harness, driver, manager, 'PAIR-A', 10)
  const second = await clonePendingShift(harness, first, 'PAIR-B')
  return {
    manager,
    ids: [first, second],
    hashes: [await reviewedHash(harness, manager, first), await reviewedHash(harness, manager, second)],
  }
}

async function tierBalances(harness: Harness): Promise<Record<string, bigint>> {
  const codes = [
    fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }),
    'company_revenue',
    'yalago_income',
    'fee_earned',
  ]
  return Object.fromEntries(await Promise.all(codes.map(async (code) => [code, await harness.deps.ledger.fundBalance(BRANCH, code)])))
}

describe('same-driver/day fixed-share approvals', () => {
  it('produces the same final ledger concurrently without a day-level true-up lock', async () => {
    const sequential = await makeHarness()
    try {
      const baseline = await prepareSameDayPair(sequential)
      for (let index = 0; index < baseline.ids.length; index += 1) {
        const approved = await approveFixedClose(
          sequential,
          baseline.manager,
          baseline.ids[index]!,
          baseline.hashes[index]!,
        )
        expect(approved.statusCode, approved.body).toBe(200)
      }
      const expected = await tierBalances(sequential)

      const concurrent = await prepareSameDayPair(h)
      const approvalPayloads = await Promise.all([
        fixedApprovalPayload(h, concurrent.manager, concurrent.ids[0], concurrent.hashes[0]),
        fixedApprovalPayload(h, concurrent.manager, concurrent.ids[1], concurrent.hashes[1]),
      ])
      const enteredLedger = latch()
      const releaseLedger = latch()
      const originalPost = h.deps.ledger.post
      let holdFirstPost = true
      h.deps.ledger.post = async (branchId, postings, meta) => {
        if (holdFirstPost) {
          holdFirstPost = false
          enteredLedger.release()
          await releaseLedger.promise
        }
        return originalPost.call(h.deps.ledger, branchId, postings, meta)
      }
      const originalRun = h.deps.closeUnitOfWork.run.bind(h.deps.closeUnitOfWork)
      let serializedApprovals = 0
      h.deps.closeUnitOfWork.run = async (input, work) => {
        if (input.serializeDriverDay) serializedApprovals += 1
        return originalRun(input, work)
      }
      try {
        const first = post(h, concurrent.manager, `/shifts/${concurrent.ids[0]}/approve-close`, approvalPayloads[0])
        await enteredLedger.promise
        const second = post(h, concurrent.manager, `/shifts/${concurrent.ids[1]}/approve-close`, approvalPayloads[1])
        releaseLedger.release()
        const responses = await Promise.all([first, second])
        expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
      } finally {
        releaseLedger.release()
        h.deps.ledger.post = originalPost
        h.deps.closeUnitOfWork.run = originalRun
      }

      expect(serializedApprovals).toBe(0)
      expect(await tierBalances(h)).toEqual(expected)
      expect(expected[fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID })]).toBe(0n)
      expect(expected.company_revenue).toBe(-4_000_000n)
      expect(expected.yalago_income).toBe(-2_000_000n)
      expect(expected.fee_earned).toBe(0n)
    } finally {
      await sequential.app.close()
    }
  })
})

describe('operations that share the shift transaction boundary', () => {
  it('does not let a standalone order land after end submission owns the close unit of work', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(h, driver, manager)
    const initialOrder = await post(h, driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'BEFORE-CLOSE',
      payMode: 'cash',
      fee: sypStr(5_000),
      zone: null,
    })
    expect(initialOrder.statusCode, initialOrder.body).toBe(201)
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)

    const closeReachedClaim = latch()
    const releaseClose = latch()
    const competingPathStarted = latch()
    const originalRun = h.deps.closeUnitOfWork.run.bind(h.deps.closeUnitOfWork)
    const originalShiftUpdate = h.deps.shifts.update
    const originalOrderCreate = h.deps.orders.create
    let runCount = 0
    let heldClaim = false

    h.deps.closeUnitOfWork.run = async (input, work) => {
      runCount += 1
      if (runCount === 2) competingPathStarted.release()
      return originalRun(input, work)
    }
    h.deps.shifts.update = async (shift, actorId) => {
      if (!heldClaim && shift.id === id && shift.state === 'pending_review') {
        heldClaim = true
        closeReachedClaim.release()
        await releaseClose.promise
      }
      return originalShiftUpdate.call(h.deps.shifts, shift, actorId)
    }
    h.deps.orders.create = async (order, actorId) => {
      if (order.providerOrderNo === 'LATE-AFTER-CLOSE') competingPathStarted.release()
      return originalOrderCreate.call(h.deps.orders, order, actorId)
    }

    try {
      const closing = put(h, driver, `/shifts/${id}/end-package`, {
        odometerKm: 1_040,
        batteryPercent: 50,
        cashDeclared: sypStr(105_000),
        walletDeclared: sypStr(49_000),
      })
      await closeReachedClaim.promise

      const lateOrder = post(h, driver, `/shifts/${id}/orders`, {
        providerOrderNo: 'LATE-AFTER-CLOSE',
        payMode: 'cash',
        fee: sypStr(5_000),
        zone: null,
      })
      // In the fixed path this is the queued UoW invocation. In the old path it is the escaped
      // repository create. Either signal proves the competing request has reached the boundary.
      await competingPathStarted.promise
      releaseClose.release()

      const [closed, added] = await Promise.all([closing, lateOrder])
      expect(closed.statusCode, closed.body).toBe(200)
      expect(added.statusCode, added.body).toBe(409)
      expect(added.json().error).toBe('shift_not_open')
    } finally {
      releaseClose.release()
      h.deps.orders.create = originalOrderCreate
      h.deps.shifts.update = originalShiftUpdate
      h.deps.closeUnitOfWork.run = originalRun
    }

    expect((await h.deps.shifts.findById(id))?.state).toBe('pending_review')
    expect(await h.deps.orders.findByProviderNo('LATE-AFTER-CLOSE')).toBeNull()
  })

  it('does not let a stale cancellation delete a shift after approve-open commits', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await awaitingOpen(h, driver)

    const approvalReachedLedger = latch()
    const releaseApproval = latch()
    const competingPathStarted = latch()
    const releaseDelete = latch()
    const originalRun = h.deps.closeUnitOfWork.run.bind(h.deps.closeUnitOfWork)
    const originalLedgerPost = h.deps.ledger.post
    const originalDelete = h.deps.shifts.delete
    let runCount = 0
    let heldLedger = false

    h.deps.closeUnitOfWork.run = async (input, work) => {
      runCount += 1
      if (runCount === 2) competingPathStarted.release()
      return originalRun(input, work)
    }
    h.deps.ledger.post = async (branchId, postings, meta) => {
      if (!heldLedger) {
        heldLedger = true
        approvalReachedLedger.release()
        await releaseApproval.promise
      }
      return originalLedgerPost.call(h.deps.ledger, branchId, postings, meta)
    }
    h.deps.shifts.delete = async (shiftId, actorId) => {
      if (shiftId === id) {
        // The vulnerable path gets here after its stale awaiting-open read. Hold the actual delete
        // until approval commits, exactly matching the PostgreSQL wait on the shift row.
        competingPathStarted.release()
        await releaseDelete.promise
      }
      return originalDelete.call(h.deps.shifts, shiftId, actorId)
    }

    try {
      const approval = post(h, manager, `/shifts/${id}/approve-open`, {
        floatTranches: [],
        topupTranches: [],
      })
      await approvalReachedLedger.promise

      const cancellation = del(h, manager, `/shifts/${id}`)
      await competingPathStarted.promise
      releaseApproval.release()
      const approved = await approval
      expect(approved.statusCode, approved.body).toBe(200)
      releaseDelete.release()

      const cancelled = await cancellation
      expect(cancelled.statusCode, cancelled.body).toBe(409)
      expect(cancelled.json().error).toBe('shift_already_opened')
    } finally {
      releaseApproval.release()
      releaseDelete.release()
      h.deps.shifts.delete = originalDelete
      h.deps.ledger.post = originalLedgerPost
      h.deps.closeUnitOfWork.run = originalRun
    }

    expect((await h.deps.shifts.findById(id))?.state).toBe('open')
    expect((await h.deps.decisions.listByShift(id)).filter((row) => row.gate === 'open')).toHaveLength(1)
  })
})

describe('legacy standalone negative orders', () => {
  it('upserts one positive cash deduction while preserving the first persisted operation time', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(h, driver, manager)

    const first = await post(h, driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'LEGACY-DEDUCTION-1',
      payMode: 'cash',
      fee: sypStr(-125),
      feeOcr: sypStr(-130),
      source: 'ocr',
      occurredMinute: '08:15',
      zone: null,
    })
    expect(first.statusCode, first.body).toBe(201)
    expect(await h.deps.orders.findByProviderNo('LEGACY-DEDUCTION-1')).toBeNull()

    const inserted = await h.deps.cashDeductions.listByShift(id)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      operationKey: 'legacy:LEGACY-DEDUCTION-1',
      amount: syp(125),
      amountOcr: syp(130),
      occurredDate: '2026-07-21',
      occurredMinute: '08:15',
      source: 'ocr',
      windowStatus: 'in_window',
      included: true,
    })
    const originalId = inserted[0]!.id

    const retry = await post(h, driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'LEGACY-DEDUCTION-1',
      payMode: 'cash',
      fee: sypStr(-250),
      feeOcr: sypStr(-255),
      source: 'ocr',
      occurredMinute: '07:59',
      zone: null,
    })
    expect(retry.statusCode, retry.body).toBe(201)

    const updated = await h.deps.cashDeductions.listByShift(id)
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      id: originalId,
      operationKey: 'legacy:LEGACY-DEDUCTION-1',
      amount: syp(250),
      amountOcr: syp(255),
      occurredDate: '2026-07-21',
      // A retry may refresh the amount/OCR evidence, but changing the persisted printed time is a
      // manager decision requiring a reason. This also prevents a cached driver page from moving
      // a row out of the shift window after the first successful submission.
      occurredMinute: '08:15',
      windowStatus: 'in_window',
      included: true,
    })
    expect(await h.deps.orders.findByProviderNo('LEGACY-DEDUCTION-1')).toBeNull()
  })
})

describe('battery swap transaction rollback', () => {
  it('restores the swap event, readings, and both battery fitments after a late memory failure', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const outgoingId = (await post(h, manager, '/batteries', {
      capacityAh: 50,
      serialNo: 'ROLLBACK-OUT',
      vehicleId: VEHICLE_ID,
      slotNo: 1,
    })).json().id as string
    const incomingId = (await post(h, manager, '/batteries', {
      capacityAh: 50,
      serialNo: 'ROLLBACK-IN',
    })).json().id as string

    const created = await post(h, driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.uploadPhoto(driver, id, 'start', 'bms_1')
    const reading = await put(h, driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId: outgoingId, percent: 90, source: 'manual' }],
    })
    expect(reading.statusCode, reading.body).toBe(200)
    const submitted = await put(h, driver, `/shifts/${id}/start-package`, {
      odometerKm: 1_000,
      batteryPercent: 90,
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const opened = await post(h, manager, `/shifts/${id}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
    })
    expect(opened.statusCode, opened.body).toBe(200)

    const beforeSwaps = await h.deps.batterySwaps.listByShift(id)
    const beforeReadings = await h.deps.batteryReadings.listByShift(id)
    const beforeOutgoing = await h.deps.directory.battery(outgoingId)
    const beforeIncoming = await h.deps.directory.battery(incomingId)
    const beforeFitted = await h.deps.directory.listBatteriesForVehicle(VEHICLE_ID)

    const originalUpdateBattery = h.deps.directory.updateBattery
    let updateCount = 0
    h.deps.directory.updateBattery = async (battery) => {
      updateCount += 1
      await originalUpdateBattery.call(h.deps.directory, battery)
      if (updateCount === 2) throw new Error('injected after incoming battery fitment')
    }
    try {
      const failed = await post(h, driver, `/shifts/${id}/battery-swap`, {
        slotNo: 1,
        inBatteryId: incomingId,
        outReading: { percent: 18 },
        inReading: { percent: 96 },
      })
      expect(failed.statusCode, failed.body).toBe(500)
    } finally {
      h.deps.directory.updateBattery = originalUpdateBattery
    }

    expect(await h.deps.batterySwaps.listByShift(id)).toEqual(beforeSwaps)
    expect(await h.deps.batteryReadings.listByShift(id)).toEqual(beforeReadings)
    expect(await h.deps.directory.battery(outgoingId)).toEqual(beforeOutgoing)
    expect(await h.deps.directory.battery(incomingId)).toEqual(beforeIncoming)
    expect(await h.deps.directory.listBatteriesForVehicle(VEHICLE_ID)).toEqual(beforeFitted)
  })
})
