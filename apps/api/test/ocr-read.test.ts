import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptedOcrReader } from '@ash/adapters/memory'
import type { OcrReader, OcrReading } from '@ash/contracts'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'
import { readScreen } from '../src/ocr.service.ts'

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
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

/** Post raw image bytes to the read endpoint, exactly as the phone does. */
const read = async (
  token: string,
  shiftId: string,
  field: string,
  // Annotated rather than inferred from the default: `Buffer.from([...])` widens to
  // `Buffer<ArrayBufferLike>`, which the narrower inferred type would reject.
  bytes: Buffer = TINY_JPEG,
  retryFailed = false,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({
    method: 'POST',
    url: `/shifts/${shiftId}/ocr/${field}`,
    headers: {
      cookie: h.cookie(token),
      'content-type': 'image/jpeg',
      ...(field === 'orders' ? { 'x-ash-orders-time-consensus': 'close-draft-v1' } : {}),
      ...(retryFailed ? { 'x-ocr-retry': 'true' } : {}),
    },
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
      rows: [{ printed: '٥٬٠٠٠', value: '5000', cancelled: false, time: '13:10', dateIso: '2026-07-21', pointA: 'المزة', pointB: 'الشعلان' }],
      fields: {},
      raw: null,
    },
  ])

describe('cloud OCR: the same pixels are never billed twice', () => {
  it('refuses a stale driver bundle before it can silently drop an unverified order time', async () => {
    const reader = scripted()
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const response = await h.app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/ocr/orders`,
      headers: { cookie: h.cookie(driver), 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    })

    expect(response.statusCode).toBe(428)
    expect(response.json().error).toBe('driver_update_required')
    expect(reader.calls).toBe(0)
  })

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
      { printed: '٥٬٠٠٠', value: '5000', cancelled: false, time: '13:10', dateIso: '2026-07-21', pointA: 'المزة', pointB: 'الشعلان' },
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

  it('makes a concurrent duplicate wait for the reserved logical read instead of serving a placeholder', async () => {
    let release!: () => void
    let announceStarted!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    let calls = 0
    const reader: OcrReader = {
      available: true,
      model: 'delayed',
      cacheSignature: (field) => `delayed-v1:${field}`,
      read: async (): Promise<OcrReading> => {
        calls += 1
        announceStarted()
        await gate
        return {
          result: { ok: true, rows: [], fields: { odometerKm: '6034' }, raw: null },
          usage: { tokensIn: 5, tokensOut: 2, latencyMs: 10 },
        }
      },
    }
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const firstPromise = read(driver, shiftId, 'odometer')
    await started
    const waitingPromise = read(driver, shiftId, 'odometer')
    let waitingSettled = false
    void waitingPromise.finally(() => {
      waitingSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waitingSettled, 'the duplicate must wait while the reservation is running').toBe(false)
    release()
    const [first, waiting] = await Promise.all([firstPromise, waitingPromise])

    expect(first.json()).toMatchObject({ ok: true, cached: false, fields: { odometerKm: '6034' } })
    expect(waiting.json()).toMatchObject({ ok: true, cached: true, fields: { odometerKm: '6034' } })
    expect(calls, 'the waiting request must not start a second logical read').toBe(1)
  })
})

describe('cloud OCR: wallet publication guard', () => {
  it('publishes one AI wallet balance verbatim', async () => {
    const reader = new ScriptedOcrReader([
      {
        ok: true,
        rows: [
          {
            printed: '٢٧٩٫٥٠',
            value: '279.50',
            cancelled: false,
            time: null,
            dateIso: null,
            pointA: null,
            pointB: null,
          },
        ],
        fields: {},
        raw: { reader: 'wallet-ai-consensus-v1', agreeingPasses: 2 },
      },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const res = await read(driver, shiftId, 'wallet')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().rows).toEqual([
      {
        printed: '٢٧٩٫٥٠',
        value: '279.50',
        cancelled: false,
        time: null,
        dateIso: null,
        pointA: null,
        pointB: null,
      },
    ])
  })

  it('stores a multi-row wallet answer as no_fields so neither the first nor a cache hit can win', async () => {
    const row = (printed: string, value: string) => ({
      printed,
      value,
      cancelled: false,
      time: null,
      dateIso: null,
      pointA: null,
      pointB: null,
    })
    const reader = new ScriptedOcrReader([
      { ok: true, rows: [row('٢٧٩٫٥٠', '279.50'), row('٣٧٩٫٥٠', '379.50')], fields: {}, raw: null },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const first = await read(driver, shiftId, 'wallet')
    expect(first.json()).toMatchObject({ ok: false, reason: 'no_fields', cached: false, rows: [] })
    const again = await read(driver, shiftId, 'wallet')
    expect(again.json()).toMatchObject({ ok: false, reason: 'no_fields', cached: true, rows: [] })
    expect(reader.calls).toBe(1)
  })
})

describe('cloud OCR: a shift cannot spend without limit', () => {
  it('atomically caps concurrent initial reads of different pixels', async () => {
    const reader = scripted()
    h = await makeHarness({ ocr: reader, maxOcrReadsPerShift: 1 })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    const distinct = (n: number): Buffer => Buffer.from([...TINY_JPEG, n])

    const [left, right] = await Promise.all([
      read(driver, shiftId, 'orders', distinct(1)),
      read(driver, shiftId, 'orders', distinct(2)),
    ])
    expect([left.json().ok, right.json().ok].sort()).toEqual([false, true])
    expect(reader.calls).toBe(1)
    expect(await h.deps.ocrReads.countBilledForShift(shiftId)).toBe(1)
  })

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
  it('allows one explicit retry of an orders shape with no authoritative monetary row', async () => {
    const reader = new ScriptedOcrReader([
      {
        ok: true,
        retryable: true,
        rows: [
          {
            printed: '155 SYP',
            value: null,
            cancelled: false,
            time: '00:49',
            dateIso: '2026-08-15',
            pointA: 'A',
            pointB: 'B',
          },
        ],
        fields: {},
        raw: null,
      },
      {
        ok: true,
        rows: [
          {
            printed: '155 SYP',
            value: '155',
            cancelled: false,
            time: '00:49',
            dateIso: '2026-08-15',
            pointA: 'A',
            pointB: 'B',
          },
        ],
        fields: {},
        raw: null,
      },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const first = await read(driver, shiftId, 'orders')
    expect(first.json()).toMatchObject({ ok: true, cached: false, retryable: true, rows: [{ value: null }] })
    const ordinary = await read(driver, shiftId, 'orders')
    expect(ordinary.json()).toMatchObject({ ok: true, cached: true, retryable: true, rows: [{ value: null }] })
    expect(reader.calls).toBe(1)

    const retried = await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(retried.json()).toMatchObject({ ok: true, cached: false, retryable: false, rows: [{ value: '155' }] })
    expect(reader.calls).toBe(2)
  })

  it('lets one explicit retry replace a cached timeout with a genuine successful read', async () => {
    const reader = new ScriptedOcrReader([
      { ok: false, reason: 'timeout' },
      {
        ok: true,
        rows: [
          {
            printed: '155 SYP',
            value: '155',
            cancelled: false,
            time: '00:49',
            dateIso: '2026-08-15',
            pointA: 'A',
            pointB: 'B',
          },
        ],
        fields: {},
        raw: null,
      },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const failed = await read(driver, shiftId, 'orders')
    expect(failed.json()).toMatchObject({ ok: false, reason: 'timeout', cached: false, retryable: true, reads: { used: 1 } })

    const retried = await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(retried.json()).toMatchObject({ ok: true, cached: false, retryable: false, reads: { used: 2 } })
    expect(retried.json().rows).toHaveLength(1)
    expect(reader.calls).toBe(2)

    const third = await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(third.json()).toMatchObject({ ok: true, cached: true, retryable: false, reads: { used: 2 } })
    expect(reader.calls, 'a successful replacement is cached forever').toBe(2)
  })

  it('bills at most one explicit retry when the provider times out twice', async () => {
    const reader = new ScriptedOcrReader([
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
    ])
    h = await makeHarness({ ocr: reader })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await read(driver, shiftId, 'orders')
    const retried = await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(retried.json()).toMatchObject({ ok: false, reason: 'timeout', cached: false, retryable: false, reads: { used: 2 } })

    const third = await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(third.json()).toMatchObject({ ok: false, reason: 'timeout', cached: true, retryable: false, reads: { used: 2 } })
    expect(reader.calls, 'attemptCount=2 makes every later retry a cache hit').toBe(2)
  })

  it('counts the explicit retry against the shift cap', async () => {
    const reader = new ScriptedOcrReader([
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
    ])
    h = await makeHarness({ ocr: reader, maxOcrReadsPerShift: 2 })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await read(driver, shiftId, 'orders')
    await read(driver, shiftId, 'orders', TINY_JPEG, true)
    expect(await h.deps.ocrReads.countBilledForShift(shiftId)).toBe(2)

    const distinct = Buffer.from([...TINY_JPEG, 7])
    const capped = await read(driver, shiftId, 'orders', distinct)
    expect(capped.json()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      retryable: false,
      reads: { used: 2, max: 2 },
    })
    expect(reader.calls).toBe(2)
  })

  it('returns 200 with a reason when the provider fails, and the shift still closes', async () => {
    const failing: OcrReader = {
      available: true,
      model: 'exploding',
      cacheSignature: (field) => `exploding-v1:${field}`,
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
      cacheSignature: (field) => `exploding-v1:${field}`,
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

  it('completes the reservation when an adapter unexpectedly throws', async () => {
    let calls = 0
    const throwing: OcrReader = {
      available: true,
      model: 'throwing',
      cacheSignature: (field) => `throwing-v1:${field}`,
      read: async () => {
        calls += 1
        throw new Error('adapter bug')
      },
    }
    h = await makeHarness({ ocr: throwing })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const first = await read(driver, shiftId, 'orders')
    expect(first.json()).toMatchObject({ ok: false, reason: 'unavailable', cached: false })
    const duplicate = await read(driver, shiftId, 'orders')
    expect(duplicate.json()).toMatchObject({ ok: false, reason: 'unavailable', cached: true })
    expect(calls).toBe(1)
  })

  it('ends a stalled BMS read at the API deadline and durably caches a named timeout', async () => {
    let calls = 0
    let providerSignal: Parameters<OcrReader['read']>[0]['signal']
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const stalled: OcrReader = {
      available: true,
      model: 'stalled-bms',
      cacheSignature: (field) => `stalled-bms-v1:${field}`,
      read: async (request): Promise<OcrReading> => {
        calls += 1
        providerSignal = request.signal
        markEntered()
        // Deliberately ignore AbortSignal. The API lifecycle guard must still settle the response
        // and complete the paid reservation instead of waiting for Vercel to kill the socket.
        return await new Promise<OcrReading>(() => undefined)
      },
    }
    h = await makeHarness({ ocr: stalled })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const pending = readScreen(h.deps, {
      shiftId,
      field: 'bms',
      bytes: TINY_JPEG,
      requestedBy: 'u-d1',
      maxReadsPerShift: 15,
      deadlineMs: 10,
    })
    await entered
    const timedOut = await pending

    expect(timedOut).toMatchObject({
      result: { ok: false, reason: 'timeout' },
      cached: false,
      retryable: true,
      reads: { used: 1 },
    })
    expect(providerSignal?.aborted).toBe(true)

    const duplicate = await readScreen(h.deps, {
      shiftId,
      field: 'bms',
      bytes: TINY_JPEG,
      requestedBy: 'u-d1',
      maxReadsPerShift: 15,
      deadlineMs: 10,
    })
    expect(duplicate).toMatchObject({ result: { ok: false, reason: 'timeout' }, cached: true })
    expect(calls, 'the completed timeout reservation must prevent an automatic second bill').toBe(1)
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
    expect(res.json().retryable).toBe(false)

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

describe('deleting an evidence photo', () => {
  const del = async (token: string, shiftId: string, pkg: string, slot: string): Promise<LightMyRequestResponse> => {
    const draft = pkg === 'end' ? await h.deps.closeDrafts.findByShift(shiftId) : null
    const attachment = pkg === 'end'
      ? (await h.deps.media.listSlots(shiftId)).find((row) => row.package === 'end' && row.slot === slot)
      : null
    return h.app.inject({
      method: 'DELETE',
      url: `/shifts/${shiftId}/media/${pkg}/${slot}`,
      headers: {
        cookie: h.cookie(token),
        ...(draft === null ? {} : { 'x-close-draft-revision': String(draft.revision) }),
        ...(pkg !== 'end'
          ? {}
          : { 'x-expected-attachment-token': attachment?.attachmentToken ?? 'missing-slot-token' }),
      },
    })
  }

  it('releases the slot and reports what is left', async () => {
    h = await makeHarness()
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await h.uploadPhoto(driver, shiftId, 'end', 'dashboard')
    await h.uploadPhoto(driver, shiftId, 'end', 'dashboard_2')
    const res = await del(driver, shiftId, 'end', 'dashboard_2')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().slots).toEqual(['dashboard'])
  })

  it('CANNOT be used to delete past a gate', async () => {
    /*
     * The property that makes this safe to give a driver at all. The BR5 gates read the slot
     * links, so removing a photo he still owes fails his own gate immediately — he can correct a
     * mistake or drop a surplus page, but he cannot delete his way to a close.
     */
    h = await makeHarness()
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    await put(driver, `/shifts/${shiftId}/operations`, {
      orders: [{ providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), source: 'manual' }],
      movements: [],
    })
    await h.uploadPhoto(driver, shiftId, 'end', 'dashboard')
    await h.uploadPhoto(driver, shiftId, 'end', 'wallet')
    await h.uploadPhoto(driver, shiftId, 'end', 'odometer')

    // Take the wallet photo back out, then try to close on money that balances perfectly.
    expect((await del(driver, shiftId, 'end', 'wallet')).statusCode).toBe(200)
    const end = await put(driver, `/shifts/${shiftId}/end-package`, {
      odometerKm: 150,
      batteryPercent: 40,
      cashDeclared: sypStr(104_000),
      walletDeclared: sypStr(0),
    })
    expect(end.statusCode, 'a missing photo must still block the close').toBe(422)
    expect(JSON.stringify(end.json())).toContain('missing_photo')

    // Put it back and the same submission goes through.
    await h.uploadPhoto(driver, shiftId, 'end', 'wallet')
    const again = await put(driver, `/shifts/${shiftId}/end-package`, {
      odometerKm: 150,
      batteryPercent: 40,
      cashDeclared: sypStr(104_000),
      walletDeclared: sypStr(0),
    })
    expect(again.statusCode, again.body).toBe(200)
  })

  it('refuses once the shift has left the driver’s hands', async () => {
    // After submission the manager is looking at this evidence to approve money. Pulling a photo
    // out from under that review is an audit decision, not a UX one.
    h = await makeHarness()
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    await put(driver, `/shifts/${shiftId}/operations`, {
      orders: [{ providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), source: 'manual' }],
      movements: [],
    })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, shiftId, 'end', slot)
    await put(driver, `/shifts/${shiftId}/end-package`, {
      odometerKm: 150, batteryPercent: 40, cashDeclared: sypStr(104_000), walletDeclared: sypStr(0),
    })
    await post(driver, `/shifts/${shiftId}/submit`)

    const res = await del(driver, shiftId, 'end', 'wallet')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_not_editable')
  })

  it('refuses another driver’s shift, and an unknown slot', async () => {
    h = await makeHarness()
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const other = await h.loginAs('driver2')
    const shiftId = await openShift(driver, manager)
    await h.uploadPhoto(driver, shiftId, 'end', 'dashboard')

    expect((await del(other, shiftId, 'end', 'dashboard')).statusCode).toBe(403)
    expect((await del(driver, shiftId, 'end', 'not_a_slot')).statusCode).toBe(422)
  })
})
