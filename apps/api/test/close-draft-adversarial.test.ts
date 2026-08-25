import type { LightMyRequestResponse } from 'fastify'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CloseDraftView,
  OcrField,
  OcrReader,
  OcrReading,
  OcrResult,
  ShiftCloseTransactionDeps,
} from '@ash/contracts'
import {
  BRANCH,
  DRIVER_ID,
  type Harness,
  TINY_JPEG,
  VEHICLE_ID,
  fixedApprovalPayload,
  makeHarness,
  today,
} from './harness.ts'

type OcrRequest = Parameters<OcrReader['read']>[0]
type Answer = OcrResult | ((request: OcrRequest, call: number) => Promise<OcrResult>)

const ok = (...rows: Extract<OcrResult, { ok: true }>['rows']): OcrResult => ({
  ok: true,
  rows,
  fields: {},
  raw: null,
})

const orderRow = (
  value = '155.00',
  options: { route?: string; rowIndex?: number; printedTime?: string; time?: string } = {},
): Extract<OcrResult, { ok: true }>['rows'][number] => ({
  printed: `${value} SYP`,
  printedTime: options.printedTime ?? '8:00 AM',
  value,
  cancelled: false,
  time: options.time ?? '08:00',
  dateIso: today,
  pointA: options.route ?? 'Pickup',
  pointB: `${options.route ?? 'Pickup'} dropoff`,
  rowIndex: options.rowIndex ?? 0,
  rowCount: 1,
  dateSection: today,
  yTop: 100,
  yBottom: 180,
})

class ControlledOcrReader implements OcrReader {
  readonly available = true
  readonly model = 'close-draft-adversarial'
  calls = 0
  signature = 1
  private readonly answers: Answer[] = []
  private readonly gates = new Map<number, { entered: () => void; wait: Promise<void>; release: () => void }>()

  cacheSignature(field: OcrField): string {
    return `close-draft-adversarial-${this.signature}:${field}`
  }

  push(...answers: Answer[]): void {
    this.answers.push(...answers)
  }

  bumpSignature(): void {
    this.signature += 1
  }

  block(call: number): { entered: Promise<void>; release: () => void } {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    this.gates.set(call, { entered: enter, wait, release })
    return { entered, release }
  }

  async read(request: OcrRequest): Promise<OcrReading> {
    this.calls += 1
    const call = this.calls
    const gate = this.gates.get(call)
    if (gate) {
      gate.entered()
      await gate.wait
    }
    const answer = this.answers[call - 1] ?? ok()
    const result = typeof answer === 'function' ? await answer(request, call) : answer
    return { result, usage: { tokensIn: 10, tokensOut: 5, latencyMs: 1 } }
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

const image = (name: string): Buffer => Buffer.concat([TINY_JPEG, Buffer.from(`:${name}`, 'utf8')])

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

async function openShift(): Promise<{ driver: string; manager: string; shiftId: string }> {
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
  return { driver, manager, shiftId }
}

async function getDraft(driver: string, shiftId: string): Promise<CloseDraftView> {
  const response = await inject('GET', driver, `/shifts/${shiftId}/close-draft`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as CloseDraftView
}

async function patchDraft(
  driver: string,
  shiftId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  // Mirror the hardened driver allowlist. OCR baselines and battery readings arrive only through
  // linked server reads; older fixture payloads may still carry them and must not reach PATCH.
  const sanitized = structuredClone(payload)
  if (typeof sanitized.figures === 'object' && sanitized.figures !== null) {
    delete (sanitized.figures as Record<string, unknown>).walletDeclaredOcr
    delete (sanitized.figures as Record<string, unknown>).odometerKmOcr
    delete (sanitized.figures as Record<string, unknown>).batteryPercent
  }
  return inject('PATCH', driver, `/shifts/${shiftId}/close-draft`, sanitized)
}

async function uploadEnd(
  driver: string,
  shiftId: string,
  slot: string,
  bytes: Buffer,
  draft: CloseDraftView,
  options: { replace?: boolean; expectedToken?: string | null } = {},
): Promise<LightMyRequestResponse> {
  const currentToken = options.expectedToken === undefined
    ? draft.attachments.find((attachment) => attachment.slot === slot)?.attachmentToken ?? null
    : options.expectedToken
  return inject('PUT', driver, `/shifts/${shiftId}/media/end/${slot}`, bytes, {
    'content-type': 'image/jpeg',
    'x-close-draft-revision': String(draft.revision),
    'x-stale-evidence-acknowledged': 'true',
    ...(options.replace ? { 'x-replace-confirmed': 'true' } : {}),
    ...(currentToken === null ? {} : { 'x-expected-attachment-token': currentToken }),
  })
}

async function readSlot(
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

async function finishCurrentEvidenceReads(
  driver: string,
  shiftId: string,
  initial: CloseDraftView,
): Promise<CloseDraftView> {
  let draft = initial
  for (const attachment of initial.attachments) {
    const field: OcrField | null =
      attachment.slot === 'dashboard' || /^dashboard_[1-9][0-9]*$/.test(attachment.slot)
        ? 'orders'
        : attachment.slot === 'wallet'
          ? 'wallet'
          : attachment.slot === 'odometer'
            ? 'odometer'
            : /^bms_[1-9][0-9]*$/.test(attachment.slot)
              ? 'bms'
              : null
    if (field === null || attachment.read?.status === 'complete' || attachment.read?.status === 'failed') continue
    draft = draftFromRead(await readSlot(driver, shiftId, attachment.slot, field, draft))
  }
  return draft
}

function draftFromUpload(response: LightMyRequestResponse): CloseDraftView {
  expect(response.statusCode, response.body).toBe(201)
  return response.json().draft as CloseDraftView
}

function draftFromRead(response: LightMyRequestResponse): CloseDraftView {
  expect(response.statusCode, response.body).toBe(200)
  return response.json().draft as CloseDraftView
}

async function readyManualDraft(
  driver: string,
  shiftId: string,
  key = 'manual-order-1',
  readEvidence = true,
): Promise<CloseDraftView> {
  let draft = await getDraft(driver, shiftId)
  for (const slot of ['dashboard', 'wallet', 'odometer']) {
    draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`ready-${key}-${slot}`), draft))
  }
  const patched = await patchDraft(driver, shiftId, {
    expectedRevision: draft.revision,
    figures: {
      odometerKm: 1_010,
      batteryPercent: 50,
      cashDeclared: '155.00',
      walletDeclared: '0.00',
    },
    operations: {
      manualOrders: [{
        clientKey: key,
        providerOrderNo: `YAL-${key}`,
        payMode: 'cash',
        fee: '155.00',
        occurredMinute: '08:00',
        occurredDate: today,
        pointA: 'A',
        pointB: 'B',
      }],
      manualCashDeductions: [],
      manualMovements: [],
    },
  })
  expect(patched.statusCode, patched.body).toBe(200)
  const ready = patched.json() as CloseDraftView
  return readEvidence ? finishCurrentEvidenceReads(driver, shiftId, ready) : ready
}

const endPayload = (draft: CloseDraftView): Record<string, unknown> => ({
  draftRevision: draft.revision,
  draftHash: draft.draftHash,
  // The durable draft is authoritative; these remain required only by the legacy wire shape.
  odometerKm: 1_010,
  batteryPercent: 50,
  cashDeclared: '155.00',
  walletDeclared: '0.00',
})

describe('durable close-draft identity', () => {
  it('rejects server-owned figure and OCR identity edits without changing the draft', async () => {
    const { driver, shiftId } = await openShift()
    const before = await getDraft(driver, shiftId)
    const forgedFigures = await inject('PATCH', driver, `/shifts/${shiftId}/close-draft`, {
      expectedRevision: before.revision,
      figures: {
        walletDeclaredOcr: '999.00',
        odometerKmOcr: 999_999,
        batteryPercent: 99,
      },
    })
    expect(forgedFigures.statusCode).toBe(400)

    const forgedRow = await inject('PATCH', driver, `/shifts/${shiftId}/close-draft`, {
      expectedRevision: before.revision,
      operations: {
        rowEdits: [{
          clientKey: 'forged-row',
          kind: 'order',
          providerOrderNo: 'FORGED',
          payMode: 'wallet',
          pointA: 'forged A',
          pointB: 'forged B',
        }],
      },
    })
    expect(forgedRow.statusCode).toBe(400)
    const after = await getDraft(driver, shiftId)
    expect(after.revision).toBe(before.revision)
    expect(after.draftHash).toBe(before.draftHash)
    expect(after.figures).toEqual(before.figures)
    expect(after.operations).toEqual(before.operations)
  })

  it('refuses a legacy end payload once a durable draft exists', async () => {
    const { driver, shiftId } = await openShift()
    await getDraft(driver, shiftId)
    const legacy = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, {
      odometerKm: 1_010,
      batteryPercent: 50,
      cashDeclared: '0.00',
      walletDeclared: '0.00',
    })
    expect(legacy.statusCode).toBe(428)
    expect(legacy.json().error).toBe('driver_update_required')
  })

  it('creates once, restores after reload, and rejects a stale compare-and-swap', async () => {
    const { driver, shiftId } = await openShift()
    const created = await getDraft(driver, shiftId)
    expect(created).toMatchObject({ revision: 0, restored: false, submittedAt: null })

    const reloaded = await getDraft(driver, shiftId)
    expect(reloaded).toMatchObject({
      revision: created.revision,
      draftHash: created.draftHash,
      restored: true,
    })

    const saved = await patchDraft(driver, shiftId, {
      expectedRevision: reloaded.revision,
      figures: { cashDeclared: '123.00' },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ revision: 1, figures: { cashDeclared: '123.00' } })

    const stale = await patchDraft(driver, shiftId, {
      expectedRevision: reloaded.revision,
      figures: { cashDeclared: '999.00' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('close_draft_revision_conflict')
    expect(await getDraft(driver, shiftId)).toMatchObject({
      revision: 1,
      figures: { cashDeclared: '123.00' },
    })
  })

  it('lets only one patch win when two clients use the same revision', async () => {
    const { driver, shiftId } = await openShift()
    const draft = await getDraft(driver, shiftId)
    const [left, right] = await Promise.all([
      patchDraft(driver, shiftId, {
        expectedRevision: draft.revision,
        figures: { cashDeclared: '111.00' },
      }),
      patchDraft(driver, shiftId, {
        expectedRevision: draft.revision,
        figures: { cashDeclared: '222.00' },
      }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409])
    const current = await getDraft(driver, shiftId)
    expect(current.revision).toBe(draft.revision + 1)
    expect(['111.00', '222.00']).toContain(current.figures.cashDeclared)
  })

  it('does not advance the revision for a canonical-equivalent autosave', async () => {
    const { driver, shiftId } = await openShift()
    const draft = await getDraft(driver, shiftId)
    const first = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { cashDeclared: '500' },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({
      revision: draft.revision + 1,
      figures: { cashDeclared: '500.00' },
    })

    // A cached phone can retain its raw `500` overlay after receiving canonical `500.00`.
    // Repeating that semantic no-op must not keep invalidating evidence upload revisions.
    const repeated = await patchDraft(driver, shiftId, {
      expectedRevision: first.json().revision,
      figures: { cashDeclared: '500' },
    })
    expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json()).toMatchObject({
      revision: first.json().revision,
      draftHash: first.json().draftHash,
      figures: { cashDeclared: '500.00' },
    })
  })
})

describe('attachment/read races and screen safety', () => {
  it('refuses manual figures when current evidence skipped its linked reads, before materialising operations', async () => {
    const { driver, shiftId } = await openShift()
    let draft = await readyManualDraft(driver, shiftId, 'unread-evidence', false)
    // This archive-only attachment deliberately has no linked read and must not appear in the gate.
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'payments_log', image('optional-log'), draft))
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'bms_1', image('unread-bms'), draft))

    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(422)
    expect(submitted.json()).toEqual({
      error: 'end_evidence_read_required',
      detail: {
        slots: [
          { slot: 'dashboard', field: 'orders', reason: 'missing' },
          { slot: 'wallet', field: 'wallet', reason: 'missing' },
          { slot: 'odometer', field: 'odometer', reason: 'missing' },
          { slot: 'bms_1', field: 'bms', reason: 'missing' },
        ],
      },
    })
    expect(await h.deps.orders.listByShift(shiftId)).toEqual([])
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({ state: 'open' })
  })

