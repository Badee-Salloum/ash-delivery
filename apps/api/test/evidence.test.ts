import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sniffImageType, storageKeyFor } from '../src/media.service.ts'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, sypStr, today } from './harness.ts'

/**
 * Photo evidence (SRS C-6).
 *
 * The point of these tests is that the BR5 gates read REALITY. An earlier version let the driver's
 * app send a list of slot names alongside the package, which meant the gate verified that the app
 * *claimed* a photo existed. For a system built on «الأدلة المصوَّرة», a claim is not evidence.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

async function newShift(driverToken: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/shifts',
    headers: { cookie: h.cookie(driverToken) },
    payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function markOpenForEndEvidence(id: string): Promise<void> {
  const shift = await h.deps.shifts.findById(id)
  if (!shift) throw new Error('test shift missing')
  await h.deps.shifts.update({
    ...shift,
    state: 'open',
    openApprovedAt: new Date(h.deps.clock.nowMs()).toISOString(),
    openApprovedBy: 'u-bm',
  }, 'u-bm')
}

const startPackage = { odometerKm: 100, batteryPercent: 90, floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)] }

describe('the gate reads uploaded photos, not client claims', () => {
  it('refuses to confirm the start package when nothing was uploaded', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)

    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: startPackage,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('start_package_incomplete')
    expect(res.json().detail).toContainEqual({ kind: 'missing_photo', slot: 'odometer' })
  })

  it('accepts it once the odometer photo actually exists', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: startPackage,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('awaiting_open_approval')
  })

  it('a client cannot inject slot names through the package request', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)

    // Zod strips unknown keys; even if it did not, the repo projects slots from media.
    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: { ...startPackage, mediaSlots: ['odometer'] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('start_package_incomplete')
  })
})

describe('upload behaviour', () => {
  it('does not pre-acknowledge a fresh image merely because a blanket header was sent', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    const uploaded = await h.uploadPhoto(driver, id, 'start', 'odometer')
    expect(uploaded.staleAcknowledged).toBe(false)

    const acknowledge = await h.app.inject({
      method: 'POST',
      url: `/shifts/${id}/media/start/odometer/acknowledge-stale`,
      headers: { cookie: h.cookie(driver) },
      payload: { mediaId: uploaded.mediaId, attachmentToken: uploaded.attachmentToken },
    })
    expect(acknowledge.statusCode).toBe(422)
    expect(acknowledge.json().error).toBe('evidence_not_stale_or_reused')
  })

  it('blocks an old attachment until the driver explicitly acknowledges the warning', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    const uploaded = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-client-taken-at': String(h.deps.clock.nowMs() - 31 * 60_000),
      },
      payload: TINY_JPEG,
    })
    expect(uploaded.statusCode, uploaded.body).toBe(409)
    expect(uploaded.json().error).toBe('stale_evidence_confirmation_required')
    const acknowledged = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-client-taken-at': String(h.deps.clock.nowMs() - 31 * 60_000),
        'x-stale-evidence-acknowledged': 'true',
      },
      payload: TINY_JPEG,
    })
    expect(acknowledged.statusCode, acknowledged.body).toBe(201)
    expect(acknowledged.json().staleAcknowledged).toBe(true)
    const accepted = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: startPackage,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
  })

  it('remembers image reuse after the original attachment is detached', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    const detached = await h.app.inject({
      method: 'DELETE',
      url: `/shifts/${id}/media/start/odometer`,
      headers: { cookie: h.cookie(driver) },
    })
    expect(detached.statusCode, detached.body).toBe(200)
    await markOpenForEndEvidence(id)

    const warning = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/end/dashboard`,
      headers: { cookie: h.cookie(driver), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })
    expect(warning.statusCode).toBe(428)
    const draft = (await h.app.inject({
      method: 'GET', url: `/shifts/${id}/close-draft`, headers: { cookie: h.cookie(driver) },
    })).json()

    const reused = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/end/dashboard`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-close-draft-revision': String(draft.revision),
        'x-stale-evidence-acknowledged': 'true',
      },
      payload: TINY_JPEG,
    })
    expect(reused.statusCode, reused.body).toBe(201)
    expect(reused.json()).toMatchObject({ reusedFromShiftId: id, staleAcknowledged: true })
    expect(h.deps.media.attachmentHistory).toHaveLength(2)
  })

  it('is content-addressed: the same photo retried dedupes instead of storing twice', async () => {
    // Office Wi-Fi drops mid-upload; the driver's app retries. That must not double-store.
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)

    const first = await h.uploadPhoto(driver, id, 'start', 'odometer')
    const retry = await h.uploadPhoto(driver, id, 'start', 'odometer')

    expect(first.deduped).toBe(false)
    expect(retry.deduped).toBe(true)
    expect(retry.mediaId).toBe(first.mediaId)
    expect(retry.sha256).toBe(first.sha256)
    expect(h.deps.blobs.size).toBe(1)
  })

  it('records the phone clock as a CLAIM and reports the skew against server receipt', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)

    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-stale-evidence-acknowledged': 'true',
        // A phone whose clock is two hours slow.
        'x-client-taken-at': String(h.deps.clock.nowMs() - 2 * 60 * 60 * 1000),
      },
      payload: TINY_JPEG,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().clockSkewMs).toBe(2 * 60 * 60 * 1000)
  })

  it('reports null skew when the phone sends no timestamp', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    expect((await h.uploadPhoto(driver, id, 'start', 'odometer')).clockSkewMs).toBeNull()
  })

  it('rejects a non-image by MAGIC BYTES, not by the declared content type', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)

    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      // Claims to be a JPEG. Is not.
      headers: { cookie: h.cookie(driver), 'content-type': 'image/jpeg' },
      payload: Buffer.from('<?php system($_GET["c"]); ?>'),
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('not_an_image')
  })

  it('rejects an empty upload', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/odometer`,
      headers: { cookie: h.cookie(driver), 'content-type': 'image/jpeg' },
      payload: Buffer.alloc(0),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects an unknown evidence slot rather than silently accepting it', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    const res = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/start/selfie`,
      headers: { cookie: h.cookie(driver), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('unknown_evidence_slot')
  })

  it('accepts the later pages of a scrollable screen, and only up to the ceiling', async () => {
    // «الطلبات الحديثة» and «سجل المدفوعات» both scroll. A day arrives as several images, and each
    // page is its own slot — so they accumulate instead of replacing one another.
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    await markOpenForEndEvidence(id)
    for (const slot of ['dashboard', 'dashboard_2', 'payments_log_3']) {
      await h.uploadPhoto(driver, id, 'end', slot)
    }
    const slots = (await h.deps.media.listSlots(id)).map((s) => s.slot)
    expect(slots).toEqual(expect.arrayContaining(['dashboard', 'dashboard_2', 'payments_log_3']))

    // Past the ceiling is not a slot at all.
    const draft = (await h.app.inject({
      method: 'GET', url: `/shifts/${id}/close-draft`, headers: { cookie: h.cookie(driver) },
    })).json()
    const tooFar = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/end/dashboard_9`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/jpeg',
        'x-close-draft-revision': String(draft.revision),
        'x-stale-evidence-acknowledged': 'true',
      },
      payload: TINY_JPEG,
    })
    expect(tooFar.statusCode).toBe(422)
    expect(tooFar.json().error).toBe('unknown_evidence_slot')
  })

  it('a re-shoot REPLACES the slot — the manager never sees two odometer photos', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    // A different image for the same slot.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const second = await h.uploadPhoto(driver, id, 'start', 'odometer', png)

    const shift = await h.deps.shifts.findById(id)
    expect(shift?.mediaSlotsStart).toEqual(['odometer'])
    expect(await h.deps.media.listSlots(id)).toEqual([
      expect.objectContaining({ package: 'start', slot: 'odometer', mediaId: second.mediaId }),
    ])
  })
  it('refuses evidence replacement after the close package enters manager review', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newShift(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 100, batteryPercent: null },
    })
    await h.app.inject({
      method: 'POST',
      url: `/shifts/${id}/approve-open`,
      headers: { cookie: h.cookie(manager) },
      payload: { floatTranches: [sypStr(100)], topupTranches: [sypStr(2)] },
    })
    h.stageCloseDraftFinancialFixture(id, {
      managerToken: manager,
      orders: [{
        clientKey: 'evidence-lock', providerOrderNo: 'EVIDENCE-LOCK', payMode: 'cash', fee: sypStr(10),
        occurredDate: today, occurredMinute: '08:00',
      }],
    })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    const ended = await h.submitEndPackage(driver, id, {
      odometerKm: 110, batteryPercent: null, cashDeclared: sypStr(110), walletDeclared: sypStr(0),
    })
    expect(ended.statusCode, ended.body).toBe(200)

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const draft = (await h.app.inject({
      method: 'GET', url: `/shifts/${id}/close-draft`, headers: { cookie: h.cookie(driver) },
    })).json()
    const wallet = draft.attachments.find((row: { slot: string }) => row.slot === 'wallet')
    const replacement = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/media/end/wallet`,
      headers: {
        cookie: h.cookie(driver),
        'content-type': 'image/png',
        'x-close-draft-revision': String(draft.revision),
        'x-expected-attachment-token': wallet.attachmentToken,
        'x-replace-confirmed': 'true',
      },
      payload: png,
    })
    expect(replacement.statusCode).toBe(409)
    expect(replacement.json().error).toBe('shift_not_editable')
  })
})

describe('serving evidence', () => {
  it('serves the bytes back to an authorised manager', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newShift(driver)
    const uploaded = await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await h.app.inject({
      method: 'GET',
      url: `/media/${uploaded.mediaId}`,
      headers: { cookie: h.cookie(manager) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.rawPayload.equals(TINY_JPEG)).toBe(true)
  })

  it('the review carries each slot’s media id, so the C-7 screen can SHOW the photos', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newShift(driver)
    const uploaded = await h.uploadPhoto(driver, id, 'start', 'odometer')

    const review = await h.app.inject({ method: 'GET', url: `/shifts/${id}/review`, headers: { cookie: h.cookie(manager) } })
    expect(review.statusCode, review.body).toBe(200)
    const media = review.json().media as Array<{
      package: string
      slot: string
      mediaId: string
      clientTakenAt: string | null
      receivedAt: string | null
    }>
    const shot = media.find((m) => m.package === 'start' && m.slot === 'odometer')
    expect(shot?.mediaId).toBe(uploaded.mediaId)

    /*
     * WHEN IT WAS TAKEN, not only that it exists.
     *
     * `MediaRecord` has carried both timestamps since the beginning and the review sent neither, so
     * the manager had no way to tell a photo taken at the counter from one chosen out of the gallery.
     * That mattered little while the camera was forced; every slot can now be filled from the
     * gallery, so the age of the image is the control that replaced `capture`.
     */
    expect(shot?.receivedAt).toBeTruthy()
    expect('clientTakenAt' in (shot ?? {})).toBe(true)
  })

  it('refuses a manager from another branch — evidence is never on a public path', async () => {
    const driver = await h.loginAs('driver1')
    const other = await h.loginAs('manager2') // Aleppo
    const id = await newShift(driver)
    const uploaded = await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await h.app.inject({
      method: 'GET',
      url: `/media/${uploaded.mediaId}`,
      headers: { cookie: h.cookie(other) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an unauthenticated reader', async () => {
    const driver = await h.loginAs('driver1')
    const id = await newShift(driver)
    const uploaded = await h.uploadPhoto(driver, id, 'start', 'odometer')
    expect((await h.app.inject({ method: 'GET', url: `/media/${uploaded.mediaId}` })).statusCode).toBe(401)
  })
})

describe('image sniffing', () => {
  it.each([
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'image/webp'],
  ])('recognises %s', (_label, bytes, expected) => {
    expect(sniffImageType(new Uint8Array(bytes))).toBe(expected)
  })

  it('returns null for anything else', () => {
    expect(sniffImageType(new Uint8Array(Buffer.from('GIF89a')))).toBeNull()
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
  })

  it('fans storage keys across directories so one folder never holds a million files', () => {
    expect(storageKeyFor('abcdef0123456789')).toBe('ab/cd/abcdef0123456789')
  })
})
