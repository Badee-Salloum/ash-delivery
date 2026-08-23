import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr, today } from './harness.ts'

/**
 * «تطبيق البطارية لا يعمل على جهازي».
 *
 * Some drivers' phones cannot run the BMS app at all — an old Android, a device the manufacturer's
 * app refuses, Bluetooth that will not pair. The start gate demands a `bms_N` screenshot AND a charge
 * figure for every fitted pack, so such a driver could not open a shift at all. The only way past it
 * was to upload a photograph of something else, which converts a hardware problem into false
 * evidence — the worst available outcome.
 *
 * The declaration does not waive the evidence, it moves who owes it: the driver proceeds, and the
 * branch manager cannot approve until he has read that pack on a device that works.
 */

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
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })

/** A bike with one fitted pack, and a driver at the start gate. */
async function shiftWithOnePack(driver: string, manager: string): Promise<{ id: string; batteryId: string }> {
  const batteryId = (await post(manager, '/batteries', { capacityAh: 50, vehicleId: VEHICLE_ID, slotNo: 1 })).json()
    .id as string
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
    .id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  return { id, batteryId }
}

async function openShiftWithPacks(
  driver: string,
  manager: string,
  count: 1 | 2,
): Promise<{ id: string; batteryIds: string[] }> {
  const batteryIds: string[] = []
  for (let slotNo = 1; slotNo <= count; slotNo += 1) {
    const created = await post(manager, '/batteries', {
      capacityAh: slotNo === 1 ? 50 : 30,
      vehicleId: VEHICLE_ID,
      slotNo,
    })
    expect(created.statusCode, created.body).toBe(201)
    batteryIds.push(created.json().id as string)
  }

  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  for (let slotNo = 1; slotNo <= count; slotNo += 1) {
    await h.uploadPhoto(driver, id, 'start', `bms_${slotNo}`)
  }
  const readings = await put(driver, `/shifts/${id}/battery-readings`, {
    package: 'start',
    readings: batteryIds.map((batteryId, i) => ({ batteryId, percent: 90 - i, source: 'manual' })),
  })
  expect(readings.statusCode, readings.body).toBe(200)
  const submitted = await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 100,
    batteryPercent: null,
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100)],
    topupTranches: [],
  })
  expect(opened.statusCode, opened.body).toBe(200)
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: [{
      clientKey: `battery-unavailable-${count}`,
      providerOrderNo: `BATTERY-UNAVAILABLE-${count}`,
      payMode: 'cash',
      fee: sypStr(10),
      occurredDate: today,
      occurredMinute: '08:00',
    }],
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  return { id, batteryIds }
}

