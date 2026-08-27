import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CloseDraftView, OcrField, OcrReader, OcrReading, OcrResult } from '@ash/contracts'
import { scanOverlapCauseSchema, scanOverlapPairCauseSchema } from '@ash/contracts'
import { SCAN_OVERLAP_CAUSES, SCAN_OVERLAP_PAIR_CAUSES } from '@ash/domain'
import { DRIVER_ID, type Harness, TINY_JPEG, VEHICLE_ID, makeHarness, today } from './harness.ts'

// Shift 4f40640e, 2026-08-25: one Recent Orders list photographed twice while scrolling. The second
// shot scrolled past its date header, so none of its rows carried a clock and the time-keyed
// matchers were blind to the fact that its first two rows were the previous shot's last two. Five
// undated rows reached the manager with nothing to say two of them were already counted, and under
// decision 13 the resulting variance is paid straight to the employee.

type OcrRequest = Parameters<OcrReader['read']>[0]
type Row = Extract<OcrResult, { ok: true }>['rows'][number]

const ok = (rows: Row[], fields: Record<string, string> = {}): OcrResult => ({
  ok: true,
  rows,
  fields,
  raw: null,
})

/** A row as the reader sees it on a page whose date header is visible. */
const dated = (value: string, rowIndex: number, clock: string, route: string): Row => ({
  printed: `${value} SYP`,
  printedTime: clock,
  value,
  cancelled: false,
  time: clock.slice(0, 5),
  dateIso: today,
  pointA: route,
  pointB: `${route} dropoff`,
  rowIndex,
  rowCount: 5,
  dateSection: today,
  yTop: rowIndex * 0.2,
  yBottom: rowIndex * 0.2 + 0.15,
})

/** The same shape after the header scrolled off: an amount, and nothing else to identify it. */
const undated = (value: string, rowIndex: number): Row => ({
  printed: `${value} SYP`,
  printedTime: null,
  value,
  cancelled: false,
  time: null,
  dateIso: null,
  pointA: null,
  pointB: null,
  rowIndex,
  rowCount: 5,
  dateSection: null,
  yTop: rowIndex * 0.2,
  yBottom: rowIndex * 0.2 + 0.15,
})

// Page one, fully legible. The -50.00 row is a cash deduction, not an order.
const PAGE_ONE = ok([
  dated('150.00', 0, '08:00 AM', 'Omaya'),
  dated('215.00', 1, '08:05 AM', 'Roud'),
  dated('-50.00', 2, '08:10 AM', 'Juzour'),
  dated('130.00', 3, '08:15 AM', 'Golden'),
  dated('125.00', 4, '08:20 AM', 'Mastaba'),
])

// Page two, scrolled. Rows 0 and 1 are page one's rows 3 and 4 all over again.
const PAGE_TWO = ok([
  undated('130.00', 0),
  undated('125.00', 1),
  undated('130.00', 2),
  undated('280.00', 3),
  undated('270.00', 4),
])

const WALLET = ok([{ ...undated('0.00', 0), rowCount: 1 }])
const ODOMETER = ok([], { odometer: '1010' })
const BMS = ok([], { percent: '50' })

class SequencedOcrReader implements OcrReader {
  readonly available = true
  readonly model = 'scan-page-overlap'
  calls = 0
  private readonly answers: OcrResult[] = []

  cacheSignature(field: OcrField): string {
    return `scan-page-overlap-1:${field}`
  }

  push(...answers: OcrResult[]): void {
    this.answers.push(...answers)
  }

  async read(_request: OcrRequest): Promise<OcrReading> {
    this.calls += 1
    return {
      result: this.answers[this.calls - 1] ?? ok([]),
      usage: { tokensIn: 10, tokensOut: 5, latencyMs: 1 },
    }
  }
}

let h: Harness
let reader: SequencedOcrReader