  it('refuses a terminal wrong-screen read even when the driver typed every figure manually', async () => {
    reader.push(
      { ok: false, reason: 'wrong_screen' },
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'no_fields' },
    )
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    for (const [slot, field] of [
      ['dashboard', 'orders'],
      ['wallet', 'wallet'],
      ['odometer', 'odometer'],
    ] as const) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`wrong-screen-${slot}`), draft))
      draft = draftFromRead(await readSlot(driver, shiftId, slot, field, draft))
    }
    const saved = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '155.00', walletDeclared: '0.00' },
      operations: {
        manualOrders: [{
          clientKey: 'wrong-screen-manual',
          providerOrderNo: 'YAL-WRONG-SCREEN-MANUAL',
          payMode: 'cash',
          fee: '155.00',
          occurredMinute: '08:00',
          occurredDate: today,
          pointA: 'A',
          pointB: 'B',
        }],
        manualCashDeductions: [],
        manualMovements: [],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    draft = saved.json() as CloseDraftView

    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(422)
    expect(submitted.json()).toEqual({
      error: 'end_evidence_read_required',
      detail: { slots: [{ slot: 'dashboard', field: 'orders', reason: 'wrong_screen' }] },
    })
    expect(await h.deps.orders.listByShift(shiftId)).toEqual([])
  })

  it('allows terminal no-fields reads to reach the ordinary close gates and preserve manual entry', async () => {
    reader.push(
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'no_fields' },
    )
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    for (const [slot, field] of [
      ['dashboard', 'orders'],
      ['wallet', 'wallet'],
      ['odometer', 'odometer'],
    ] as const) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`no-fields-${slot}`), draft))
      draft = draftFromRead(await readSlot(driver, shiftId, slot, field, draft))
    }
    const saved = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '0.00', walletDeclared: '0.00' },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    draft = saved.json() as CloseDraftView

    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(422)
    expect(submitted.json().error).toBe('end_package_incomplete')
    expect(submitted.json().detail).toContainEqual({ kind: 'no_orders' })
  })

  it('requires the linked read for a replacement generation and accepts it once the current token is read', async () => {
    reader.push(
      ok(orderRow('155.00', { route: 'old generation' })),
      ok(orderRow('155.00', { route: 'current generation' })),
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'no_fields' },
    )
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('generation-old'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const oldToken = draft.attachments.find((row) => row.slot === 'dashboard')!.attachmentToken
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('generation-current'),
      draft,
      { replace: true },
    ))
    expect(draft.attachments.find((row) => row.slot === 'dashboard')!.attachmentToken).not.toBe(oldToken)
    for (const [slot, field] of [['wallet', 'wallet'], ['odometer', 'odometer']] as const) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`generation-${slot}`), draft))
      draft = draftFromRead(await readSlot(driver, shiftId, slot, field, draft))
    }
    let saved = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '155.00', walletDeclared: '0.00' },
      operations: {
        manualOrders: [{
          clientKey: 'replacement-manual',
          providerOrderNo: 'YAL-REPLACEMENT-MANUAL',
          payMode: 'cash',
          fee: '155.00',
          occurredMinute: '08:00',
          occurredDate: today,
          pointA: 'A',
          pointB: 'B',
        }],
        manualCashDeductions: [],
        manualMovements: [],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    draft = saved.json() as CloseDraftView

    const unread = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(unread.statusCode, unread.body).toBe(422)
    expect(unread.json()).toMatchObject({
      error: 'end_evidence_read_required',
      detail: { slots: [{ slot: 'dashboard', field: 'orders', reason: 'missing' }] },
    })
    expect(await h.deps.orders.listByShift(shiftId)).toEqual([])

    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    saved = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(saved.statusCode, saved.body).toBe(200)
  })

  it('returns the first attachment before OCR and runs the evidence-bound read separately', async () => {
    reader.push(ok(orderRow()))
    const { driver, shiftId } = await openShift()
    const draft = await getDraft(driver, shiftId)
    const blocked = reader.block(1)
    const uploaded = await uploadEnd(driver, shiftId, 'dashboard', image('attach-before-ocr'), draft)
    expect(uploaded.statusCode, uploaded.body).toBe(201)
    expect(reader.calls, 'an empty slot has no accepted generation that needs a blocking preflight').toBe(0)

    const accepted = uploaded.json().draft as CloseDraftView
    const readPromise = readSlot(driver, shiftId, 'dashboard', 'orders', accepted)
    await blocked.entered
    blocked.release()
    const read = await readPromise
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().draft.operations.orders).toHaveLength(1)
    expect(read.json().draft.attachments[0]?.read).toMatchObject({
      status: 'complete',
      rowCount: 1,
      ordersCount: 1,
      deductionsCount: 0,
      cancelledCount: 0,
    })
  })

  it('makes an end-photo retry idempotent when the first 201 was lost', async () => {
    const { driver, shiftId } = await openShift()
    const before = await getDraft(driver, shiftId)
    const bytes = image('lost-201')
    const first = await uploadEnd(driver, shiftId, 'dashboard', bytes, before)
    const accepted = draftFromUpload(first)
    const attachment = accepted.attachments.find((row) => row.slot === 'dashboard')!
    const historyBefore = await h.deps.media.listAttachmentHistory(shiftId)

    // Simulate the phone that never received the response: it still has the old draft revision and
    // therefore cannot know the attachment token created by the first request.
    const retry = await uploadEnd(driver, shiftId, 'dashboard', bytes, before, { expectedToken: null })
    expect(retry.statusCode, retry.body).toBe(201)
    expect(retry.json()).toMatchObject({
      deduped: true,
      mediaId: attachment.mediaId,
      attachmentToken: attachment.attachmentToken,
      draft: { revision: accepted.revision, draftHash: accepted.draftHash },
    })
    expect(await h.deps.media.listAttachmentHistory(shiftId)).toEqual(historyBefore)
  })

  it('does not treat different bytes without the current token as a lost-response retry', async () => {
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('current'), draft))

    const rejected = await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('different-candidate'),
      draft,
      { replace: true, expectedToken: null },
    )
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json().error).toBe('evidence_attachment_changed')
    expect((await getDraft(driver, shiftId)).attachments[0]?.attachmentToken).toBe(
      draft.attachments[0]?.attachmentToken,
    )
  })

  it('accepts a stale global revision for the same attachment and preserves the newer autosave', async () => {
    reader.push(ok(orderRow('155.00', { route: 'stale revision, current token' })))
    const { driver, shiftId } = await openShift()
    const empty = await getDraft(driver, shiftId)
    const attached = draftFromUpload(
      await uploadEnd(driver, shiftId, 'dashboard', image('stale-revision-read'), empty),
    )
    const saved = await patchDraft(driver, shiftId, {
      expectedRevision: attached.revision,
      figures: { cashDeclared: '700' },
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const read = await readSlot(driver, shiftId, 'dashboard', 'orders', attached)
    const merged = draftFromRead(read)
    expect(merged.figures.cashDeclared).toBe('700.00')
    expect(merged.operations.orders).toHaveLength(1)
    expect(merged.revision).toBe(saved.json().revision + 1)
  })

  it('retries the evidence draft CAS when an autosave wins after attachment commit starts', async () => {
    reader.push(ok())
    const { driver, shiftId } = await openShift()
    const draft = await getDraft(driver, shiftId)
    const repo = h.deps.closeDrafts
    const originalUpdate = repo.update.bind(repo)
    let release!: () => void
    let entered!: () => void
    const updateEntered = new Promise<void>((resolve) => { entered = resolve })
    const waitForAutosave = new Promise<void>((resolve) => { release = resolve })
    let blocked = false
    repo.update = async (input) => {
      if (!blocked && input.data.evidence.odometer !== undefined) {
        blocked = true
        entered()
        await waitForAutosave
      }
      return originalUpdate(input)
    }

    try {
      const uploadPromise = uploadEnd(driver, shiftId, 'odometer', image('autosave-after-attach'), draft)
      await updateEntered
      const saved = await patchDraft(driver, shiftId, {
        expectedRevision: draft.revision,
        figures: { cashDeclared: '700' },
      })
      expect(saved.statusCode, saved.body).toBe(200)
      release()

      const uploaded = await uploadPromise
      expect(uploaded.statusCode, uploaded.body).toBe(201)
      expect(uploaded.json().draft).toMatchObject({
        revision: saved.json().revision + 1,
        figures: { cashDeclared: '700.00' },
      })
      expect(uploaded.json().draft.attachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ slot: 'odometer' })]),
      )
    } finally {
      release()
      repo.update = originalUpdate
    }
  })

  it('rechecks media reuse after slow OCR and preserves the occupied slot on a stale confirmation', async () => {
    reader.push(ok(), ok())
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('reuse-race-current'), draft))
    const currentAttachment = draft.attachments.find((row) => row.slot === 'dashboard')!

    const replacementBytes = image('reuse-race-replacement')
    const blocked = reader.block(1)
    const replacementPromise = uploadEnd(
      driver,
      shiftId,
      'dashboard',
      replacementBytes,
      draft,
      { replace: true },
    )
    await blocked.entered
    const shaHex = createHash('sha256').update(replacementBytes).digest('hex')
    const media = await h.deps.media.findBySha(BRANCH, shaHex)
    expect(media).not.toBeNull()
    await h.deps.media.attach('concurrent-reuse-shift', 'end', 'dashboard', media!.id, {
      actorId: 'u-d2',
      attachedAtMs: h.deps.clock.nowMs(),
    })
    blocked.release()

    const rejected = await replacementPromise
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({
      error: 'stale_evidence_confirmation_required',
      detail: { confirmationStale: true, reusedFromShiftId: 'concurrent-reuse-shift' },
    })
    const after = await getDraft(driver, shiftId)
    expect(after.revision).toBe(draft.revision)
    expect(after.attachments.find((row) => row.slot === 'dashboard')).toEqual(currentAttachment)
  })

  it('rejects restoring a wrong historical screen without rotating the current attachment', async () => {
    reader.push(ok(), { ok: false, reason: 'wrong_screen' })
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('restore-history-old'), draft))
    const oldMediaId = draft.attachments.find((row) => row.slot === 'dashboard')!.mediaId
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('restore-history-current'),
      draft,
      { replace: true },
    ))
    const currentAttachment = draft.attachments.find((row) => row.slot === 'dashboard')!
    const historical = (await h.deps.media.listAttachmentHistory(shiftId)).find(
      (row) => row.mediaId === oldMediaId,
    )!
    reader.bumpSignature()

    const restore = () => inject(
      'POST',
      driver,
      `/shifts/${shiftId}/close-draft/attachments/${historical.id}/restore`,
      {
        expectedRevision: draft.revision,
        expectedAttachmentToken: currentAttachment.attachmentToken,
        reason: 'restore the previous dashboard',
      },
    )
    const first = await restore()
    expect(first.statusCode).toBe(422)
    expect(first.json().error).toBe('wrong_screen')
    const callsAfterFirst = reader.calls
    const second = await restore()
    expect(second.statusCode).toBe(422)
    expect(reader.calls).toBe(callsAfterFirst)

    const after = await getDraft(driver, shiftId)
    expect(after.revision).toBe(draft.revision)
    expect(after.attachments.find((row) => row.slot === 'dashboard')).toEqual(currentAttachment)
  })

  it('rejects a payments-log image for an occupied orders slot without changing the attachment or rows', async () => {
    reader.push(ok(orderRow()), { ok: false, reason: 'wrong_screen' })
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('orders-good'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    const before = structuredClone(draft)

    const rejected = await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('payments-wrong-slot'),
      draft,
      { replace: true },
    )
    expect(rejected.statusCode).toBe(422)
    expect(rejected.json().error).toBe('wrong_screen')

    const after = await getDraft(driver, shiftId)
    expect(after.revision).toBe(before.revision)
    expect(after.draftHash).toBe(before.draftHash)
    expect(after.attachments.find((row) => row.slot === 'dashboard')).toEqual(
      before.attachments.find((row) => row.slot === 'dashboard'),
    )
    expect(after.operations).toEqual(before.operations)
  })

  it('commits exactly one of two replacement uploads racing on one draft revision', async () => {
    reader.push(ok(), ok())
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('race-original'), draft))
    const originalToken = draft.attachments[0]!.attachmentToken
    const second = reader.block(1)
    const third = reader.block(2)

    const leftPromise = uploadEnd(driver, shiftId, 'dashboard', image('race-left'), draft, { replace: true })
    const rightPromise = uploadEnd(driver, shiftId, 'dashboard', image('race-right'), draft, { replace: true })
    await Promise.all([second.entered, third.entered])
    second.release()
    third.release()
    const [left, right] = await Promise.all([leftPromise, rightPromise])

    expect([left.statusCode, right.statusCode].sort()).toEqual([201, 409])
    const current = await getDraft(driver, shiftId)
    expect(current.revision).toBe(draft.revision + 1)
    expect(current.attachments).toHaveLength(1)
    expect(current.attachments[0]!.attachmentToken).not.toBe(originalToken)
    const winner = left.statusCode === 201 ? left.json() : right.json()
    expect(current.attachments[0]!.mediaId).toBe(winner.mediaId)
  })

  it('refuses a linked read result when the attachment is replaced while OCR is running', async () => {
    reader.push(ok(orderRow('155.00', { route: 'stale result' })), ok())
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('swap-original'), draft))

    reader.bumpSignature()
    const blocked = reader.block(1)
    const staleReadPromise = readSlot(driver, shiftId, 'dashboard', 'orders', draft)
    await blocked.entered
    const replaced = await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('swap-replacement'),
      draft,
      { replace: true },
    )
    expect(replaced.statusCode, replaced.body).toBe(201)
    blocked.release()
    const staleRead = await staleReadPromise
    expect(staleRead.statusCode).toBe(409)
    expect(staleRead.json().error).toBe('evidence_attachment_changed')

    const current = await getDraft(driver, shiftId)
    expect(current.operations.orders).toHaveLength(0)
    expect(current.attachments[0]!.mediaId).toBe(replaced.json().mediaId)
  })

  it('retains a successful row when a same-attachment reread fails', async () => {
    reader.push(ok(orderRow()), { ok: false, reason: 'no_fields' })
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('failed-reread'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const goodRows = structuredClone(draft.operations.orders)

    reader.bumpSignature()
    const failed = await readSlot(driver, shiftId, 'dashboard', 'orders', draft, true)
    const after = draftFromRead(failed)
    expect(after.operations.orders).toEqual(goodRows)
    expect(after.attachments[0]?.read).toMatchObject({ status: 'failed', failure: 'no_fields' })
  })
})

