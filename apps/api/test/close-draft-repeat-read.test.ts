import type { LightMyRequestResponse } from 'fastify'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloseDraftView, OcrField, OcrReader, OcrReading, OcrResult } from '@ash/contracts'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, today } from './harness.ts'
import {readFileSync} from 'node:fs'
const dailySummaryFixtures = JSON.parse(readFileSync(new URL('../../../test-fixtures/daily-summary.json',import.meta.url),'utf8')) as Array<{
  name:string;photoSha256:string;fields:Record<string,string>
}>

// Thaer's shift 4f40640e read one dashboard photo twice, three seconds apart. The OCR layer served
// the second call from its content-hash cache and charged nothing — but the close draft appended a
// second read row and a second full set of observations, so five scanned rows became ten stored
// sightings. These tests pin that a second complete read of the same attachment generation is an
// idempotent no-op, without disturbing the retry path a genuinely failed read still needs.

type OcrRequest = Parameters<OcrReader['read']>[0]

const ok = (...rows: Extract<OcrResult, { ok: true }>['rows']): Extract<OcrResult, { ok: true }> => ({
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

describe('untrusted image amounts cannot crash draft materialisation', () => {
  it('validates an old cached successful answer without charging another OCR call', async () => {
    reader.push(ok(orderRow('125.50', 0, '08:00')))
    const { driver, shiftId } = await openShift()
    const bytes = image('old-cache')
    await uploadEnd(driver, shiftId, 'payments_log', bytes, await getDraft(driver, shiftId))
    const response = await inject('POST', driver, `/shifts/${shiftId}/ocr/payments_log`, bytes,
      { 'content-type': 'image/jpeg' })
    expect(response.statusCode).toBe(200)
    const shift = (await h.deps.shifts.findById(shiftId))!
    const cached = (await h.deps.ocrReads.findBySha(shift.branchId,
      createHash('sha256').update(bytes).digest('hex'), 'payments_log', reader.cacheSignature('payments_log')))!
    cached.result = ok(orderRow('not a number', 0, '08:00'))
    const cachedResponse = await inject('POST', driver, `/shifts/${shiftId}/ocr/payments_log`, bytes,
      { 'content-type': 'image/jpeg' })
    expect(cachedResponse.json()).toMatchObject({ ok: false, cached: true, retryable: false })
    const linked = await readSlot(driver, shiftId, 'payments_log', 'payments_log', await getDraft(driver, shiftId))
    expect(linked.statusCode, linked.body).toBe(200)
    expect(linked.json().draft.attachments.find((a: {slot: string}) => a.slot === 'payments_log').read)
      .toMatchObject({ status: 'failed', failure: 'no_fields' })
    expect(reader.calls).toBe(1)
    expect((await getDraft(driver, shiftId)).operations.movements).toHaveLength(0)
  })

  it('cannot read into or mutate an approved shift', async () => {
    const { driver, shiftId } = await openShift()
    const draft = await uploadDashboard(driver, shiftId)
    const shift = (await h.deps.shifts.findById(shiftId))!
    await h.deps.shifts.update({ ...shift, state: 'approved' }, null)
    const posted = vi.spyOn(h.deps.ledger, 'post'), changed = vi.spyOn(h.deps.shifts, 'update')
    const response = await readSlot(driver, shiftId, 'dashboard', 'orders', draft)
    expect(response.statusCode, response.body).toBe(409)
    expect((await h.deps.shifts.findById(shiftId))?.state).toBe('approved')
    expect(reader.calls).toBe(0)
    expect(posted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('does not accept a JSON number masquerading as exact monetary text', async () => {
    reader.push(ok({ ...orderRow('5', 0, '08:00'), value: 5 as unknown as string }))
    const { driver, shiftId } = await openShift()
    const draft = await uploadDashboard(driver, shiftId)
    const response = await readSlot(driver, shiftId, 'dashboard', 'orders', draft)
    expect(response.statusCode, response.body).toBe(200)
    expect((await getDraft(driver, shiftId)).operations.orders[0]).toMatchObject({
      fee: null, included: false, reviewRequired: true,
    })
  })
  it.each(['not readable', '1,234.50', '12.3.4', '1e3', '12.345', '92233720368547758.08']) (
    'returns a failed archival read, not HTTP500 or guessed money: %s', async value => {
      reader.push(ok(orderRow(value, 0, '08:00')))
      const { driver, shiftId } = await openShift()
      const before = await getDraft(driver, shiftId)
      const posted = vi.spyOn(h.deps.ledger, 'post')
      const shifted = vi.spyOn(h.deps.shifts, 'update')
      const uploaded = await uploadEnd(driver, shiftId, 'payments_log', image(value), before)
      expect(uploaded.statusCode, uploaded.body).toBe(201)
      const response = await readSlot(driver, shiftId, 'payments_log', 'payments_log', await getDraft(driver, shiftId))
      expect(response.statusCode, response.body).toBe(200)
      const draft = await getDraft(driver, shiftId)
      expect(draft.attachments.find(a => a.slot === 'payments_log')?.read)
        .toMatchObject({ status: 'failed', failure: 'no_fields' })
      expect(draft.operations).toEqual(before.operations)
      expect(posted).not.toHaveBeenCalled()
      expect(shifted).not.toHaveBeenCalled()
      // Retrying an old answer cannot bypass the publication guard or charge automatically.
      const again = await readSlot(driver, shiftId, 'payments_log', 'payments_log', draft)
      expect(again.statusCode, again.body).toBe(200)
      expect(reader.calls).toBe(1)
    },
  )

  it('accepts an explicit positive sign exactly and keeps archival movements idempotent', async () => {
    reader.push(ok(orderRow('+125.50', 0, '08:00'), orderRow('-5.00', 1, '08:01')))
    const { driver, shiftId } = await openShift()
    const before = await getDraft(driver, shiftId)
    await uploadEnd(driver, shiftId, 'payments_log', image('signed-amounts'), before)
    const posted = vi.spyOn(h.deps.ledger, 'post')
    const first = await readSlot(driver, shiftId, 'payments_log', 'payments_log', await getDraft(driver, shiftId))
    expect(first.statusCode, first.body).toBe(200)
    const draft = await getDraft(driver, shiftId)
    expect(draft.operations.movements.map(row => row.amount)).toEqual(['125.50', '-5.00'])
    const again = await readSlot(driver, shiftId, 'payments_log', 'payments_log', draft)
    expect(again.statusCode, again.body).toBe(200)
    expect((await getDraft(driver, shiftId)).operations.movements).toHaveLength(2)
    expect(reader.calls).toBe(1)
    expect(posted).not.toHaveBeenCalled()
  })

  it('keeps clear archival rows and unknown observations while marking the page incomplete', async () => {
    reader.push(ok(orderRow('+125.50', 0, '08:00'), orderRow('not readable', 1, '08:01')))
    const { driver, shiftId } = await openShift()
    const before = await getDraft(driver, shiftId)
    const posted = vi.spyOn(h.deps.ledger, 'post')
    const uploaded = await uploadEnd(driver, shiftId, 'payments_log', image('partial-archive'), before)
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    const first = await readSlot(driver, shiftId, 'payments_log', 'payments_log', await getDraft(driver, shiftId))
    expect(first.statusCode, first.body).toBe(200)
    const draft = first.json().draft as CloseDraftView
    expect(draft.operations.movements).toHaveLength(1)
    expect(draft.operations.movements[0]).toMatchObject({ amount: '125.50', role: 'unmatched' })
    expect(draft.attachments.find(a => a.slot === 'payments_log')?.read)
      .toMatchObject({ status: 'failed', failure: 'no_fields', rowCount: 2 })
    expect(first.json().rows[1]).toMatchObject({ value: null, reviewRequired: true })
    expect(observationsFor(shiftId)).toHaveLength(2)
    const again = await readSlot(driver, shiftId, 'payments_log', 'payments_log', await getDraft(driver, shiftId))
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().draft.operations.movements).toHaveLength(1)
    expect(reader.calls).toBe(1)
    expect(again.json().draft.revision).toBe(draft.revision)
    expect(observationsFor(shiftId)).toHaveLength(2)
    expect(posted).not.toHaveBeenCalled()
  })

  it.each(['unknown', '92233720368547758.08', '-92233720368547758.08']) (
    'keeps an invalid order amount visible for review, never zero: %s', async value => {
      reader.push(ok(orderRow(value, 0, '08:00')))
      const { driver, shiftId } = await openShift()
      const draft = await uploadDashboard(driver, shiftId)
      const response = await readSlot(driver, shiftId, 'dashboard', 'orders', draft)
      expect(response.statusCode, response.body).toBe(200)
      expect((await getDraft(driver, shiftId)).operations.orders[0]).toMatchObject({
        fee: null, feeOcr: null, included: false, reviewRequired: true,
        reviewReasons: expect.arrayContaining(['missing_money']),
      })
      expect(observationsFor(shiftId)).toHaveLength(1)
    },
  )

  it('never interprets a non-money odometer row as a monetary amount', async () => {
    reader.push({ ...ok(orderRow('1,234 km', 0, '08:00')), fields: { odometer: '1234' } })
    const { driver, shiftId } = await openShift()
    const before = await getDraft(driver, shiftId)
    await uploadEnd(driver, shiftId, 'odometer', image('distance-with-unit'), before)
    const response = await readSlot(driver, shiftId, 'odometer', 'odometer', await getDraft(driver, shiftId))
    expect(response.statusCode, response.body).toBe(200)
    expect((await getDraft(driver, shiftId)).figures.odometerKmOcr).toBe(1234)
  })
})

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


describe('optional daily summary evidence', () => {
  it.each(dailySummaryFixtures)('persists the five verified fields and restores them in both views: $name', async fixture => {
    const {driver,shiftId}=await openShift()
    reader.push({ok:true,rows:[],fields:{...fixture.fields},raw:null})
    const upload=await uploadEnd(driver,shiftId,'daily_summary',image(fixture.photoSha256),await getDraft(driver,shiftId))
    expect(upload.statusCode,upload.body).toBe(201)
    const before=structuredClone(await h.deps.shifts.findById(shiftId))
    const journals=structuredClone(h.deps.ledger.entries)
    const read=await readSlot(driver,shiftId,'daily_summary','daily_summary',await getDraft(driver,shiftId))
    expect(read.statusCode,read.body).toBe(200)
    let saved=await getDraft(driver,shiftId)
    expect(saved.attachments.find(a=>a.slot==='daily_summary')?.read).toMatchObject({status:'complete',fields:fixture.fields})
    const date=await inject('PATCH',driver,`/shifts/${shiftId}/close-draft`,{expectedRevision:saved.revision,figures:{dailySummaryDate:'2026-11-04'}})
    expect(date.statusCode,date.body).toBe(200)
    saved=await getDraft(driver,shiftId)
    const retry=await readSlot(driver,shiftId,'daily_summary','daily_summary',saved,true)
    expect(retry.statusCode,retry.body).toBe(200)
    expect((await getDraft(driver,shiftId)).revision).toBe(saved.revision)
    for(const [token,suffix] of [[driver,'/driver'],[await h.loginAs('manager'),'']] as const){
      const ref=await inject('GET',token,`/shifts/${shiftId}/close-reference${suffix}`)
      expect(ref.statusCode,ref.body).toBe(200)
      expect(ref.json().summary).toMatchObject({date:'2026-11-04',read:{status:'complete',fields:fixture.fields}})
    }
    expect(reader.calls).toBe(1)
    expect(saved.operations.orders).toHaveLength(0)
    expect(await h.deps.shifts.findById(shiftId)).toEqual(before)
    expect(h.deps.ledger.entries).toEqual(journals)
  })

  it('recovers the paid receipt after a failed save without a second provider call', async()=>{
    const {driver,shiftId}=await openShift()
    const fields=dailySummaryFixtures[0]!.fields
    reader.push({ok:true,rows:[],fields:{...fields},raw:null})
    await uploadEnd(driver,shiftId,'daily_summary',image('save-failed-summary'),await getDraft(driver,shiftId))
    const before=await getDraft(driver,shiftId)
    const save=vi.spyOn(h.deps.closeDrafts,'saveRead').mockRejectedValueOnce(Object.assign(new Error('fixture constraint'),{code:'23514'}))
    const failed=await readSlot(driver,shiftId,'daily_summary','daily_summary',before)
    expect(failed.statusCode,failed.body).toBe(503)
    expect(failed.json().error).toBe('daily_summary_save_failed')
    expect((await getDraft(driver,shiftId)).revision).toBe(before.revision)
    expect(save).toHaveBeenCalledTimes(1)
    const retry=await readSlot(driver,shiftId,'daily_summary','daily_summary',await getDraft(driver,shiftId),true)
    expect(retry.statusCode,retry.body).toBe(200)
    expect((await getDraft(driver,shiftId)).attachments.find(a=>a.slot==='daily_summary')?.read)
      .toMatchObject({status:'complete',fields})
    expect(reader.calls).toBe(1)
  })

  it('does not restore a summary into an approved shift',async()=>{
    const {driver,shiftId}=await openShift()
    await uploadEnd(driver,shiftId,'daily_summary',image('approved-summary'),await getDraft(driver,shiftId))
    const draft=await getDraft(driver,shiftId),shift=(await h.deps.shifts.findById(shiftId))!
    await h.deps.shifts.update({...shift,state:'approved'},null)
    const posted=vi.spyOn(h.deps.ledger,'post'),changed=vi.spyOn(h.deps.shifts,'update')
    const result=await readSlot(driver,shiftId,'daily_summary','daily_summary',draft)
    expect(result.statusCode).toBe(409)
    expect(reader.calls).toBe(0)
    expect(posted).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect((await getDraft(driver,shiftId)).revision).toBe(draft.revision)
  })
  it('persists scalar readings without creating orders or changing financial figures', async () => {
    const {driver, shiftId} = await openShift()
    let before = structuredClone(await h.deps.shifts.findById(shiftId))
    const journals = structuredClone(h.deps.ledger.entries)
    reader.push({ok:true, rows:[], fields:{grossTotal:'4645.00', blueTotal:'3736.00', trips:'14', distanceKm:'103', onlineMinutes:'772'}, raw:null})
    const upload = await uploadEnd(driver, shiftId, 'daily_summary', image('home-summary'), await getDraft(driver, shiftId))
    expect(upload.statusCode, upload.body).toBe(201)
    before = structuredClone(await h.deps.shifts.findById(shiftId))
    const response = await readSlot(driver, shiftId, 'daily_summary', 'daily_summary', await getDraft(driver, shiftId))
    expect(response.statusCode, response.body).toBe(200)
    const saved = await getDraft(driver, shiftId)
    expect(saved.attachments.find(x => x.slot === 'daily_summary')?.read?.fields?.grossTotal).toBe('4645.00')
    expect(saved.operations.orders).toHaveLength(0)
    expect(await h.deps.shifts.findById(shiftId)).toEqual(before)
    expect(h.deps.ledger.entries).toEqual(journals)
    const manager = await h.loginAs('manager')
    const reference = await inject('GET', manager, `/shifts/${shiftId}/close-reference`)
    expect(reference.statusCode, reference.body).toBe(200)
    expect(reference.json().summary.read.fields.trips).toBe('14')
  })
})
