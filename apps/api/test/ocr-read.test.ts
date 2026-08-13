import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptedOcrReader } from '@ash/adapters/memory'
import type { OcrReader, OcrReading } from '@ash/contracts'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The paid reader, and the four things that keep it from being dangerous.
 *
 * Everything here is about SPEND and BLAST RADIUS, not about accuracy — accuracy is measured
 * offline against a 311-row answer key by `scripts/vision-bench.mjs`, because no unit test can tell
 * you whether a model reads Arabic-Indic digits. What a unit test CAN pin is that a model which
 * fails, or a phone which retries, cannot cost money or cost a driver his shift.
 *
 * The four:
 *   1. the same pixels are never billed twice
 *   2. a shift cannot spend without limit
 *   3. an upstream failure is a 200 with a reason, never something that blocks a close
 *   4. with no provider configured, nothing calls out at all
 */

let h: Harness
afterEach(async () => {
  if (h) await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

/** Post raw image bytes to the read endpoint, exactly as the phone does. */
const read = async (
  token: string,
  shiftId: string,
  field: string,
  // Annotated rather than inferred from the default: `Buffer.from([...])` widens to
  // `Buffer<ArrayBufferLike>`, which the narrower inferred type would reject.
  bytes: Buffer = TINY_JPEG,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({
    method: 'POST',
    url: `/shifts/${shiftId}/ocr/${field}`,
    headers: { cookie: h.cookie(token), 'content-type': 'image/jpeg' },
    payload: bytes,
  })

async function openShift(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  return id
}

/** One clean answer, repeated. `ScriptedOcrReader` counts how many times it was actually reached. */
const scripted = (): ScriptedOcrReader =>
  new ScriptedOcrReader([
    {
      ok: true,
      rows: [{ printed: '٥٬٠٠٠', value: '5000', cancelled: false, time: '13:10', dateIso: '2026-07-21' }],
      fields: {},
      raw: null,
    },
  ])

describe('cloud OCR: the same pixels are never billed twice', () => {
  it('serves a repeat of identical bytes from the cache without reaching the provider', async () => {
    const reader = scripted()
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const first = await read(driver, shiftId, 'orders')
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().ok).toBe(true)
    expect(first.json().cached).toBe(false)
    expect(first.json().rows).toEqual([
      { printed: '٥٬٠٠٠', value: '5000', cancelled: false, time: '13:10', dateIso: '2026-07-21' },
    ])
    expect(reader.calls).toBe(1)

    // The driver's connection dropped and the phone retried. Same photo, same answer, no money.
    const again = await read(driver, shiftId, 'orders')
    expect(again.json().cached).toBe(true)
    expect(again.json().rows).toEqual(first.json().rows)
    expect(reader.calls, 'a cache hit must not reach the provider').toBe(1)
  })

  it('treats the same pixels asked a DIFFERENT question as a different read', async () => {
    // An orders screen read as a payments log returns different rows, so the cache key carries the
    // field. Getting this wrong would serve one screen's answer for another's question.
    const reader = scripted()
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await read(driver, shiftId, 'orders')
    const other = await read(driver, shiftId, 'payments_log')
    expect(other.json().cached).toBe(false)
    expect(reader.calls).toBe(2)
  })
})

describe('cloud OCR: a shift cannot spend without limit', () => {
  it('stops calling out at the cap and answers unavailable instead of an error', async () => {
    const reader = scripted()
    // Cap of 2, and every image distinct so the cache never absorbs a call.
    h = await makeHarness({ ocr: reader, maxOcrReadsPerShift: 2 })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    // A trailing byte past the JPEG's EOI: different content hash, same magic bytes, still a photo.
    const distinct = (n: number): Buffer => Buffer.from([...TINY_JPEG, n])

    expect((await read(driver, shiftId, 'orders', distinct(1))).json().ok).toBe(true)
    expect((await read(driver, shiftId, 'orders', distinct(2))).json().ok).toBe(true)
    expect(reader.calls).toBe(2)

    const third = await read(driver, shiftId, 'orders', distinct(3))
    // A 200, not a 429. The phone's job on `unavailable` is to fall back to its own reader, and
    // that is the same thing it does when the network is gone — one code path, not two.
    expect(third.statusCode).toBe(200)
    expect(third.json().ok).toBe(false)
    expect(third.json().reason).toBe('unavailable')
    expect(reader.calls, 'past the cap nothing may be billed').toBe(2)
  })

  it('does not let cache hits consume the cap', async () => {
    const reader = scripted()
    h = await makeHarness({ ocr: reader, maxOcrReadsPerShift: 1 })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await read(driver, shiftId, 'orders')
    // Five retries of the same photo. Capping these would punish the driver for a bad connection.
    for (let i = 0; i < 5; i++) {
      const again = await read(driver, shiftId, 'orders')
      expect(again.json().ok).toBe(true)
      expect(again.json().cached).toBe(true)
    }
    expect(reader.calls).toBe(1)
  })
})

describe('cloud OCR: a failure never blocks a shift', () => {
  it('returns 200 with a reason when the provider fails, and the shift still closes', async () => {
    const failing: OcrReader = {
      available: true,
      model: 'exploding',
      read: async (): Promise<OcrReading> => ({
        result: { ok: false, reason: 'timeout' },
        usage: { tokensIn: 0, tokensOut: 0, latencyMs: 45_000 },
      }),
    }
    h = await makeHarness({ ocr: failing })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const res = await read(driver, shiftId, 'wallet')
    expect(res.statusCode, 'an OCR limb must never fail a money limb').toBe(200)
    expect(res.json().ok).toBe(false)
    expect(res.json().reason).toBe('timeout')
    expect(res.json().rows).toEqual([])

    // And the shift is untouched by it: the close path never consulted the reader. One order,
    // typed by hand exactly as a driver does when no reader helps him — which is the state this
    // whole failure path leaves him in.
    await put(driver, `/shifts/${shiftId}/operations`, {
      orders: [{ providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), source: 'manual' }],
      movements: [],
    })
    await h.uploadPhoto(driver, shiftId, 'end', 'dashboard')
    await h.uploadPhoto(driver, shiftId, 'end', 'wallet')
    await h.uploadPhoto(driver, shiftId, 'end', 'odometer')
    const end = await put(driver, `/shifts/${shiftId}/end-package`, {
      odometerKm: 150,
      batteryPercent: 40,
      // BR1: 100,000 float + 0.80 × 5,000 = 104,000 in hand, wallet zeroed.
      cashDeclared: sypStr(104_000),
      walletDeclared: sypStr(0),
    })
    expect(end.statusCode, end.body).toBe(200)
  })

  it('records the failure so a retry is not billed again', async () => {
    let calls = 0
    const failing: OcrReader = {
      available: true,
      model: 'exploding',
      read: async (): Promise<OcrReading> => {
        calls += 1
        return { result: { ok: false, reason: 'timeout' }, usage: { tokensIn: 10, tokensOut: 0, latencyMs: 1 } }
      },
    }
    h = await makeHarness({ ocr: failing })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await read(driver, shiftId, 'odometer')
    const again = await read(driver, shiftId, 'odometer')
    expect(again.json().cached).toBe(true)
    expect(calls, 'a stored timeout is what stops us paying to rediscover it').toBe(1)
  })
})

describe('cloud OCR: switched off by default', () => {
  it('reports unavailable and never calls out when no provider is configured', async () => {
    // The harness default is `MemoryOcrReader` — available: false — which is what every other test
    // in this suite inherits, so adding this port cannot make anything start hitting the network.
    h = await makeHarness()
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const res = await read(driver, shiftId, 'orders')
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(false)
    expect(res.json().reason).toBe('unavailable')

    // Nothing was recorded, because nothing was spent.
    expect(await h.deps.ocrReads.countBilledForShift(shiftId)).toBe(0)
  })
})

describe('cloud OCR: malformed requests still 4xx', () => {
  it('refuses a body that is not an image, and an unknown field', async () => {
    h = await makeHarness({ ocr: scripted() })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    // A client posting a PDF has a bug; a 4xx is how it finds out. This is the one place the
    // endpoint does throw — "your request is malformed" is not the same as "the image was hard".
    const notAnImage = await read(driver, shiftId, 'orders', Buffer.from('%PDF-1.7 not a photo'))
    expect(notAnImage.statusCode).toBe(415)
    expect(notAnImage.json().error).toBe('not_an_image')

    const empty = await read(driver, shiftId, 'orders', Buffer.alloc(0))
    expect(empty.statusCode).toBe(422)

    const unknown = await read(driver, shiftId, 'not_a_screen')
    expect(unknown.statusCode).toBe(400)
  })

  it('refuses a driver reading another driver’s shift', async () => {
    // `shift.operate` is scoped `own` for a driver — the same grant the upload route beside it uses.
    h = await makeHarness({ ocr: scripted() })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const other = await h.loginAs('driver2')
    const shiftId = await openShift(driver, manager)

    const res = await read(other, shiftId, 'orders')
    expect(res.statusCode).toBe(403)
  })
})
