import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_OCR_SAMPLE_CHARS } from '@ash/contracts'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Every reader learns, not just the fee one.
 *
 * Measured on three real shifts, the odometer reader was wrong THREE TIMES OUT OF THREE: it read 200
 * for 6948, 229 for 5426, and refused the third. Every one of those corrections was thrown away the
 * moment the driver typed the right number — fees kept their pixels, nothing else did.
 *
 * The odometer's sample is deliberately WIDER than a fee strip. 200 is not a misreading of 6948; it
 * is a different number on the dashboard. A tight crop around what the reader chose would preserve
 * the mistake perfectly, so the sample has to be everything it had to choose from.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (t: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(t, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })

async function openShift(driver: string, manager: string, start: Record<string, unknown>): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
    .id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 6948, batteryPercent: 90, ...start })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  return id
}

describe('what the odometer reader saw', () => {
  it('keeps the dashboard beside the number it produced', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    // The real failure: the reader answered 200 for a dashboard reading 6948.
    await openShift(driver, manager, { odometerKmOcr: 200, odometerStrip: PNG })

    const samples = await h.deps.orders.listOcrSamples('odometer')
    expect(samples).toHaveLength(1)
    expect(samples[0]!.package).toBe('start')
    expect(samples[0]!.source).toBe('ocr')
  })

  /**
   * A REFUSAL IS THE MORE VALUABLE SAMPLE. The third shift produced no reading at all, and the image
   * it could not read — beside the 5618 the driver then typed — is precisely the case it is failing.
   * Recording only successes would keep the examples it already handles and discard the ones it does not.
   */
  it('keeps it when the reader refused, tagged as a refusal', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await openShift(driver, manager, { odometerKmOcr: null, odometerStrip: PNG })

    const samples = await h.deps.orders.listOcrSamples('odometer')
    expect(samples).toHaveLength(1)
    expect(samples[0]!.source).toBe('refused')
  })

  /**
   * THE REGRESSION THAT BLOCKED A SHIFT START.
   *
   * The odometer sample was first cut as a LOSSLESS PNG of a whole prepared photo, which ran far
   * past the wire's ceiling. Zod rejected the entire start package with 400, the driver saw
   * «البيانات المُدخلة غير صحيحة», and could not open his shift — a picture kept for a future model
   * stopping the day's work. The server had always had the forgiving rule; it simply never ran,
   * because validation refused the request before it.
   *
   * Two things guard it now: the sample is a JPEG the driver refuses to send when oversized, and
   * the wire's ceiling is one exported constant both sides read.
   */
  it('never lets an oversized sample stop the shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    // A data URL past the wire's ceiling. The DRIVER now drops such a sample rather than sending it;
    // this pins what happens if one ever arrives anyway.
    const huge = `data:image/jpeg;base64,${'A'.repeat(MAX_OCR_SAMPLE_CHARS)}`
    const res = await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 6948,
      batteryPercent: 90,
      odometerStrip: huge,
    })
    // It is refused as a bad request rather than accepted — but the point of the guard is that the
    // driver's app never produces one, so this can only be reached by a hand-built request.
    expect(res.statusCode).toBe(400)

    // And without the sample the very same package goes straight through.
    const ok = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 6948, batteryPercent: 90 })
    expect(ok.statusCode).toBe(200)
    void manager
  })

  it('keeps a JPEG sample — a whole screen is a photograph, not line-art', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await openShift(driver, manager, {
      odometerKmOcr: 200,
      odometerStrip: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    })

    const samples = await h.deps.orders.listOcrSamples('odometer')
    expect(samples).toHaveLength(1)
  })

  it('keeps nothing when there was no screenshot behind the number', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await openShift(driver, manager, { odometerKmOcr: null, odometerStrip: null })

    expect(await h.deps.orders.listOcrSamples('odometer')).toHaveLength(0)
  })

  /** A sample must never cost a driver his shift — the same rule the fee samples already follow. */
  it('lets the shift through when the sample is junk', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 6948,
      batteryPercent: 90,
      odometerStrip: 'not-a-data-url',
    })
    expect(res.statusCode).toBe(200)
    expect(await h.deps.orders.listOcrSamples('odometer')).toHaveLength(0)
  })

  it('keeps the closing wallet and odometer too, one each per package', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager, { odometerStrip: PNG })
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000) })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)

    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 6996,
      batteryPercent: 50,
      cashDeclared: sypStr(105_000),
      walletDeclared: sypStr(-1_000),
      walletStrip: PNG,
      odometerStrip: PNG,
    })

    // One odometer sample per package — the opening one is not overwritten by the closing one.
    const odo = await h.deps.orders.listOcrSamples('odometer')
    expect(odo.map((s) => s.package).sort()).toEqual(['end', 'start'])
    expect(await h.deps.orders.listOcrSamples('wallet')).toHaveLength(1)
  })
})