describe('a pack the driver cannot read on his own phone', () => {
  it('lets him start the shift — he is not asked for a screenshot he cannot take', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)

    const declared = await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    expect(declared.statusCode).toBe(200)

    // No `bms_1` photo, no charge figure — and the start package still goes through.
    const submitted = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })
    expect(submitted.statusCode).toBe(200)
    expect((await get(manager, `/shifts/${id}/review`)).json().state).toBe('awaiting_open_approval')
  })

  it('but stops the MANAGER approving until he has read the pack himself', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })

    const refused = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [],
    })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toBe('start_package_incomplete')
    expect(refused.json().detail).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 1 })
  })

  it('does not let a late driver OCR/upload write undo the confirmed declaration', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })

    // This is the request that was already running when the driver tapped “app will not run”. It
    // arrives later and must not hand the pack back to the driver or satisfy the manager's gate.
    const late = await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: 73, unavailable: false, source: 'ocr' }],
    })
    expect(late.statusCode, late.body).toBe(200)
    expect(late.json().readings).toEqual([
      expect.objectContaining({ batteryId, percent: null, unavailable: true }),
    ])

    expect((await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })).statusCode).toBe(200)
    const refused = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100)],
      topupTranches: [],
    })
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().detail).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 1 })
  })

  it('opens once the manager supplies the reading, and records that HE produced it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })

    // The manager reads the pack on a device that works.
    const supplied = await put(manager, `/shifts/${id}/battery-readings/manager`, {
      package: 'start',
      readings: [{ batteryId, percent: 88, unavailable: true, source: 'manager' }],
    })
    expect(supplied.statusCode).toBe(200)

    const opened = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [],
    })
    expect(opened.statusCode).toBe(200)

    // `manager` is not `manual`: a figure he took after the driver could not is a different fact
    // from one the driver typed, and must not be distinguishable only by reading the audit log.
    const reading = (await get(manager, `/shifts/${id}/review`)).json().startPackage.batteries[0]
    expect(reading.percent).toBe(88)
    expect(reading.source).toBe('manager')
  })

  it('does not waive a pack he simply has not done yet', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id } = await shiftWithOnePack(driver, manager)

    // Nothing declared, nothing read — the driver still owes this one, as before.
    const submitted = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })
    expect(submitted.statusCode).toBe(422)
    expect(submitted.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
  })

  it.each([1, 2] as const)(
    'lets the driver submit the close with %i server-confirmed unavailable pack(s)',
    async (count) => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const { id, batteryIds } = await openShiftWithPacks(driver, manager, count)

      const declared = await put(driver, `/shifts/${id}/battery-readings`, {
        package: 'end',
        readings: batteryIds.map((batteryId) => ({
          batteryId,
          percent: null,
          unavailable: true,
          source: 'manual',
        })),
      })
      expect(declared.statusCode, declared.body).toBe(200)

      // The state endpoint is the remount boundary. A null charge must retain the declaration for
      // every pack, otherwise the restored closing screen asks for remaining energy again.
      const resumed = await get(driver, `/shifts/${id}/state`)
      expect(resumed.statusCode, resumed.body).toBe(200)
      expect(resumed.json().endPackage.batteries).toEqual(
        expect.arrayContaining(
          batteryIds.map((batteryId, i) =>
            expect.objectContaining({ batteryId, slotNo: i + 1, percent: null, unavailable: true }),
          ),
        ),
      )

      const ended = await put(driver, `/shifts/${id}/end-package`, {
        odometerKm: 110,
        batteryPercent: null,
        cashDeclared: sypStr(110),
        walletDeclared: sypStr(-2),
      })
      expect(ended.statusCode, ended.body).toBe(200)
      expect(ended.json().state).toBe('pending_review')

      if (count === 1) {
        const review = await get(manager, `/shifts/${id}/review`)
        expect(review.statusCode, review.body).toBe(200)
        const refused = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
        expect(refused.statusCode, refused.body).toBe(422)
        expect(refused.json().detail).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 1 })

        const supplied = await put(manager, `/shifts/${id}/battery-readings/manager`, {
          package: 'end',
          readings: [{ batteryId: batteryIds[0], percent: 42, unavailable: true }],
        })
        expect(supplied.statusCode, supplied.body).toBe(200)
        const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
        expect(approved.statusCode, approved.body).toBe(200)
        expect(approved.json().state).toBe('approved')
      }
    },
  )

  it('atomically hands missing end BMS evidence to the manager while ending a mismatched shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryIds } = await openShiftWithPacks(driver, manager, 2)

    expect((await get(manager, '/dashboard/working-now')).json()).toMatchObject({
      drivers: 1,
      vehicles: 1,
    })

    // Pack 1 is complete. Pack 2 has a manual value but no evidence generation, so the server
    // preserves pack 1 and turns only pack 2 into an explicit manager obligation.
    const firstPhoto = await h.uploadPhoto(driver, id, 'end', 'bms_1')
    const readings = await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'end',
      readings: [
        { batteryId: batteryIds[0], percent: 61, source: 'manual' },
        { batteryId: batteryIds[1], percent: 47, source: 'manual' },
      ],
    })
    expect(readings.statusCode, readings.body).toBe(200)

    const ended = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 110,
      batteryPercent: null,
      cashDeclared: sypStr(0),
      walletDeclared: sypStr(0),
      deferMissingBatteryEvidenceToManager: true,
    })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json()).toMatchObject({ state: 'pending_review', br1: { balanced: false } })
    expect((await get(manager, '/dashboard/working-now')).json()).toMatchObject({
      drivers: 0,
      vehicles: 0,
    })

    const stored = (await h.deps.batteryReadings.listByShift(id)).filter((row) => row.package === 'end')
    expect(stored.find((row) => row.batteryId === batteryIds[0])).toMatchObject({
      percent: 61,
      mediaId: firstPhoto.mediaId,
      unavailable: false,
      source: 'manual',
    })
    expect(stored.find((row) => row.batteryId === batteryIds[1])).toMatchObject({
      percent: null,
      mediaId: null,
      unavailable: true,
      source: 'manual',
    })

    const review = await get(manager, `/shifts/${id}/review`)
    const refused = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json()).toMatchObject({ error: 'end_package_incomplete' })
    expect(refused.json().detail).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 2 })

    const supplied = await put(manager, `/shifts/${id}/battery-readings/manager`, {
      package: 'end',
      readings: [{ batteryId: batteryIds[1], percent: 46 }],
    })
    expect(supplied.statusCode, supplied.body).toBe(200)
    const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json().state).toBe('approved')
  })

  it('keeps the historical battery gate when the explicit defer flag is absent', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryIds } = await openShiftWithPacks(driver, manager, 1)
    expect((await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'end',
      readings: [{ batteryId: batteryIds[0], percent: 51, source: 'manual' }],
    })).statusCode).toBe(200)

    const refused = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 110,
      batteryPercent: null,
      cashDeclared: sypStr(110),
      walletDeclared: sypStr(-2),
    })
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json()).toMatchObject({ error: 'end_package_incomplete' })
    expect(refused.json().detail).toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
  })
})
