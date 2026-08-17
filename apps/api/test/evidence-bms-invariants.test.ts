import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (
  token: string,
  url: string,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

const put = async (
  token: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

interface OnePackShift {
  id: string
  batteryId: string
  driver: string
  manager: string
}

async function onePackShift(): Promise<OnePackShift> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const battery = await post(manager, '/batteries', {
    capacityAh: 50,
    vehicleId: VEHICLE_ID,
    slotNo: 1,
  })
  expect(battery.statusCode, battery.body).toBe(201)
  const created = await post(driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    shiftNo: 1,
  })
  expect(created.statusCode, created.body).toBe(201)
  return {
    id: created.json().id as string,
    batteryId: battery.json().id as string,
    driver,
    manager,
  }
}

const batteryReading = async (
  shift: OnePackShift,
  pkg: 'start' | 'end',
  percent: number,
): Promise<LightMyRequestResponse> =>
  await put(shift.driver, `/shifts/${shift.id}/battery-readings`, {
    package: pkg,
    readings: [{ batteryId: shift.batteryId, percent, source: 'ocr' }],
  })

async function submitCompleteStart(shift: OnePackShift): Promise<{
  odometerMediaId: string
  bmsMediaId: string
}> {
  const odometer = await h.uploadPhoto(shift.driver, shift.id, 'start', 'odometer')
  const bms = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1')
  const reading = await batteryReading(shift, 'start', 88)
  expect(reading.statusCode, reading.body).toBe(200)
  const submitted = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
    odometerKm: 100,
    batteryPercent: null,
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  expect(submitted.json().state).toBe('awaiting_open_approval')
  return {
    odometerMediaId: odometer.mediaId as string,
    bmsMediaId: bms.mediaId as string,
  }
}