describe('canonical row provenance', () => {
  it('keeps a driver-filled OCR amount pending until a fresh manager decision', async () => {
    reader.push(ok({
      ...orderRow('155.00', { route: 'missing fee then typed' }),
      printed: '? SYP',
      value: null,
    }))
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('typed-missing-fee'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const row = draft.operations.orders[0]!
    expect(row.reviewReasons).toContain('missing_money')

    const filled = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      operations: {
        rowEdits: [{ kind: 'order', clientKey: row.clientKey, fee: '155.00' }],
      },
    })
    expect(filled.statusCode, filled.body).toBe(200)
    draft = filled.json() as CloseDraftView
    expect(draft.operations.orders[0]!.reviewReasons).not.toContain('missing_money')
    expect(draft.operations.orders[0]!.reviewReasons).toContain('human_money_edit')
    expect(draft.operations.orders[0]).toMatchObject({ reviewRequired: true })

    for (const slot of ['wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`typed-fee-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '155.00', walletDeclared: '0.00' },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo(row.providerOrderNo)).toMatchObject({
      included: false,
      closeDraftReviewReasons: ['human_money_edit'],
    })

    const resolved = await inject('POST', manager, `/shifts/${shiftId}/operations/revise`, {
      orders: [{
        providerOrderNo: row.providerOrderNo,
        fee: '155.00',
        reason: 'manager verified the typed fee against the cash',
      }],
    })
    expect(resolved.statusCode, resolved.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo(row.providerOrderNo)).toMatchObject({
      included: true,
      windowStatus: 'open_minute_boundary',
      closeDraftReviewReasons: [],
      decidedBy: 'u-bm',
    })
  })

  it('keeps driver-typed order and deduction times outside accounting until a manager decides', async () => {
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`typed-window-${slot}`), draft))
    }
    const patched = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
      operations: {
        manualOrders: [{
          clientKey: 'typed-window-order',
          providerOrderNo: 'TYPED-WINDOW-ORDER',
          payMode: 'cash',
          fee: '100.00',
          occurredDate: today,
          occurredMinute: '08:00',
          pointA: 'A',
          pointB: 'B',
        }],
        manualCashDeductions: [{
          clientKey: 'typed-window-deduction',
          operationKey: 'typed-window-deduction',
          amount: '25.00',
          occurredDate: today,
          occurredMinute: '08:00',
          pointA: 'A',
          pointB: 'B',
        }],
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    draft = patched.json() as CloseDraftView
    expect(draft.operations.orders[0]).toMatchObject({ included: false, reviewRequired: true })
    expect(draft.operations.orders[0]!.reviewReasons).toContain('human_time_edit')
    expect(draft.operations.cashDeductions[0]).toMatchObject({ included: false, reviewRequired: true })
    expect(draft.operations.cashDeductions[0]!.reviewReasons).toContain('human_time_edit')

    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    const review = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(review.statusCode, review.body).toBe(200)
    expect(review.json().orders[0]).toMatchObject({
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: ['human_time_edit'],
    })
    expect(review.json().cashDeductions[0]).toMatchObject({
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: ['human_time_edit'],
    })
    const blocked = await inject(
      'POST',
      manager,
      `/shifts/${shiftId}/approve-close`,
      await fixedApprovalPayload(h, manager, shiftId, review.json().br1.ordersHash as string),
    )
    expect(blocked.statusCode, blocked.body).toBe(422)
    expect(blocked.json().error).toBe('operation_window_unresolved')

    const decided = await inject('POST', manager, `/shifts/${shiftId}/operations/revise`, {
      orders: [{
        providerOrderNo: 'TYPED-WINDOW-ORDER',
        included: true,
        occurredDate: today,
        occurredMinute: '08:00',
        reason: 'manager verified the typed order against source evidence',
      }],
      cashDeductions: [{
        id: review.json().cashDeductions[0].id,
        included: true,
        occurredDate: today,
        occurredMinute: '08:00',
        reason: 'manager verified the typed deduction against source evidence',
      }],
    })
    expect(decided.statusCode, decided.body).toBe(200)
    const after = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json().orders[0]).toMatchObject({ included: true, closeDraftReviewReasons: [] })
    expect(after.json().cashDeductions[0]).toMatchObject({ included: true, closeDraftReviewReasons: [] })
    const approved = await inject(
      'POST',
      manager,
      `/shifts/${shiftId}/approve-close`,
      await fixedApprovalPayload(h, manager, shiftId, after.json().br1.ordersHash as string),
    )
    expect(approved.statusCode, approved.body).toBe(200)
  })

  it('keeps a known clock with no date pending for review and out of the window', async () => {
    reader.push(ok({
      ...orderRow(),
      dateIso: null,
      dateSection: null,
    }))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('known-time-no-date'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    expect(draft.operations.orders[0]).toMatchObject({
      occurredMinute: '08:00',
      occurredDate: null,
      included: false,
      reviewRequired: true,
    })
    expect(draft.operations.orders[0]!.reviewReasons).toContain('missing_time')
  })

  it('keeps the overlapping operation when one of its two page sightings is deleted', async () => {
    const overlap = orderRow('155.00', { route: 'same delivery' })
    reader.push(ok(overlap), ok(overlap))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('overlap-1'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard_2', image('overlap-2'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard_2', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    expect(draft.operations.orders[0]!.sightings).toHaveLength(2)
    const pageTwo = draft.attachments.find((row) => row.slot === 'dashboard_2')!

    const removed = await inject('DELETE', driver, `/shifts/${shiftId}/media/end/dashboard_2`, undefined, {
      'x-close-draft-revision': String(draft.revision),
      'x-expected-attachment-token': pageTwo.attachmentToken,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const after = removed.json().draft as CloseDraftView
    expect(after.operations.orders).toHaveLength(1)
    expect(after.operations.orders[0]!.sightings).toHaveLength(1)
    expect(after.operations.orders[0]).toMatchObject({
      fee: '155.00',
      occurredMinute: '08:00',
      included: true,
      windowBasis: 'printed_time',
    })
    expect(after.operations.orders[0]!.evidence?.attachmentToken).not.toBe(pageTwo.attachmentToken)
  })

  it('preserves human money and time corrections across a same-token reread', async () => {
    reader.push(ok(orderRow('155.00')), ok(orderRow('155.00')))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('human-retry'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const row = draft.operations.orders[0]!
    const corrected = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      operations: {
        rowEdits: [{
          kind: 'order',
          clientKey: row.clientKey,
          fee: '200.00',
          occurredDate: today,
          occurredMinute: '08:01',
        }],
      },
    })
    expect(corrected.statusCode, corrected.body).toBe(200)
    draft = corrected.json() as CloseDraftView

    reader.bumpSignature()
    const reread = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft, true))
    expect(reread.operations.orders).toHaveLength(1)
    expect(reread.operations.orders[0]).toMatchObject({
      clientKey: row.clientKey,
      fee: '200.00',
      feeOcr: '155.00',
      occurredDate: today,
      occurredMinute: '08:01',
      included: false,
    })
    expect(reread.operations.orders[0]!.reviewReasons).toContain('human_time_edit')
  })

  it.each([
    {
      label: 'different route',
      newDate: today,
      oldRoute: 'generation old route',
      newRoute: 'generation genuinely different route',
    },
    {
      label: 'different date',
      newDate: new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
      oldRoute: 'generation same route',
      newRoute: 'generation same route',
    },
  ])('does not heal equal money/clock across a replacement with $label', async ({
    label,
    newDate,
    oldRoute,
    newRoute,
  }) => {
    const replacement = {
      ...orderRow('155.00', { route: newRoute, printedTime: '1:00 PM', time: '13:00' }),
      dateIso: newDate,
      dateSection: newDate,
    }
    reader.push(
      ok({
        ...orderRow('155.00', { route: oldRoute, printedTime: '1:00' }),
        time: null,
      }),
      ok(replacement),
    )
    const { driver, shiftId } = await openShift()
    h.deps.clock.set(h.deps.clock.nowMs() + 6 * 60 * 60 * 1_000)
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image(`conservative-old-${label}`),
      draft,
    ))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const oldClientKey = draft.operations.orders[0]!.clientKey

    reader.bumpSignature()
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image(`conservative-new-${label}`),
      draft,
      { replace: true },
    ))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))

    expect(draft.operations.orders).toHaveLength(2)
    const oldRow = draft.operations.orders.find((row) => row.clientKey === oldClientKey)!
    const newRow = draft.operations.orders.find((row) => row.clientKey !== oldClientKey)!
    expect(oldRow).toMatchObject({ included: false, sightings: [] })
    expect(oldRow.reviewReasons).toContain('evidence_removed')
    expect(newRow).toMatchObject({
      fee: '155.00',
      occurredDate: newDate,
      occurredMinute: '13:00',
      pointA: newRoute,
    })
    expect(newRow.providerOrderNo).not.toBe(oldRow.providerOrderNo)
  })

  it('does not guess which equal orphan a replacement row belongs to', async () => {
    const equal = orderRow('155.00', { route: 'identical repeated route', printedTime: '8:00 AM', time: '08:00' })
    reader.push(
      ok(
        { ...equal, rowIndex: 0, rowCount: 2 },
        { ...equal, rowIndex: 1, rowCount: 2 },
      ),
      ok({ ...equal, rowIndex: 0, rowCount: 1 }),
    )
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('ambiguous-old-page'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(2)
    const oldKeys = new Set(draft.operations.orders.map((row) => row.clientKey))

    reader.bumpSignature()
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('ambiguous-new-page'),
      draft,
      { replace: true },
    ))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))

    expect(draft.operations.orders).toHaveLength(3)
    const oldRows = draft.operations.orders.filter((row) => oldKeys.has(row.clientKey))
    expect(oldRows).toHaveLength(2)
    for (const row of oldRows) {
      expect(row.included).toBe(false)
      expect(row.reviewReasons).toContain('evidence_removed')
    }
    expect(draft.operations.orders.filter((row) => !oldKeys.has(row.clientKey))).toHaveLength(1)
  })

  it('assigns distinct stable keys to equal cash-deduction rows on the same page', async () => {
    reader.push(ok(
      orderRow('-50.00', { rowIndex: 0, route: 'deduction' }),
      orderRow('-50.00', { rowIndex: 1, route: 'deduction' }),
    ))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('duplicate-deductions'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.cashDeductions).toHaveLength(2)
    expect(new Set(draft.operations.cashDeductions.map((row) => row.clientKey)).size).toBe(2)
    expect(new Set(draft.operations.cashDeductions.map((row) => row.operationKey)).size).toBe(2)
    expect(draft.operations.cashDeductions.map((row) => row.amount)).toEqual(['50.00', '50.00'])
  })

  it('surfaces a cancelled reader conflict instead of silently dropping the row', async () => {
    reader.push(ok({
      ...orderRow('155.00', { route: 'cancelled conflict' }),
      cancelled: true,
      reviewRequired: true,
    }))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('cancelled-conflict'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    expect(draft.operations.orders[0]).toMatchObject({ reviewRequired: true })
    expect(draft.operations.orders[0]!.reviewReasons).toContain('cancelled_conflict')
  })

  it('records why a completed orders page produced no accounting row', async () => {
    reader.push(ok({
      ...orderRow('155.00', { route: 'uncontested cancelled order' }),
      cancelled: true,
    }))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('cancelled-only'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))

    expect(draft.operations.orders).toHaveLength(0)
    expect(draft.operations.cashDeductions).toHaveLength(0)
    expect(draft.attachments[0]?.read).toMatchObject({
      status: 'complete',
      rowCount: 1,
      ordersCount: 0,
      deductionsCount: 0,
      cancelledCount: 1,
    })
  })

  it('blocks approval of a cancelled conflict until a manager records a fresh window decision', async () => {
    reader.push(ok({
      ...orderRow('155.00', { route: 'cancelled approval gate' }),
      cancelled: true,
      reviewRequired: true,
    }))
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('cancelled-gate'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const providerOrderNo = draft.operations.orders[0]!.providerOrderNo
    for (const slot of ['wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`cancelled-gate-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)

    const review = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(review.statusCode, review.body).toBe(200)
    expect(review.json().orders[0].closeDraftReviewReasons).toContain('cancelled_conflict')
    const blocked = await inject(
      'POST',
      manager,
      `/shifts/${shiftId}/approve-close`,
      await fixedApprovalPayload(h, manager, shiftId, review.json().br1.ordersHash as string),
    )
    expect(blocked.statusCode, blocked.body).toBe(422)
    expect(blocked.json().error).toBe('operation_window_unresolved')

    const decided = await inject('POST', manager, `/shifts/${shiftId}/operations/revise`, {
      orders: [{
        providerOrderNo,
        included: false,
        reason: 'manager verified that the row was cancelled',
      }],
    })
    expect(decided.statusCode, decided.body).toBe(200)
    const after = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json().orders[0]).toMatchObject({
      included: false,
      decisionReason: 'manager verified that the row was cancelled',
      decidedBy: 'u-bm',
      closeDraftReviewReasons: [],
    })
    const approved = await inject(
      'POST',
      manager,
      `/shifts/${shiftId}/approve-close`,
      await fixedApprovalPayload(h, manager, shiftId, after.json().br1.ordersHash as string),
    )
    expect(approved.statusCode, approved.body).toBe(200)
  })
})

