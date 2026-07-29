import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, VEHICLE_TYPE, makeHarness, sypStr } from './harness.ts'

/**
 * Mid-shift battery swap (SRS §L seam). At a charging stop the driver trades a depleted pack for a
 * charged spare; both packs' BMS readings are captured, the bike is re-fitted (old → charging
 * spare, new → the slot), and the swap is logged. No money moves — BR1 is untouched. Driver-only
 * (`shift.operate`, own shift). Also pins the configurable per-vehicle-type pack ceiling.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const fit = async (manager: string, slotNo: number, serialNo: string): Promise<string> =>
  (await post(manager, '/batteries', { capacityAh: 50, serialNo, vehicleId: VEHICLE_ID, slotNo })).json().id as string
const spare = async (manager: string, serialNo: string): Promise<string> =>
  (await post(manager, '/batteries', { capacityAh: 50, serialNo })).json().id as string

/** Open a two-pack shift end to end: fit two packs, submit the start package for both, approve. */
async function openTwoPackShift(driver: string, manager: string, packs: string[]): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  for (let i = 0; i < packs.length; i++) {
    await h.uploadPhoto(driver, id, 'start', `bms_${i + 1}`)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId: packs[i], percent: 90, source: 'manual' }],
    })
  }
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  return id
}

describe('mid-shift battery swap', () => {
  it('swaps a slot, captures both readings, re-fits the bike, and logs the swap', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const pack1 = await fit(manager, 1, 'PACK-1')
    const pack2 = await fit(manager, 2, 'PACK-2')
    const spareId = await spare(manager, 'SPARE-1')
    const id = await openTwoPackShift(driver, manager, [pack1, pack2])

    const res = await post(driver, `/shifts/${id}/battery-swap`, {
      slotNo: 2,
      inBatteryId: spareId,
      outReading: { percent: 18 },
      inReading: { percent: 96 },
    })
    expect(res.statusCode, res.body).toBe(201)

    // The bike now carries PACK-1 (slot 1) and the spare (slot 2); PACK-2 is off.
    const fitted = res.json().batteries as Array<{ id: string; slotNo: number }>
    expect(fitted.map((b) => b.id).sort()).toEqual([pack1, spareId].sort())
    expect(fitted.find((b) => b.id === spareId)?.slotNo).toBe(2)

    // The asset rows moved: PACK-2 to the shelf to charge, the spare onto slot 2.
    expect(await h.deps.directory.battery(pack2)).toMatchObject({ vehicleId: null, slotNo: null, state: 'charging' })
    expect(await h.deps.directory.battery(spareId)).toMatchObject({ vehicleId: VEHICLE_ID, slotNo: 2, state: 'ready' })

    // Both readings persisted, tied to the swap; and the swap is logged once.
    const readings = await h.deps.batteryReadings.listByShift(id)
    expect(readings.find((r) => r.package === 'swap_out' && r.batteryId === pack2)?.percent).toBe(18)
    expect(readings.find((r) => r.package === 'swap_in' && r.batteryId === spareId)?.percent).toBe(96)
    const swaps = await h.deps.batterySwaps.listByShift(id)
    expect(swaps).toHaveLength(1)
    expect(swaps[0]).toMatchObject({ seqNo: 1, slotNo: 2, outBatteryId: pack2, inBatteryId: spareId })
  })

  it('rejects a replay: the pack that already came off is no longer fitted at that slot', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const pack1 = await fit(manager, 1, 'PACK-1')
    const pack2 = await fit(manager, 2, 'PACK-2')
    const spareId = await spare(manager, 'SPARE-1')
    const id = await openTwoPackShift(driver, manager, [pack1, pack2])

    const body = { slotNo: 2, inBatteryId: spareId, outReading: { percent: 18 }, inReading: { percent: 96 } }
    expect((await post(driver, `/shifts/${id}/battery-swap`, body)).statusCode).toBe(201)
    // After the first swap the spare IS slot 2's pack, so the identical retry is refused (out === in)
    // rather than double-applied — the "outgoing must still be fitted" validation is the replay guard.
    const replay = await post(driver, `/shifts/${id}/battery-swap`, body)
    expect(replay.statusCode).toBe(422)
    expect(replay.json().error).toBe('same_battery')
    expect(await h.deps.batterySwaps.listByShift(id)).toHaveLength(1)
  })

  it('a driver may not swap on another driver’s shift (shift.operate, own)', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const driver2 = await h.loginAs('driver2')
    const pack1 = await fit(manager, 1, 'PACK-1')
    const pack2 = await fit(manager, 2, 'PACK-2')
    const spareId = await spare(manager, 'SPARE-1')
    const id = await openTwoPackShift(driver, manager, [pack1, pack2])

    const res = await post(driver2, `/shifts/${id}/battery-swap`, {
      slotNo: 2,
      inBatteryId: spareId,
      outReading: { percent: 18 },
      inReading: { percent: 96 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a swap for a slot that has no pack fitted', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const pack1 = await fit(manager, 1, 'PACK-1')
    const spareId = await spare(manager, 'SPARE-1')
    const id = await openTwoPackShift(driver, manager, [pack1])

    const res = await post(driver, `/shifts/${id}/battery-swap`, {
      slotNo: 2, // nothing fitted at slot 2
      inBatteryId: spareId,
      outReading: { percent: 18 },
      inReading: { percent: 96 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('slot_not_fitted')
  })
})

describe('per-vehicle-type pack ceiling (two OR MORE packs)', () => {
  it('accepts a slot within the type max but refuses one above it', async () => {
    const manager = await h.loginAs('manager')
    // The test harness sets e_motorbike battery_slots = 3.
    expect((await post(manager, '/batteries', { capacityAh: 50, serialNo: 'P3', vehicleId: VEHICLE_ID, slotNo: 3 })).statusCode).toBe(201)

    const tooHigh = await post(manager, '/batteries', { capacityAh: 50, serialNo: 'P4', vehicleId: VEHICLE_ID, slotNo: 4 })
    expect(tooHigh.statusCode).toBe(422)
    expect(tooHigh.json().error).toBe('slot_out_of_range')
  })

  it('lets the sysadmin raise a type’s battery-slot ceiling', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/vehicle-types/${VEHICLE_TYPE}`,
      headers: { cookie: h.cookie(admin) },
      payload: { batterySlots: 4 },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().batterySlots).toBe(4)
  })
})