beforeEach(async () => {
  reader = new SequencedOcrReader()
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

const image = (name: string): Buffer => Buffer.concat([TINY_JPEG, Buffer.from(`:${name}`, 'utf8')])

async function getDraft(driver: string, shiftId: string): Promise<CloseDraftView> {
  const response = await inject('GET', driver, `/shifts/${shiftId}/close-draft`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as CloseDraftView
}

async function uploadEnd(
  driver: string,
  shiftId: string,
  slot: string,
  draft: CloseDraftView,
): Promise<CloseDraftView> {
  const token = draft.attachments.find((attachment) => attachment.slot === slot)?.attachmentToken ?? null
  const response = await inject('PUT', driver, `/shifts/${shiftId}/media/end/${slot}`, image(slot), {
    'content-type': 'image/jpeg',
    'x-close-draft-revision': String(draft.revision),
    'x-stale-evidence-acknowledged': 'true',
    ...(token === null ? {} : { 'x-expected-attachment-token': token }),
  })
  expect([200, 201], response.body).toContain(response.statusCode)
  return getDraft(driver, shiftId)
}

async function readSlot(
  driver: string,
  shiftId: string,
  slot: string,
  field: OcrField,
  draft: CloseDraftView,
  retryFailed = false,
): Promise<CloseDraftView> {
  const attachment = draft.attachments.find((candidate) => candidate.slot === slot)
  if (!attachment) throw new Error(`missing ${slot} attachment`)
  const response = await inject('POST', driver, `/shifts/${shiftId}/close-draft/media/${slot}/read`, {
    expectedRevision: draft.revision,
    mediaId: attachment.mediaId,
    attachmentToken: attachment.attachmentToken,
    field,
    retryFailed,
  }, field === 'orders' ? { 'x-ash-orders-time-consensus': 'close-draft-v1' } : {})
  expect(response.statusCode, response.body).toBe(200)
  return response.json().draft as CloseDraftView
}

/** Open a shift, scan both overlapping dashboard pages plus the scalar evidence, and submit. */
async function submitOverlappingClose(): Promise<{ manager: string; driver: string; shiftId: string }> {
  reader.push(PAGE_ONE, PAGE_TWO, WALLET, ODOMETER, BMS)
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
  expect((await inject('PUT', driver, `/shifts/${shiftId}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })).statusCode).toBe(200)
  expect((await inject('POST', manager, `/shifts/${shiftId}/approve-open`, {
    floatTranches: [],
    topupTranches: [],
  })).statusCode).toBe(200)

  let draft = await getDraft(driver, shiftId)
  for (const slot of ['dashboard', 'dashboard_2', 'wallet', 'odometer', 'bms_1']) {
    draft = await uploadEnd(driver, shiftId, slot, draft)
  }
  draft = await readSlot(driver, shiftId, 'dashboard', 'orders', draft)
  draft = await readSlot(driver, shiftId, 'dashboard_2', 'orders', draft)
  draft = await readSlot(driver, shiftId, 'wallet', 'wallet', draft)
  draft = await readSlot(driver, shiftId, 'odometer', 'odometer', draft)
  draft = await readSlot(driver, shiftId, 'bms_1', 'bms', draft)

  const patched = await inject('PATCH', driver, `/shifts/${shiftId}/close-draft`, {
    expectedRevision: draft.revision,
    figures: { odometerKm: 1_010, cashDeclared: '620.00', walletDeclared: '0.00' },
  })
  expect(patched.statusCode, patched.body).toBe(200)
  draft = patched.json() as CloseDraftView

  const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, {
    draftRevision: draft.revision,
    draftHash: draft.draftHash,
    odometerKm: 1_010,
    batteryPercent: 50,
    cashDeclared: '620.00',
    walletDeclared: '0.00',
  })
  expect(submitted.statusCode, submitted.body).toBe(200)
  return { manager, driver, shiftId }
}

const review = async (manager: string, shiftId: string): Promise<Record<string, any>> => {
  const response = await inject('GET', manager, `/shifts/${shiftId}/review`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Record<string, any>
}

describe('overlapping dashboard scans are surfaced to the manager', () => {
  it('names the two rows the second photo repeated, and says the match is amount-only', async () => {
    const { manager, shiftId } = await submitOverlappingClose()
    const body = await review(manager, shiftId)

    expect(body.duplicateHints).toHaveLength(1)
    const hint = body.duplicateHints[0]
    expect(hint.length).toBe(2)
    expect(hint.earlier.slot).toBe('dashboard')
    expect(hint.later.slot).toBe('dashboard_2')
    expect(hint.causes).toContain('scan_overlap_suffix_prefix')
    expect(hint.causes).toContain('scan_overlap_amount_only')

    // Both sides must name a real operation the manager can act on, not a bare row index.
    expect(hint.pairs).toHaveLength(2)
    for (const pair of hint.pairs) {
      expect(pair.earlier.kind).toBe('order')
      expect(pair.later.kind).toBe('order')
      expect(pair.earlier.providerOrderNo).not.toBe(pair.later.providerOrderNo)
    }
    expect(hint.pairs.map((pair: any) => pair.earlier.rowIndex)).toEqual([3, 4])
    expect(hint.pairs.map((pair: any) => pair.later.rowIndex)).toEqual([0, 1])
  })

  it('changes no money, no inclusion and no hash by being there', async () => {
    const { manager, shiftId } = await submitOverlappingClose()
    const first = await review(manager, shiftId)
    expect(first.duplicateHints.length).toBeGreaterThan(0)

    // The hint is advisory. Every figure a manager approves against must be identical to what the
    // un-hinted arithmetic produced, and the rows it points at must still be exactly as the
    // operation-window rules left them — excluded and unknown, awaiting HIS decision.
    const second = await review(manager, shiftId)
    expect(second.br1).toEqual(first.br1)
    expect(second.br1.ordersHash).toBe(first.br1.ordersHash)
    expect(second.orders).toEqual(first.orders)

    const flagged = new Set<string>()
    for (const pair of first.duplicateHints[0].pairs) flagged.add(pair.later.providerOrderNo)
    const flaggedOrders = first.orders.filter((order: any) => flagged.has(order.providerOrderNo))
    expect(flaggedOrders).toHaveLength(2)
    for (const order of flaggedOrders) {
      expect(order.included).toBe(false)
      expect(order.windowStatus).toBe('unknown')
      expect(order.decisionReason).toBeNull()
      expect(order.decidedBy).toBeNull()
    }
  })

  it('keeps the hint off the driver-facing shift state', async () => {
    const { driver, shiftId } = await submitOverlappingClose()
    const state = await inject('GET', driver, `/shifts/${shiftId}/state`)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json()).not.toHaveProperty('duplicateHints')
  })
  it('reads a twice-read page as one page, not as ten rows', async () => {
    // Production already holds exactly this: one dashboard with two complete reads, written before
    // the read guard existed, so ten stored rows describe five real ones. Building a page from both
    // reads would interleave duplicate row indices and compare the wrong rows against the other
    // page. Only the newest read of an attachment may build a page.
    reader.push(PAGE_ONE, PAGE_TWO, WALLET, ODOMETER, BMS)
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
    expect((await inject('PUT', driver, `/shifts/${shiftId}/start-package`, {
      odometerKm: 1_000,
      batteryPercent: 90,
    })).statusCode).toBe(200)
    expect((await inject('POST', manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
    })).statusCode).toBe(200)

    let draft = await getDraft(driver, shiftId)
    for (const slot of ['dashboard', 'dashboard_2', 'wallet', 'odometer', 'bms_1']) {
      draft = await uploadEnd(driver, shiftId, slot, draft)
    }
    draft = await readSlot(driver, shiftId, 'dashboard', 'orders', draft)
    draft = await readSlot(driver, shiftId, 'dashboard', 'orders', draft, true)
    draft = await readSlot(driver, shiftId, 'dashboard_2', 'orders', draft)
    draft = await readSlot(driver, shiftId, 'wallet', 'wallet', draft)
    draft = await readSlot(driver, shiftId, 'odometer', 'odometer', draft)
    draft = await readSlot(driver, shiftId, 'bms_1', 'bms', draft)

    const patched = await inject('PATCH', driver, `/shifts/${shiftId}/close-draft`, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '620.00', walletDeclared: '0.00' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    draft = patched.json() as CloseDraftView
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, {
      draftRevision: draft.revision,
      draftHash: draft.draftHash,
      odometerKm: 1_010,
      batteryPercent: 50,
      cashDeclared: '620.00',
      walletDeclared: '0.00',
    })
    expect(submitted.statusCode, submitted.body).toBe(200)

    // Precondition: the page really was read twice and really did store two sets of rows. Without
    // this the test would pass for the wrong reason — by there being nothing to overlap at all.
    const dashboardReads = [...h.deps.closeDrafts.reads.values()]
      .filter((read) => read.shiftId === shiftId && read.slot === 'dashboard' && read.status === 'complete')
    expect(dashboardReads).toHaveLength(2)
    const dashboardRows = [...h.deps.closeDrafts.observations.values()]
      .filter((observation) => observation.shiftId === shiftId && observation.slot === 'dashboard')
    expect(dashboardRows).toHaveLength(10)

    // Ten stored rows on one page, five on the other — and still exactly the same answer as when
    // the page had been read once: page one's last two rows are page two's first two.
    const body = await review(manager, shiftId)
    expect(body.duplicateHints).toHaveLength(1)
    expect(body.duplicateHints[0].length).toBe(2)
    expect(body.duplicateHints[0].earlier.slot).toBe('dashboard')
    expect(body.duplicateHints[0].later.slot).toBe('dashboard_2')
    expect(body.duplicateHints[0].pairs.map((pair: any) => pair.earlier.rowIndex)).toEqual([3, 4])
    expect(body.duplicateHints[0].pairs.map((pair: any) => pair.later.rowIndex)).toEqual([0, 1])
  })
})

describe('the wire contract cannot drift from the domain', () => {
  it('accepts every cause code the detector can emit', () => {
    // A cause the enum does not know throws inside `scanDuplicateHintSchema.parse` on the review
    // endpoint — a 500 on the exact screen this feature exists to serve. Adding a code to the
    // domain without adding it here must fail in CI, not in front of a manager.
    expect([...scanOverlapCauseSchema.options].sort()).toEqual([...SCAN_OVERLAP_CAUSES].sort())
    expect([...scanOverlapPairCauseSchema.options].sort()).toEqual([...SCAN_OVERLAP_PAIR_CAUSES].sort())
  })
})