describe('BMS readings stay bound to their evidence and package state', () => {
  it('stages an old-PWA read-before-upload row, then binds it to the first bms_N photo', async () => {
    const shift = await onePackShift()

    const response = await batteryReading(shift, 'start', 88)

    expect(response.statusCode, response.body).toBe(200)
    expect(await h.deps.batteryReadings.listByShift(shift.id)).toEqual([
      expect.objectContaining({ batteryId: shift.batteryId, percent: 88, mediaId: null }),
    ])

    await h.uploadPhoto(shift.driver, shift.id, 'start', 'odometer')
    const beforeEvidence = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(beforeEvidence.statusCode, beforeEvidence.body).toBe(422)
    expect(beforeEvidence.json().detail).toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
    expect(beforeEvidence.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })

    const photo = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1')
    expect((await h.deps.batteryReadings.listByShift(shift.id))[0]?.mediaId).toBe(photo.mediaId)
    const accepted = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
  })

  it('stages an old-PWA retake away from the old photo, then binds only the replacement upload', async () => {
    const shift = await onePackShift()
    await h.uploadPhoto(shift.driver, shift.id, 'start', 'odometer')
    const firstPhoto = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1')
    expect((await batteryReading(shift, 'start', 88)).statusCode).toBe(200)

    // A cached PWA has no expectedMediaId and reads the newly picked file before uploading it.
    const stagedRetake = await batteryReading(shift, 'start', 91)
    expect(stagedRetake.statusCode, stagedRetake.body).toBe(200)
    expect(await h.deps.batteryReadings.listByShift(shift.id)).toEqual([
      expect.objectContaining({ percent: 91, mediaId: null }),
    ])

    const incomplete = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(incomplete.statusCode, incomplete.body).toBe(422)
    expect(incomplete.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })

    const replacement = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1', TINY_PNG)
    expect(replacement.mediaId).not.toBe(firstPhoto.mediaId)
    expect(await h.deps.batteryReadings.listByShift(shift.id)).toEqual([
      expect.objectContaining({ percent: 91, mediaId: replacement.mediaId }),
    ])
    const accepted = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
  })

  it('invalidates a reading when bms_N is replaced until the replacement is read', async () => {
    const shift = await onePackShift()
    await h.uploadPhoto(shift.driver, shift.id, 'start', 'odometer')
    const firstPhoto = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1')
    expect((await batteryReading(shift, 'start', 88)).statusCode).toBe(200)

    const replacement = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1', TINY_PNG)
    expect(replacement.mediaId).not.toBe(firstPhoto.mediaId)

    const staleReading = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(staleReading.statusCode, staleReading.body).toBe(422)
    expect(staleReading.json().error).toBe('start_package_incomplete')
    expect(staleReading.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
    expect(staleReading.json().detail).not.toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
    expect((await h.deps.batteryReadings.listByShift(shift.id))[0]?.mediaId).toBe(firstPhoto.mediaId)

    const reread = await batteryReading(shift, 'start', 91)
    expect(reread.statusCode, reread.body).toBe(200)
    expect((await h.deps.batteryReadings.listByShift(shift.id))[0]?.mediaId).toBe(replacement.mediaId)
    const accepted = await put(shift.driver, `/shifts/${shift.id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
  })

  it('refuses a late reading locked to the old BMS attachment and accepts the exact replacement', async () => {
    const shift = await onePackShift()
    const firstPhoto = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1')
    expect((await batteryReading(shift, 'start', 88)).statusCode).toBe(200)

    const replacement = await h.uploadPhoto(shift.driver, shift.id, 'start', 'bms_1', TINY_PNG)
    const stale = await put(shift.driver, `/shifts/${shift.id}/battery-readings`, {
      package: 'start',
      readings: [{
        batteryId: shift.batteryId,
        percent: 91,
        source: 'ocr',
        expectedMediaId: firstPhoto.mediaId,
      }],
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('battery_evidence_changed')
    expect(await h.deps.batteryReadings.listByShift(shift.id)).toEqual([
      expect.objectContaining({ percent: 88, mediaId: firstPhoto.mediaId }),
    ])

    const current = await put(shift.driver, `/shifts/${shift.id}/battery-readings`, {
      package: 'start',
      readings: [{
        batteryId: shift.batteryId,
        percent: 91,
        source: 'ocr',
        expectedMediaId: replacement.mediaId,
      }],
    })
    expect(current.statusCode, current.body).toBe(200)
    expect(await h.deps.batteryReadings.listByShift(shift.id)).toEqual([
      expect.objectContaining({ percent: 91, mediaId: replacement.mediaId }),
    ])
  })

  it('resumes, edits, and closes against the state endpoint mediaId without reuploading BMS', async () => {
    const shift = await onePackShift()
    await submitCompleteStart(shift)
    const opened = await post(shift.manager, `/shifts/${shift.id}/approve-open`, {
      floatTranches: [sypStr(100)],
      topupTranches: [],
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect((await post(shift.driver, `/shifts/${shift.id}/orders`, {
      providerOrderNo: 'BMS-RESUME-ORDER',
      payMode: 'cash',
      fee: sypStr(10),
    })).statusCode).toBe(201)

    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      await h.uploadPhoto(shift.driver, shift.id, 'end', slot)
    }
    const bms = await h.uploadPhoto(shift.driver, shift.id, 'end', 'bms_1')
    expect((await batteryReading(shift, 'end', 75)).statusCode).toBe(200)

    // This is the remount boundary: the browser File is gone and only `/state` can identify the
    // evidence generation an ordinary field edit belongs to.
    const state = await get(shift.driver, `/shifts/${shift.id}/state`)
    expect(state.statusCode, state.body).toBe(200)
    const restored = state.json().endPackage.batteries.find(
      (reading: { batteryId: string }) => reading.batteryId === shift.batteryId,
    )
    expect(restored).toMatchObject({ percent: 75, mediaId: bms.mediaId })

    const edited = await put(shift.driver, `/shifts/${shift.id}/battery-readings`, {
      package: 'end',
      readings: [{
        batteryId: shift.batteryId,
        percent: 74,
        source: 'manual',
        expectedMediaId: restored.mediaId,
      }],
    })
    expect(edited.statusCode, edited.body).toBe(200)
    expect((await h.deps.batteryReadings.listByShift(shift.id)).find(
      (row) => row.package === 'end',
    )).toMatchObject({ percent: 74, mediaId: bms.mediaId })

    const ended = await put(shift.driver, `/shifts/${shift.id}/end-package`, {
      odometerKm: 110,
      batteryPercent: null,
      cashDeclared: sypStr(110),
      walletDeclared: sypStr(-2),
    })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json().state).toBe('pending_review')
    expect((await h.deps.media.listSlots(shift.id)).find(
      (slot) => slot.package === 'end' && slot.slot === 'bms_1',
    )?.mediaId).toBe(bms.mediaId)
  })

  it('locks driver BMS writes and start-evidence replacement after start submission', async () => {
    const shift = await onePackShift()
    const original = await submitCompleteStart(shift)

    const reading = await batteryReading(shift, 'start', 92)
    expect(reading.statusCode, reading.body).toBe(409)
    expect(reading.json()).toMatchObject({
      error: 'battery_reading_package_not_editable',
      detail: { package: 'start', state: 'awaiting_open_approval' },
    })

    const replacement = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${shift.id}/media/start/odometer`,
      headers: { cookie: h.cookie(shift.driver), 'content-type': 'image/png' },
      payload: TINY_PNG,
    })
    expect(replacement.statusCode, replacement.body).toBe(409)
    expect(replacement.json()).toMatchObject({
      error: 'shift_not_editable',
      detail: { package: 'start', state: 'awaiting_open_approval' },
    })
    const attached = await h.deps.media.listSlots(shift.id)
    expect(attached.find((slot) => slot.package === 'start' && slot.slot === 'odometer')?.mediaId)
      .toBe(original.odometerMediaId)
  })

  it('locks driver end-BMS writes once the close package is pending review', async () => {
    const shift = await onePackShift()
    await submitCompleteStart(shift)
    const opened = await post(shift.manager, `/shifts/${shift.id}/approve-open`, {
      floatTranches: [sypStr(100)],
      topupTranches: [],
    })
    expect(opened.statusCode, opened.body).toBe(200)
    const order = await post(shift.driver, `/shifts/${shift.id}/orders`, {
      providerOrderNo: 'BMS-LOCK-ORDER',
      payMode: 'cash',
      fee: sypStr(10),
    })
    expect(order.statusCode, order.body).toBe(201)

    for (const slot of ['dashboard', 'wallet', 'odometer', 'bms_1']) {
      await h.uploadPhoto(shift.driver, shift.id, 'end', slot)
    }
    expect((await batteryReading(shift, 'end', 75)).statusCode).toBe(200)
    const ended = await put(shift.driver, `/shifts/${shift.id}/end-package`, {
      odometerKm: 110,
      batteryPercent: null,
      cashDeclared: sypStr(110),
      walletDeclared: sypStr(-2),
    })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json().state).toBe('pending_review')

    const reading = await batteryReading(shift, 'end', 74)
    expect(reading.statusCode, reading.body).toBe(409)
    expect(reading.json()).toMatchObject({
      error: 'battery_reading_package_not_editable',
      detail: { package: 'end', state: 'pending_review' },
    })
    expect((await h.deps.batteryReadings.listByShift(shift.id))
      .find((row) => row.package === 'end')?.percent).toBe(75)
  })
})

