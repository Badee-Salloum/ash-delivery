import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The training samples — the fee's own pixels beside what the reader made of them.
 *
 * A day spent transcribing 25 screenshots by hand measurably made the classifier WORSE: averaged
 * prototypes dilute when the samples come from other phones. What it has never had is volume from
 * the phones actually in use, and that arrives free with every shift — the driver corrects, the
 * manager approves, and that figure is ground truth verified by two people.
 *
 * These pin the three decisions that make it safe to keep: only rows with pixels behind them, never
 * at the cost of a driver's order, and `refused` preserved as its own answer.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

/** A one-pixel PNG. Real strips are ~2 KB; the size is not what is under test. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function openShift(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  const open = await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  expect(open.statusCode, open.body).toBe(200)
  return id
}

describe('a real shift teaches the reader', () => {
  it('keeps a sample for a row OCR read, tagged «ocr»', async () => {
    const driver = await h.loginAs('driver1')
    const id = await openShift(driver, await h.loginAs('manager'))

    const res = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(235), source: 'ocr', feeOcr: sypStr(235), feeStrip: PNG,
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(h.deps.orders.ocrSamples).toHaveLength(1)
    expect(h.deps.orders.ocrSamples[0]!.source).toBe('ocr')
    expect(h.deps.orders.ocrSamples[0]!.bytes).toBeGreaterThan(0)
  })

  it('keeps a sample for a row the reader REFUSED — the example it learns most from', async () => {
    // A refusal is a hard glyph at real phone scale with a human's correction attached. It used to
    // arrive as `manual` with no baseline — indistinguishable from a fee typed from memory.
    const driver = await h.loginAs('driver1')
    const id = await openShift(driver, await h.loginAs('manager'))

    await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'A-2', payMode: 'cash', fee: sypStr(210), source: 'refused', feeStrip: PNG,
    })

    expect(h.deps.orders.ocrSamples[0]!.source).toBe('refused')
    // On the MONEY row it stays `manual`, which is the truth: a person typed that fee. Widening a
    // CHECK constraint on a money table to carry a research distinction would be the wrong trade.
    const orders = await h.deps.orders.listByShift(id)
    expect(orders[0]!.source).toBe('manual')
    expect(orders[0]!.feeOcr).toBeNull()
  })

  it('keeps NOTHING for a row typed with no screenshot behind it', async () => {
    const driver = await h.loginAs('driver1')
    const id = await openShift(driver, await h.loginAs('manager'))
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-3', payMode: 'cash', fee: sypStr(130) })
    expect(h.deps.orders.ocrSamples).toHaveLength(0)
  })

  it('still records the order when the strip is junk — a sample never costs a driver his shift', async () => {
    const driver = await h.loginAs('driver1')
    const id = await openShift(driver, await h.loginAs('manager'))

    const res = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'A-4', payMode: 'cash', fee: sypStr(170), source: 'ocr', feeOcr: sypStr(170), feeStrip: 'not-a-data-url',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(h.deps.orders.ocrSamples).toHaveLength(0)
    expect(await h.deps.orders.listByShift(id)).toHaveLength(1)
  })

  it('keeps one sample per order however often the close is re-submitted', async () => {
    const driver = await h.loginAs('driver1')
    const id = await openShift(driver, await h.loginAs('manager'))
    const order = { providerOrderNo: 'A-5', payMode: 'cash', fee: sypStr(120), source: 'ocr', feeOcr: sypStr(120), feeStrip: PNG }
    await put(driver, `/shifts/${id}/operations`, { orders: [order], movements: [] })
    await put(driver, `/shifts/${id}/operations`, { orders: [order], movements: [] })
    expect(h.deps.orders.ocrSamples).toHaveLength(1)
  })
})
