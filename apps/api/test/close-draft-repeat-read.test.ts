import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CloseDraftView, OcrField, OcrReader, OcrReading, OcrResult } from '@ash/contracts'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, today } from './harness.ts'

// Thaer's shift 4f40640e read one dashboard photo twice, three seconds apart. The OCR layer served
// the second call from its content-hash cache and charged nothing — but the close draft appended a
// second read row and a second full set of observations, so five scanned rows became ten stored
// sightings. These tests pin that a second complete read of the same attachment generation is an
// idempotent no-op, without disturbing the retry path a genuinely failed read still needs.

type OcrRequest = Parameters<OcrReader['read']>[0]

const ok = (...rows: Extract<OcrResult, { ok: true }>['rows']): OcrResult => ({
  ok: true,
  rows,
  fields: {},
  raw: null,
})

const orderRow = (
  value: string,
  rowIndex: number,
  time: string,
): Extract<OcrResult, { ok: true }>['rows'][number] => ({
  printed: `${value} SYP`,
  printedTime: time,
  value,
  cancelled: false,
  time,
  dateIso: today,
  pointA: `Pickup ${rowIndex}`,
  pointB: `Dropoff ${rowIndex}`,
  rowIndex,
  rowCount: 5,
  dateSection: today,
  // Fractions of the page height: shift_close_draft_observations bounds them to [0,1].
  yTop: rowIndex * 0.2,
  yBottom: rowIndex * 0.2 + 0.15,
})

/** The five rows of one dashboard page. */
const PAGE = ok(
  orderRow('150.00', 0, '01:00'),
  orderRow('215.00', 1, '00:37'),
  orderRow('130.00', 2, '23:48'),
  orderRow('125.00', 3, '22:47'),
  orderRow('120.00', 4, '22:21'),
)

class ControlledOcrReader implements OcrReader {
  readonly available = true
  readonly model = 'close-draft-repeat-read'
  calls = 0
  private readonly answers: OcrResult[] = []
  private readonly gates = new Map<number, { entered: () => void; wait: Promise<void>; release: () => void }>()

  cacheSignature(field: OcrField): string {
    return `close-draft-repeat-read-1:${field}`
  }

  push(...answers: OcrResult[]): void {
    this.answers.push(...answers)
  }

  block(call: number): { entered: Promise<void>; release: () => void } {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    this.gates.set(call, { entered: enter, wait, release })
    return { entered, release }
  }

  async read(_request: OcrRequest): Promise<OcrReading> {
    this.calls += 1
    const call = this.calls
    const gate = this.gates.get(call)
    if (gate) {
      gate.entered()
      await gate.wait
    }
    return {
      result: this.answers[call - 1] ?? ok(),
      usage: { tokensIn: 10, tokensOut: 5, latencyMs: 1 },
    }
  }
}

let h: Harness
let reader: ControlledOcrReader

beforeEach(async () => {
  reader = new ControlledOcrReader()
  h = await makeHarness({ ocr: reader, maxOcrReadsPerShift: 50 })
})

afterEach(async () => {
  await h.app.close()
})

const inject = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  token: string,
  url: string,
  payload?: Buffer | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> => h.app.inject({
  method,
  url,
  headers: { cookie: h.cookie(token), ...headers },
  ...(payload === undefined ? {} : { payload }),
})

