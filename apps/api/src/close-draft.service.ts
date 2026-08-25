import { createHash } from 'node:crypto'
import { resolveSamePageOrderTimes } from '@ash/adapters/ocr'
import type {
  AttachedSlot,
  CloseDraftCashDeduction,
  CloseDraftData,
  CloseDraftMovement,
  CloseDraftOrder,
  CloseDraftRecord,
  CloseDraftView,
  Deps,
  LinkedCloseDraftReadRequest,
  OcrRow,
  PatchCloseDraftRequest,
  ShiftRecord,
} from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { hasVisibleText, minor, parseMinor, type Actor, type Minor } from '@ash/domain'
import { readEvidence } from './media.service.ts'
import { readScreen } from './ocr.service.ts'
import { ServiceError } from './shifts.service.ts'
import { closeDraftHash } from './close-draft.hash.ts'

const EMPTY_FIGURES: CloseDraftData['figures'] = {
  odometerKm: null,
  odometerKmOcr: null,
  odometerAnomalyConfirmed: false,
  batteryPercent: null,
  cashDeclared: null,
  walletDeclared: null,
  walletDeclaredOcr: null,
}

const emptyData = (slots: readonly AttachedSlot[]): CloseDraftData => ({
  figures: { ...EMPTY_FIGURES },
  operations: { orders: [], cashDeductions: [], movements: [] },
  reads: {},
  evidence: Object.fromEntries(
    slots
      .filter((slot) => slot.package === 'end')
      .map((slot) => [slot.slot, {
        mediaId: slot.mediaId,
        attachmentToken: slot.attachmentToken,
        attachedAtMs: slot.attachedAtMs,
      }]),
  ),
})

const initialData = async (
  deps: Deps,
  shift: ShiftRecord,
  slots: readonly AttachedSlot[],
): Promise<CloseDraftData> => {
  const data = emptyData(slots)
  const [orders, deductions, movements] = await Promise.all([
    deps.orders.listByShift(shift.id),
    deps.cashDeductions.listByShift(shift.id),
    deps.movements.listByShift(shift.id),
  ])
  const audited = (row: { decisionReason: string | null; decidedBy: string | null; decidedAt: string | null }) =>
    row.decidedBy !== null && row.decidedAt !== null && hasVisibleText(row.decisionReason)
  data.figures = {
    odometerKm: shift.odoEnd,
    odometerKmOcr: shift.odoEndOcr,
    odometerAnomalyConfirmed: shift.odoEndAnomalyConfirmedAt !== null,
    batteryPercent: shift.batteryEnd,
    cashDeclared: shift.endCashDeclared === null ? null : serializeMoney(shift.endCashDeclared),
    walletDeclared: shift.endWalletDeclared === null ? null : serializeMoney(shift.endWalletDeclared),
    walletDeclaredOcr: shift.endWalletDeclaredOcr === null ? null : serializeMoney(shift.endWalletDeclaredOcr),
  }
  data.operations.orders = orders.map((row) => {
    const protectedManual = row.kind === 'manual'
    const needsEvidence = !protectedManual && !audited(row)
    const fee = serializeMoney(row.fee)
    return {
      clientKey: row.closeDraftClientKey ?? `legacy:order:${row.id}`,
      matchKey: protectedManual ? null : stableKey(['orders', row.occurredDate, row.occurredMinute, fee]),
      providerOrderNo: row.providerOrderNo,
      payMode: row.payMode,
      fee,
      feeOcr: row.feeOcr === null ? null : serializeMoney(row.feeOcr),
      feeRefused: false,
      reviewRequired: needsEvidence,
      reviewReasons: needsEvidence ? ['evidence_removed' as const] : (row.closeDraftReviewReasons ?? []),
      included: needsEvidence ? false : row.included,
      occurredMinute: row.occurredMinute,
      occurredDate: row.occurredDate,
      pointA: row.points.find((point) => point.role === 'start')?.label ?? null,
      pointB: [...row.points].reverse().find((point) => point.role === 'end')?.label ?? null,
      source: protectedManual ? 'manual' as const : row.source === 'ocr' ? 'cloud_ocr' as const : 'local_ocr' as const,
      readId: null,
      observationId: row.observationId ?? null,
      rowIndex: null,
      dateSection: row.occurredDate,
      evidence: null,
      windowBasis: row.windowBasis ?? null,
      position: row.positionEvidence ?? null,
      sightings: [],
    }
  })
  data.operations.cashDeductions = deductions.map((row) => {
    const needsEvidence = !audited(row)
    const amount = serializeMoney(row.amount)
    const signed = serializeMoney(minor(-row.amount))
    return {
      clientKey: row.closeDraftClientKey ?? `legacy:deduction:${row.id}`,
      matchKey: stableKey(['orders', row.occurredDate, row.occurredMinute, signed]),
      operationKey: row.operationKey,
      amount,
      amountOcr: row.amountOcr === null ? null : serializeMoney(row.amountOcr),
      reviewRequired: needsEvidence,
      reviewReasons: needsEvidence ? ['evidence_removed' as const] : (row.closeDraftReviewReasons ?? []),
      included: needsEvidence ? false : row.included,
      occurredMinute: row.occurredMinute,
      occurredDate: row.occurredDate,
      pointA: row.pointA,
      pointB: row.pointB,
      source: row.source === 'ocr' ? 'cloud_ocr' as const : 'local_ocr' as const,
      readId: null,
      observationId: row.observationId ?? null,
      rowIndex: null,
      dateSection: row.occurredDate,
      evidence: null,
      windowBasis: row.windowBasis ?? null,
      position: row.positionEvidence ?? null,
      sightings: [],
    }
  })
  data.operations.movements = movements.map((row) => ({
    clientKey: `legacy:movement:${row.id}`,
    matchKey: null,
    amount: serializeMoney(row.amount),
    occurredMinute: row.occurredMinute || null,
    role: row.role,
    providerOrderNo: null,
    ambiguous: row.ambiguous,
    included: row.included,
    notes: row.notes,
    source: row.source === 'ocr' ? 'cloud_ocr' : 'manual',
    readId: null,
    observationId: null,
    rowIndex: null,
    dateSection: null,
    evidence: null,
    sightings: [],
  }))
  return data
}

export { closeDraftHash } from './close-draft.hash.ts'

const readKey = (attachmentToken: string, field: string): string => `${attachmentToken}|${field}`

