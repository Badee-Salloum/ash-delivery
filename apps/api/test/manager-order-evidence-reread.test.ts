import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptedOcrReader } from '@ash/adapters/memory'
import {
  DRIVER_ID,
  type Harness,
  TINY_JPEG,
  VEHICLE_ID,
  makeHarness,
  sypStr,
  today,
} from './harness.ts'

let h: Harness
let reader: ScriptedOcrReader

afterEach(async () => {
  if (h) await h.app.close()
})

const post = async (
  token: string,
  url: string,
  payload: Record<string, unknown> = {},
  consensus = true,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: h.cookie(token),
      ...(consensus ? { 'x-ash-orders-time-consensus': 'v1' } : {}),
    },
    payload,
  })

const put = async (
  token: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

async function pendingReviewShift(driver: string, manager: string): Promise<string> {
  const created = await post(
    driver,
    '/shifts',
    { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    false,
  )
  const shiftId = created.json().id as string
  await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
  await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${shiftId}/approve-open`, { floatTranches: [sypStr(100)], topupTranches: [] }, false)

  await put(driver, `/shifts/${shiftId}/operations`, {
    orders: [
      {
        providerOrderNo: 'order-7',
        payMode: 'cash',
        fee: '155.00',
        // The cloud reader saw this dashboard row but refused its value/time. The driver supplied
        // the value; the money table consequently stores `manual`, while the selected dashboard
        // evidence remains the legitimate source for a manager retry.
        source: 'refused',
        feeOcr: null,
        occurredDate: today,
        occurredMinute: '11:30',
        pointA: 'Pickup seven',
        pointB: 'Dropoff seven',
      },
    ],
    cashDeductions: [
      {
        operationKey: 'recent-orders:deduction-1',
        amount: '50.00',
        source: 'refused',
        amountOcr: null,
        occurredDate: today,
        occurredMinute: '10:00',
        pointA: 'Deduction pickup',
        pointB: 'Deduction dropoff',
      },
    ],
    movements: [],
  })
  await h.uploadPhoto(driver, shiftId, 'end', 'dashboard')
  await h.uploadPhoto(driver, shiftId, 'end', 'wallet')
  await h.uploadPhoto(driver, shiftId, 'end', 'odometer')
  const submitted = await put(driver, `/shifts/${shiftId}/end-package`, {
    odometerKm: 101,
    batteryPercent: 20,
    cashDeclared: '100.00',
    walletDeclared: '0.00',
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  expect(submitted.json().state).toBe('pending_review')
  return shiftId
}

const body = (slot = 'dashboard') => ({
  package: 'end',
  slot,
  target: { kind: 'order' as const, providerOrderNo: 'order-7' },
  reason: 'Verify the printed midnight time from the stored page',
})

beforeEach(async () => {
  reader = new ScriptedOcrReader([
    {
      ok: true,
      rows: [
        {
          printed: '155 SYP',
          value: '155.00',
          cancelled: false,
          time: '00:03',
          dateIso: today,
          pointA: 'Pickup six',
          pointB: 'Dropoff six',
        },
        {
          printed: '155 SYP',
          value: '155.00',
          cancelled: false,
          time: '00:30',
          dateIso: today,
          pointA: 'Pickup seven',
          pointB: 'Dropoff seven',
        },
      ],
      fields: {},
      raw: null,
    },
  ])
  h = await makeHarness({ ocr: reader })
})

describe('manager re-read of stored Recent Orders evidence', () => {
  it('returns the complete selected page as suggestions without changing the target operation', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await pendingReviewShift(driver, manager)
    const before = await h.deps.orders.listByShift(shiftId)
    expect(before[0]?.source).toBe('manual')

    const response = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      body(),
    )

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      cached: false,
      evidence: { package: 'end', slot: 'dashboard' },
      target: { kind: 'order', providerOrderNo: 'order-7', provenanceLinked: false },
      rows: [
        { value: '155.00', time: '00:03', dateIso: today },
        { value: '155.00', time: '00:30', dateIso: today },
      ],
    })
    expect(response.json().reviewedOrdersHash).toEqual(expect.any(String))
    expect(response.json().settlementHash).toEqual(expect.any(String))
    expect(reader.calls).toBe(1)

    const after = await h.deps.orders.listByShift(shiftId)
    expect(after).toEqual(before)
    expect(after[0]?.occurredMinute).toBe('11:30')

    const audit = h.deps.audit.rows.find(
      (row) => row.tableName === 'shift_order_evidence_rereads' && row.recordId === shiftId,
    )
    expect(audit).toMatchObject({
      actorId: 'u-bm',
      action: 'INSERT',
      branchId: 'branch-damascus',
      after: {
        decision: 'reread_stored_orders_evidence',
        slot: 'dashboard',
        target: { kind: 'order', providerOrderNo: 'order-7', provenanceLinked: false },
        result: 'suggestions_returned',
      },
    })
  })

  it('accepts an OCR cash-deduction target as audit context without changing it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await pendingReviewShift(driver, manager)
    const [deduction] = await h.deps.cashDeductions.listByShift(shiftId)
    expect(deduction).toBeDefined()
    expect(deduction!.source).toBe('manual')
    const before = { ...deduction! }

    const response = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      {
        package: 'end',
        slot: 'dashboard',
        target: {
          kind: 'cash_deduction',
          id: deduction!.id,
          operationKey: deduction!.operationKey,
        },
        reason: 'Verify the deduction printed time from the stored page',
      },
    )

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().target).toEqual({
      kind: 'cash_deduction',
      id: deduction!.id,
      operationKey: deduction!.operationKey,
      provenanceLinked: false,
    })
    expect(await h.deps.cashDeductions.findByOperationKey(shiftId, deduction!.operationKey)).toEqual(before)
    expect(h.deps.audit.rows.at(-1)?.after).toMatchObject({
      target: {
        kind: 'cash_deduction',
        id: deduction!.id,
        operationKey: deduction!.operationKey,
        provenanceLinked: false,
      },
    })
  })

  it('returns failed reads honestly and never bypasses the two-attempt cache cap', async () => {
    await h.app.close()
    reader = new ScriptedOcrReader([
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'refused' },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await pendingReviewShift(driver, manager)

    const first = await post(manager, `/shifts/${shiftId}/ocr/orders/evidence-reread`, body())
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ ok: false, reason: 'no_fields', cached: false, retryable: true })

    const second = await post(manager, `/shifts/${shiftId}/ocr/orders/evidence-reread`, body())
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({ ok: false, reason: 'refused', cached: false, retryable: false })

    const capped = await post(manager, `/shifts/${shiftId}/ocr/orders/evidence-reread`, body())
    expect(capped.statusCode, capped.body).toBe(200)
    expect(capped.json()).toMatchObject({ ok: false, reason: 'refused', cached: true, retryable: false })
    expect(reader.calls).toBe(2)
    expect(
      h.deps.audit.rows.filter(
        (row) => row.tableName === 'shift_order_evidence_rereads' && row.recordId === shiftId,
      ),
    ).toHaveLength(3)
  })

  it('refuses stale manager clients before spending an OCR attempt', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await pendingReviewShift(driver, manager)

    const response = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      body(),
      false,
    )

    expect(response.statusCode).toBe(428)
    expect(response.json().error).toBe('manager_update_required')
    expect(reader.calls).toBe(0)
  })

  it('requires the manager branch, pending-review state, a stored dashboard slot and a real order', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const otherManager = await h.loginAs('manager2')

    const openCreated = await post(
      driver,
      '/shifts',
      { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
      false,
    )
    const openShiftId = openCreated.json().id as string
    expect(
      (await post(manager, `/shifts/${openShiftId}/ocr/orders/evidence-reread`, body())).json().error,
    ).toBe('shift_not_under_review')
    expect(reader.calls).toBe(0)
    const cancelled = await h.app.inject({
      method: 'DELETE',
      url: `/shifts/${openShiftId}/mine`,
      headers: { cookie: h.cookie(driver) },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)

    const shiftId = await pendingReviewShift(driver, manager)
    const foreign = await post(otherManager, `/shifts/${shiftId}/ocr/orders/evidence-reread`, body())
    expect(foreign.statusCode).toBe(403)

    const wrongScreen = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      body('wallet'),
    )
    expect(wrongScreen.statusCode).toBe(422)
    expect(wrongScreen.json().error).toBe('evidence_not_orders_screen')

    const missingSlot = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      body('dashboard_2'),
    )
    expect(missingSlot.statusCode).toBe(404)
    expect(missingSlot.json().error).toBe('evidence_slot_empty')

    const missingOrder = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      { ...body(), target: { kind: 'order', providerOrderNo: 'missing-order' } },
    )
    expect(missingOrder.statusCode).toBe(404)
    expect(missingOrder.json().error).toBe('order_not_found')

    const manual = await post(
      manager,
      `/shifts/${shiftId}/orders/manual`,
      {
        providerOrderNo: 'manager-manual-order',
        payMode: 'cash',
        fee: '100.00',
        kind: 'manual',
        driverShare: '40.00',
        companyShare: '60.00',
        points: [
          { role: 'start', label: 'Branch pickup', lat: null, lng: null },
          { role: 'end', label: 'Manual dropoff', lat: null, lng: null },
        ],
      },
      false,
    )
    expect(manual.statusCode, manual.body).toBe(201)
    const manualReread = await post(
      manager,
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      { ...body(), target: { kind: 'order', providerOrderNo: 'manager-manual-order' } },
    )
    expect(manualReread.statusCode).toBe(422)
    expect(manualReread.json().error).toBe('operation_has_no_ocr_evidence')
    expect(reader.calls).toBe(0)
  })
})