describe('removed and migrated evidence', () => {
  it('keeps an evidence-removed canonical row excluded when the draft is submitted', async () => {
    reader.push(ok(orderRow('155.00', { route: 'removed evidence' })), ok())
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('removed-original'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const providerOrderNo = draft.operations.orders[0]!.providerOrderNo
    const dashboard = draft.attachments.find((row) => row.slot === 'dashboard')!
    const removed = await inject('DELETE', driver, `/shifts/${shiftId}/media/end/dashboard`, undefined, {
      'x-close-draft-revision': String(draft.revision),
      'x-expected-attachment-token': dashboard.attachmentToken,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    draft = removed.json().draft as CloseDraftView
    expect(draft.operations.orders[0]).toMatchObject({ included: false, reviewRequired: true })
    expect(draft.operations.orders[0]!.reviewReasons).toContain('evidence_removed')

    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('removed-replacement'), draft))
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'wallet', image('removed-wallet'), draft))
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'odometer', image('removed-odometer'), draft))
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    const persisted = await h.deps.orders.findByProviderNo(providerOrderNo)
    expect(persisted).toMatchObject({ included: false })
    expect((await getDraft(driver, shiftId)).operations.orders[0]!.reviewReasons).toContain('evidence_removed')
  })

  it('excludes an old OCR operation omitted from the new draft while preserving a manual row', async () => {
    const { driver, manager, shiftId } = await openShift()
    const legacy = await inject('PUT', driver, `/shifts/${shiftId}/operations`, {
      orders: [
        {
          providerOrderNo: 'LEGACY-OCR-ABSENT',
          payMode: 'cash',
          fee: '100.00',
          feeOcr: '100.00',
          source: 'ocr',
          occurredDate: today,
          occurredMinute: '08:00',
          pointA: 'legacy A',
          pointB: 'legacy B',
        },
      ],
      cashDeductions: [],
      movements: [],
    })
    expect(legacy.statusCode, legacy.body).toBe(200)
    const managerManual = await inject('POST', manager, `/shifts/${shiftId}/orders/manual`, {
      providerOrderNo: 'MANUAL-PRESERVED',
      payMode: 'cash',
      fee: '50.00',
      kind: 'manual',
      driverShare: '20.00',
      companyShare: '30.00',
      notes: 'manager-priced branch job',
      points: [
        { role: 'start', label: 'manual A', lat: null, lng: null },
        { role: 'end', label: 'manual B', lat: null, lng: null },
      ],
    })
    expect(managerManual.statusCode, managerManual.body).toBe(201)
    expect(await h.deps.orders.findByProviderNo('LEGACY-OCR-ABSENT')).toMatchObject({
      kind: 'yallago',
      source: 'ocr',
      fee: 10_000n,
      feeOcr: 10_000n,
      createdBy: 'u-d1',
      decidedBy: null,
      decidedAt: null,
    })

    let draft = await getDraft(driver, shiftId)
    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`migration-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo('LEGACY-OCR-ABSENT')).toMatchObject({ included: false })
    expect(await h.deps.orders.findByProviderNo('MANUAL-PRESERVED')).toMatchObject({ included: true })
  })

  it('tombstones corrected legacy order and deduction rows created after an empty draft snapshot', async () => {
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    expect(draft.operations.orders).toHaveLength(0)
    expect(draft.operations.cashDeductions).toHaveLength(0)
    const snapshotIdentity = { revision: draft.revision, draftHash: draft.draftHash }

    const legacy = await inject('PUT', driver, `/shifts/${shiftId}/operations`, {
      orders: [{
        providerOrderNo: 'LEGACY-CORRECTED-ABSENT',
        payMode: 'cash',
        fee: '125.00',
        feeOcr: '100.00',
        source: 'ocr',
        occurredDate: today,
        occurredMinute: '08:05',
        pointA: 'legacy corrected A',
        pointB: 'legacy corrected B',
      }],
      cashDeductions: [{
        operationKey: 'legacy:corrected-deduction-absent',
        amount: '40.00',
        amountOcr: '50.00',
        source: 'ocr',
        occurredDate: today,
        occurredMinute: '08:06',
        pointA: 'legacy deduction A',
        pointB: 'legacy deduction B',
      }],
      movements: [],
    })
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo('LEGACY-CORRECTED-ABSENT')).toMatchObject({
      fee: 12_500n,
      feeOcr: 10_000n,
      included: true,
      createdBy: 'u-d1',
    })
    const [legacyDeduction] = await h.deps.cashDeductions.listByShift(shiftId)
    expect(legacyDeduction).toMatchObject({
      operationKey: 'legacy:corrected-deduction-absent',
      amount: 4_000n,
      amountOcr: 5_000n,
      included: true,
      createdBy: 'u-d1',
    })

    // Legacy operations never acquire canonical provenance or mutate the durable draft identity.
    const unchanged = await getDraft(driver, shiftId)
    expect(unchanged).toMatchObject(snapshotIdentity)
    expect(unchanged.operations.orders).toHaveLength(0)
    expect(unchanged.operations.cashDeductions).toHaveLength(0)

    h.deps.clock.set(h.deps.clock.nowMs() + 6 * 60 * 60 * 1_000)
    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(
        driver,
        shiftId,
        slot,
        image(`legacy-corrected-${slot}`),
        draft,
      ))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, {
      ...endPayload(draft),
      cashDeclared: '0.00',
    })
    expect(submitted.statusCode, submitted.body).toBe(200)

    expect(await h.deps.orders.findByProviderNo('LEGACY-CORRECTED-ABSENT')).toMatchObject({
      fee: 12_500n,
      feeOcr: 10_000n,
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    })
    expect((await h.deps.cashDeductions.listByShift(shiftId))[0]).toMatchObject({
      amount: 4_000n,
      amountOcr: 5_000n,
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    })

    const review = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(review.statusCode, review.body).toBe(200)
    expect(review.json().orders).toContainEqual(expect.objectContaining({
      providerOrderNo: 'LEGACY-CORRECTED-ABSENT',
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    }))
    expect(review.json().cashDeductions).toContainEqual(expect.objectContaining({
      operationKey: 'legacy:corrected-deduction-absent',
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    }))
  })

  it('materializes Muhammad\'s 01:18 top row as an included order', async () => {
    const openedAt = Date.UTC(2026, 7, 15, 16, 13) // 2026-08-15 19:13 Damascus
    const capturedAt = Date.UTC(2026, 7, 15, 22, 37) // 2026-08-16 01:37 Damascus
    h.deps.clock.set(openedAt)
    reader.push(ok(
      {
        ...orderRow('220.00', { rowIndex: 0, route: 'Muhammad top', printedTime: '1:18' }),
        time: null,
        dateIso: '2026-08-16',
        dateSection: '2026-08-16',
        rowCount: 2,
      },
      {
        ...orderRow('200.00', { rowIndex: 1, route: 'Muhammad anchor', printedTime: '12:57 AM', time: '00:57' }),
        dateIso: '2026-08-16',
        dateSection: '2026-08-16',
        rowCount: 2,
      },
    ))
    const { driver, shiftId } = await openShift()
    h.deps.clock.set(capturedAt)
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('muhammad-0118'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const topObservationId = draft.operations.orders[0]!.observationId
    const anchorObservationId = draft.operations.orders[1]!.observationId
    expect(draft.operations.orders[0]).toMatchObject({
      fee: '220.00',
      occurredDate: '2026-08-16',
      occurredMinute: '01:18',
      included: true,
      windowBasis: 'screen_position',
      position: {
        anchorObservationIds: expect.arrayContaining([topObservationId, anchorObservationId]),
      },
    })
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'wallet', image('muhammad-wallet'), draft))
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'odometer', image('muhammad-odometer'), draft))
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '420.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    const top = (await h.deps.orders.listByShift(shiftId)).find((row) => row.fee === 22_000n)
    expect(top).toMatchObject({
      occurredDate: '2026-08-16',
      occurredMinute: '01:18',
      included: true,
      windowBasis: 'screen_position',
      observationId: topObservationId,
      positionEvidence: {
        anchorObservationIds: expect.arrayContaining([topObservationId, anchorObservationId]),
      },
    })
  })
})

describe('atomic final materialization', () => {
  it('keeps an excluded unpriced OCR ghost as evidence without blocking real priced orders', async () => {
    const priced = { ...orderRow('155.00', { rowIndex: 0, time: '08:00' }), rowCount: 2 }
    const ghost = {
      ...orderRow('0.00', { route: 'reader ghost without money', rowIndex: 1, time: '09:00' }),
      printed: '? SYP',
      value: null,
      rowCount: 2,
    }
    reader.push(ok(priced, ghost))
    const { driver, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('unpriced-excluded-row'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))

    const unpriced = draft.operations.orders.find((row) => row.fee === null)
    expect(unpriced).toMatchObject({ included: false })
    expect(unpriced?.reviewReasons).toContain('missing_money')

    for (const slot of ['wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`unpriced-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: { odometerKm: 1_010, cashDeclared: '155.00', walletDeclared: '0.00' },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView

    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const submitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('pending_review')
    const materialized = await h.deps.orders.listByShift(shiftId)
    expect(materialized).toHaveLength(1)
    expect(materialized[0]).toMatchObject({ fee: 15_500n, included: true })
    expect((await h.deps.closeDrafts.findByShift(shiftId))?.data.operations.orders).toContainEqual(
      expect.objectContaining({ clientKey: unpriced?.clientKey, fee: null, included: false }),
    )
  })

  it('never lets force-close preparation silently bypass an unsubmitted durable draft operation', async () => {
    reader.push(ok(orderRow('155.00', { route: 'force-close draft row' })))
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('force-close-draft'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    expect(draft.operations.orders[0]).toMatchObject({ included: true, windowBasis: 'printed_time' })

    const prepared = await inject('POST', manager, `/shifts/${shiftId}/force-close`, {
      prepareOnly: true,
      reason: 'driver cannot complete the close flow',
      cashDeclared: '0.00',
      walletDeclared: '0.00',
    })
    if (prepared.statusCode === 200) {
      expect(prepared.json()).toMatchObject({ state: 'pending_review', prepared: true })
      expect((await h.deps.closeDrafts.findByShift(shiftId))?.submittedAtMs).not.toBeNull()
      const persisted = await h.deps.orders.listByShift(shiftId)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject({
        fee: 15_500n,
        included: true,
        createdBy: 'u-d1',
        closeDraftClientKey: draft.operations.orders[0]!.clientKey,
      })
    } else {
      expect([409, 422]).toContain(prepared.statusCode)
      expect(prepared.json().error).toMatch(/close_draft|draft_close/)
      expect((await h.deps.shifts.findById(shiftId))?.state).toBe('open')
    }
  })

  it('force-prepare tombstones a driver OCR row created after the draft snapshot', async () => {
    const { driver, manager, shiftId } = await openShift()
    const snapshot = await getDraft(driver, shiftId)
    expect(snapshot.operations.orders).toHaveLength(0)
    const legacy = await inject('PUT', driver, `/shifts/${shiftId}/operations`, {
      orders: [{
        providerOrderNo: 'FORCE-LEGACY-ABSENT',
        payMode: 'cash',
        fee: '100.00',
        feeOcr: '100.00',
        source: 'ocr',
        occurredDate: today,
        occurredMinute: '08:00',
        pointA: 'legacy force A',
        pointB: 'legacy force B',
      }],
      cashDeductions: [],
      movements: [],
    })
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo('FORCE-LEGACY-ABSENT')).toMatchObject({
      createdBy: 'u-d1',
      included: true,
    })

    const prepared = await inject('POST', manager, `/shifts/${shiftId}/force-close`, {
      prepareOnly: true,
      reason: 'driver unavailable after the durable snapshot',
      cashDeclared: '0.00',
      walletDeclared: '0.00',
    })
    expect(prepared.statusCode, prepared.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo('FORCE-LEGACY-ABSENT')).toMatchObject({
      createdBy: 'u-d1',
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    })
  })

  it('tombstones force-materialized OCR money when rephoto removes its only evidence', async () => {
    reader.push(
      ok(orderRow('155.00', { route: 'force then removed' })),
      ok(),
      ok(),
      ok(),
    )
    const { driver, manager, shiftId } = await openShift()
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('force-old-page'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const clientKey = draft.operations.orders[0]!.clientKey

    const prepared = await inject('POST', manager, `/shifts/${shiftId}/force-close`, {
      prepareOnly: true,
      reason: 'driver cannot complete the first close flow',
      cashDeclared: '0.00',
      walletDeclared: '0.00',
    })
    expect(prepared.statusCode, prepared.body).toBe(200)
    expect(await h.deps.orders.listByShift(shiftId)).toHaveLength(1)

    const requested = await inject('POST', manager, `/shifts/${shiftId}/request-rephoto`, {
      notes: 'the old row was not present on the replacement page',
    })
    expect(requested.statusCode, requested.body).toBe(200)

    reader.bumpSignature()
    draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('force-empty-replacement'),
      draft,
      { replace: true },
    ))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    for (const slot of ['wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`force-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const resubmitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(resubmitted.statusCode, resubmitted.body).toBe(200)

    const persisted = await h.deps.orders.listByShift(shiftId)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      closeDraftClientKey: clientKey,
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    })
  })

  it('reconciles exact rephoto evidence with a value-only manager correction instead of double-counting', async () => {
    reader.push(
      ok({
        ...orderRow('155.00', { route: 'timing heals', printedTime: '1:00' }),
        time: null,
      }),
      { ok: false, reason: 'no_fields' },
      { ok: false, reason: 'no_fields' },
      ok(orderRow('155.00', { route: 'timing heals', printedTime: '1:00 PM', time: '13:00' })),
    )
    const { driver, manager, shiftId } = await openShift()
    h.deps.clock.set(h.deps.clock.nowMs() + 6 * 60 * 60 * 1_000)
    let draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(driver, shiftId, 'dashboard', image('timing-heal-old'), draft))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    expect(draft.operations.orders).toHaveLength(1)
    expect(draft.operations.orders[0]).toMatchObject({
      occurredMinute: null,
      included: false,
      reviewRequired: true,
    })
    expect(draft.operations.orders[0]!.reviewReasons).toContain('missing_time')
    const providerOrderNo = draft.operations.orders[0]!.providerOrderNo
    for (const slot of ['wallet', 'odometer']) {
      draft = draftFromUpload(await uploadEnd(driver, shiftId, slot, image(`timing-heal-${slot}`), draft))
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: draft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    draft = figures.json() as CloseDraftView
    draft = await finishCurrentEvidenceReads(driver, shiftId, draft)
    const first = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(first.statusCode, first.body).toBe(200)

    const valueOnly = await inject('POST', manager, `/shifts/${shiftId}/operations/revise`, {
      orders: [{
        providerOrderNo,
        fee: '200.00',
        reason: 'manager verified the money only',
      }],
    })
    expect(valueOnly.statusCode, valueOnly.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo(providerOrderNo)).toMatchObject({
      fee: 20_000n,
      occurredMinute: null,
      included: false,
      decidedBy: 'u-bm',
    })
    const requested = await inject('POST', manager, `/shifts/${shiftId}/request-rephoto`, {
      notes: 'retake the page so the printed marker is legible',
    })
    expect(requested.statusCode, requested.body).toBe(200)

    reader.bumpSignature()
    draft = await getDraft(driver, shiftId)
    draft = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'dashboard',
      image('timing-heal-new'),
      draft,
      { replace: true },
    ))
    draft = draftFromRead(await readSlot(driver, shiftId, 'dashboard', 'orders', draft))
    const resubmitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(draft))
    expect(resubmitted.statusCode, resubmitted.body).toBe(200)

    const persisted = await h.deps.orders.listByShift(shiftId)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      providerOrderNo,
      fee: 20_000n,
      feeOcr: 15_500n,
      occurredDate: today,
      occurredMinute: '13:00',
      included: true,
      windowStatus: 'in_window',
      windowBasis: 'printed_time',
      closeDraftReviewReasons: [],
      decidedBy: 'u-bm',
    })
  })

  it('rejects stale revision/hash without materializing any operation', async () => {
    const { driver, shiftId } = await openShift()
    const ready = await readyManualDraft(driver, shiftId, 'stale-final')
    const changed = await patchDraft(driver, shiftId, {
      expectedRevision: ready.revision,
      figures: { cashDeclared: '156.00' },
    })
    expect(changed.statusCode, changed.body).toBe(200)

    const stale = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(ready))
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('close_draft_changed')
    expect(await h.deps.orders.listByShift(shiftId)).toHaveLength(0)
    expect(await h.deps.cashDeductions.listByShift(shiftId)).toHaveLength(0)
    expect((await h.deps.shifts.findById(shiftId))?.state).toBe('open')
    expect((await h.deps.closeDrafts.findByShift(shiftId))?.submittedAtMs).toBeNull()
  })

  it('rolls back materialized rows and the draft submission marker after a late failure', async () => {
    const { driver, shiftId } = await openShift()
    const ready = await readyManualDraft(driver, shiftId, 'rollback-final')
    const originalRun = h.deps.closeUnitOfWork.run.bind(h.deps.closeUnitOfWork)
    h.deps.closeUnitOfWork.run = async (input, work) => originalRun(input, async (transaction) => {
      const failing: ShiftCloseTransactionDeps = {
        ...transaction,
        operationBatches: {
          apply: async (id, batch, actorId) => {
            await transaction.operationBatches.apply(id, batch, actorId)
            throw new Error('injected after operation materialization')
          },
        },
      }
      return work(failing)
    })

    try {
      const failed = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(ready))
      expect(failed.statusCode).toBe(500)
    } finally {
      h.deps.closeUnitOfWork.run = originalRun
    }

    expect(await h.deps.orders.listByShift(shiftId)).toHaveLength(0)
    expect(await h.deps.cashDeductions.listByShift(shiftId)).toHaveLength(0)
    expect((await h.deps.shifts.findById(shiftId))?.state).toBe('open')
    expect((await h.deps.closeDrafts.findByShift(shiftId))?.submittedAtMs).toBeNull()
  })

  it('materializes once and treats an exact final retry as idempotent', async () => {
    const { driver, shiftId } = await openShift()
    const ready = await readyManualDraft(driver, shiftId, 'idempotent-final')
    const first = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(ready))
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().state).toBe('pending_review')
    const afterFirst = await h.deps.orders.listByShift(shiftId)
    expect(afterFirst).toHaveLength(1)

    const retry = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(ready))
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json().state).toBe('pending_review')
    expect(await h.deps.orders.listByShift(shiftId)).toEqual(afterFirst)
    expect((await h.deps.closeDrafts.findByShift(shiftId))?.submittedAtMs).not.toBeNull()
  })

  it('reopens the submitted draft for rephoto and accepts only the new revision on resubmit', async () => {
    const { driver, manager, shiftId } = await openShift()
    const firstDraft = await readyManualDraft(driver, shiftId, 'rephoto-final')
    const first = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(firstDraft))
    expect(first.statusCode, first.body).toBe(200)

    const requested = await inject('POST', manager, `/shifts/${shiftId}/request-rephoto`, {
      notes: 'Retake the dashboard screenshot',
    })
    expect(requested.statusCode, requested.body).toBe(200)
    expect(requested.json().state).toBe('open')
    const reopened = await getDraft(driver, shiftId)
    expect(reopened.submittedAt).toBeNull()
    expect(reopened.revision).toBe(firstDraft.revision + 1)

    const staleRetry = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(firstDraft))
    expect(staleRetry.statusCode).toBe(409)
    expect(staleRetry.json().error).toBe('close_draft_changed')

    const resubmitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(reopened))
    expect(resubmitted.statusCode, resubmitted.body).toBe(200)
    expect(resubmitted.json().state).toBe('pending_review')
    expect(await h.deps.orders.listByShift(shiftId)).toHaveLength(1)
    expect((await h.deps.closeDrafts.findByShift(shiftId))?.submittedAtMs).not.toBeNull()
  })

  it('changes the settlement hash after rephoto even when rows and figures are unchanged', async () => {
    reader.push(ok(orderRow('0.00', { route: 'settlement generation anchor' })))
    const { driver, manager, shiftId } = await openShift()
    let firstDraft = await getDraft(driver, shiftId)
    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      firstDraft = draftFromUpload(await uploadEnd(
        driver,
        shiftId,
        slot,
        image(`settlement-generation-${slot}`),
        firstDraft,
      ))
      if (slot === 'dashboard') {
        firstDraft = draftFromRead(await readSlot(driver, shiftId, slot, 'orders', firstDraft))
      }
    }
    const figures = await patchDraft(driver, shiftId, {
      expectedRevision: firstDraft.revision,
      figures: {
        odometerKm: 1_010,
        batteryPercent: 50,
        cashDeclared: '0.00',
        walletDeclared: '0.00',
      },
    })
    expect(figures.statusCode, figures.body).toBe(200)
    firstDraft = figures.json() as CloseDraftView
    expect(firstDraft.operations.orders).toHaveLength(1)
    expect(firstDraft.operations.orders[0]).toMatchObject({ fee: '0.00', included: true })
    firstDraft = await finishCurrentEvidenceReads(driver, shiftId, firstDraft)
    const first = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(firstDraft))
    expect(first.statusCode, first.body).toBe(200)
    const firstSettlement = await inject('GET', manager, `/shifts/${shiftId}/settlement`)
    expect(firstSettlement.statusCode, firstSettlement.body).toBe(200)
    const firstHash = firstSettlement.json().settlementHash as string

    const requested = await inject('POST', manager, `/shifts/${shiftId}/request-rephoto`, {
      notes: 'replace one piece of closing evidence',
    })
    expect(requested.statusCode, requested.body).toBe(200)
    let reopened = await getDraft(driver, shiftId)
    reopened = draftFromUpload(await uploadEnd(
      driver,
      shiftId,
      'wallet',
      image('settlement-generation-wallet-replacement'),
      reopened,
      { replace: true },
    ))
    reopened = await finishCurrentEvidenceReads(driver, shiftId, reopened)
    const second = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(reopened))
    expect(second.statusCode, second.body).toBe(200)

    const secondSettlement = await inject('GET', manager, `/shifts/${shiftId}/settlement`)
    expect(secondSettlement.statusCode, secondSettlement.body).toBe(200)
    const secondHash = secondSettlement.json().settlementHash as string
    expect(secondHash).not.toBe(firstHash)
    const currentReview = await inject('GET', manager, `/shifts/${shiftId}/review`)
    expect(currentReview.statusCode, currentReview.body).toBe(200)

    const staleApproval = await inject('POST', manager, `/shifts/${shiftId}/approve-close`, {
      reviewedOrdersHash: currentReview.json().br1.ordersHash,
      reviewedSettlementHash: firstHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: null,
    })
    expect(staleApproval.statusCode, staleApproval.body).toBe(409)
    expect(staleApproval.json().error).toBe('settlement_changed_since_review')
  })

  it('keeps a driver-created manual Yallago row excluded when it is removed on rephoto', async () => {
    const { driver, manager, shiftId } = await openShift()
    const firstDraft = await readyManualDraft(driver, shiftId, 'removed-driver-manual')
    const providerOrderNo = firstDraft.operations.orders[0]!.providerOrderNo
    const first = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(firstDraft))
    expect(first.statusCode, first.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo(providerOrderNo)).toMatchObject({
      kind: 'yallago',
      source: 'manual',
      createdBy: 'u-d1',
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: ['human_time_edit'],
    })

    const requested = await inject('POST', manager, `/shifts/${shiftId}/request-rephoto`, {
      notes: 'remove the driver-entered row that is not on the evidence',
    })
    expect(requested.statusCode, requested.body).toBe(200)
    const reopened = await getDraft(driver, shiftId)
    const removed = await patchDraft(driver, shiftId, {
      expectedRevision: reopened.revision,
      operations: { manualOrders: [] },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const withoutRow = removed.json() as CloseDraftView
    expect(withoutRow.operations.orders).toHaveLength(0)

    const resubmitted = await inject('PUT', driver, `/shifts/${shiftId}/end-package`, endPayload(withoutRow))
    expect(resubmitted.statusCode, resubmitted.body).toBe(200)
    expect(await h.deps.orders.findByProviderNo(providerOrderNo)).toMatchObject({
      included: false,
      windowStatus: 'unknown',
      closeDraftReviewReasons: expect.arrayContaining(['evidence_removed']),
    })
  })
})