const recordView = async (
  deps: Deps,
  record: CloseDraftRecord,
  restored: boolean,
): Promise<CloseDraftView> => {
  const slots = (await deps.media.listSlots(record.shiftId)).filter((slot) => slot.package === 'end')
  return {
    shiftId: record.shiftId,
    revision: record.revision,
    draftHash: record.draftHash,
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    submittedAt: record.submittedAtMs === null ? null : new Date(record.submittedAtMs).toISOString(),
    restored,
    figures: structuredClone(record.data.figures),
    attachments: slots.map((slot) => {
      const read = Object.entries(record.data.reads)
        .filter(([key]) => key.startsWith(`${slot.attachmentToken}|`))
        .map(([, value]) => value)
        .at(-1) ?? null
      return {
        package: 'end',
        slot: slot.slot,
        mediaId: slot.mediaId,
        attachmentToken: slot.attachmentToken,
        attachedAtMs: slot.attachedAtMs,
        attachedAt: new Date(slot.attachedAtMs).toISOString(),
        read,
      }
    }),
    operations: structuredClone(record.data.operations),
  }
}

const assertEditable = async (deps: Deps, shiftId: string): Promise<void> => {
  const shift = await deps.shifts.findById(shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  if (shift.state !== 'open' && shift.state !== 'suspended') {
    throw new ServiceError(409, 'close_draft_not_editable', { state: shift.state })
  }
}

const invalidateMissingEvidence = (data: CloseDraftData, slots: readonly AttachedSlot[]): CloseDraftData => {
  const currentTokens = new Set(slots.filter((slot) => slot.package === 'end').map((slot) => slot.attachmentToken))
  const priorEvidence = data.evidence
  const currentEvidence = Object.fromEntries(
    slots.filter((slot) => slot.package === 'end').map((slot) => [slot.slot, {
      mediaId: slot.mediaId,
      attachmentToken: slot.attachmentToken,
      attachedAtMs: slot.attachedAtMs,
    }]),
  )
  const generationChanged = (slot: string): boolean =>
    priorEvidence[slot]?.attachmentToken !== currentEvidence[slot]?.attachmentToken
  const hadSuccessfulRead = (slot: string, field: LinkedCloseDraftReadRequest['field']): boolean => {
    const token = priorEvidence[slot]?.attachmentToken
    return token !== undefined && data.reads[readKey(token, field)]?.status === 'complete'
  }
  const retainCurrentSightings = <T extends DraftOperation>(row: T): T => {
    let rebound = row
    const staleTokens = new Set(
      (row.sightings ?? [])
        .map((sighting) => sighting.evidence.attachmentToken)
        .filter((token) => !currentTokens.has(token)),
    )
    for (const token of staleTokens) rebound = withdrawAttachmentSighting(rebound, token)
    return rebound
  }
  return {
    ...data,
    figures: {
      ...data.figures,
      // A replacement must never display a value read from the old thumbnail. Human-confirmed
      // declarations are separate fields and deliberately survive this generation change.
      walletDeclaredOcr: generationChanged('wallet') && hadSuccessfulRead('wallet', 'wallet')
        ? null
        : data.figures.walletDeclaredOcr,
      odometerKmOcr: generationChanged('odometer') && hadSuccessfulRead('odometer', 'odometer')
        ? null
        : data.figures.odometerKmOcr,
      batteryPercent: Object.keys(priorEvidence).some(
        (slot) => /^bms_[1-9]\d*$/.test(slot) && generationChanged(slot) && hadSuccessfulRead(slot, 'bms'),
      ) ? null : data.figures.batteryPercent,
    },
    evidence: currentEvidence,
    reads: Object.fromEntries(Object.entries(data.reads).filter(([key]) => currentTokens.has(key.split('|')[0]!))),
    operations: {
      orders: data.operations.orders.map(retainCurrentSightings),
      cashDeductions: data.operations.cashDeductions.map(retainCurrentSightings),
      movements: data.operations.movements.map(retainCurrentSightings),
    },
  }
}

export async function getCloseDraft(deps: Deps, actor: Actor, shiftId: string): Promise<CloseDraftView> {
  const shift = await deps.shifts.findById(shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  const slots = await deps.media.listSlots(shiftId)
  const existing = await deps.closeDrafts.findByShift(shiftId)
  if (!existing) {
    await assertEditable(deps, shiftId)
    const data = await initialData(deps, shift, slots)
    const created = await deps.closeDrafts.getOrCreate({
      shiftId,
      draftHash: closeDraftHash(data),
      data,
      updatedAtMs: deps.clock.nowMs(),
      updatedBy: actor.userId,
      submittedAtMs: null,
    })
    return recordView(deps, created, false)
  }

  if (existing.submittedAtMs === null) {
    const reconciled = invalidateMissingEvidence(existing.data, slots)
    const hash = closeDraftHash(reconciled)
    if (hash !== existing.draftHash) {
      const updated = await deps.closeDrafts.update({
        shiftId,
        expectedRevision: existing.revision,
        data: reconciled,
        draftHash: hash,
        updatedAtMs: deps.clock.nowMs(),
        updatedBy: actor.userId,
      })
      if (updated) return recordView(deps, updated, true)
      const current = await deps.closeDrafts.findByShift(shiftId)
      if (current) return recordView(deps, current, true)
    }
  }
  return recordView(deps, existing, true)
}

const moneyText = (value: Minor | null | undefined): string | null => value == null ? null : serializeMoney(value)

type DraftOperationsPatch = NonNullable<PatchCloseDraftRequest['operations']>

type DraftWindow = { openMinute: string; closeMinute: string }

const classifyDraftTime = (
  occurredDate: string | null,
  occurredMinute: string | null,
  window: DraftWindow,
): { included: boolean; resolved: boolean } => {
  if (occurredDate === null || occurredMinute === null) return { included: false, resolved: false }
  const key = `${occurredDate} ${occurredMinute}`
  return { included: key >= window.openMinute && key <= window.closeMinute, resolved: true }
}

const manualOrder = (
  row: NonNullable<DraftOperationsPatch['manualOrders']>[number],
  window: DraftWindow,
): CloseDraftOrder => {
  const classification = classifyDraftTime(row.occurredDate, row.occurredMinute, window)
  return {
  clientKey: row.clientKey,
  matchKey: null,
  providerOrderNo: row.providerOrderNo,
  payMode: row.payMode,
  fee: moneyText(row.fee),
  feeOcr: null,
  feeRefused: row.fee === null,
  reviewRequired: true,
  reviewReasons: [
    ...(row.fee === null ? ['missing_money' as const] : []),
    ...(!classification.resolved ? ['missing_time' as const] : []),
    'human_time_edit',
  ],
  included: false,
  occurredMinute: row.occurredMinute,
  occurredDate: row.occurredDate,
  pointA: row.pointA,
  pointB: row.pointB,
  source: 'manual',
  readId: null,
  observationId: null,
  rowIndex: null,
  dateSection: row.occurredDate,
  evidence: null,
  windowBasis: null,
  position: null,
  sightings: [],
  }
}

const manualDeduction = (
  row: NonNullable<DraftOperationsPatch['manualCashDeductions']>[number],
  window: DraftWindow,
): CloseDraftCashDeduction => {
  const classification = classifyDraftTime(row.occurredDate, row.occurredMinute, window)
  return {
  clientKey: row.clientKey,
  matchKey: null,
  operationKey: row.operationKey,
  amount: moneyText(row.amount),
  amountOcr: null,
  reviewRequired: true,
  reviewReasons: [
    ...(row.amount === null ? ['missing_money' as const] : []),
    ...(!classification.resolved ? ['missing_time' as const] : []),
    'human_time_edit',
  ],
  included: false,
  occurredMinute: row.occurredMinute,
  occurredDate: row.occurredDate,
  pointA: row.pointA,
  pointB: row.pointB,
  source: 'manual',
  readId: null,
  observationId: null,
  rowIndex: null,
  dateSection: row.occurredDate,
  evidence: null,
  windowBasis: null,
  position: null,
  sightings: [],
  }
}

const manualMovement = (
  row: NonNullable<DraftOperationsPatch['manualMovements']>[number],
): CloseDraftMovement => ({
  clientKey: row.clientKey,
  matchKey: null,
  amount: serializeMoney(row.amount),
  occurredMinute: row.occurredMinute,
  role: row.role,
  providerOrderNo: row.providerOrderNo,
  ambiguous: row.ambiguous,
  included: true,
  notes: row.notes,
  source: 'manual',
  readId: null,
  observationId: null,
  rowIndex: null,
  dateSection: null,
  evidence: null,
  sightings: [],
})

function mergeHumanPatch(current: CloseDraftData, patch: PatchCloseDraftRequest, window: DraftWindow): CloseDraftData {
  const data = structuredClone(current)
  if (patch.figures) {
    const figures = patch.figures
    if (figures.odometerKm !== undefined) data.figures.odometerKm = figures.odometerKm
    if (figures.odometerAnomalyConfirmed !== undefined) data.figures.odometerAnomalyConfirmed = figures.odometerAnomalyConfirmed
    if (figures.cashDeclared !== undefined) data.figures.cashDeclared = moneyText(figures.cashDeclared)
    if (figures.walletDeclared !== undefined) data.figures.walletDeclared = moneyText(figures.walletDeclared)
  }
  const operations = patch.operations
  if (!operations) return data
  if (operations.manualOrders) {
    data.operations.orders = [
      ...data.operations.orders.filter((row) => row.source !== 'manual'),
      ...operations.manualOrders.map((row) => manualOrder(row, window)),
    ]
  }
  if (operations.manualCashDeductions) {
    data.operations.cashDeductions = [
      ...data.operations.cashDeductions.filter((row) => row.source !== 'manual'),
      ...operations.manualCashDeductions.map((row) => manualDeduction(row, window)),
    ]
  }
  if (operations.manualMovements) {
    data.operations.movements = [
      ...data.operations.movements.filter((row) => row.source !== 'manual'),
      ...operations.manualMovements.map(manualMovement),
    ]
  }
  for (const edit of operations.rowEdits ?? []) {
    if (edit.kind === 'order') {
      const row = data.operations.orders.find((candidate) => candidate.clientKey === edit.clientKey)
      if (!row) throw new ServiceError(422, 'close_draft_row_not_found', { clientKey: edit.clientKey })
      if (edit.fee !== undefined) {
        const moneyChanged = moneyText(edit.fee) !== row.fee
        row.fee = moneyText(edit.fee)
        row.feeRefused = false
        row.reviewReasons = (row.reviewReasons ?? []).filter((reason) => reason !== 'missing_money')
        if (edit.fee === null) row.reviewReasons.push('missing_money')
        else if (moneyChanged && row.source !== 'manual') row.reviewReasons.push('human_money_edit')
        row.reviewReasons = [...new Set(row.reviewReasons)]
        row.included = classifyDraftTime(row.occurredDate, row.occurredMinute, window).included
        row.reviewRequired = row.reviewReasons.length > 0
      }
      const minuteChanged = edit.occurredMinute !== undefined && edit.occurredMinute !== row.occurredMinute
      const dateChanged = edit.occurredDate !== undefined && edit.occurredDate !== row.occurredDate
      if (minuteChanged || dateChanged) {
        if (edit.occurredMinute !== undefined) row.occurredMinute = edit.occurredMinute
        if (edit.occurredDate !== undefined) row.occurredDate = edit.occurredDate
        row.windowBasis = null
        row.position = null
        row.included = classifyDraftTime(row.occurredDate, row.occurredMinute, window).included
        row.reviewReasons = [...new Set([
          ...(row.reviewReasons ?? []).filter((reason) => reason !== 'missing_time'),
          'human_time_edit' as const,
        ])]
        row.reviewRequired = true
      }
    } else if (edit.kind === 'cash_deduction') {
      const row = data.operations.cashDeductions.find((candidate) => candidate.clientKey === edit.clientKey)
      if (!row) throw new ServiceError(422, 'close_draft_row_not_found', { clientKey: edit.clientKey })
      if (edit.amount !== undefined) {
        const moneyChanged = moneyText(edit.amount) !== row.amount
        row.amount = moneyText(edit.amount)
        row.reviewReasons = (row.reviewReasons ?? []).filter((reason) => reason !== 'missing_money')
        if (edit.amount === null) row.reviewReasons.push('missing_money')
        else if (moneyChanged && row.source !== 'manual') row.reviewReasons.push('human_money_edit')
        row.reviewReasons = [...new Set(row.reviewReasons)]
        row.included = classifyDraftTime(row.occurredDate, row.occurredMinute, window).included
        row.reviewRequired = row.reviewReasons.length > 0
      }
      const minuteChanged = edit.occurredMinute !== undefined && edit.occurredMinute !== row.occurredMinute
      const dateChanged = edit.occurredDate !== undefined && edit.occurredDate !== row.occurredDate
      if (minuteChanged || dateChanged) {
        if (edit.occurredMinute !== undefined) row.occurredMinute = edit.occurredMinute
        if (edit.occurredDate !== undefined) row.occurredDate = edit.occurredDate
        row.windowBasis = null
        row.position = null
        row.included = classifyDraftTime(row.occurredDate, row.occurredMinute, window).included
        row.reviewReasons = [...new Set([
          ...(row.reviewReasons ?? []).filter((reason) => reason !== 'missing_time'),
          'human_time_edit' as const,
        ])]
        row.reviewRequired = true
      }
    } else {
      const row = data.operations.movements.find((candidate) => candidate.clientKey === edit.clientKey)
      if (!row) throw new ServiceError(422, 'close_draft_row_not_found', { clientKey: edit.clientKey })
      if (edit.amount !== undefined && edit.amount !== null) row.amount = serializeMoney(edit.amount)
      if (edit.occurredMinute !== undefined) row.occurredMinute = edit.occurredMinute
      if (edit.notes !== undefined) row.notes = edit.notes
      if (edit.ambiguous !== undefined) row.ambiguous = edit.ambiguous
    }
  }
  for (const row of data.operations.orders) {
    const reasons = new Set(row.reviewReasons ?? [])
    if (row.fee === null) reasons.add('missing_money')
    if (row.occurredDate === null || (row.occurredMinute === null && row.windowBasis !== 'screen_position')) {
      reasons.add('missing_time')
    } else reasons.delete('missing_time')
    row.reviewReasons = [...reasons]
    row.reviewRequired = row.reviewReasons.length > 0
  }
  for (const row of data.operations.cashDeductions) {
    const reasons = new Set(row.reviewReasons ?? [])
    if (row.amount === null) reasons.add('missing_money')
    if (row.occurredDate === null || (row.occurredMinute === null && row.windowBasis !== 'screen_position')) {
      reasons.add('missing_time')
    } else reasons.delete('missing_time')
    row.reviewReasons = [...reasons]
    row.reviewRequired = row.reviewReasons.length > 0
  }
  const keys = [
    ...data.operations.orders.map((row) => row.clientKey),
    ...data.operations.cashDeductions.map((row) => row.clientKey),
    ...data.operations.movements.map((row) => row.clientKey),
  ]
  if (new Set(keys).size !== keys.length) throw new ServiceError(422, 'duplicate_close_draft_client_key')
  return data
}

export async function patchCloseDraft(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  patch: PatchCloseDraftRequest,
): Promise<CloseDraftView> {
  await assertEditable(deps, shiftId)
  const current = await deps.closeDrafts.findByShift(shiftId)
  if (!current) throw new ServiceError(409, 'close_draft_missing')
  if (current.revision !== patch.expectedRevision) {
    throw new ServiceError(409, 'close_draft_revision_conflict', { current: await recordView(deps, current, true) })
  }
  const shift = await deps.shifts.findById(shiftId)
  const branch = shift ? await deps.directory.branch(shift.branchId) : null
  if (!shift || !branch || shift.openApprovedAt === null) throw new ServiceError(409, 'shift_window_unavailable')
  const data = mergeHumanPatch(current.data, patch, {
    openMinute: localMinuteKey(Date.parse(shift.openApprovedAt), branch.timezone),
    closeMinute: localMinuteKey(deps.clock.nowMs(), branch.timezone),
  })
  const draftHash = closeDraftHash(data)
  // Cached driver bundles used to keep sending an equivalent human overlay after the server
  // canonicalised money text (`500` -> `500.00`). Advancing the global draft revision for that
  // no-op lets the autosave loop continually invalidate an evidence upload. Keep PATCH
  // idempotent: only a semantic data change owns a new revision.
  if (draftHash === current.draftHash) return recordView(deps, current, true)
  const updated = await deps.closeDrafts.update({
    shiftId,
    expectedRevision: patch.expectedRevision,
    data,
    draftHash,
    updatedAtMs: deps.clock.nowMs(),
    updatedBy: actor.userId,
  })
  if (!updated) {
    const latest = await deps.closeDrafts.findByShift(shiftId)
    throw new ServiceError(409, 'close_draft_revision_conflict', {
      current: latest ? await recordView(deps, latest, true) : null,
    })
  }
  return recordView(deps, updated, true)
}

const stableKey = (parts: readonly (string | number | null | undefined)[]): string => {
  const framed = parts.map((part) => {
    const value = part == null ? '' : String(part)
    return `${Buffer.byteLength(value, 'utf8')}:${value}`
  }).join('')
  return createHash('sha256').update(framed).digest('hex').slice(0, 32)
}

const normalizePrintedClock = (printedTime: string | null | undefined): string | null => {
  if (printedTime == null) return null
  const ascii = printedTime.normalize('NFKC').replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.codePointAt(0)!
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660)
  })
  const match = ascii.match(/(?:^|[^0-9])([0-9]{1,2})\s*[:٫.]\s*([0-9]{2})(?=$|[^0-9])/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${hour}:${String(minute).padStart(2, '0')}`
}

const normalizeRouteEvidence = (value: string | null): string | null => {
  const normalized = value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en') ?? ''
  return normalized === '' ? null : normalized
}

const hasStrongSameRoute = (left: DraftOperation, right: DraftOperation): boolean => {
  if (!('pointA' in left) || !('pointA' in right)) return false
  const leftA = normalizeRouteEvidence(left.pointA)
  const leftB = normalizeRouteEvidence(left.pointB)
  const rightA = normalizeRouteEvidence(right.pointA)
  const rightB = normalizeRouteEvidence(right.pointB)
  return leftA !== null && leftB !== null && rightA !== null && rightB !== null &&
    leftA === rightA && leftB === rightB
}

function localMinuteKey(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epochMs)
  const value = (kind: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === kind)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

function expectedFieldForSlot(slot: string): LinkedCloseDraftReadRequest['field'] | null {
  if (/^dashboard(?:_[2-9]|_[1-9]\d+)?$/.test(slot)) return 'orders'
  if (/^payments_log(?:_[2-9]|_[1-9]\d+)?$/.test(slot)) return 'payments_log'
  if (slot === 'wallet') return 'wallet'
  if (slot === 'odometer') return 'odometer'
  if (/^bms_[1-9]\d*$/.test(slot)) return 'bms'
  return null
}

function linkedRows(
  deps: Deps,
  shiftId: string,
  rows: readonly OcrRow[],
  field: LinkedCloseDraftReadRequest['field'],
  slot: string,
  mediaId: string,
  attachmentToken: string,
  readId: string,
  attachmentAtMs: number,
  shiftOpenMinute: string,
  timeZone: string,
): {
  orders: CloseDraftOrder[]
  deductions: CloseDraftCashDeduction[]
  movements: CloseDraftMovement[]
  observations: Parameters<Deps['closeDrafts']['saveRead']>[0]['observations']
} {
  const receivedLocal = localMinuteKey(attachmentAtMs, timeZone)
  const resolutions = field === 'orders'
    ? resolveSamePageOrderTimes(
        rows.map((row) => ({ printedTime: row.printedTime, dateIso: row.dateIso })),
        { dateIso: receivedLocal.slice(0, 10), time: receivedLocal.slice(11) },
      )
    : rows.map(() => ({ time: null, candidates: [], basis: 'unknown' as const, conflict: false }))
  const observations = rows.map((row, index) => ({
    id: deps.ids.uuid(),
    rowIndex: row.rowIndex ?? index,
    rowCount: row.rowCount ?? rows.length,
    dateSection: row.dateSection ?? row.dateIso,
    yTop: row.yTop ?? null,
    yBottom: row.yBottom ?? null,
    row: { ...row, ...(field === 'orders' ? { time: resolutions[index]!.time } : {}) },
  }))
  const orders: CloseDraftOrder[] = []
  const deductions: CloseDraftCashDeduction[] = []
  const movements: CloseDraftMovement[] = []
  const captureMinute = receivedLocal
  const absoluteAt = (index: number): string | null => {
    const row = rows[index]
    const time = resolutions[index]?.time
    return row?.dateIso && time ? `${row.dateIso} ${time}` : null
  }
  const positionAt = (index: number) => {
    const observation = observations[index]!
    const exact = absoluteAt(index)
    const basis = resolutions[index]!.basis
    if (exact !== null) {
      const targetDateSection = observation.dateSection
      const neighbour = [...Array(rows.length).keys()]
        .filter((candidate) =>
          candidate !== index &&
          targetDateSection !== null &&
          observations[candidate]?.dateSection === targetDateSection &&
          absoluteAt(candidate) !== null,
        )
        .sort((left, right) => Math.abs(left - index) - Math.abs(right - index))[0]
      const included = exact >= shiftOpenMinute && exact <= captureMinute
      const positionalProof = basis === 'screen_position' && neighbour !== undefined
      return {
        included,
        basis: basis === 'screen_position'
          ? positionalProof ? basis : null
          : basis === 'unknown' ? null : basis,
        position: positionalProof ? {
          rowIndex: observation.rowIndex,
          rowCount: observation.rowCount,
          yTop: observation.yTop,
          yBottom: observation.yBottom,
          lowerInstant: exact,
          upperInstant: exact,
          anchorObservationIds: [observation.id, observations[neighbour]!.id],
        } : null,
      }
    }
    const targetDateSection = observation.dateSection
    if (targetDateSection === null) return { included: false, basis: null, position: null }
    let above: number | null = null
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (observations[candidate]?.dateSection !== targetDateSection) break
      if (absoluteAt(candidate) !== null) { above = candidate; break }
    }
    let below: number | null = null
    for (let candidate = index + 1; candidate < rows.length; candidate += 1) {
      if (observations[candidate]?.dateSection !== targetDateSection) break
      if (absoluteAt(candidate) !== null) { below = candidate; break }
    }
    const lowerInstant = below === null ? null : absoluteAt(below)
    const upperInstant = above === null ? null : absoluteAt(above)
    const proven = lowerInstant !== null && upperInstant !== null &&
      lowerInstant >= shiftOpenMinute && upperInstant <= captureMinute && lowerInstant <= upperInstant
    return {
      included: proven,
      basis: proven ? ('screen_position' as const) : null,
      position: proven ? {
        rowIndex: observation.rowIndex,
        rowCount: observation.rowCount,
        yTop: observation.yTop,
        yBottom: observation.yBottom,
        lowerInstant,
        upperInstant,
        anchorObservationIds: [
          ...(above === null ? [] : [observations[above]!.id]),
          ...(below === null ? [] : [observations[below]!.id]),
        ],
      } : null,
    }
  }
  rows.forEach((row, index) => {
    if (field === 'orders' && row.cancelled && row.reviewRequired !== true) return
    const observation = observations[index]!
    const resolved = resolutions[index]!
    const value = row.value === null ? null : parseMinor(row.value)
    const evidence = { mediaId, attachmentToken, slot }
    // Routes are enrichment and fluctuate across reads. The overlap identity deliberately uses
    // only printed accounting/time evidence; a one-to-one merge below preserves repeated equal
    // rows as separate operations without baking volatile text or page-relative ordinals into it.
    const printedClock = normalizePrintedClock(row.printedTime)
    const matchKey = row.dateIso !== null && printedClock !== null && row.value !== null
      ? stableKey([field, row.dateIso, printedClock, row.value])
      : null
    const clientKey = `${field}:${stableKey([attachmentToken, observation.rowIndex])}`
    const position = positionAt(index)
    const reviewReasons = [...new Set([
      ...(row.reviewRequired === true ? [row.cancelled ? 'cancelled_conflict' as const : 'reader_conflict' as const] : []),
      ...(resolved.conflict ? ['time_conflict' as const] : []),
      ...(value === null ? ['missing_money' as const] : []),
      ...(row.dateIso === null || (resolved.time === null && position.basis !== 'screen_position')
        ? ['missing_time' as const]
        : []),
      ...(resolved.basis === 'screen_position' && position.basis !== 'screen_position'
        ? ['missing_time' as const]
        : []),
    ])]
    const included = position.included && reviewReasons.length === 0
    const sightingBase = {
      readId,
      observationId: observation.id,
      rowIndex: observation.rowIndex,
      dateSection: observation.dateSection,
      evidence,
      printedTime: row.printedTime ?? null,
      occurredMinute: field === 'orders' ? resolved.time : row.time,
      occurredDate: row.dateIso,
      included,
      reviewReasons,
      pointA: row.pointA,
      pointB: row.pointB,
      windowBasis: position.basis,
      position: position.position,
    }
    if (field === 'orders') {
      if (value !== null && value < 0n) {
        const magnitude = serializeMoney(minor(-value))
        const sighting = { ...sightingBase, kind: 'cash_deduction' as const, value: magnitude }
        deductions.push({
          clientKey,
          matchKey,
          operationKey: `draft:${stableKey([shiftId, clientKey])}`,
          amount: magnitude,
          amountOcr: magnitude,
          reviewRequired: reviewReasons.length > 0,
          reviewReasons,
          included,
          occurredMinute: resolved.time,
          occurredDate: row.dateIso,
          pointA: row.pointA,
          pointB: row.pointB,
          source: 'cloud_ocr',
          readId,
          observationId: observation.id,
          rowIndex: observation.rowIndex,
          dateSection: observation.dateSection,
          evidence,
          windowBasis: position.basis,
          position: position.position,
          sightings: [sighting],
        })
      } else {
        const money = value === null ? null : serializeMoney(value)
        const sighting = { ...sightingBase, kind: 'order' as const, value: money }
        orders.push({
          clientKey,
          matchKey,
          providerOrderNo: `YAL-${stableKey([shiftId, clientKey])}`,
          payMode: 'cash',
          fee: money,
          feeOcr: money,
          feeRefused: value === null,
          reviewRequired: reviewReasons.length > 0,
          reviewReasons,
          included,
          occurredMinute: resolved.time,
          occurredDate: row.dateIso,
          pointA: row.pointA,
          pointB: row.pointB,
          source: 'cloud_ocr',
          readId,
          observationId: observation.id,
          rowIndex: observation.rowIndex,
          dateSection: observation.dateSection,
          evidence,
          windowBasis: position.basis,
          position: position.position,
          sightings: [sighting],
        })
      }
    } else if (field === 'payments_log' && value !== null) {
      const money = serializeMoney(value)
      const sighting = {
        ...sightingBase,
        kind: 'movement' as const,
        value: money,
        included: true,
        reviewReasons: [],
      }
      movements.push({
        clientKey,
        matchKey,
        amount: money,
        occurredMinute: row.time,
        role: 'unmatched',
        providerOrderNo: null,
        ambiguous: true,
        included: true,
        notes: null,
        source: 'cloud_ocr',
        readId,
        observationId: observation.id,
        rowIndex: observation.rowIndex,
        dateSection: observation.dateSection,
        evidence,
        sightings: [sighting],
      })
    }
  })
  return { orders, deductions, movements, observations }
}

type DraftOperation = CloseDraftOrder | CloseDraftCashDeduction | CloseDraftMovement

function withdrawAttachmentSighting<T extends DraftOperation>(row: T, attachmentToken: string): T {
  const sightings = (row.sightings ?? []).filter(
    (sighting) => sighting.evidence.attachmentToken !== attachmentToken,
  )
  const primary = sightings.at(-1)
  if (primary) {
    const humanTiming = 'reviewReasons' in row && row.reviewReasons.includes('human_time_edit')
    const rebound = {
      ...row,
      sightings,
      readId: primary.readId,
      observationId: primary.observationId,
      rowIndex: primary.rowIndex,
      dateSection: primary.dateSection,
      evidence: primary.evidence,
      included: humanTiming ? row.included : primary.included,
      occurredMinute: humanTiming ? row.occurredMinute : primary.occurredMinute,
      ...('position' in row ? {
        occurredDate: humanTiming ? row.occurredDate : primary.occurredDate,
        pointA: primary.pointA,
        pointB: primary.pointB,
        windowBasis: humanTiming ? row.windowBasis : primary.windowBasis,
        position: humanTiming ? row.position : primary.position,
      } : {}),
    } as T
    if ('fee' in rebound) {
      const humanMoney = rebound.fee !== rebound.feeOcr
      if (!humanMoney) {
        rebound.fee = primary.value
        rebound.feeOcr = primary.value
        rebound.feeRefused = primary.value === null
      }
      rebound.reviewReasons = [
        ...primary.reviewReasons.filter((reason) => !(humanMoney && reason === 'missing_money')),
        ...(row as CloseDraftOrder).reviewReasons.filter(
          (reason) => reason === 'human_time_edit' || reason === 'human_money_edit',
        ),
      ]
      rebound.reviewRequired = rebound.reviewReasons.length > 0
    } else if ('amountOcr' in rebound) {
      const humanMoney = rebound.amount !== rebound.amountOcr
      if (!humanMoney) {
        rebound.amount = primary.value
        rebound.amountOcr = primary.value
      }
      rebound.reviewReasons = [
        ...primary.reviewReasons.filter((reason) => !(humanMoney && reason === 'missing_money')),
        ...(row as CloseDraftCashDeduction).reviewReasons.filter(
          (reason) => reason === 'human_time_edit' || reason === 'human_money_edit',
        ),
      ]
      rebound.reviewRequired = rebound.reviewReasons.length > 0
    }
    return rebound
  }
  return {
    ...row,
    sightings: [],
    included: false,
    readId: null,
    observationId: null,
    rowIndex: null,
    dateSection: null,
    evidence: null,
    ...('reviewRequired' in row ? {
      reviewRequired: true,
      reviewReasons: [...new Set([...(row.reviewReasons ?? []), 'evidence_removed' as const])],
      windowBasis: null,
      position: null,
    } : {}),
  }
}

/**
 * Replace one attachment generation's sightings while retaining canonical human corrections and
 * independent support from overlapping pages. Matching is a one-to-one multiset operation: two
 * genuinely equal rows on one page never collapse into one amount.
 */
function mergeLinkedRows<T extends DraftOperation>(
  existing: readonly T[],
  fresh: readonly T[],
  attachmentToken: string,
): T[] {
  const humanTimingByClientKey = new Map(existing.flatMap((row) =>
    'reviewReasons' in row && row.reviewReasons.includes('human_time_edit')
      ? [[row.clientKey, {
          occurredMinute: row.occurredMinute,
          occurredDate: row.occurredDate,
          included: row.included,
          windowBasis: row.windowBasis,
          position: row.position,
        }] as const]
      : [],
  ))
  const out = existing.map((row) => withdrawAttachmentSighting(row, attachmentToken))
  const used = new Set<number>()
  for (const freshRow of fresh) {
    let index = out.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) && candidate.clientKey === freshRow.clientKey,
    )
    if (index === -1) {
      index = out.findIndex((candidate, candidateIndex) =>
        !used.has(candidateIndex) &&
        (candidate.sightings?.length ?? 0) > 0 &&
        candidate.source !== 'manual' &&
        candidate.matchKey !== null &&
        candidate.matchKey === freshRow.matchKey,
      )
    }
    if (index === -1) {
      // A replacement may make an AM/PM marker legible. Rebind only when one and only one orphan
      // has the same non-null date, literal clock digits (the matchKey deliberately ignores the
      // marker), money and both route labels. Ambiguous equal rows remain separate for the manager.
      const orphanCandidates = out.flatMap((candidate, candidateIndex) => {
        if (
          used.has(candidateIndex) ||
          (candidate.sightings?.length ?? 0) !== 0 ||
          !('reviewReasons' in candidate) ||
          !('occurredDate' in candidate) || !('occurredDate' in freshRow) ||
          !candidate.reviewReasons.includes('evidence_removed') ||
          candidate.occurredDate === null || freshRow.occurredDate === null ||
          candidate.occurredDate !== freshRow.occurredDate ||
          candidate.matchKey === null || candidate.matchKey !== freshRow.matchKey ||
          !hasStrongSameRoute(candidate, freshRow)
        ) return []
        return [candidateIndex]
      })
      if (orphanCandidates.length === 1) index = orphanCandidates[0]!
    }
    if (index === -1) {
      out.push(freshRow)
      used.add(out.length - 1)
      continue
    }

    used.add(index)
    const current = out[index]!
    const humanTiming = humanTimingByClientKey.get(current.clientKey)
    const sightings = [
      ...(current.sightings ?? []),
      ...freshRow.sightings.filter(
        (freshSighting) => !(current.sightings ?? []).some(
          (prior) => prior.observationId === freshSighting.observationId,
        ),
      ),
    ]
    const primary = sightings.at(-1)!
    const merged = {
      ...freshRow,
      clientKey: current.clientKey,
      sightings,
      readId: primary.readId,
      observationId: primary.observationId,
      rowIndex: primary.rowIndex,
      dateSection: primary.dateSection,
      evidence: primary.evidence,
      ...('position' in freshRow ? {
        windowBasis: primary.windowBasis,
        position: primary.position,
      } : {}),
    } as T

    if ('fee' in current && 'fee' in merged) {
      const correctedMoney = current.fee !== current.feeOcr
      merged.providerOrderNo = current.providerOrderNo
      merged.payMode = current.payMode
      if (correctedMoney) {
        merged.fee = current.fee
        merged.feeRefused = current.feeRefused
        merged.reviewReasons = (merged.reviewReasons ?? []).filter((reason) => reason !== 'missing_money')
        if (current.reviewReasons.includes('human_money_edit')) merged.reviewReasons.push('human_money_edit')
      }
      if (current.pointA !== null && merged.pointA === null) merged.pointA = current.pointA
      if (current.pointB !== null && merged.pointB === null) merged.pointB = current.pointB
      if (humanTiming !== undefined) {
        merged.occurredMinute = humanTiming.occurredMinute
        merged.occurredDate = humanTiming.occurredDate
        merged.included = humanTiming.included
        merged.windowBasis = humanTiming.windowBasis
        merged.position = humanTiming.position
        merged.reviewReasons = [...new Set([...merged.reviewReasons, 'human_time_edit' as const])]
      }
    } else if ('amountOcr' in current && 'amountOcr' in merged) {
      const correctedMoney = current.amount !== current.amountOcr
      merged.operationKey = current.operationKey
      if (correctedMoney) {
        merged.amount = current.amount
        merged.reviewReasons = (merged.reviewReasons ?? []).filter((reason) => reason !== 'missing_money')
        if (current.reviewReasons.includes('human_money_edit')) merged.reviewReasons.push('human_money_edit')
      }
      if (current.pointA !== null && merged.pointA === null) merged.pointA = current.pointA
      if (current.pointB !== null && merged.pointB === null) merged.pointB = current.pointB
      if (humanTiming !== undefined) {
        merged.occurredMinute = humanTiming.occurredMinute
        merged.occurredDate = humanTiming.occurredDate
        merged.included = humanTiming.included
        merged.windowBasis = humanTiming.windowBasis
        merged.position = humanTiming.position
        merged.reviewReasons = [...new Set([...merged.reviewReasons, 'human_time_edit' as const])]
      }
    } else if ('notes' in current && 'notes' in merged) {
      merged.amount = current.amount
      merged.occurredMinute = current.occurredMinute
      merged.role = current.role
      merged.providerOrderNo = current.providerOrderNo
      merged.ambiguous = current.ambiguous
      merged.included = current.included
      merged.notes = current.notes
    }
    if ('reviewReasons' in merged) merged.reviewRequired = merged.reviewReasons.length > 0
    out[index] = merged
  }
  return out
}

export async function readCloseDraftAttachment(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  slot: string,
  input: LinkedCloseDraftReadRequest,
  maxReadsPerShift: number,
): Promise<{ draft: CloseDraftView; rows: OcrRow[]; fields: Readonly<Record<string, string | null>> }> {
  await assertEditable(deps, shiftId)
  const current = await deps.closeDrafts.findByShift(shiftId)
  if (!current || current.revision !== input.expectedRevision) {
    throw new ServiceError(409, 'close_draft_revision_conflict', {
      current: current ? await recordView(deps, current, true) : null,
    })
  }
  const attached = (await deps.media.listSlots(shiftId)).find(
    (candidate) => candidate.package === 'end' && candidate.slot === slot,
  )
  if (!attached) throw new ServiceError(404, 'evidence_slot_empty')
  if (attached.mediaId !== input.mediaId || attached.attachmentToken !== input.attachmentToken) {
    throw new ServiceError(409, 'evidence_attachment_changed')
  }
  const expectedField = expectedFieldForSlot(slot)
  if (expectedField === null || expectedField !== input.field) {
    throw new ServiceError(422, 'ocr_field_slot_mismatch', { slot, expectedField, field: input.field })
  }
  const shift = await deps.shifts.findById(shiftId)
  const branch = shift ? await deps.directory.branch(shift.branchId) : null
  if (!shift || !branch || shift.openApprovedAt === null) throw new ServiceError(409, 'shift_window_unavailable')
  const { bytes } = await readEvidence(deps, attached.mediaId)
  const readId = deps.ids.uuid()
  const key = readKey(attached.attachmentToken, input.field)
  // The provider call can take a minute. Persisting an unleased `running` row first leaves the
  // draft permanently stuck if this process dies. The local request state shows progress; only a
  // terminal immutable read is committed, with a CAS retry that preserves concurrent autosaves.
  const output = await readScreen(deps, {
    shiftId,
    field: input.field,
    bytes,
    requestedBy: actor.userId,
    maxReadsPerShift,
    retryFailed: input.retryFailed,
  })
  const rows = output.result.ok ? output.result.rows : []
  const fields = output.result.ok ? output.result.fields : {}
  const linked = linkedRows(
    deps,
    shiftId,
    rows,
    input.field,
    slot,
    attached.mediaId,
    attached.attachmentToken,
    readId,
    attached.attachedAtMs,
    localMinuteKey(Date.parse(shift.openApprovedAt), branch.timezone),
    branch.timezone,
  )
  const shouldReplaceRows = output.result.ok || (!output.result.ok && output.result.reason === 'wrong_screen')
  for (let casAttempt = 0; casAttempt < 3; casAttempt += 1) {
    const latest = await deps.closeDrafts.findByShift(shiftId)
    if (!latest || latest.submittedAtMs !== null) throw new ServiceError(409, 'close_draft_not_editable')
    const slots = await deps.media.listSlots(shiftId)
    const live = slots.find((candidate) => candidate.package === 'end' && candidate.slot === slot)
    if (!live || live.mediaId !== attached.mediaId || live.attachmentToken !== attached.attachmentToken) {
      throw new ServiceError(409, 'evidence_attachment_changed')
    }
    const data = invalidateMissingEvidence(latest.data, slots)
    if (input.field === 'orders' && shouldReplaceRows) {
      data.operations.orders = mergeLinkedRows(data.operations.orders, linked.orders, attached.attachmentToken)
      data.operations.cashDeductions = mergeLinkedRows(
        data.operations.cashDeductions,
        linked.deductions,
        attached.attachmentToken,
      )
    } else if (input.field === 'payments_log' && shouldReplaceRows) {
      data.operations.movements = mergeLinkedRows(data.operations.movements, linked.movements, attached.attachmentToken)
    } else if (input.field === 'wallet') {
      if (rows[0]?.value != null) {
        const parsed = moneySchema.safeParse(rows[0].value)
        // OCR is evidence, not declared money. A syntactically valid BigInt may still be outside
        // PostgreSQL bigint; never retain such a baseline and never let it block close submission.
        if (parsed.success) data.figures.walletDeclaredOcr = serializeMoney(parsed.data)
      }
      else if (!output.result.ok && output.result.reason === 'wrong_screen') data.figures.walletDeclaredOcr = null
    } else if (input.field === 'odometer') {
      const raw = fields.odometer ?? rows[0]?.value ?? null
      const value = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
      if (value !== null && Number.isSafeInteger(value)) data.figures.odometerKmOcr = value
      else if (!output.result.ok && output.result.reason === 'wrong_screen') data.figures.odometerKmOcr = null
    } else if (input.field === 'bms') {
      const raw = fields.percent ?? fields.batteryPercent ?? null
      const value = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : null
      if (value !== null && value >= 0 && value <= 100) data.figures.batteryPercent = value
      else if (!output.result.ok && output.result.reason === 'wrong_screen') data.figures.batteryPercent = null
    }
    const priorAttempts = data.reads[key]?.attempts ?? 0
    const read = {
      readId,
      status: output.result.ok ? ('complete' as const) : ('failed' as const),
      field: input.field,
      failure: output.result.ok ? null : output.result.reason,
      attempts: Math.max(priorAttempts + 1, output.result.attemptCount ?? 1),
    }
    data.reads[key] = read
    const saved = await deps.closeDrafts.saveRead({
      shiftId,
      expectedRevision: latest.revision,
      mediaId: attached.mediaId,
      attachmentToken: attached.attachmentToken,
      slot,
      read,
      observations: output.result.ok ? linked.observations : [],
      data,
      draftHash: closeDraftHash(data),
      updatedAtMs: deps.clock.nowMs(),
      updatedBy: actor.userId,
    })
    if (saved) return { draft: await recordView(deps, saved, true), rows, fields }
  }
  const latest = await deps.closeDrafts.findByShift(shiftId)
  throw new ServiceError(409, 'close_draft_revision_conflict', {
    current: latest ? await recordView(deps, latest, true) : null,
  })
}

/** Called after an evidence mutation; binds the new generation into the optimistic draft hash. */
export async function syncCloseDraftEvidence(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  expectedRevision: number,
  options: { rebaseConcurrentEdits?: boolean } = {},
): Promise<CloseDraftView> {
  let revision = expectedRevision
  // Upload validation may spend seconds in OCR before its small attachment transaction begins.
  // When requested by that path, merge the evidence generation over a scalar autosave that won
  // either side of `beforeCommit`. The repository CAS still makes each attempt atomic; retrying
  // never overwrites the human figures from the winning revision.
  const attempts = options.rebaseConcurrentEdits ? 8 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await deps.closeDrafts.findByShift(shiftId)
    if (!current || (!options.rebaseConcurrentEdits && current.revision !== revision)) {
      throw new ServiceError(409, 'close_draft_revision_conflict', {
        current: current ? await recordView(deps, current, true) : null,
      })
    }
    revision = current.revision
    const data = invalidateMissingEvidence(current.data, await deps.media.listSlots(shiftId))
    const draftHash = closeDraftHash(data)
    if (draftHash === current.draftHash) return recordView(deps, current, true)
    const updated = await deps.closeDrafts.update({
      shiftId,
      expectedRevision: revision,
      data,
      draftHash,
      updatedAtMs: deps.clock.nowMs(),
      updatedBy: actor.userId,
    })
    if (updated) return recordView(deps, updated, true)
  }
  const latest = await deps.closeDrafts.findByShift(shiftId)
  throw new ServiceError(409, 'close_draft_revision_conflict', {
    current: latest ? await recordView(deps, latest, true) : null,
  })
}