async function openShift(): Promise<{ driver: string; shiftId: string }> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const created = await inject('POST', driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    shiftNo: 1,
  })
  expect(created.statusCode, created.body).toBe(201)
  const shiftId = created.json().id as string
  await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
  const start = await inject('PUT', driver, `/shifts/${shiftId}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })
  expect(start.statusCode, start.body).toBe(200)
  const approved = await inject('POST', manager, `/shifts/${shiftId}/approve-open`, {
    floatTranches: [],
    topupTranches: [],
  })
  expect(approved.statusCode, approved.body).toBe(200)
  return { driver, shiftId }
}

async function getDraft(driver: string, shiftId: string): Promise<CloseDraftView> {
  const response = await inject('GET', driver, `/shifts/${shiftId}/close-draft`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as CloseDraftView
}

async function uploadEnd(
  driver: string,
  shiftId: string,
  slot: string,
  bytes: Buffer,
  draft: CloseDraftView,
  options: { replace?: boolean } = {},
): Promise<LightMyRequestResponse> {
  const currentToken = draft.attachments.find((attachment) => attachment.slot === slot)?.attachmentToken ?? null
  return inject('PUT', driver, `/shifts/${shiftId}/media/end/${slot}`, bytes, {
    'content-type': 'image/jpeg',
    'x-close-draft-revision': String(draft.revision),
    'x-stale-evidence-acknowledged': 'true',
    ...(options.replace ? { 'x-replace-confirmed': 'true' } : {}),
    ...(currentToken === null ? {} : { 'x-expected-attachment-token': currentToken }),
  })
}

function readSlot(
  driver: string,
  shiftId: string,
  slot: string,
  field: OcrField,
  draft: CloseDraftView,
  retryFailed = false,
): Promise<LightMyRequestResponse> {
  const attachment = draft.attachments.find((candidate) => candidate.slot === slot)
  if (!attachment) throw new Error(`missing ${slot} attachment`)
  return inject('POST', driver, `/shifts/${shiftId}/close-draft/media/${slot}/read`, {
    expectedRevision: draft.revision,
    mediaId: attachment.mediaId,
    attachmentToken: attachment.attachmentToken,
    field,
    retryFailed,
  }, field === 'orders' ? { 'x-ash-orders-time-consensus': 'close-draft-v1' } : {})
}

const image = (name: string): Buffer => Buffer.concat([TINY_JPEG, Buffer.from(`:${name}`, 'utf8')])

/** Every stored observation for one shift, regardless of which read wrote it. */
const observationsFor = (shiftId: string): unknown[] =>
  [...h.deps.closeDrafts.observations.values()].filter(
    (observation) => (observation as { shiftId?: string }).shiftId === shiftId,
  )

async function uploadDashboard(driver: string, shiftId: string): Promise<CloseDraftView> {
  const draft = await getDraft(driver, shiftId)
  const uploaded = await uploadEnd(driver, shiftId, 'dashboard', image('dashboard'), draft)
  expect([200, 201], uploaded.body).toContain(uploaded.statusCode)
  return getDraft(driver, shiftId)
}

describe('a close-draft attachment is read at most once', () => {
  it('replays the incident: a second read of the same photo changes nothing', async () => {
    reader.push(PAGE, PAGE)
    const { driver, shiftId } = await openShift()
    const afterUpload = await uploadDashboard(driver, shiftId)

    const first = await readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    expect(first.statusCode, first.body).toBe(200)
    const afterFirst = await getDraft(driver, shiftId)
    expect(afterFirst.operations.orders).toHaveLength(5)
    expect(observationsFor(shiftId)).toHaveLength(5)

    const second = await readSlot(driver, shiftId, 'dashboard', 'orders', afterFirst)
    expect(second.statusCode, second.body).toBe(200)
    const afterSecond = await getDraft(driver, shiftId)

    // The photo is byte-identical, so the OCR layer never calls the provider twice. What this pins
    // is the draft ledger: no second read row, no second set of sightings, no revision churn.
    expect(reader.calls).toBe(1)
    expect(await h.deps.ocrReads.countBilledForShift(shiftId)).toBe(1)
    expect(observationsFor(shiftId)).toHaveLength(5)
    expect(afterSecond.operations.orders).toHaveLength(5)
    expect(afterSecond.attachments.find((a) => a.slot === 'dashboard')?.read?.attempts).toBe(1)
    expect(afterSecond.revision).toBe(afterFirst.revision)
  })

  it('coalesces two in-flight reads of the same photo', async () => {
    reader.push(PAGE, PAGE)
    const gate = reader.block(1)
    const { driver, shiftId } = await openShift()
    const afterUpload = await uploadDashboard(driver, shiftId)

    const a = readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    await gate.entered
    const b = readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    gate.release()
    const [first, second] = await Promise.all([a, b])

    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)
    const draft = await getDraft(driver, shiftId)
    expect(observationsFor(shiftId)).toHaveLength(5)
    expect(draft.operations.orders).toHaveLength(5)
  })

  it('still allows a retry after a failed read', async () => {
    reader.push({ ok: false, reason: 'no_fields', retryable: true, raw: null } as OcrResult, PAGE)
    const { driver, shiftId } = await openShift()
    const afterUpload = await uploadDashboard(driver, shiftId)

    const failed = await readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    expect(failed.statusCode, failed.body).toBe(200)
    const afterFailure = await getDraft(driver, shiftId)
    expect(afterFailure.attachments.find((a) => a.slot === 'dashboard')?.read?.status).toBe('failed')
    expect(observationsFor(shiftId)).toHaveLength(0)

    const retried = await readSlot(driver, shiftId, 'dashboard', 'orders', afterFailure, true)
    expect(retried.statusCode, retried.body).toBe(200)
    const afterRetry = await getDraft(driver, shiftId)
    expect(afterRetry.attachments.find((a) => a.slot === 'dashboard')?.read?.status).toBe('complete')
    expect(observationsFor(shiftId)).toHaveLength(5)
    expect(afterRetry.operations.orders).toHaveLength(5)
  })

  it('treats a replaced photo as a new page, not a repeat', async () => {
    reader.push(PAGE, ok(orderRow('999.00', 0, '21:00')))
    const { driver, shiftId } = await openShift()
    const afterUpload = await uploadDashboard(driver, shiftId)

    const first = await readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    expect(first.statusCode, first.body).toBe(200)
    const afterFirst = await getDraft(driver, shiftId)

    const replaced = await uploadEnd(driver, shiftId, 'dashboard', image('replacement'), afterFirst, { replace: true })
    expect([200, 201], replaced.body).toContain(replaced.statusCode)
    const afterReplace = await getDraft(driver, shiftId)

    const second = await readSlot(driver, shiftId, 'dashboard', 'orders', afterReplace)
    expect(second.statusCode, second.body).toBe(200)

    // A rotated attachment token is a different page by definition, so the guard must not fire.
    expect(reader.calls).toBe(2)
  })
  it('still collapses duplicate sightings to one order per row when two reads do land', async () => {
    // Thaer's shift already holds two complete reads of one page, and no guard can retroactively
    // remove append-only evidence. What kept that from becoming ten orders is `mergeLinkedRows`
    // matching on the page-scoped clientKey. An explicit re-read is the one path that still writes
    // a second complete read, so it is also the way to keep that collapse under test.
    reader.push(PAGE, PAGE)
    const { driver, shiftId } = await openShift()
    const afterUpload = await uploadDashboard(driver, shiftId)

    const first = await readSlot(driver, shiftId, 'dashboard', 'orders', afterUpload)
    expect(first.statusCode, first.body).toBe(200)
    const afterFirst = await getDraft(driver, shiftId)

    const again = await readSlot(driver, shiftId, 'dashboard', 'orders', afterFirst, true)
    expect(again.statusCode, again.body).toBe(200)
    const afterAgain = await getDraft(driver, shiftId)

    expect(observationsFor(shiftId).length).toBeGreaterThan(5)
    expect(afterAgain.operations.orders).toHaveLength(5)
    expect(new Set(afterAgain.operations.orders.map((order) => order.clientKey)).size).toBe(5)
  })
})