describe('stale acknowledgement is attachment-specific', () => {
  it('rejects an old mediaId after replacement and leaves the replacement unacknowledged', async () => {
    const driver = await h.loginAs('driver1')
    const created = await post(driver, '/shifts', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
    })
    const id = created.json().id as string
    const staleTakenAt = String(h.deps.clock.nowMs() - 31 * 60_000)

    const first = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-client-taken-at': staleTakenAt,
        'x-stale-evidence-acknowledged': 'true',
      },
      payload: TINY_JPEG,
    })
    expect(first.statusCode, first.body).toBe(201)
    const second = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/png',
        'x-client-taken-at': staleTakenAt,
        'x-stale-evidence-acknowledged': 'true',
        'x-expected-attachment-token': first.json().attachmentToken,
        'x-replace-confirmed': 'true',
      },
      payload: TINY_PNG,
    })
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json()).toMatchObject({ staleAcknowledged: true })
    expect(second.json().mediaId).not.toBe(first.json().mediaId)

    const acknowledgement = await post(
      driver,
      `/shifts/${id}/media/start/odometer/acknowledge-stale`,
      {
        mediaId: first.json().mediaId,
        attachmentToken: first.json().attachmentToken,
      },
    )
    expect(acknowledgement.statusCode, acknowledgement.body).toBe(409)
    expect(acknowledgement.json().error).toBe('evidence_attachment_changed')

    const [attached] = await h.deps.media.listSlots(id)
    expect(attached).toMatchObject({
      mediaId: second.json().mediaId,
      staleAcknowledgedAtMs: h.deps.clock.nowMs(),
      staleAcknowledgedBy: 'u-d1',
    })
    const blocked = await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
  })

  it('uses the attachment token to reject a stale A token after A → B → A', async () => {
    const driver = await h.loginAs('driver1')
    const created = await post(driver, '/shifts', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
    })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    const staleTakenAt = String(h.deps.clock.nowMs() - 31 * 60_000)
    const upload = async (
      contentType: 'image/jpeg' | 'image/png',
      bytes: Buffer,
      expectedAttachmentToken?: string,
    ) =>
      await h.app.inject({
        method: 'PUT',
        url: `/shifts/${id}/media/start/odometer`,
        headers: {
          cookie: h.cookie(driver),
          'content-type': contentType,
          'x-client-taken-at': staleTakenAt,
          'x-stale-evidence-acknowledged': 'true',
          ...(expectedAttachmentToken === undefined ? {} : {
            'x-expected-attachment-token': expectedAttachmentToken,
            'x-replace-confirmed': 'true',
          }),
        },
        payload: bytes,
      })

    const firstA = await upload('image/jpeg', TINY_JPEG)
    const middleB = await upload('image/png', TINY_PNG, firstA.json().attachmentToken)
    const currentA = await upload('image/jpeg', TINY_JPEG, middleB.json().attachmentToken)
    expect(firstA.statusCode, firstA.body).toBe(201)
    expect(middleB.statusCode, middleB.body).toBe(201)
    expect(currentA.statusCode, currentA.body).toBe(201)
    expect(currentA.json().mediaId).toBe(firstA.json().mediaId)
    expect(middleB.json().mediaId).not.toBe(firstA.json().mediaId)
    expect(currentA.json().attachmentToken).not.toBe(firstA.json().attachmentToken)
    expect(currentA.json().staleAcknowledged).toBe(true)

    const missingToken = await post(
      driver,
      `/shifts/${id}/media/start/odometer/acknowledge-stale`,
      { mediaId: currentA.json().mediaId },
    )
    expect(missingToken.statusCode, missingToken.body).toBe(400)
    expect(missingToken.json().error).toBe('invalid_request')

    const oldToken = await post(
      driver,
      `/shifts/${id}/media/start/odometer/acknowledge-stale`,
      {
        mediaId: firstA.json().mediaId,
        attachmentToken: firstA.json().attachmentToken,
      },
    )
    expect(oldToken.statusCode, oldToken.body).toBe(409)
    expect(oldToken.json().error).toBe('evidence_attachment_changed')

    const [acknowledged] = await h.deps.media.listSlots(id)
    expect(acknowledged).toMatchObject({
      mediaId: currentA.json().mediaId,
      attachmentToken: currentA.json().attachmentToken,
      staleAcknowledgedAtMs: h.deps.clock.nowMs(),
      staleAcknowledgedBy: 'u-d1',
    })
  })
})
