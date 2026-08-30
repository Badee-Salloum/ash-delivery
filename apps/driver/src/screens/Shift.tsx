import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { MAX_PAGE_SLOTS, PAYMENTS_LOG_SLOT, type PayMode, pageSlot } from '@ash/domain'
import type {
  CloseDraftAttachment,
  CloseDraftReadResponse,
  CloseDraftView,
  DraftCashDeduction,
  DraftMovement,
  DraftOrder,
  EvidenceUploadResponse,
} from '@ash/client'
import {
  allProblems,
  withoutSupersededRemnants,
  br1DifferencePresentation,
  cashDeductionsAreValid,
  checkOdometer,
  clientUuid,
  applyCloseDraftOperationsOverlay,
  closeDraftEditableFingerprint,
  closeDraftOperations,
  closeDraftOperationsPatch,
  compressImage,
  driverPhaseFor,
  previewBr1,
  readInCloud,
  reconcileLocalCashDeductions,
  sanitizeCloseDraftOperationsOverlay,
  resumedOrderWindowState,
  syncRecordedCashDeductions,
  isUsableMoneyText,
  normalizeDecimalDigits,
  odometerFromCloudFields,
  parseNonNegativeInteger,
  mergeCanonicalManualOperations,
  slotLabel,
  splitSlot,
  uploadEvidencePath,
} from '@ash/client'
import { closeGateBlockers } from '../close-gate.ts'
import { LINKED_READ_UI_TIMEOUT_MS } from '../linked-read-task.ts'
import {
  isStaleCloseDraftView,
  ownsPendingCloseDraftRead,
  preservePendingCloseDraftReads,
} from '../close-draft-revision.ts'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { useGpsBeacon } from '../use-gps-beacon.ts'
import { Button, Card, Field, Money, MoneyInput, Screen, TextInput } from '../ui.tsx'
import { OperationsList } from './OrderEntry.tsx'
import { BatteryPanel, type FittedBattery, type PackState, restorePacks } from './BatteryPanel.tsx'
import { BatterySwap, type SpareBattery } from './BatterySwap.tsx'
import { PageGrid } from './PageGrid.tsx'
import { CloudReadStatus } from './CloudReadStatus.tsx'
import { ReadingLock } from './ReadingLock.tsx'
import { type CloudReadEvent, PhotoSlot } from './PhotoSlot.tsx'
import { SourceMark, sourceOf } from './ReadingSource.tsx'
import {
  clearEndDraft,
  type PersistedEndDraft,
  readEndDraft,
  restoreEndDraftScalars,
  writeEndDraft,
} from '../end-draft-storage.ts'
import { runCloseDraftSaveWithRetry } from '../close-draft-autosave.ts'
import {
  endOdometerSubmission,
  type LocalOdometerReadEvent,
  localOdometerEvent,
  localOdometerFailureCopyKey,
  odometerValueForRetake,
} from '../odometer-flow.ts'
import { type AiOcrAuthorityState, reduceAiOcrAuthority } from '../ai-ocr-authority.ts'
import {
  describeEndSubmitFailure,
  type EndSubmitFailureNotice,
} from '../end-submit-error.ts'
import { endReviewWarningKeys } from '../end-review.ts'
import type { AiPageReadState } from '../ai-page-read-state.ts'
import { deletePendingEvidenceForShift } from '../pending-evidence-storage.ts'
import { openedShiftState, type OpenedShiftFunds, type OpenedShiftState } from '../opened-shift.ts'

/**
 * The driver's shift flow: start package → order entry → end package.
 *
 * Photo capture uses the device camera (`capture="environment"`), compresses to ~300 KB on the
 * phone before upload, and retries idempotently — the server dedupes by content hash, so a
 * dropped Wi-Fi connection mid-upload is a re-tap, not a lost photo.
 */

/**
 * `orders` is the RUNNING shift — no longer order entry. Closing is two steps: `closeOrders` (scan
 * the day's Yallago deliveries) then `end` (the closing package and BR1).
 */
type Phase = 'start' | 'awaiting' | 'orders' | 'suspended' | 'end' | 'done'

type ShiftState = OpenedShiftState

/** Server-owned opening evidence used when a draft shift is resumed after a browser remount. */
interface StartPackageRestore {
  odometerKm: number | null
  mediaSlots: string[]
  batteries: Array<{ batteryId: string; slotNo: number; percent: number | null; mediaId: string | null }>
}

/**
 * How many pages of one scrollable screen actually uploaded.
 *
 * Page 1 is the BARE slot name (`dashboard`), pages 2+ carry a suffix (`dashboard_2`) — see
 * `pageSlot`. So the count is the highest suffix present, or 1 when only the bare name is there.
 */
function pagesIn(slots: readonly string[], base: string): number {
  // No `new RegExp` with a template literal here: `\d` inside one collapses to a plain `d`, so the
  // pattern silently became `^dashboard_(d+)$` and matched nothing. String work says what it means.
  let max = 1 // a screen always has page 1, which carries the bare name
  for (const slot of slots) {
    if (!slot.startsWith(`${base}_`)) continue
    const suffix = slot.slice(base.length + 1)
    // Only a pure number is a page number — otherwise `payments_log` reads as a page of `payments`.
    if (!/^[0-9]+$/.test(suffix)) continue
    max = Math.max(max, Number(suffix))
  }
  return max
}

/** What cloud AI made of a paged operations screen, including every concurrent page. */
type LogState = AiPageReadState

/**
 * The closing package while it is being filled in.
 *
 * It lives in `ShiftFlow`, not inside `EndPackage`, because the driver can now step BACK out of the
 * close — and a back button that costs him four re-uploaded screenshots and every typed figure is a
 * trap, not a way out. Nothing here was ever lost on unmount (photos upload immediately, battery
 * readings are pushed as they are typed); it was the *screen* that forgot, and then refused to
 * submit until he retyped what the server already had.
 */
interface EndDraft {
  /** Revision/hash of the only server draft allowed to materialise at submit. */
  closeDraftRevision: number | null
  closeDraftHash: string | null
  /** Stale local money disagreed with a newer canonical row; never autosave/submit silently. */
  closeDraftMergeConflict: boolean
  /** Latest server snapshot retained until the driver explicitly chooses which values to keep. */
  closeDraftConflictCanonical: CloseDraftView | null
  closeDraftAttachments: Readonly<Record<string, CloseDraftAttachment>>
  closeDraftRestored: boolean
  /** Last canonical editable payload; debounced persistence compares against this. */
  persistedCloseDraftFingerprint: string | null
  persistedCashDeclared: string | null
  persistedWalletDeclared: string | null
  persistedOdometerKm: number | null
  persistedOdometerAnomalyConfirmed: boolean
  cash: string
  wallet: string
  /** What cloud AI read, kept even if the driver edits the field (SRS D-3 baseline). */
  walletOcr: string | null
  /** Only explicit typing can stop a later AI wallet result from filling the field. */
  walletHumanEdited: boolean
  /** File identity is the generation token; a late answer from a replaced screenshot is ignored. */
  walletFile: File | null
  /** What the CLOUD reader is doing with the wallet photo — running, done, or why it failed. */
  walletCloud: CloudReadEvent | null
  /** The wallet screen as the reader worked on it — training material. */
  walletStrip: string | null
  /** The closing dashboard as the reader worked on it. */
  odoStrip: string | null
  /** OCR baseline for the closing odometer, independent of later driver correction. */
  odoOcr: number | null
  /** True only when `odoOcr` came from cloud AI; local OCR is training evidence, never authority. */
  odoAiAuthoritative: boolean
  /** Cloud reader state and retained file make a timeout retryable without another gallery trip. */
  odoCloud: CloudReadEvent | null
  odoFile: File | null
  odoHumanEdited: boolean
  /** Explicit acknowledgement of the current anomalous end value; reset whenever that value changes. */
  odoConfirmed: boolean
  /** Phone-reader result, independent of the cloud reader and retained with its true failure. */
  odoLocal: LocalOdometerReadEvent | null
  odo: string
  /** Evidence slots already uploaded, so the tiles come back showing their taken state. */
  slots: ReadonlySet<string>
  log: LogState
  /** Per-pack BMS readings, so the charge fields come back filled and the gate stays satisfied. */
  packs: Record<string, PackState>
  /** Server attachment generation for each restored/uploaded pack; Files do not survive remounts. */
  batteryMediaIds: Record<string, string | null>
  /**
   * How many tiles each scrollable screen is showing.
   *
   * «الطلبات الحديثة» and «سجل المدفوعات» both scroll, and a day rarely fits one screenful — one
   * screenshot silently truncates the list, and on the log that means truncating the only
   * measurement of how much of each fee reached the wallet. Page 1 keeps the bare slot name, so
   * these counts start at 1 and every shift that was ever closed stays readable.
   */
  dashboardPages: number
  logPages: number
  /**
   * What each screen's last read did. Two screens, two answers, two status lines — a per-page
   * tally is no longer needed now that each read reports what it ADDED rather than what it saw.
   */
  dash: LogState
  /** The operations list itself — the orders and the wallet rows, with their checkboxes. */
  orders: DraftOrder[]
  movements: DraftMovement[]
  cashDeductions: DraftCashDeduction[]
  opsError: string | null
}

const EMPTY_END_DRAFT: EndDraft = {
  closeDraftRevision: null,
  closeDraftHash: null,
  closeDraftMergeConflict: false,
  closeDraftConflictCanonical: null,
  closeDraftAttachments: {},
  closeDraftRestored: false,
  persistedCloseDraftFingerprint: null,
  persistedCashDeclared: null,
  persistedWalletDeclared: null,
  persistedOdometerKm: null,
  persistedOdometerAnomalyConfirmed: false,
  cash: '',
  wallet: '',
  walletOcr: null,
  walletHumanEdited: false,
  walletFile: null,
  walletCloud: null,
  walletStrip: null,
  odoStrip: null,
  odoOcr: null,
  odoAiAuthoritative: false,
  odoCloud: null,
  odoFile: null,
  odoHumanEdited: false,
  odoConfirmed: false,
  odoLocal: null,
  odo: '',
  slots: new Set(),
  log: { kind: 'idle' },
  packs: {},
  batteryMediaIds: {},
  dashboardPages: 1,
  logPages: 1,
  dash: { kind: 'idle' },
  orders: [],
  movements: [],
  cashDeductions: [],
  opsError: null,
}

const freshEndDraft = (): EndDraft => ({
  ...EMPTY_END_DRAFT,
  slots: new Set(),
  packs: {},
  batteryMediaIds: {},
  orders: [],
  movements: [],
  cashDeductions: [],
  closeDraftAttachments: {},
})

function restoredPageReadState(
  attachments: readonly CloseDraftAttachment[],
  base: string,
  rows: number,
  refused: number,
): AiPageReadState {
  const relevant = attachments.filter((attachment) => splitSlot(attachment.slot).base === base)
  if (relevant.length === 0) return { kind: 'idle' }
  const pending = relevant.filter((attachment) => attachment.read?.status === 'running').length
  const succeeded = relevant.filter((attachment) => attachment.read?.status === 'complete').length
  const failures = relevant.filter((attachment) => attachment.read?.status === 'failed').length
  const totals = { rows, refused, cutOff: 0, succeeded, failures }
  if (pending > 0) return { kind: 'reading', pending, ...totals }
  return succeeded > 0 ? { kind: 'read', ...totals } : failures > 0 ? { kind: 'failed', ...totals } : { kind: 'idle' }
}

/** Apply one canonical close-draft snapshot; no local-only OCR row can enter through this path. */
function restoreCloseDraft(current: EndDraft, view: CloseDraftView): EndDraft {
  const rawOperations = closeDraftOperations(view)
  const operations = applyCloseDraftOperationsOverlay(
    rawOperations,
    sanitizeCloseDraftOperationsOverlay(
      rawOperations,
      closeDraftOperationsPatch(
        rawOperations.orders,
        rawOperations.cashDeductions,
        rawOperations.movements,
      ),
    ),
  )
  const canonicalAttachments = Object.fromEntries(
    view.attachments.map((attachment) => [attachment.slot, attachment]),
  )
  const attachments = preservePendingCloseDraftReads(
    current.closeDraftAttachments,
    canonicalAttachments,
  )
  const restoredAttachments = Object.values(attachments)
  const orderRefusals = operations.orders.filter(
    (row) => row.feeText.trim() === '' || row.timeReviewRequired === true,
  ).length
  const deductionRefusals = operations.cashDeductions.filter(
    (row) => row.amountText.trim() === '' || row.timeReviewRequired === true,
  ).length
  const serverFingerprint = closeDraftEditableFingerprint({
    figures: {
      cashDeclared: view.figures.cashDeclared,
      walletDeclared: view.figures.walletDeclared,
      odometerKm: view.figures.odometerKm,
      odometerAnomalyConfirmed: view.figures.odometerAnomalyConfirmed,
    },
    ...rawOperations,
  })
  const walletOcr = view.figures.walletDeclaredOcr
  const walletHumanEdited =
    (view.figures.walletDeclared !== null && view.figures.walletDeclared !== view.figures.walletDeclaredOcr)
  const restoredWallet = view.figures.walletDeclared ?? walletOcr ?? ''
  const restoredOdometer =
    view.figures.odometerKm === null
      ? view.figures.odometerKmOcr === null
        ? ''
        : String(view.figures.odometerKmOcr)
      : String(view.figures.odometerKm)
  return {
    ...current,
    closeDraftRevision: view.revision,
    closeDraftHash: view.draftHash,
    closeDraftAttachments: attachments,
    closeDraftRestored: current.closeDraftRestored || view.restored,
    persistedCloseDraftFingerprint: serverFingerprint,
    persistedCashDeclared: view.figures.cashDeclared,
    persistedWalletDeclared: view.figures.walletDeclared,
    persistedOdometerKm: view.figures.odometerKm,
    persistedOdometerAnomalyConfirmed: view.figures.odometerAnomalyConfirmed,
    slots: new Set(view.attachments.map((attachment) => attachment.slot)),
    dashboardPages: Math.max(current.dashboardPages, pagesIn(view.attachments.map((x) => x.slot), 'dashboard')),
    logPages: Math.max(current.logPages, pagesIn(view.attachments.map((x) => x.slot), PAYMENTS_LOG_SLOT)),
    cash: view.figures.cashDeclared ?? '',
    wallet: restoredWallet,
    walletOcr,
    walletHumanEdited,
    odo: restoredOdometer,
    odoOcr: view.figures.odometerKmOcr,
    odoAiAuthoritative: view.figures.odometerKmOcr !== null,
    odoHumanEdited:
      view.figures.odometerKm !== null && view.figures.odometerKm !== view.figures.odometerKmOcr,
    odoConfirmed: view.figures.odometerAnomalyConfirmed,
    orders: operations.orders,
    cashDeductions: operations.cashDeductions,
    movements: operations.movements,
    dash: restoredPageReadState(
      restoredAttachments,
      'dashboard',
      operations.orders.length + operations.cashDeductions.length,
      orderRefusals + deductionRefusals,
    ),
    log: restoredPageReadState(restoredAttachments, PAYMENTS_LOG_SLOT, operations.movements.length, 0),
  }
}

/** Apply linked scalar OCR through the same human-wins authority rule as the legacy reader. */
export function applyLinkedScalarRead(
  current: EndDraft,
  response: CloseDraftReadResponse,
  field: 'orders' | 'payments_log' | 'wallet' | 'odometer' | 'bms',
  generation: string,
): EndDraft {
  const restored = rebaseCloseDraft(current, response.draft)
  if (field === 'wallet') {
    const value = response.draft.figures.walletDeclaredOcr ?? response.rows.find((row) => row.value !== null)?.value ?? null
    if (value === null) return { ...restored, walletCloud: null }
    const authority = reduceAiOcrAuthority<string, string>(
      {
        generation,
        phase: 'reading',
        value: restored.wallet === '' ? null : restored.wallet,
        aiValue: restored.walletOcr,
        humanEdited: restored.walletHumanEdited,
      },
      { type: 'ai_read', generation, value },
    )
    return {
      ...restored,
      wallet: authority.value ?? '',
      walletOcr: authority.aiValue,
      walletHumanEdited: authority.humanEdited,
      walletCloud: null,
    }
  }
  if (field === 'odometer') {
    const value = response.draft.figures.odometerKmOcr ?? odometerFromCloudFields(response.fields)
    if (value === null) return { ...restored, odoCloud: null }
    const authority = reduceAiOcrAuthority<number, string>(
      {
        generation,
        phase: 'reading',
        value: parseNonNegativeInteger(restored.odo),
        aiValue: restored.odoOcr,
        humanEdited: restored.odoHumanEdited,
      },
      { type: 'ai_read', generation, value },
    )
    return {
      ...restored,
      odo: authority.value === null ? '' : String(authority.value),
      odoOcr: authority.aiValue,
      odoAiAuthoritative: authority.aiValue !== null,
      odoConfirmed: false,
      odoCloud: null,
    }
  }
  return restored
}

/** Rebase local human input over a newer canonical revision without retaining withdrawn OCR rows. */
export function rebaseCloseDraft(
  current: EndDraft,
  view: CloseDraftView,
  conservativeHigherRevision = true,
): EndDraft {
  // Upload, autosave and linked-read requests can finish out of order. A late older response is
  // not a new base: applying it would rewind attachment generations, canonical rows and the CAS
  // revision, after which the next legitimate save conflicts or publishes withdrawn OCR rows.
  if (isStaleCloseDraftView(current.closeDraftRevision, view.revision)) return current
  const moneyEqual = (left: string | null, right: string | null): boolean => {
    if (left === right) return true
    if (left === null || right === null) return false
    return isUsableMoneyText(left) && isUsableMoneyText(right) &&
      closeDraftEditableFingerprint({
        figures: { cashDeclared: left, walletDeclared: null, odometerKm: null, odometerAnomalyConfirmed: false },
        orders: [], cashDeductions: [], movements: [],
      }) === closeDraftEditableFingerprint({
        figures: { cashDeclared: right, walletDeclared: null, odometerKm: null, odometerAnomalyConfirmed: false },
        orders: [], cashDeductions: [], movements: [],
      })
  }
  const desiredCash = current.cash.trim() === '' ? null : current.cash
  const desiredWallet = current.wallet.trim() === '' ? null : current.wallet
  const cashDirty = !moneyEqual(desiredCash, current.persistedCashDeclared)
  const walletDirty = !moneyEqual(desiredWallet, current.persistedWalletDeclared)
  const currentOdometer = parseNonNegativeInteger(current.odo)
  const odometerDirty = currentOdometer !== current.persistedOdometerKm
  const odometerConfirmationDirty =
    current.odoConfirmed !== current.persistedOdometerAnomalyConfirmed
  const scalarConflict =
    (cashDirty && !moneyEqual(view.figures.cashDeclared, current.persistedCashDeclared) &&
      !moneyEqual(view.figures.cashDeclared, desiredCash)) ||
    (walletDirty && !moneyEqual(view.figures.walletDeclared, current.persistedWalletDeclared) &&
      !moneyEqual(view.figures.walletDeclared, desiredWallet)) ||
    (odometerDirty && view.figures.odometerKm !== current.persistedOdometerKm &&
      view.figures.odometerKm !== currentOdometer) ||
    (odometerConfirmationDirty &&
      view.figures.odometerAnomalyConfirmed !== current.persistedOdometerAnomalyConfirmed &&
      view.figures.odometerAnomalyConfirmed !== current.odoConfirmed)
  const restored = restoreCloseDraft(current, view)
  const canonicalOperations = {
    orders: restored.orders,
    cashDeductions: restored.cashDeductions,
    movements: restored.movements,
  }
  const localBaseOperations = {
    orders: current.orders,
    cashDeductions: current.cashDeductions,
    movements: current.movements,
  }
  // Before the first close-draft response, `/state` may temporarily show COMMITTED rows using
  // `already-*` local ids. They are a readable fallback, not a human-authored overlay. Reapplying
  // them here used to save one evidence-less manual copy beside every canonical OCR row. A real
  // offline overlay is applied separately by `rebaseStoredCloseDraft` immediately afterwards.
  const localOverlay = closeDraftOperationsPatch(
    current.orders,
    current.cashDeductions,
    current.movements,
  )
  const staleMerge = conservativeHigherRevision &&
    current.closeDraftRevision !== null && view.revision > current.closeDraftRevision
    ? mergeCanonicalManualOperations(canonicalOperations, localOverlay, localBaseOperations, 'local')
    : null
  const acceptsSuccessfulWrite = !conservativeHigherRevision &&
    current.closeDraftRevision !== null && view.revision > current.closeDraftRevision
  const operations = current.closeDraftRevision === null || acceptsSuccessfulWrite
    ? canonicalOperations
    : applyCloseDraftOperationsOverlay(
        canonicalOperations,
        staleMerge !== null
          ? staleMerge.overlay
          : localOverlay,
      )
  const newConflict = scalarConflict || (staleMerge?.conflicts.length ?? 0) > 0
  const mergeConflict = acceptsSuccessfulWrite
    ? false
    : current.closeDraftMergeConflict || newConflict
  return {
    ...restored,
    cash: cashDirty ? current.cash : restored.cash,
    wallet: walletDirty ? current.wallet : restored.wallet,
    walletHumanEdited: walletDirty ? current.walletHumanEdited : restored.walletHumanEdited,
    odo: odometerDirty ? current.odo : restored.odo,
    odoHumanEdited: odometerDirty ? current.odoHumanEdited : restored.odoHumanEdited,
    odoConfirmed: odometerConfirmationDirty ? current.odoConfirmed : restored.odoConfirmed,
    closeDraftMergeConflict: mergeConflict,
    closeDraftConflictCanonical: acceptsSuccessfulWrite
      ? null
      : mergeConflict ? view : null,
    ...operations,
  }
}

/** Overlay locally crash-saved human work only after the canonical rows have been restored. */
export function rebaseStoredCloseDraft(
  current: EndDraft,
  view: CloseDraftView,
  saved: PersistedEndDraft | null,
): EndDraft {
  const canonical = rebaseCloseDraft(current, view)
  if (saved === null) return canonical
  const canonicalOperations = {
    orders: canonical.orders,
    cashDeductions: canonical.cashDeductions,
    movements: canonical.movements,
  }
  const sanitized = sanitizeCloseDraftOperationsOverlay(canonicalOperations, saved.operations)
  const sameBase = saved.baseRevision === view.revision && saved.baseDraftHash === view.draftHash
  // The three manual arrays are full replacement snapshots. On a newer/unknown base (including
  // legacy v2), convert them to a server-wins union: preserve canonical keys and append phone-only
  // keys. Absence is never inferred as deletion; that would require an explicit tombstone.
  const staleMerge = sameBase
    ? null
    : mergeCanonicalManualOperations(canonicalOperations, sanitized, undefined, 'local')
  const safeOperations = staleMerge?.overlay ?? sanitized
  const operations = applyCloseDraftOperationsOverlay(canonicalOperations, safeOperations)
  const overlaid = sameBase
    ? restoreEndDraftScalars({ ...canonical, ...operations }, saved)
    : { ...canonical, ...operations }
  return {
    ...overlaid,
    closeDraftMergeConflict:
      canonical.closeDraftMergeConflict || (staleMerge?.conflicts.length ?? 0) > 0,
    closeDraftConflictCanonical:
      canonical.closeDraftConflictCanonical ??
      ((staleMerge?.conflicts.length ?? 0) > 0 ? view : null),
    persistedCashDeclared: canonical.persistedCashDeclared,
    persistedWalletDeclared: canonical.persistedWalletDeclared,
    persistedOdometerKm: canonical.persistedOdometerKm,
    persistedOdometerAnomalyConfirmed: canonical.persistedOdometerAnomalyConfirmed,
  }
}

export type CloseDraftConflictResolution = 'phone' | 'server'

export type CloseDraftSaveNotice = 'saved' | 'saving' | 'failed' | 'conflict'

/** Keep a restored/concurrent conflict actionable even when no network save failed first. */
export function closeDraftSaveNotice(
  draftSaved: boolean,
  saveFailed: boolean,
  mergeConflict: boolean,
): CloseDraftSaveNotice {
  if (mergeConflict) return 'conflict'
  if (draftSaved) return 'saved'
  return saveFailed ? 'failed' : 'saving'
}

/** A late conflict-refresh response must never cross from one shift into the next. */
export function ownsCloseDraftRefresh(
  activeShiftId: string | null,
  requestedShiftId: string,
  responseShiftId: string,
): boolean {
  return activeShiftId === requestedShiftId && responseShiftId === requestedShiftId
}

/** Resolve a real concurrent edit only after the driver chooses which values should win. */
export function resolveCloseDraftMergeConflict(
  current: EndDraft,
  resolution: CloseDraftConflictResolution,
): EndDraft {
  if (!current.closeDraftMergeConflict) return current
  if (resolution === 'phone') {
    return {
      ...current,
      closeDraftMergeConflict: false,
      closeDraftConflictCanonical: null,
    }
  }
  const view = current.closeDraftConflictCanonical
  if (view === null) return current
  const canonical = restoreCloseDraft(current, view)
  const canonicalOperations = {
    orders: canonical.orders,
    cashDeductions: canonical.cashDeductions,
    movements: canonical.movements,
  }
  // Keep additions that exist only on this phone, but never replay a same-key value or row edit
  // after the driver chose the server. The close UI has no delete action, so omission is not one.
  const safeLocalOnly = mergeCanonicalManualOperations(
    canonicalOperations,
    closeDraftOperationsPatch(current.orders, current.cashDeductions, current.movements),
  ).overlay
  const operations = applyCloseDraftOperationsOverlay(canonicalOperations, safeLocalOnly)
  return {
    ...canonical,
    ...operations,
    closeDraftMergeConflict: false,
    closeDraftConflictCanonical: null,
  }
}

/** Project the wallet fields into the reusable AI-authority state machine. */
const walletAuthority = (draft: EndDraft): AiOcrAuthorityState<string, File> => ({
  generation: draft.walletFile,
  phase:
    draft.walletCloud === null
      ? 'idle'
      : draft.walletCloud.status === 'reading'
        ? 'reading'
        : draft.walletCloud.status === 'read'
          ? 'read'
          : 'failed',
  value: draft.wallet === '' ? null : draft.wallet,
  aiValue: draft.walletOcr,
  humanEdited: draft.walletHumanEdited,
})

/** Keep the public close-package scalars in lockstep with the authority decision. */
const withWalletAuthority = (
  draft: EndDraft,
  authority: AiOcrAuthorityState<string, File>,
): EndDraft => ({
  ...draft,
  walletFile: authority.generation,
  wallet: authority.value ?? '',
  walletOcr: authority.aiValue,
  walletHumanEdited: authority.humanEdited,
})

/** Where a shift already in flight puts the driver back. */
const PHASE_FOR: Record<string, Phase> = {
  draft: 'start',
  awaiting_open_approval: 'awaiting',
  open: 'orders',
  // «معلقة» (س29): a manager put the shift on hold for a mid-shift incident. The driver sees why
  // and resumes when it clears; the data is later completed under the same equation.
  suspended: 'suspended',
  pending_review: 'done',
}

/** Accessing `localStorage` itself can throw in hardened/private browser contexts. */
const localDraftStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function ShiftFlow({
  assignment,
  batteries,
  spares = [],
  resume,
  onDiscarded,
}: {
  /** No `shiftNo`: the SERVER numbers the shift. A client cannot know which numbers are taken. */
  assignment: { driverId: string; vehicleId: string }
  /** The packs fitted to this bike, from `/me/assignment` — the same list the BR5 gate counts. */
  batteries: readonly FittedBattery[]
  /** Ready spares on the branch shelf, for a mid-shift swap (SRS §L seam). */
  spares?: readonly SpareBattery[]
  /** A shift already in flight. Present ⇒ resume it; absent ⇒ this is a fresh start. */
  resume?: { id: string; state: string }
  onDiscarded?(): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [phase, setPhase] = useState<Phase>(resume ? (PHASE_FOR[resume.state] ?? 'start') : 'start')
  // The fitted set can change mid-shift when the driver swaps a pack, so it lives in state: the
  // swap panel hands back the new fitment and the close screen then reads THAT, not the old pack.
  const [fitted, setFitted] = useState<readonly FittedBattery[]>(batteries)
  const [shift, setShift] = useState<ShiftState | null>(null)
  const [startRestore, setStartRestore] = useState<StartPackageRestore | null>(null)
  const [loaded, setLoaded] = useState(!resume)
  /** The resume fetch failed — shown as a retry, never as a phase we cannot actually render. */
  const [resumeFailed, setResumeFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [endDraft, setEndDraft] = useState<EndDraft>(freshEndDraft)
  const [closeDraftFailed, setCloseDraftFailed] = useState(false)
  const [closeDraftReloadKey, setCloseDraftReloadKey] = useState(0)
  const [closeDraftSaveFailed, setCloseDraftSaveFailed] = useState(false)
  const [closeDraftSaveRetryKey, setCloseDraftSaveRetryKey] = useState(0)
  const [hydratedDraftShiftId, setHydratedDraftShiftId] = useState<string | null>(null)
  const pendingStoredDraft = useRef<PersistedEndDraft | null>(null)
  // A changed resume prop names the new owner before its state request finishes; never let the old
  // in-memory draft win merely because `shift` still points at the previous response for a moment.
  const activeDraftShiftId = resume?.id ?? shift?.id ?? null
  const activeDraftShiftIdRef = useRef<string | null>(activeDraftShiftId)
  activeDraftShiftIdRef.current = activeDraftShiftId
  const previousDraftShiftId = useRef<string | null>(null)

  useEffect(() => {
    if (resume) setPhase(PHASE_FOR[resume.state] ?? 'start')
  }, [resume?.id, resume?.state])

  /** Restore once per shift, and remove the prior shift's scalar draft when identity changes. */
  useEffect(() => {
    const shiftId = activeDraftShiftId
    if (shiftId === null) return
    const storage = localDraftStorage()

    const previous = previousDraftShiftId.current
    const changedShift = previous !== null && previous !== shiftId
    if (changedShift && storage) clearEndDraft(storage, assignment.driverId, previous)
    previousDraftShiftId.current = shiftId

    if (changedShift) {
      const newShiftIsTerminal = resume?.id === shiftId && PHASE_FOR[resume.state] === 'done'
      const saved = !newShiftIsTerminal && storage
        ? readEndDraft(storage, assignment.driverId, shiftId)
        : null
      pendingStoredDraft.current = saved
      if (newShiftIsTerminal && storage) clearEndDraft(storage, assignment.driverId, shiftId)
      const blank = freshEndDraft()
      setEndDraft(saved ? restoreEndDraftScalars(blank, saved) : blank)
      setHydratedDraftShiftId(shiftId)
      return
    }

    if (phase === 'done') {
      pendingStoredDraft.current = null
      if (storage) clearEndDraft(storage, assignment.driverId, shiftId)
      if (hydratedDraftShiftId !== shiftId) setHydratedDraftShiftId(shiftId)
      return
    }
    if (hydratedDraftShiftId === shiftId) return

    const saved = storage ? readEndDraft(storage, assignment.driverId, shiftId) : null
    pendingStoredDraft.current = saved
    if (saved) setEndDraft((current) => restoreEndDraftScalars(current, saved))
    setHydratedDraftShiftId(shiftId)
  }, [activeDraftShiftId, assignment.driverId, hydratedDraftShiftId, phase, resume?.id, resume?.state])

  /** Persist only the dirty human overlay; canonical save removes it immediately. */
  useEffect(() => {
    const shiftId = activeDraftShiftId
    if (
      shiftId === null ||
      phase === 'done' ||
      hydratedDraftShiftId !== shiftId ||
      endDraft.closeDraftRevision === null ||
      endDraft.closeDraftMergeConflict
    ) return
    const storage = localDraftStorage()
    if (!storage) return
    const fingerprint = closeDraftEditableFingerprint({
      figures: {
        cashDeclared: endDraft.cash.trim() === '' ? null : endDraft.cash,
        walletDeclared: endDraft.wallet.trim() === '' ? null : endDraft.wallet,
        odometerKm: parseNonNegativeInteger(endDraft.odo),
        odometerAnomalyConfirmed: endDraft.odoConfirmed,
      },
      orders: endDraft.orders,
      cashDeductions: endDraft.cashDeductions,
      movements: endDraft.movements,
    })
    if (fingerprint === endDraft.persistedCloseDraftFingerprint) {
      clearEndDraft(storage, assignment.driverId, shiftId)
      return
    }
    const stored = writeEndDraft(
      storage,
      assignment.driverId,
      shiftId,
      {
        persistedCashDeclared: endDraft.persistedCashDeclared,
        persistedWalletDeclared: endDraft.persistedWalletDeclared,
        persistedOdometerKm: endDraft.persistedOdometerKm,
        persistedOdometerAnomalyConfirmed: endDraft.persistedOdometerAnomalyConfirmed,
        cash: endDraft.cash,
        wallet: endDraft.wallet,
        walletOcr: endDraft.walletOcr,
        walletHumanEdited: endDraft.walletHumanEdited,
        odo: endDraft.odo,
        odoOcr: endDraft.odoOcr,
        odoAiAuthoritative: endDraft.odoAiAuthoritative,
        odoHumanEdited: endDraft.odoHumanEdited,
        odoConfirmed: endDraft.odoConfirmed,
      },
      closeDraftOperationsPatch(endDraft.orders, endDraft.cashDeductions, endDraft.movements),
      fingerprint,
      { revision: endDraft.closeDraftRevision, draftHash: endDraft.closeDraftHash ?? '' },
    )
    if (!stored) setCloseDraftSaveFailed(true)
  }, [
    activeDraftShiftId,
    assignment.driverId,
    hydratedDraftShiftId,
    phase,
    endDraft.closeDraftRevision,
    endDraft.closeDraftMergeConflict,
    endDraft.persistedCloseDraftFingerprint,
    endDraft.persistedCashDeclared,
    endDraft.persistedWalletDeclared,
    endDraft.persistedOdometerKm,
    endDraft.persistedOdometerAnomalyConfirmed,
    endDraft.cash,
    endDraft.wallet,
    endDraft.walletOcr,
    endDraft.walletHumanEdited,
    endDraft.odo,
    endDraft.odoOcr,
    endDraft.odoAiAuthoritative,
    endDraft.odoHumanEdited,
    endDraft.odoConfirmed,
    endDraft.orders,
    endDraft.cashDeductions,
    endDraft.movements,
  ])

  const closeDraftSaveCycle = useRef(0)
  /** Persist human edits with bounded retry; conflicts rebase without discarding the local overlay. */
  useEffect(() => {
    if (
      phase !== 'end' || shift === null || endDraft.closeDraftRevision === null ||
      endDraft.closeDraftMergeConflict
    ) return
    const odometerKm = parseNonNegativeInteger(endDraft.odo)
    const fingerprint = closeDraftEditableFingerprint({
      figures: {
        cashDeclared: endDraft.cash.trim() === '' ? null : endDraft.cash,
        walletDeclared: endDraft.wallet.trim() === '' ? null : endDraft.wallet,
        odometerKm,
        odometerAnomalyConfirmed: endDraft.odoConfirmed,
      },
      orders: endDraft.orders,
      cashDeductions: endDraft.cashDeductions,
      movements: endDraft.movements,
    })
    if (fingerprint === endDraft.persistedCloseDraftFingerprint) {
      setCloseDraftSaveFailed(false)
      return
    }
    const expectedRevision = endDraft.closeDraftRevision
    const cycle = closeDraftSaveCycle.current + 1
    closeDraftSaveCycle.current = cycle
    let active = true
    const payload = {
      expectedRevision,
      figures: {
        cashDeclared: endDraft.cash.trim() === '' ? null : endDraft.cash,
        walletDeclared: endDraft.wallet.trim() === '' ? null : endDraft.wallet,
        odometerKm,
        odometerAnomalyConfirmed: endDraft.odoConfirmed,
      },
      operations: closeDraftOperationsPatch(
        endDraft.orders,
        endDraft.cashDeductions,
        endDraft.movements,
      ),
    }
    void runCloseDraftSaveWithRetry({
      save: () => api.patchCloseDraft(shift.id, payload),
      conflictValue: (error) => {
        const apiError = error as { error?: string; detail?: unknown }
        if (apiError.error !== 'close_draft_revision_conflict') return null
        const detail = apiError.detail as { current?: CloseDraftView } | undefined
        return detail?.current ?? null
      },
      isCurrent: () => active && closeDraftSaveCycle.current === cycle,
      onTransientFailure: () => {
        if (active && closeDraftSaveCycle.current === cycle) setCloseDraftSaveFailed(true)
      },
    }).then((result) => {
      if (!active || closeDraftSaveCycle.current !== cycle) return
      if (result.kind === 'conflict') {
        setCloseDraftSaveFailed(true)
        // A safe disjoint union adopts the latest revision and autosaves normally. A true
        // same-field conflict remains blocked; a generic transport retry is not permission to
        // overwrite the other editor's monetary value.
        setEndDraft((current) => rebaseCloseDraft(current, result.value))
        return
      }
      if (result.kind === 'saved') {
        setEndDraft((current) => ({
          ...rebaseCloseDraft(current, result.value, false),
          closeDraftMergeConflict: false,
          closeDraftConflictCanonical: null,
        }))
        setCloseDraftSaveFailed(false)
      }
    })
    return () => {
      active = false
      if (closeDraftSaveCycle.current === cycle) closeDraftSaveCycle.current += 1
    }
  }, [
    api,
    phase,
    shift?.id,
    closeDraftSaveRetryKey,
    endDraft.closeDraftRevision,
    endDraft.closeDraftMergeConflict,
    endDraft.persistedCloseDraftFingerprint,
    endDraft.cash,
    endDraft.wallet,
    endDraft.odo,
    endDraft.odoConfirmed,
    endDraft.orders,
    endDraft.cashDeductions,
    endDraft.movements,
  ])

  /**
   * WHAT THE SERVER SAYS THE SHIFT IS NOW — applied to the screen the driver is looking at.
   *
   * The app asked once, on mount, and then never again. So a manager could cancel a shift, suspend
   * it or force-close it and the driver's phone would go on showing «جارية» for the rest of the
   * day: he keeps delivering against a shift that no longer exists and finds out when his close is
   * refused. A reload always corrected it — `/me/assignment` reports only LIVE_STATES — which is
   * exactly why nobody noticed: the one person who never reloads is the driver mid-shift.
   *
   * Returns true when the shift is GONE and this component should stop caring about it.
   */
  // The phase as a ref so the watcher can READ it without being rebuilt on every phase change —
  // and so the decision is never taken inside a state updater, which React may run twice.
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const applyServerState = useCallback(
    (state: string): boolean => {
      // The decision itself is pure and tested (`driverPhaseFor`), so the screen and the rule
      // cannot drift; this only carries out what it decides.
      const { gone, phase: next } = driverPhaseFor(state, phaseRef.current)
      if (next) setPhase(next)
      if (gone === 'cancelled') {
        const storage = localDraftStorage()
        if (storage && activeDraftShiftIdRef.current) {
          clearEndDraft(storage, assignment.driverId, activeDraftShiftIdRef.current)
        }
        if (activeDraftShiftIdRef.current) void deletePendingEvidenceForShift(activeDraftShiftIdRef.current)
        toast.error(t.shift.cancelledByManager)
        onDiscarded?.()
        return true
      }
      if (gone === 'closed') {
        const storage = localDraftStorage()
        if (storage && activeDraftShiftIdRef.current) {
          clearEndDraft(storage, assignment.driverId, activeDraftShiftIdRef.current)
        }
        if (activeDraftShiftIdRef.current) void deletePendingEvidenceForShift(activeDraftShiftIdRef.current)
        toast.success(t.shift.closedByManager)
        return true
      }
      return false
    },
    [assignment.driverId, toast, t, onDiscarded],
  )

  const showManagerReturnReason = useCallback(
    (decision: { decision: 'approved' | 'rejected' | 'rephoto_requested'; notes: string | null } | null | undefined) => {
      if (!decision || (decision.decision !== 'rephoto_requested' && decision.decision !== 'rejected')) return
      const label = decision.decision === 'rejected' ? t.shift.closeRejected : t.shift.retakeRequested
      toast.error(decision.notes ? `${label}: ${decision.notes}` : label)
    },
    [t, toast],
  )

  /**
   * Poll while the shift is in flight.
   *
   * Twenty seconds: a cancellation the driver learns about a minute late is a minute of deliveries
   * recorded against nothing, and the request is one row.
   */
  useEffect(() => {
    const watching = phase === 'orders' || phase === 'end' || phase === 'suspended'
    if (!watching || !shift) return
    const timer = setInterval(() => {
      void api
        .shiftState(shift.id)
        .then((st) => applyServerState(st.state))
        // Swallowed: a dropped poll is a network blip, and the offline banner already says so.
        .catch(() => undefined)
    }, 20_000)
    return () => clearInterval(timer)
  }, [api, phase, shift, applyServerState])

  /**
   * Keep the manager-review screen alive. A rephoto changes the SAME shift from pending_review back
   * to open; without this small poll the phone remains in the success cul-de-sac until a hard reload.
   */
  useEffect(() => {
    if (phase !== 'done' || !shift) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const check = async (): Promise<void> => {
      try {
        const state = await api.shiftState(shift.id)
        if (cancelled) return
        if (state.state === 'open') {
          // Force a fresh canonical revision/hash. Keeping the submitted generation would make the
          // next submit fail with close_draft_changed and could hide the manager's evidence edits.
          setEndDraft((current) => ({
            ...current,
            closeDraftRevision: null,
            closeDraftHash: null,
          }))
          setCloseDraftFailed(false)
          setCloseDraftSaveFailed(false)
          showManagerReturnReason(state.lastDecision)
          applyServerState(state.state)
          stop()
          return
        }
        if (applyServerState(state.state)) stop()
      } catch {
        // A dropped poll is harmless; the next interval retries and the offline banner is visible.
      }
    }
    void check()
    timer = setInterval(() => void check(), 8_000)
    return () => {
      cancelled = true
      stop()
    }
  }, [api, phase, shift, applyServerState, showManagerReturnReason])

  /**
   * Pick the shift back up.
   *
   * The float and top-up come from the MANAGER's approval, so the order screen's live BR1 preview
   * would be wrong without them; the orders already recorded must come back because
   * `provider_order_no` is globally unique and retyping one is a 409 the driver cannot see.
   */
  useEffect(() => {
    if (!resume) return
    void api
      .shiftState(resume.id)
      .then((st) => {
        setStartRestore({
          odometerKm: st.startPackage.odometerKm,
          mediaSlots: st.startPackage.mediaSlots,
          batteries: st.startPackage.batteries,
        })
        setShift({
          id: st.id,
          floatText: st.startPackage.floatTotal,
          topupText: st.startPackage.topupTotal,
          businessDate: st.businessDate,
          odoStart: st.startPackage.odometerKm,
        })
        // The operations already stored come back INTO the draft, checkboxes and all. They are
        // editable now: the submit upserts, so correcting a sent row is a correction rather than
        // the 409 it used to be.
        setEndDraft((d) => ({
          ...d,
          /*
           * EVERYTHING THE SERVER ALREADY HOLDS COMES BACK, not just the orders.
           *
           * A cheap Android evicts a browser tab as a matter of course, and this app is used
           * outdoors for hours. On reopen the driver used to face empty photo tiles and blank
           * cash/wallet/odometer/battery fields — and a submit gate that refused him until he
           * re-shot and retyped every one of them, all of which the server had the whole time.
           * The typed figures are only overwritten while they are still blank, so a resume can
           * never clobber something he is in the middle of correcting.
           */
          slots: new Set(st.endPackage.mediaSlots),
          /*
           * THE PAGE COUNTS COME BACK TOO.
           *
           * `dashboardPages`/`logPages` start at 1 and were never restored, so a driver who
           * photographed six pages of «الطلبات الحديثة» and then had his tab evicted came back to a
           * SINGLE tile — his other five uploads present on the server, ticked nowhere, and the
           * add-page button the only way to see them again. Derived from the slots that actually
           * uploaded, so the screen shows exactly what the server holds.
           */
          dashboardPages: Math.max(d.dashboardPages, pagesIn(st.endPackage.mediaSlots, 'dashboard')),
          logPages: Math.max(d.logPages, pagesIn(st.endPackage.mediaSlots, PAYMENTS_LOG_SLOT)),
          cash: d.cash || (st.endPackage.cashDeclared ?? ''),
          wallet: d.wallet || (st.endPackage.walletDeclared ?? ''),
          walletOcr: d.walletOcr ?? st.endPackage.walletDeclaredOcr ?? null,
          walletHumanEdited:
            d.wallet !== ''
              ? d.walletHumanEdited
              : st.endPackage.walletDeclared !== null &&
                (st.endPackage.walletDeclaredOcr == null ||
                  st.endPackage.walletDeclared !== st.endPackage.walletDeclaredOcr),
          odo: d.odo || (st.endPackage.odometerKm === null ? '' : String(st.endPackage.odometerKm)),
          odoOcr: d.odoOcr ?? st.endPackage.odometerKmOcr ?? null,
          odoAiAuthoritative: d.odoAiAuthoritative || st.endPackage.odometerKmOcr !== null,
          odoHumanEdited: d.odoHumanEdited || st.endPackage.odometerKm !== null,
          // Owned by `BatteryPanel`, which is the only thing that knows the shape. Building it here
          // by hand — behind an `as` cast — is what crashed every resumed close screen.
          packs: restorePacks(st.endPackage.batteries, d.packs),
          batteryMediaIds: Object.fromEntries(
            st.endPackage.batteries.map((reading) => [reading.batteryId, reading.mediaId]),
          ),
          /*
           * THE THREE ROW LISTS BELONG TO THE CLOSE DRAFT, NOT TO THIS ENDPOINT.
           *
           * `st.orders` is the COMMITTED orders table (`orders.listByShift`, app.ts), and draft
           * rows only reach that table at close submit. For a shift that is still open it is
           * therefore ALWAYS EMPTY — so writing it unconditionally replaced the driver's real list
           * with nothing, every time this effect re-ran.
           *
           * That is what emptied محمد المسلماني's «الطلبات» on 2026-08-25: both dashboard reads
           * completed at 18:24, the server draft held 7 orders at 18:28, and his screen showed
           * «0 طلبات» at 18:31. The photo badges still said «القراءة: تمت» because
           * `closeDraftAttachments` is not one of the fields this block writes — so the read record
           * survived while the rows it produced did not.
           *
           * Nothing repaired it either: the close-draft fetch below is skipped once
           * `closeDraftRevision` is set, and the autosave fingerprint only covers MANUAL rows, so
           * deleting canonical OCR rows produced an identical fingerprint and sent nothing.
           *
           * The typed figures above were already protected — «a resume can never clobber something
           * he is in the middle of correcting». The row lists were simply left out of that promise.
           * Once a draft is loaded it is the owner; before that, restoring the committed rows is
           * still exactly right, which is what this endpoint is for.
           */
          ...(d.closeDraftRevision === null
            ? {
                orders: st.orders.map((o) => ({
                  // `already-<no>` rather than a random id: the list is rebuilt from the server on
                  // every resume, and a stable key keeps React from remounting rows he is editing.
                  localId: `already-${o.providerOrderNo}`,
                  providerOrderNo: o.providerOrderNo,
                  payMode: o.payMode,
                  feeText: o.fee,
                  recorded: true,
                  ...resumedOrderWindowState(o),
                  walletAmountText: o.walletAmount ?? '',
                  timeText: o.occurredMinute ?? '',
                  dateText: o.occurredDate ?? '',
                  // «A» و«B» come back from the stored route, so a resumed shift still shows where
                  // each order went — the only thing on the row a person can recognise.
                  pointA: o.points?.find((p) => p.role === 'start')?.label ?? null,
                  pointB: o.points?.find((p) => p.role === 'end')?.label ?? null,
                })),
                movements: (st.movements ?? []).map((m) => ({
                  localId: `already-${m.id}`,
                  amountText: m.amount,
                  timeText: m.occurredMinute,
                  included: m.included,
                  role: m.role,
                  ambiguous: m.ambiguous,
                })),
                cashDeductions: syncRecordedCashDeductions([], st.cashDeductions ?? []),
              }
            : {}),
        }))
        // Trust the server's state over the one the assignment reported: the manager may have
        // approved between the two calls. A shift that is no longer LIVE goes through the same
        // rule as the watcher — landing on «بدء النوبة» for a shift the manager cancelled is how
        // a driver ends up photographing an odometer for a shift that cannot accept it.
        if (!applyServerState(st.state)) setPhase(PHASE_FOR[st.state] ?? 'start')
        // C-7: if the manager bounced this shift back for a re-shoot or rejected the close, tell the
        // driver WHY — otherwise a shift that jumped back a phase looks like a silent glitch.
        showManagerReturnReason(st.lastDecision)
        setResumeFailed(false)
        setLoaded(true)
      })
      .catch(() => {
        // NOT a silent fall-through. `phase` came from /me/assignment, but `shift` is still null,
        // so every guarded branch below used to miss and land on the final «✓ بانتظار المراجعة»
        // screen — telling a driver whose shift is still running that he had finished it.
        setResumeFailed(true)
        setLoaded(true)
      })
  }, [api, resume, reloadKey, applyServerState, showManagerReturnReason])

  /**
   * The end screen never accepts evidence until its revisioned server draft is loaded.
   * This covers both a resumed shift and a freshly-opened shift entering close for the first time.
   */
  useEffect(() => {
    if (phase !== 'end' || shift === null || endDraft.closeDraftRevision !== null) return
    let cancelled = false
    setCloseDraftFailed(false)
    void api
      .closeDraft(shift.id)
      .then((view) => {
        if (cancelled) return
        const saved = pendingStoredDraft.current
        pendingStoredDraft.current = null
        setEndDraft((current) => rebaseStoredCloseDraft(current, view, saved))
      })
      .catch(() => {
        if (!cancelled) setCloseDraftFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [api, phase, shift?.id, endDraft.closeDraftRevision, closeDraftReloadKey])

  if (!loaded) {
    return (
      <Screen title={t.shift.resumeShift}>
        <Card>
          <p className="text-center text-slate-600">{t.common.loading}</p>
        </Card>
      </Screen>
    )
  }

  // The state could not be fetched. Say so and offer the retry, rather than guessing at a phase
  // whose data we do not have.
  if (resumeFailed && phase !== 'done') {
    return (
      <Screen title={t.shift.resumeShift}>
        <Card className="flex flex-col gap-3">
          <p className="text-center text-sm font-medium text-red-600">{t.shift.resumeFailed}</p>
          <Button onClick={() => setReloadKey((k) => k + 1)}>{t.common.retry}</Button>
        </Card>
      </Screen>
    )
  }

  if (phase === 'start' || phase === 'awaiting') {
    return (
      <StartPackage
        assignment={assignment}
        batteries={fitted}
        existingShiftId={resume?.id ?? null}
        restore={startRestore}
        onDiscarded={onDiscarded}
        awaiting={phase === 'awaiting'}
        onOpened={(id) => {
          setShift({ id, floatText: '0', topupText: '0', businessDate: '', odoStart: null })
          setPhase('awaiting')
        }}
        onApproved={(funds) => {
          // The manager entered the float + top-up at approval; carry them into the order screen so
          // the live BR1 preview is right.
          setShift((current) => openedShiftState(current, funds))
          setPhase('orders')
        }}
      />
    )
  }
  if (phase === 'suspended' && shift) {
    return <SuspendedScreen shiftId={shift.id} onResumed={() => setPhase('orders')} />
  }
  // The shift is RUNNING. No order entry here: the driver records his Yallago deliveries in one go
  // when he closes, by scanning the «Recent orders» list off his phone — which is how he reads them
  // anyway, and it stops a long shift being punctuated by typing. What he needs while out is the
  // battery, a way to flag an incident, and the beacon.
  if (phase === 'orders' && shift) {
    return (
      <Screen
        title={t.shift.running}
        footer={
          <Button variant="success" onClick={() => setPhase('end')}>
            {t.shift.finishShift}
          </Button>
        }
      >
        {/* WHAT HE IS CARRYING. For six hours the running screen showed three controls and no
            state at all — no float, no top-up, no order count — while the driver held the branch's
            money, which is the very figure he will be reconciled against at close. Both were in
            state already and used only for the closing preview. */}
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-sm text-slate-600">{t.shift.cashFloat}</span>
            <Money value={shift.floatText} className="font-semibold" />
            <span className="text-sm text-slate-600">{t.shift.walletTopup}</span>
            <Money value={shift.topupText} className="font-semibold" />
          </div>
        </Card>
        <Card>
          <p className="text-center text-sm text-slate-600">{t.shift.runningHint}</p>
        </Card>
        {/* «تبديل بطارية» (SRS §L seam): at a charging stop the driver swaps a depleted pack for a
            charged spare; both packs' readings are captured and the bike is re-fitted. */}
        <BatterySwap shiftId={shift.id} fitted={fitted} spares={spares} onSwapped={setFitted} />
        {/* «بلاغ حادثة» (C-1): the driver can't suspend himself — he flags the incident to the
            branch, which rings the bell so a manager can put the shift on hold. */}
        <ReportIncident shiftId={shift.id} />
        {/* SRS K: stream location while the shift is open (foreground-only). */}
        <GpsBeacon shiftId={shift.id} />
      </Screen>
    )
  }
  if (phase === 'end' && shift) {
    if (endDraft.closeDraftRevision === null) {
      return (
        <Screen
          title={t.shift.endShift}
          back={{ label: t.common.back, onBack: () => setPhase('orders') }}
        >
          <Card className="flex flex-col gap-3">
            <p className={`text-center text-sm ${closeDraftFailed ? 'font-medium text-red-700' : 'text-slate-600'}`}>
              {closeDraftFailed ? t.shift.resumeFailed : t.common.loading}
            </p>
            {closeDraftFailed ? (
              <Button onClick={() => setCloseDraftReloadKey((value) => value + 1)}>{t.common.retry}</Button>
            ) : null}
          </Card>
        </Screen>
      )
    }
    return (
      <EndPackage
        shift={shift}
        batteries={fitted}
        draft={endDraft}
        onDraft={setEndDraft}
        saveFailed={closeDraftSaveFailed}
        onRetrySave={() => {
          setCloseDraftSaveFailed(false)
          setCloseDraftSaveRetryKey((value) => value + 1)
        }}
        onResolveSaveConflict={(resolution) => {
          setCloseDraftSaveFailed(false)
          if (resolution === 'server') {
            // Resolve against a fresh canonical snapshot. The other device may have saved again
            // while this choice was on screen; restoring the first 409 body would rewind the CAS
            // revision and leave the close blocked a second time.
            const requestedShiftId = shift.id
            void api.closeDraft(requestedShiftId).then((latest) => {
              if (!ownsCloseDraftRefresh(
                activeDraftShiftIdRef.current,
                requestedShiftId,
                latest.shiftId,
              )) return
              setEndDraft((current) => {
                if (!ownsCloseDraftRefresh(
                  activeDraftShiftIdRef.current,
                  requestedShiftId,
                  latest.shiftId,
                )) return current
                return resolveCloseDraftMergeConflict(
                  rebaseCloseDraft(current, latest),
                  'server',
                )
              })
              setCloseDraftSaveRetryKey((value) => value + 1)
            }).catch(() => {
              if (activeDraftShiftIdRef.current === requestedShiftId) {
                setCloseDraftSaveFailed(true)
              }
            })
            return
          }
          setEndDraft((current) => resolveCloseDraftMergeConflict(current, 'phone'))
          setCloseDraftSaveRetryKey((value) => value + 1)
        }}
        // Back to the running shift. The operations list now lives ON this screen, so there is no
        // intermediate step to return to — and the package survives the trip either way.
        onBack={() => setPhase('orders')}
        onSubmitted={() => {
          const storage = localDraftStorage()
          if (storage) clearEndDraft(storage, assignment.driverId, shift.id)
          void deletePendingEvidenceForShift(shift.id)
          setPhase('done')
        }}
      />
    )
  }
  return (
    <Screen title={t.app.title}>
      <Card>
        <p className="text-center text-lg font-semibold text-emerald-700">{t.shift.states.pending_review} ✓</p>
      </Card>
      {/* Submitted, awaiting the manager. A missing order is now the manager's to add from the
          review — the driver no longer proposes one. */}
      <Card>
        <p className="text-center text-sm text-slate-600">{t.shift.awaitingManager}</p>
      </Card>
      {/* A WAY ON. This app is used twice a day and the close used to end in a cul-de-sac: two
          static cards, and the driver's only exits were the small «تسجيل الخروج» at the very top
          or killing the app. */}
      {onDiscarded ? <Button onClick={onDiscarded}>{t.shift.startAnother}</Button> : null}
    </Screen>
  )
}

/**
 * Post the orders, reporting BOTH what saved and what would not.
 *
 * It used to `await` each one with no catch: a single rejection — a duplicate order number is a
 * 409, and they are GLOBALLY unique — took the whole promise down, the phase never advanced, and
 * the driver tapped «تم» to no visible effect. Reporting the failures lets the screen say which.
 *
 * `sent` matters just as much on a PARTIAL failure. The rows before the one that failed are on the
 * server; if the caller forgets them, the driver's retry posts them a second time, every one comes
 * back a 409, and the list of "failed" orders grows on each attempt until nothing he can do will
 * clear it — a deadlock built out of orders that all saved perfectly the first time.
 */
async function submitOrders(
  api: ReturnType<typeof useApp>['api'],
  shiftId: string,
  orders: DraftOrder[],
): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = []
  const failed: string[] = []
  for (const o of orders) {
    const no = o.providerOrderNo.trim()
    try {
      await api.post(`/shifts/${shiftId}/orders`, {
        providerOrderNo: no,
        payMode: o.payMode,
        fee: o.feeText,
        zone: null,
        // SRS D-1/D-3: mark rows scanned off «Recent orders», keeping what OCR read as the baseline.
        // `refused` is its own answer — the reader saw this row and declined to price it, which is
        // not the same as a driver typing a fee from memory.
        source: o.feeOcrText != null ? 'ocr' : o.feeRefused === true ? 'refused' : 'manual',
        feeOcr: o.feeOcrText ?? null,
        feeStrip: o.feeStrip ?? null,
      })
      sent.push(no)
    } catch {
      failed.push(no)
    }
  }
  return { sent, failed }
}

function StartPackage({
  assignment,
  batteries,
  existingShiftId,
  restore,
  onDiscarded,
  awaiting,
  onOpened,
  onApproved,
}: {
  /** No `shiftNo`: the SERVER numbers the shift. A client cannot know which numbers are taken. */
  assignment: { driverId: string; vehicleId: string }
  batteries: readonly FittedBattery[]
  /** A draft that already exists. Present ⇒ attach to it; absent ⇒ create one. */
  existingShiftId?: string | null
  /** Opening package already persisted by this draft, restored from the driver's state endpoint. */
  restore?: StartPackageRestore | null
  /** Called after the draft is cancelled, to return to bike selection. */
  onDiscarded?: (() => void) | undefined
  awaiting: boolean
  onOpened(shiftId: string): void
  /**
   * The manager approved. Carries the shift's OWN DAY as well as the money: the poller already has
   * it in hand, and without it the operations list compares every scanned row's date against an
   * empty string and stamps «يوم آخر» on all of them.
   */
  onApproved(funds: OpenedShiftFunds): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [shiftId, setShiftId] = useState<string | null>(existingShiftId ?? null)
  const [odo, setOdo] = useState(
    restore?.odometerKm === null || restore?.odometerKm === undefined ? '' : String(restore.odometerKm),
  )
  // SRS D-3 baseline: what OCR read for the odometer, kept even if the driver then edits it, so the
  // manager sees «قراءة الآلة ← ما أكّده السائق».
  const [odoOcr, setOdoOcr] = useState<number | null>(null)
  /**
   * The dashboard as the reader worked on it — training material, kept whether it read or refused.
   *
   * Measured on three real shifts this reader was wrong three times out of three, and every
   * correction was thrown away. A refusal is the MORE valuable sample: it is the case it is
   * currently getting wrong, about to be labelled by the driver typing the right number.
   */
  const [odoStrip, setOdoStrip] = useState<string | null>(null)
  /** What the cloud reader is doing with the odometer photo. `null` until one is picked. */
  const [odoCloud, setOdoCloud] = useState<CloudReadEvent | null>(null)
  /** Explicit driver input is authoritative over either asynchronous reader. */
  const odoHumanEdited = useRef(restore?.odometerKm !== null && restore?.odometerKm !== undefined)
  /** Phone OCR is retained only as labelled training/status evidence; it never owns a number. */
  const [odoLocal, setOdoLocal] = useState<LocalOdometerReadEvent | null>(null)
  /** Kept so a timed-out read can be retried without another trip to the gallery. */
  const [odoFile, setOdoFile] = useState<File | null>(null)
  const odoFileRef = useRef<File | null>(null)
  const [odoShot, setOdoShot] = useState(restore?.mediaSlots.includes('odometer') ?? false)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [startSlots, setStartSlots] = useState<Set<string>>(() => new Set(restore?.mediaSlots ?? []))
  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)

  // The phone still reads the original dashboard pixels so its sample can be trained, but its
  // numeric guess is never published. Cloud AI is the sole automatic odometer authority.
  const runOcr = useCallback(async (file: File): Promise<void> => {
    setOdoLocal({ status: 'reading' })
    try {
      const { readDashboard } = await import('../ocr.ts')
      // The ORIGINAL file, not the compressed upload: 1280 px at q=0.4 puts body text under the
      // LSTM's recognition floor, and no tesseract parameter recovers from that.
      const result = await readDashboard(file)
      if (odoFileRef.current !== file) return
      // The picture and outcome are training/status evidence only. Never copy `result.reading`
      // into either the visible value or the OCR baseline.
      setOdoStrip((cur) => cur ?? result.sample ?? null)
      setOdoLocal(
        localOdometerEvent(
          result.ok ? { ok: true, odometer: result.reading.odometer } : result,
        ),
      )
    } catch {
      if (odoFileRef.current === file) {
        setOdoLocal({ status: 'failed', reason: 'unavailable' })
      }
    }
  }, [])

  /**
   * The odometer read in the CLOUD, and this is the one worth having.
   *
   * Migration `0022`'s header records what the on-device reader does with this photograph: wrong
   * THREE TIMES OUT OF THREE — 200 for 6948, 229 for 5426, and a refusal. Its failure is not a
   * misread digit but a wrong CHOICE of number on a dashboard that also shows a trip meter and a
   * voltage, which is the hardest thing to fix with better glyph templates and the easiest thing
   * for a model that can read the labels around it.
   *
   * It is the only callback that may write the machine baseline. What it does not overwrite is a
   * number the driver has typed.
   */
  const odoCloudRead = useCallback((e: CloudReadEvent, file?: File): void => {
    if (file && odoFileRef.current !== file) return
    if (e.status !== 'read') {
      setOdoCloud(e)
      return
    }
    // The reader is told to label it «odometer»; accept the obvious variants rather than failing
    // on a synonym, since a wrong label costs the whole read.
    const km = odometerFromCloudFields(e.response.fields)
    if (km === null) {
      // A structured response without an odometer is a terminal, visible failure — never a hidden
      // success and never permission to promote the phone's guess.
      setOdoCloud({ status: 'failed', reason: 'no_fields', retryable: e.response.retryable })
      return
    }
    setOdoCloud(e)
    // Digits only. «ODO 02611 km» must not become 2611000 because "km" carried digits, and a
    // fractional odometer is not a thing this dashboard prints.
    setOdoOcr(km)
    if (!odoHumanEdited.current) setOdo(String(km))
  }, [])

  /**
   * Read the odometer photo again after a timeout, from the file already in hand.
   *
   * A timeout is the one failure worth offering a button for: it means the reader ANSWERED too
   * slowly, not that it refused, so the same pixels often succeed on a second attempt. The server
   * caches by content hash, so a retry that lands after the first one finally arrives costs
   * nothing — and neither does one that fails again.
   */
  const retryOdoCloud = useCallback(
    async (file: File): Promise<void> => {
      if (!shiftId) return
      setOdoCloud({ status: 'reading' })
      const res = await readInCloud(api, shiftId, 'odometer', file, true)
      odoCloudRead(
        res === null
          ? { status: 'failed', reason: 'unavailable', retryable: false }
          : res.ok
            ? { status: 'read', response: res }
            : { status: 'failed', reason: res.reason ?? 'unavailable', retryable: res.retryable },
        file,
      )
    },
    [api, shiftId, odoCloudRead],
  )

  // Create the draft shift once, so the odometer photo has a shift to attach to. If this fails the
  // driver must be TOLD: swallowing it left the camera tile stuck on "loading" with no way to know
  // the bike was already on someone else's shift.
  useEffect(() => {
    // A shift the driver is RESUMING already exists. Posting again would be refused with
    // `driver_already_on_shift` — which is exactly the dead end resuming exists to end.
    if (shiftId) return
    void api
      .post<{ id: string }>('/shifts', assignment)
      .then((s) => {
        setShiftId(s.id)
        setCreateError(null)
      })
      .catch((e) => {
        const err = e as { error?: string; detail?: unknown }
        const detail = Array.isArray(err.detail) ? String(err.detail[0]) : undefined
        setCreateError(detail ?? err.error ?? 'error')
      })
  }, [api, assignment, shiftId])

  async function confirm(): Promise<void> {
    if (!shiftId) return
    if (odoCloud?.status === 'reading') return
    const odometerKm = parseNonNegativeInteger(odo)
    if (odometerKm === null) return
    setBusy(true)
    try {
      // The driver submits only the odometer + photo. The cash float and wallet top-up are the
      // branch's money, entered by the manager at approval. Charge is captured per pack, so the
      // bike-level battery % is gone (sent null — the column stays a nullable seam).
      const submitted = await api.put<{
        id: string
        state: string
        businessDate: string
        startPackage: { odometerKm: number | null; floatTotal: string; topupTotal: string }
      }>(`/shifts/${shiftId}/start-package`, {
        odometerKm,
        batteryPercent: null,
        // SRS D-3: the odometer OCR baseline (null when OCR never ran).
        odometerKmOcr: odoOcr,
        batteryPercentOcr: null,
        // What the reader was looking at, so the correction he just made becomes an example.
        odometerStrip: odoStrip,
      })
      if (submitted.state === 'open') {
        onApproved({
          shiftId: submitted.id,
          floatText: submitted.startPackage.floatTotal,
          topupText: submitted.startPackage.topupTotal,
          businessDate: submitted.businessDate,
          odoStart: submitted.startPackage.odometerKm,
        })
      } else {
        onOpened(shiftId)
      }
    } catch (e) {
      // A driver can't read a console — a failed upload must show on the glass, not vanish.
      const code = (e as { error?: string }).error
      toast.error((code && (t.errors as Record<string, string>)[code]) || t.common.actionFailed)
    } finally {
      setBusy(false)
    }
  }

  /** How long he has been standing at the branch waiting — so the screen is visibly alive. */
  const [waitedSec, setWaitedSec] = useState(0)
  useEffect(() => {
    if (!awaiting) return
    const timer = setInterval(() => setWaitedSec((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [awaiting])

  // Poll for the branch manager's approval once submitted. On approval, read the float + top-up the
  // manager recorded so the order screen's live BR1 preview matches the ledger.
  useEffect(() => {
    if (!awaiting || !shiftId) return
    const timer = setInterval(async () => {
      try {
        const s = await api
          // `/state`, not the manager's `/review`: that one is `shift.approve`, so every poll a
          // driver made returned 403, was swallowed, and he waited on an approval that had
          // already happened.
          .shiftState(shiftId)
          .catch(() => null)
        if (s?.state === 'open') {
          onApproved({
            shiftId: s.id,
            floatText: s.startPackage.floatTotal,
            topupText: s.startPackage.topupTotal,
            businessDate: s.businessDate,
            odoStart: s.startPackage.odometerKm,
          })
        }
      } catch {
        /* keep polling */
      }
    }, 4000)
    return () => clearInterval(timer)
  }, [awaiting, shiftId, api, onApproved])

  // Back out of a fresh (or resumed-but-unopened) shift. The draft it created holds the bike and
  // nothing has posted yet, so cancelling it releases the bike and returns to selection — the only
  // way «العودة من هنا» before the manager opens the shift.
  const discardSelf = async (): Promise<void> => {
    if (!shiftId) return
    await api.cancelMyShift(shiftId).catch(() => undefined)
    onDiscarded?.()
  }

  if (awaiting) {
    return (
      <Screen title={t.shift.startShift}>
        {/* A WAIT WITH INFORMATION IN IT. This was one amber line and nothing else: no sign the
            manager had been told, no elapsed time, no evidence the check was still running — and
            if the poll was failing (no signal) the screen looked exactly the same as a healthy
            wait, forever. The only labelled way out was the destructive one. */}
        <Card className="flex flex-col gap-2">
          <p className="text-center text-lg font-semibold text-amber-700">{t.shift.states.awaiting_open_approval}…</p>
          <p className="num text-center text-sm text-slate-600">
            {t.shift.waitingFor} {Math.floor(waitedSec / 60)}:{String(waitedSec % 60).padStart(2, '0')}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full w-1/3 animate-[ash-slide_1.2s_ease-in-out_infinite] rounded-full bg-amber-500" />
          </div>
        </Card>
        {shiftId ? <DiscardButton onDiscard={discardSelf} /> : null}
      </Screen>
    )
  }

  // Opening remains strict: a driver cannot confirm the start until every fitted pack's required
  // reading is in. End-of-shift evidence is different because an incomplete pack can be handed to
  // the manager for review, but the opening baseline must be complete before work begins.
  const missing: string[] = [
    ...(odoShot ? [] : [t.shift.odometerShot]),
    ...(parseNonNegativeInteger(odo) === null ? [t.shift.odometer] : []),
    ...(batteriesReady ? [] : [t.battery.percent]),
    ...(odoCloud?.status === 'reading' ? [t.shift.reading] : []),
    // `shiftId` was a silent term of `ready` while the panel below rendered only for a non-empty
    // list — the same shape that stranded five drivers at the CLOSING gate on 2026-08-24. A driver
    // whose shift never got created could fill everything in and tap a dead button forever.
    ...(shiftId === null ? [t.shift.shiftNotCreated] : []),
  ]
  const ready = missing.length === 0

  return (
    <Screen
      title={t.shift.startShift}
      footer={
        <div className="flex flex-col gap-2">
          {!ready ? (
            <p className="text-sm font-medium text-amber-800">
              {t.shift.stillMissing} {missing.join(' · ')}
            </p>
          ) : null}
          <Button variant="success" disabled={!ready || busy} onClick={confirm}>
            {busy ? t.common.loading : t.shift.confirmStart}
          </Button>
        </div>
      }
    >
      {shiftId ? (
        <PhotoSlot
          shiftId={shiftId}
          pkg="start"
          slot="odometer"
          label={t.shift.odometer}
          uploaded={odoShot}
          onUploaded={(slot) => {
            setOdoShot(true)
            setStartSlots((cur) => new Set(cur).add(slot))
          }}
          /*
           * The server holds this photo even though a newer selection owns the tile. Without this
           * the gate goes on demanding «صورة العداد» for evidence that already exists, and the
           * driver's only way out is discarding the shift he is standing in front of.
           */
          onSupersededAttach={(slot) => {
            setOdoShot(true)
            setStartSlots((cur) => new Set(cur).add(slot))
          }}
          onImage={(file) => {
            odoFileRef.current = file
            setOdoCloud(null)
            setOdoOcr(null)
            setOdoStrip(null)
            setOdoLocal({ status: 'reading' })
            // A new photograph must not inherit a machine-prefill from the old one. A value the
            // driver actually typed is different: human input remains authoritative across a retake.
            setOdo(odometerValueForRetake(odo, odoHumanEdited.current))
            setOdoFile(file)
            void runOcr(file)
          }}
          ocrField="odometer"
          onCloudRead={odoCloudRead}
        />
      ) : (
        <Card>
          {createError ? (
            <p className="text-center font-medium text-red-600">
              {t.shift.cannotStart[createError as keyof typeof t.shift.cannotStart] ?? createError}
            </p>
          ) : (
            <p className="text-center text-slate-600">{t.common.loading}</p>
          )}
        </Card>
      )}
      {existingShiftId ? (
        <Card>
          <p className="text-center text-sm text-slate-500">{t.shift.resumeHint}</p>
        </Card>
      ) : null}
      <ReadingLock active={odoCloud?.status === 'reading'}>
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.odometer}>
          <TextInput
            inputMode="numeric"
            value={odo}
            onChange={(e) => {
              odoHumanEdited.current = true
              setOdo(normalizeDecimalDigits(e.target.value))
            }}
          />
        </Field>
        {/* WHERE THIS NUMBER CAME FROM. Captured on every shift as the D-3 baseline and shown
            nowhere until now, so a pre-filled OCR odometer and one typed from memory looked
            identical. This reader was wrong three times out of three on real shifts. */}
        <SourceMark source={sourceOf({ ocrValue: odoOcr, hadImage: odoStrip !== null, value: odo })} />
        <LocalOdometerReadStatus
          event={odoLocal}
          {...(odoFile ? { onRetry: () => void runOcr(odoFile) } : {})}
        />
        {/* The odometer is the screen the on-device reader is WORST at — migration 0022 records it
            wrong three times out of three — so it is also the one where a silent cloud failure
            costs the most. Retry re-reads the file already in hand; no second trip to the gallery. */}
        <CloudReadStatus
          event={odoCloud}
          {...(odoFile ? { onRetry: () => void retryOdoCloud(odoFile) } : {})}
        />
      </Card>
      </ReadingLock>
      {/* One screenshot and one set of numbers per pack fitted — the same count the gate reads. */}
      {shiftId ? (
        <BatteryPanel
          shiftId={shiftId}
          pkg="start"
          batteries={batteries}
          slots={startSlots}
          onSlotUploaded={(slot) => setStartSlots((cur) => new Set(cur).add(slot))}
          onReadingsChanged={setBatteriesReady}
          initialPacks={restorePacks(restore?.batteries ?? [], {})}
          initialMediaIds={Object.fromEntries(
            (restore?.batteries ?? []).map((reading) => [reading.batteryId, reading.mediaId]),
          )}
        />
      ) : null}
      {/* Destructive, so it sits at the END. It used to be wedged between the odometer photo and the
          number that photo produced — the one place on this screen where a mis-tap costs the whole
          start package, directly in the path of the eye moving from picture to field. */}
      {shiftId ? <DiscardButton onDiscard={discardSelf} /> : null}
    </Screen>
  )
}

/** The phone reader has its own outcome and retry; a cloud outcome must never hide or replace it. */
function LocalOdometerReadStatus({
  event,
  onRetry,
}: {
  event: LocalOdometerReadEvent | null
  onRetry?: (() => void) | undefined
}): ReactNode {
  const { t } = useApp()
  if (event === null || event.status === 'read') return null
  if (event.status === 'reading') {
    return <p className="text-sm text-slate-600">{t.shift.localOcrReading}</p>
  }

  return (
    <div className="flex flex-col items-start gap-1" aria-live="polite">
      <p className="text-sm font-medium text-amber-800">
        {t.shift[localOdometerFailureCopyKey(event.reason)]}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900"
        >
          {t.shift.localOcrRetry}
        </button>
      ) : null}
    </div>
  )
}

function EndPackage({
  shift,
  batteries,
  draft,
  onDraft,
  saveFailed,
  onRetrySave,
  onResolveSaveConflict,
  onBack,
  onSubmitted,
}: {
  shift: ShiftState
  batteries: readonly FittedBattery[]
  /** Held by the caller so the package survives a step back to the order list. See `EndDraft`. */
  draft: EndDraft
  onDraft: Dispatch<SetStateAction<EndDraft>>
  saveFailed: boolean
  onRetrySave(): void
  onResolveSaveConflict(resolution: CloseDraftConflictResolution): void
  onBack?(): void
  onSubmitted(): void
}): ReactNode {
  const { api, t, lang } = useApp()
  const toast = useToast()
  const { cash, wallet, walletOcr, odo, odoConfirmed, slots } = draft
  const odometerFields = endOdometerSubmission(odo, draft.odoOcr, odoConfirmed)
  const odometerKm = odometerFields?.odometerKm ?? null
  const patch = useCallback((p: Partial<EndDraft>): void => onDraft((d) => ({ ...d, ...p })), [onDraft])
  // Stable, and a no-op update when the readings are unchanged — an unstable callback here would
  // loop the panel's notify-effect against this state.
  const onPacksChanged = useCallback(
    (packs: Record<string, PackState>): void => onDraft((d) => (d.packs === packs ? d : { ...d, packs })),
    [onDraft],
  )
  const [br1, setBr1] = useState<{ difference: string; balanced: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  /** A server refusal stays beside the close button until the driver fixes it or retries. */
  const [closeFailure, setCloseFailure] = useState<EndSubmitFailureNotice | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const applyCanonicalDraft = useCallback(
    (view: CloseDraftView): void => onDraft((current) => rebaseCloseDraft(current, view)),
    [onDraft],
  )

  /** Read only an accepted attachment generation. Raw/unlinked OCR is not used by this screen. */
  const readLinkedAttachment = useCallback(
    async (
      slot: string,
      field: 'orders' | 'payments_log' | 'wallet' | 'odometer' | 'bms',
      retryFailed: boolean,
      upload?: EvidenceUploadResponse,
      signal?: AbortSignal,
    ): Promise<CloseDraftReadResponse | null> => {
      const uploadedDraft = upload?.draft
      if (uploadedDraft) applyCanonicalDraft(uploadedDraft)
      const current = uploadedDraft ?? null
      const attachment =
        current?.attachments.find((item) => item.slot === slot) ??
        draftRef.current.closeDraftAttachments[slot] ??
        (upload
          ? {
              package: 'end' as const,
              slot,
              mediaId: upload.mediaId,
              attachmentToken: upload.attachmentToken,
              read: null,
            }
          : null)
      const revision = current?.revision ?? draftRef.current.closeDraftRevision
      if (!attachment || revision === null) return null

      // A unique presentation id is the ownership token for this exact browser request. Reusing
      // the persisted read id let an aborted older request restore over a newer retry of the same
      // attachment token.
      const pendingReadId = `pending-${attachment.attachmentToken}-${clientUuid()}`

      /** Restore only the local marker installed below; keep the accepted image and canonical draft. */
      const restorePendingRead = (): void => {
        onDraft((state) => {
          if (!ownsPendingCloseDraftRead(
            state.closeDraftAttachments,
            slot,
            attachment.attachmentToken,
            pendingReadId,
          )) return state
          return {
            ...state,
            ...(field === 'wallet' ? { walletCloud: null } : {}),
            ...(field === 'odometer' ? { odoCloud: null } : {}),
            closeDraftAttachments: {
              ...state.closeDraftAttachments,
              [slot]: attachment,
            },
          }
        })
      }

      // A running marker is presentation only. It is deliberately not terminal, so the IndexedDB
      // copy remains until the server returns a persisted complete/failed read.
      onDraft((state) => ({
        ...state,
        closeDraftAttachments: {
          ...state.closeDraftAttachments,
          [slot]: {
            ...attachment,
            read: attachment.read
              ? { ...attachment.read, readId: pendingReadId, status: 'running', failure: null }
              : {
                  readId: pendingReadId,
                  status: 'running',
                  field,
                  failure: null,
                  attempts: 0,
                },
          },
        },
      }))
      /*
       * A BROWSER-SIDE DEADLINE FOR EVERY READ, NOT JUST THE BATTERY ONE.
       *
       * `signal` is optional and exactly one of the nine call sites passes one — the BMS panel,
       * which wraps its read in `createLinkedReadTask`. Orders, payments-log, wallet and odometer
       * reads ran bare: no deadline, no cancel. A fetch whose connection never settles therefore
       * left the `running` marker installed above in place FOREVER, and a running read is a hard
       * close blocker (`readingInFlight` in `close-gate.ts`) whose retry button is hidden.
       *
       * That is unrecoverable without closing the app, at the end of a shift, standing at the
       * branch. Provider and API deadlines cannot help — they bound the server, not this socket.
       * So a caller that brings no lifetime of its own gets one here.
       */
      const ownDeadline = signal ? null : new AbortController()
      const deadlineTimer = ownDeadline
        ? setTimeout(() => ownDeadline.abort('timeout'), LINKED_READ_UI_TIMEOUT_MS)
        : null
      const effectiveSignal = signal ?? ownDeadline?.signal
      const onAbort = (): void => restorePendingRead()
      effectiveSignal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (effectiveSignal?.aborted) {
          restorePendingRead()
          return null
        }
        const response = await api.readCloseDraftAttachment(shift.id, slot, {
          expectedRevision: revision,
          mediaId: attachment.mediaId,
          attachmentToken: attachment.attachmentToken,
          field,
          ...(retryFailed ? { retryFailed: true } : {}),
        }, effectiveSignal ? { signal: effectiveSignal } : {})
        if (effectiveSignal?.aborted) return null
        onDraft((state) => {
          if (!ownsPendingCloseDraftRead(
            state.closeDraftAttachments,
            slot,
            attachment.attachmentToken,
            pendingReadId,
          )) return state
          return applyLinkedScalarRead(state, response, field, attachment.attachmentToken)
        })
        return response
      } catch (error) {
        if (effectiveSignal?.aborted) {
          restorePendingRead()
          return null
        }
        const apiError = error as { error?: string; detail?: unknown }
        const detail = apiError.detail as { current?: CloseDraftView } | undefined
        const latest = detail?.current
        if (latest) applyCanonicalDraft(latest)
        else restorePendingRead()
        return null
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer)
        effectiveSignal?.removeEventListener('abort', onAbort)
      }
    },
    [api, shift.id, applyCanonicalDraft, onDraft],
  )

  // Heal a phone-only overlap even when it entered the draft before this component rendered (for
  // example while a service-worker update was waiting). Persisted rows carry `recorded:true` and
  // are deliberately left for the server's audited reconciliation path.
  useEffect(() => {
    const reconciled = reconcileLocalCashDeductions(draft.cashDeductions)
    if (reconciled.length === draft.cashDeductions.length) return
    onDraft((current) => {
      const currentReconciled = reconcileLocalCashDeductions(current.cashDeductions)
      return currentReconciled.length === current.cashDeductions.length
        ? current
        : { ...current, cashDeductions: currentReconciled }
    })
  }, [draft.cashDeductions, onDraft])

  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)
  // The zeroed-wallet photo was dropped (product owner) — the wallet screenshot is the evidence.
  // «سجل المدفوعات» is optional archive/training evidence only. It neither classifies order pay
  // modes nor changes BR1, so an unread or absent log must never keep a driver at the branch.
  const required = ['dashboard', 'wallet', 'odometer']
  const labels: Record<string, string> = {
    dashboard: t.shift.dashboardShot,
    wallet: t.shift.walletBalance,
    odometer: t.shift.odometer,
    payments_log: t.shift.paymentsLog,
  }
  /**
   * The tiles, in order, with the extra PAGES of the two scrollable screens sitting under page 1.
   *
   * Only page 1 of the dashboard is required (`required` is unchanged, and so is the server gate):
   * a short day genuinely fits one screenful, and demanding a second would be demanding a
   * screenshot of nothing.
   */
  const labelOf = (slot: string): string => {
    const { base, n } = splitSlot(slot)
    const name = labels[base] ?? slot
    return n === 1 ? name : `${name} ${n}`
  }
  // Each fitted pack's closing charge is still measured here, but incomplete END evidence is a
  // manager-review warning rather than a reason to strand the driver at work. The server
  // atomically transfers only those incomplete packs to the manager when the shift is submitted.
  // The bike-level battery field is gone — charge is tracked per pack.
  // The close gate counts the shift's ORDERS, checked or not — see `endPackageGaps`. Deliberately
  // the total and not the checked count: a driver who unchecks everything would otherwise be
  // refused submission, and every tool that could rescue him needs the shift to reach review first.
  const named = draft.orders.filter((o) => o.providerOrderNo.trim() !== '').length
  const currentDraftFingerprint = closeDraftEditableFingerprint({
    figures: {
      cashDeclared: cash.trim() === '' ? null : cash,
      walletDeclared: wallet.trim() === '' ? null : wallet,
      odometerKm,
      odometerAnomalyConfirmed: odoConfirmed,
    },
    orders: draft.orders,
    cashDeductions: draft.cashDeductions,
    movements: draft.movements,
  })
  const draftSaved =
    !draft.closeDraftMergeConflict &&
    currentDraftFingerprint === draft.persistedCloseDraftFingerprint
  const draftSaveNotice = closeDraftSaveNotice(
    draftSaved,
    saveFailed,
    draft.closeDraftMergeConflict,
  )
  const readingAttachment = Object.values(draft.closeDraftAttachments).some(
    (attachment) =>
      attachment.read?.status === 'running' && attachment.read.field !== 'payments_log',
  )
  /**
   * WHAT IS STILL MISSING, named — instead of one grey button and no explanation.
   *
   * Seven independent conditions used to collapse into a single `disabled`, at the bottom of a
   * page several thousand pixels long. The driver's worst moment in the product was standing at
   * the branch at the end of a shift, everything apparently filled in, tapping a dead button that
   * said nothing about the blank battery field or the one bad fee twenty rows up.
   *
   * The list IS the gate: `ready` is now "nothing missing", so the two can never drift apart.
   *
   * ── AND IT MUST STAY THAT WAY. On the night of 2026-08-24 it did not. ──────────────────────
   * `ready` was `missing.length === 0 && !odometerNeedsConfirmation && draftSaved`: three
   * conditions, one list. When the list was EMPTY and `draftSaved` was false, the explanation
   * below rendered nothing at all — it was guarded on `missing.length > 0` — so the driver got a
   * dead green button, no words, and a 12px grey «حفظ المسودة» that never went away.
   *
   * That is precisely how امجد عبدالله was stranded at 01:39 with thirteen photos, fifteen orders
   * and every figure filled in. The cause behind it (a `500` / `500.00` fingerprint mismatch that
   * kept autosave permanently dirty) is fixed in `closeDraftEditableFingerprint`; this is the
   * guarantee that the NEXT such mismatch names itself instead of hiding behind a grey button.
   *
   * So every condition lives in the list. `ready` is the list being empty, and nothing else.
   */
  const odometerQuestion = checkOdometer(shift.odoStart, odometerKm)
  const odometerNeedsConfirmation = odometerQuestion?.kind === 'odometer_went_backwards' && !odoConfirmed
  const blockers = closeGateBlockers({
    requiredSlots: required,
    presentSlots: slots,
    cashText: cash,
    walletText: wallet,
    moneyIsUsable: isUsableMoneyText,
    odometerKm,
    namedOrderCount: named,
    // The gate must judge exactly the rows on his screen. A copy superseded by a retake raises
    // `duplicate_order_no` against the row that replaced it — on shift d0a5a7ec that was ten such
    // collisions, none of them visible to the driver, refusing a close he could not repair. That is
    // the shape that stranded امجد: a refusal naming something he cannot find.
    hasBadOrderRows: allProblems(withoutSupersededRemnants(draft.orders)).size > 0,
    hasBadDeductionRows: !cashDeductionsAreValid(withoutSupersededRemnants(draft.cashDeductions)),
    readingInFlight: readingAttachment,
    odometerNeedsConfirmation,
    draftSaved,
  })
  const missing = blockers.map((blocker) => {
    switch (blocker.kind) {
      // The photo is named AS a photo — the slot catalogue gives «العداد» to both the picture and
      // the number, so the footer used to read «العداد · … · العداد» with no way to tell them apart.
      case 'missing_photo':
        return `${t.shift.photoOf} ${labelOf(blocker.slot)}`
      case 'missing_value':
        return blocker.field === 'cash'
          ? t.shift.cashHandover
          : blocker.field === 'wallet'
            ? t.shift.walletBalance
            : t.shift.odometer
      case 'unreadable_money':
        return `${blocker.field === 'cash' ? t.shift.cashHandover : t.shift.walletBalance} — ${t.shift.badMoneyFigure}`
      case 'no_orders':
        return t.orders.title
      case 'bad_rows':
        return t.shift.fixOrderRows
      case 'reading_in_flight':
        return t.shift.reading
      case 'confirm_odometer':
        return t.shift.confirmOdometerReading
      case 'draft_not_saved':
        return t.shift.draftNotSaved
    }
  })
  const ready = blockers.length === 0

  const preview = previewBr1({
    floatText: shift.floatText,
    topupText: shift.topupText,
    orders: draft.orders,
    movements: draft.movements,
    cashDeductions: draft.cashDeductions,
    // Spread so the keys are ABSENT rather than undefined: the preview shows a difference only
    // once BOTH declared figures exist, and an explicit `undefined` would satisfy that check.
    ...(cash === '' || wallet === '' ? {} : { declaredCashText: cash, declaredWalletText: wallet }),
  })
  const previewDifference =
    preview?.differenceText === null || preview?.differenceText === undefined
      ? null
      : br1DifferencePresentation(preview.differenceText)
  const submittedDifference = br1 === null ? null : br1DifferencePresentation(br1.difference)
  const reviewWarningKeys = endReviewWarningKeys({
    difference: previewDifference?.direction ?? null,
    batteriesReady,
  })
  const reviewWarnings = reviewWarningKeys.map((key) =>
    key === 'moneyMismatch'
      ? t.shift.reviewWarningMoneyMismatch
      : t.shift.reviewWarningBatteryIncomplete,
  )

  /** Submit the exact revision/hash; the server materialises its canonical draft atomically. */
  async function submit(): Promise<void> {
    if (
      odometerFields === null ||
      draft.closeDraftRevision === null ||
      draft.closeDraftHash === null ||
      Object.values(draft.closeDraftAttachments).some(
        (item) => item.read?.status === 'running' && item.read.field !== 'payments_log',
      )
    ) return
    setCloseFailure(null)
    setBusy(true)
    try {
      // Replace, do not merely mark, the local list. The server may have atomically removed a
      // historical partial/full OCR overlap; keeping that deleted phone row would subtract the
      // deduction twice in the preview until a page reload.
      patch({ opsError: null })

      const res = await api.put<{ br1: { difference: string; balanced: boolean } }>(`/shifts/${shift.id}/end-package`, {
        ...odometerFields,
        // Bike-level battery % is gone — charge is captured per pack. Sent null (nullable seam).
        batteryPercent: null,
        cashDeclared: cash,
        walletDeclared: wallet,
        // SRS D-3: the authoritative cloud-AI baseline (null when AI did not read a value).
        walletDeclaredOcr: walletOcr,
        // The pictures both closing readers worked from, so the driver's corrections become examples.
        walletStrip: draft.walletStrip,
        odometerStrip: draft.odoStrip,
        draftRevision: draft.closeDraftRevision,
        draftHash: draft.closeDraftHash,
        // Missing end BMS evidence must not keep a driver clocked in. The API converts only those
        // incomplete packs into an explicit manager-reading obligation inside the close transaction.
        deferMissingBatteryEvidenceToManager: true,
      })
      setBr1(res.br1)
      // A non-zero difference is now a manager settlement decision, not a driver submission gate.
      // The server has already moved the shift to pending_review at this point; keeping the driver
      // on the editable close screen made a successful request look like a failed one.
      onSubmitted()
    } catch (e) {
      const err = e as { error?: string; detail?: { providerOrderNo?: string; businessDate?: string } }
      const notice = describeEndSubmitFailure(
        e,
        t.shift.closeFailure,
        (slot) => slotLabel(slot, t.shift.slotNames, lang),
      )
      // The one failure a driver can actually act on: a row he scrolled too far back to reach.
      // «تعذّر الحفظ» tells him nothing; the order number and the day tell him which to uncheck.
      if (err.error === 'order_belongs_to_other_shift') {
        const no = err.detail?.providerOrderNo ?? ''
        const day = err.detail?.businessDate ?? ''
        // NAME IT THE WAY THE SCREEN DOES. The server answers with `provider_order_no`, which is
        // a generated UUID the list deliberately never shows — telling the driver to uncheck
        // «YAL-3f9a…» pointed him at forty characters that appear on none of his thirty rows.
        // He recognises a delivery by its clock, its route and its fee, so that is what he is told.
        const row = draft.orders.find((o) => o.providerOrderNo.trim() === no)
        const named = row
          ? [row.timeText, row.pointA, row.feeText].filter((x) => x !== undefined && x !== null && x !== '').join(' · ')
          : no
        const message = `${t.errors.order_belongs_to_other_shift}: ${named}${day ? ` (${day})` : ''}`
        patch({ opsError: message })
        setCloseFailure({ ...notice, lines: [message] })
        // The error card sits above a list that sits below ten photo tiles, and the driver tapping
        // submit is pinned to the footer at the bottom of a very long page. Unannounced, the
        // button simply greys and comes back and he taps it again, and again.
        toast.error(message)
        return
      }
      setCloseFailure(notice)
      toast.error(`${notice.title}: ${notice.lines[0] ?? t.common.actionFailed}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * The wallet screenshot, read ON DEVICE.
   *
   * It still runs on every photo so its sample can be trained against the driver's eventual value.
   * Its numeric guess is NEVER published: not while AI is reading and not after AI fails. That
   * prevents a fast local guess from becoming indistinguishable from explicit human input.
   */
  const walletImage = useCallback(
    async (file: File): Promise<void> => {
      // Claim this file generation and clear any older machine value before either reader answers.
      // A human edit is retained; the authority reducer is the only place allowed to make that call.
      onDraft((d) => ({
        ...withWalletAuthority(
          d,
          reduceAiOcrAuthority(walletAuthority(d), { type: 'started', generation: file }),
        ),
        walletCloud: { status: 'reading' },
        walletStrip: null,
      }))

      try {
        const { readWallet } = await import('../ocr.ts')
        const result = await readWallet(file)
        onDraft((d) => {
          if (d.walletFile !== file) return d
          const observed = result.ok
            ? reduceAiOcrAuthority(walletAuthority(d), {
                type: 'local_observed',
                generation: file,
                value: result.reading.amountText,
              })
            : walletAuthority(d)
          // Kept whether it read or refused — the hard/refused sample is often the better example.
          return { ...withWalletAuthority(d, observed), walletStrip: result.sample ?? null }
        })
      } catch {
        // Local OCR is training-only for this field. Its failure cannot alter AI or human money.
      }
    },
    [onDraft],
  )

  /**
   * Read the closing dashboard on the phone while upload/cloud OCR proceed independently.
   * `newEvidence=false` retries the same pixels without erasing the cloud's outcome or value.
   */
  const odoImage = useCallback(
    async (file: File, newEvidence = true): Promise<void> => {
      onDraft((d) => {
        if (!newEvidence) {
          return d.odoFile === file ? { ...d, odoLocal: { status: 'reading' } } : d
        }
        return {
          ...d,
          odoFile: file,
          odoStrip: null,
          odoOcr: null,
          odoAiAuthoritative: false,
          odoCloud: null,
          odoLocal: { status: 'reading' },
          odoConfirmed: false,
          // Do not let an earlier photo's machine value survive a retake whose readers may fail.
          odo: odometerValueForRetake(d.odo, d.odoHumanEdited),
        }
      })
      try {
        const { readDashboard } = await import('../ocr.ts')
        const result = await readDashboard(file)
        onDraft((d) => {
          // A second selection superseded this read; never let the old photo label the new one.
          if (d.odoFile !== file) return d
          const odo = result.ok ? result.reading.odometer : null
          const next = {
            ...d,
            odoLocal: localOdometerEvent(result.ok ? { ok: true, odometer: odo } : result),
            odoStrip: result.sample ?? null,
          }
          // Phone OCR stops here: its outcome and strip are training evidence, never an automatic
          // odometer or baseline, even if it finishes before AI or AI later fails.
          return next
        })
      } catch {
        onDraft((d) =>
          d.odoFile === file
            ? { ...d, odoLocal: { status: 'failed', reason: 'unavailable' } }
            : d,
        )
      }
    },
    [onDraft],
  )

  const dashImage = useCallback(
    async (_file: File, slot: string, result?: EvidenceUploadResponse): Promise<void> => {
      await readLinkedAttachment(slot, 'orders', false, result)
    },
    [readLinkedAttachment],
  )
  const logImage = useCallback(
    async (_file: File, slot: string, result?: EvidenceUploadResponse): Promise<void> => {
      await readLinkedAttachment(slot, 'payments_log', false, result)
    },
    [readLinkedAttachment],
  )
  const retryDashboardRead = useCallback(
    async (slot: string): Promise<void> => {
      await readLinkedAttachment(slot, 'orders', true)
    },
    [readLinkedAttachment],
  )
  const retryLogRead = useCallback(
    async (slot: string): Promise<void> => {
      await readLinkedAttachment(slot, 'payments_log', true)
    },
    [readLinkedAttachment],
  )

  return (
    <Screen
      title={t.shift.endShift}
      {...(onBack ? { back: { label: t.common.back, onBack } } : {})}
      footer={
        <div className="flex flex-col gap-2">
          {/* The equation LIVE, before he submits — so a missing operation is visible while he can
              still fix it, rather than discovered by the manager.

              THE TOTAL, NOT THE SPLIT. With pay mode no longer collected (SRS BR3 retired), what
              lands in cash versus wallet cannot be predicted — only their sum. Showing a confident
              «expected cash» computed as though every delivery were cash would be a number the app
              cannot actually know, which is the one failure this project spends its effort avoiding.
              What remains is the equation the owner described: cash + wallet against float + topup
              + 80% of the fees. */}
          {preview ? (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-slate-700">{t.shift.closeSummary}</summary>
              <div className="mt-1 grid grid-cols-2 gap-x-4">
              <div className="col-span-2 flex items-baseline justify-between gap-2">
                <span className="text-slate-600">{t.br1.expected}</span>
                <Money value={preview.expectedTotalText} className="font-semibold" />
              </div>
              {/* The difference, the moment both declared figures exist — it was computed all
                  along and never shown, so the driver first learned of a gap after submitting. */}
              {previewDifference !== null ? (
                <div className="col-span-2 flex items-baseline justify-between gap-2 border-t border-slate-200 pt-1">
                  <span
                    className={`font-semibold ${
                      previewDifference.direction === 'balanced'
                        ? 'text-emerald-700'
                        : previewDifference.direction === 'surplus'
                          ? 'text-amber-800'
                          : 'text-red-700'
                    }`}
                  >
                    {t.br1[previewDifference.direction]}
                  </span>
                  <Money
                    value={previewDifference.amountText}
                    className={`font-bold ${
                      previewDifference.direction === 'balanced'
                        ? 'text-emerald-700'
                        : previewDifference.direction === 'surplus'
                          ? 'text-amber-800'
                          : 'text-red-700'
                    }`}
                  />
                </div>
              ) : null}
              {/* THE EQUATION USED AS A CHECK ON THE READER. Of every fee the driver keeps 80%
                  between cash and wallet, so a gap of 696 is a fee of 870 — one read wrongly, or
                  one delivery never scanned. Naming the amount turns "your numbers are off" into
                  something the driver can actually go and look for. */}
              {preview.feeGapText !== null ? (
                <p className="col-span-2 text-sm font-medium text-red-700">
                  {t.br1.feeGap.replace('{n}', preview.feeGapText)}
                  {preview.suspectLocalIds.length > 0 ? ` · ${t.br1.checkScanned}` : ''}
                </p>
              ) : null}
              </div>
            </details>
          ) : null}
          {reviewWarnings.length > 0 ? (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-amber-900" role="note">
              <p className="text-sm font-semibold">{t.shift.reviewWarningTitle}</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
                {reviewWarnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}
          {/* NAMED, not merely absent. Tapping the footer's dead button is how a driver concludes
              the app is broken; this says which thing to go and do.

              Guarded on `!ready` ALONE. It used to also require `missing.length > 0`, which was
              the same condition twice while `ready` had two extra terms — so a driver blocked by
              `draftSaved` got a disabled button and an empty page. `ready` is now exactly
              "the list is empty", making the two forms equivalent by construction rather than by
              a coincidence that already broke once. */}
          {!ready ? (
            <details className="text-sm text-amber-800">
              <summary className="cursor-pointer font-medium">
                {t.shift.remainingCount.replace('{n}', String(missing.length))}
              </summary>
              <p className="pt-1">{missing.join(' · ')}</p>
            </details>
          ) : null}
          {draftSaveNotice === 'conflict' || draftSaveNotice === 'failed' ? (
              <div
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-red-800"
                role="alert"
              >
                {draftSaveNotice === 'conflict' ? (
                  <div className="min-w-0 flex-1 basis-full space-y-2">
                    <p className="text-sm font-semibold">{t.shift.draftMergeConflictTitle}</p>
                    <p className="break-words text-xs">{t.shift.draftMergeConflictBody}</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onResolveSaveConflict('phone')}
                        className="min-h-10 rounded-lg bg-red-700 px-3 text-xs font-semibold text-white"
                      >
                        {t.shift.usePhoneDraft}
                      </button>
                      <button
                        type="button"
                        onClick={() => onResolveSaveConflict('server')}
                        className="min-h-10 rounded-lg bg-white px-3 text-xs font-semibold text-red-800 ring-1 ring-red-200"
                      >
                        {t.shift.useServerDraft}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                  <p className="min-w-0 flex-1 break-words text-xs font-medium">{t.shift.draftSaveFailed}</p>
                  <button
                    type="button"
                    onClick={onRetrySave}
                    className="min-h-9 shrink-0 rounded-lg bg-red-100 px-3 text-xs font-semibold"
                  >
                    {t.shift.retryDraftSave}
                  </button>
                  </>
                )}
              </div>
          ) : draftSaveNotice === 'saving' ? (
            <p className="truncate text-xs text-slate-500" role="status">{t.shift.savingDraft}</p>
          ) : null}
          {closeFailure ? (
            <details
              className="rounded-xl bg-red-50 p-2 text-red-800"
              role="alert"
              aria-live="assertive"
              open
            >
              <summary className="cursor-pointer text-sm font-bold">{closeFailure.title}</summary>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
                {closeFailure.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </details>
          ) : null}
          {submittedDifference ? (
            <div
              className={`flex items-center justify-between rounded-2xl px-4 py-2 ${
                submittedDifference.direction === 'balanced'
                  ? 'bg-emerald-100 text-emerald-800'
                  : submittedDifference.direction === 'surplus'
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-red-100 text-red-800'
              }`}
            >
              <span>{t.br1[submittedDifference.direction]}</span>
              <Money value={submittedDifference.amountText} className="font-bold" />
            </div>
          ) : null}
          <Button variant="success" disabled={!ready || busy} onClick={submit}>
            {busy
              ? t.common.loading
              : reviewWarnings.length > 0
                ? t.shift.submitEndForReview
                : t.shift.submitEnd}
          </Button>
        </div>
      }
    >
      {draft.closeDraftRestored ? (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-800" role="status">
          {t.shift.draftRestored}
        </p>
      ) : null}
      {/*
        * THE PAGED SCREENS, AS GRIDS.
        *
        * A real close package rendered TWELVE tiles - six dashboard pages, two log pages, a wallet,
        * an odometer, two BMS shots - and `PhotoSlot`'s row is an 80px full-width bar. That is about
        * a thousand pixels of near-identical grey before the driver reaches a single field he came
        * to fill in. These pages differ only by a number, so a number is all the label they need.
        *
        * Four columns at 328px of content gives ~76px cells: well above a 44px target, and the six
        * pages a real shift produced fit in two rows with the add-tile beside them.
        */}
      <PageGrid
        title={t.shift.dashboardShot}
        base="dashboard"
        pages={draft.dashboardPages}
        shiftId={shift.id}
        slots={slots}
        attachments={draft.closeDraftAttachments}
        closeDraftRevision={draft.closeDraftRevision}
        onCloseDraft={applyCanonicalDraft}
        onRetryRead={retryDashboardRead}
        onUploaded={(up) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(up) }))}
        onAddPage={() => onDraft((d) => ({ ...d, dashboardPages: d.dashboardPages + 1 }))}
        onImage={dashImage}
        onDeleted={(gone) => {
          onDraft((d) => {
            const next = new Set(d.slots)
            next.delete(gone)
            return { ...d, slots: next }
          })
        }}
      />

      {/* THE list: every operation of the shift, with server-owned inclusion shown read-only. It
          sits directly under the pages that produced it, which is the order the work happens in. */}
      {draft.opsError ? (
        <Card>
          <p className="text-center text-sm font-medium text-red-600">{draft.opsError}</p>
        </Card>
      ) : null}
      <OperationsList
        orders={draft.orders}
        movements={draft.movements}
        cashDeductions={draft.cashDeductions}
        today={shift.businessDate}
        suspectLocalIds={preview?.suspectLocalIds ?? []}
        onOrders={(orders) => onDraft((d) => ({ ...d, orders }))}
        onCashDeductions={(cashDeductions) => onDraft((d) => ({ ...d, cashDeductions }))}
      />

      <p className="text-sm text-slate-500">{t.shift.paymentsLogArchiveHint}</p>
      <PageGrid
        title={t.shift.paymentsLog}
        base={PAYMENTS_LOG_SLOT}
        pages={draft.logPages}
        shiftId={shift.id}
        slots={slots}
        attachments={draft.closeDraftAttachments}
        closeDraftRevision={draft.closeDraftRevision}
        onCloseDraft={applyCanonicalDraft}
        onRetryRead={retryLogRead}
        onUploaded={(up) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(up) }))}
        onAddPage={() => onDraft((d) => ({ ...d, logPages: d.logPages + 1 }))}
        onImage={logImage}
        onDeleted={(gone) => {
          onDraft((d) => {
            const next = new Set(d.slots)
            next.delete(gone)
            return { ...d, slots: next }
          })
        }}
      />

      {/*
        * EACH NUMBER BESIDE THE PICTURE THAT PRODUCED IT.
        *
        * The wallet tile and the wallet balance field used to be separated by the entire operations
        * list - thousands of pixels - so the driver confirmed a figure with its evidence off screen.
        */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="w-20 shrink-0">
            <PhotoSlot
              shiftId={shift.id}
              pkg="end"
              slot="wallet"
              label={t.shift.walletBalance}
              variant="tile"
              uploaded={slots.has('wallet')}
              attachment={draft.closeDraftAttachments.wallet ?? null}
              closeDraftRevision={draft.closeDraftRevision}
              onCloseDraft={applyCanonicalDraft}
              recognitionFocus="wallet"
              onUploaded={(up) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(up) }))}
              onImage={async (file, result) => {
                await walletImage(file)
                await readLinkedAttachment('wallet', 'wallet', false, result)
              }}
              onRetryRead={async () => {
                await readLinkedAttachment('wallet', 'wallet', true)
              }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Field label={t.shift.walletBalance}>
              <MoneyInput
                value={wallet}
                onChange={(e) => {
                  // Normalised like the odometer field above: «٧٠٠٠٠» is what an Arabic keyboard
                  // produces, and the wire's money schema is ASCII-only, so leaving it raw 400s
                  // every autosave and silently strands the close.
                  const value = normalizeDecimalDigits(e.target.value)
                  onDraft((d) =>
                    withWalletAuthority(
                      d,
                      reduceAiOcrAuthority<string, File>(walletAuthority(d), {
                        type: 'human_edited',
                        value: value === '' ? null : value,
                      }),
                    ),
                  )
                }}
              />
            </Field>
            <SourceMark source={sourceOf({ ocrValue: walletOcr, hadImage: draft.walletStrip !== null, value: wallet })} />
            {/* The wallet balance is the one figure BR1 checks against counted cash, so a read
                that quietly never finished is worth a line rather than a blank tile. */}
          </div>
        </div>

        <ReadingLock active={draft.odoCloud?.status === 'reading'}>
        <div className="flex items-start gap-3">
          <div className="w-20 shrink-0">
            <PhotoSlot
              shiftId={shift.id}
              pkg="end"
              slot="odometer"
              label={t.shift.odometer}
              variant="tile"
              uploaded={slots.has('odometer')}
              attachment={draft.closeDraftAttachments.odometer ?? null}
              closeDraftRevision={draft.closeDraftRevision}
              onCloseDraft={applyCanonicalDraft}
              recognitionQuality
              onUploaded={(up) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(up) }))}
              onImage={async (file, result) => {
                await odoImage(file)
                await readLinkedAttachment('odometer', 'odometer', false, result)
              }}
              onRetryRead={async () => {
                await readLinkedAttachment('odometer', 'odometer', true)
              }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Field label={t.shift.odometer}>
              <TextInput
                inputMode="numeric"
                value={odo}
                onChange={(e) =>
                  patch({ odo: normalizeDecimalDigits(e.target.value), odoHumanEdited: true, odoConfirmed: false })
                }
              />
            </Field>
            <SourceMark
              source={sourceOf({
                ocrValue: draft.odoOcr,
                hadImage: draft.odoStrip !== null || draft.odoFile !== null || slots.has('odometer'),
                value: odo,
              })}
            />
            <LocalOdometerReadStatus
              event={draft.odoLocal}
              {...(draft.odoFile
                ? { onRetry: () => void odoImage(draft.odoFile!, false) }
                : {})}
            />
          </div>
        </div>
        </ReadingLock>

        {/* Checked against the number this very shift opened on, which is the only thing that makes
            6900 after 6948 visibly wrong. Asked, never refused: a bike really can be carried on a
            truck, and refusing would teach him to type whatever gets past it. */}
        {(() => {
          const question = odometerQuestion
          if (!question || odoConfirmed) return null
          return (
            <div className="flex flex-col gap-2 rounded-xl bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                {question.kind === 'odometer_went_backwards'
                  ? t.shift.odoBackwards.replace('{start}', String(question.start))
                  : t.shift.odoJump.replace('{km}', String(question.km))}
              </p>
              <Button
                variant="ghost"
                className="self-start"
                onClick={() => onDraft((d) => ({ ...d, odoConfirmed: true }))}
              >
                {t.battery.yesCorrect}
              </Button>
            </div>
          )
        })()}

        <Field label={t.shift.cashHandover}>
          {/* Same normalisation as the wallet and odometer fields — see `isUsableMoneyText`. */}
          <MoneyInput value={cash} onChange={(e) => patch({ cash: normalizeDecimalDigits(e.target.value) })} />
        </Field>
      </Card>
      {/* The close gate asks for the same per-pack evidence the open gate did. */}
      <BatteryPanel
        shiftId={shift.id}
        pkg="end"
        batteries={batteries}
        slots={slots}
        onSlotUploaded={(slot) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(slot) }))}
        onReadingsChanged={setBatteriesReady}
        initialPacks={draft.packs}
        initialMediaIds={draft.batteryMediaIds}
        onPacksChanged={onPacksChanged}
        closeDraftAttachments={draft.closeDraftAttachments}
        closeDraftRevision={draft.closeDraftRevision}
        onCloseDraft={applyCanonicalDraft}
        onLinkedRead={(slot, retryFailed, upload, signal) =>
          readLinkedAttachment(slot, 'bms', retryFailed, upload, signal)
        }
        onMediaIdChanged={(batteryId, mediaId) =>
          onDraft((d) => ({
            ...d,
            batteryMediaIds: { ...d.batteryMediaIds, [batteryId]: mediaId },
          }))
        }
      />
    </Screen>
  )
}

/**
 * «معلقة» (SRS C-1 / س29): the shift is on hold after a mid-shift incident a manager logged. The
 * driver sees it's paused — not silently reset — and resumes it himself once he's able to carry on.
 */
function SuspendedScreen({ shiftId, onResumed }: { shiftId: string; onResumed: () => void }): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function resume(): Promise<void> {
    setBusy(true)
    try {
      await api.resumeShift(shiftId)
      onResumed()
    } catch (e) {
      const code = (e as { error?: string }).error
      toast.error((code && (t.errors as Record<string, string>)[code]) || t.common.actionFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      title={t.shift.states.suspended}
      footer={
        <Button variant="success" disabled={busy} onClick={resume}>
          {busy ? t.common.loading : t.shift.resumeShift}
        </Button>
      }
    >
      <Card>
        <p className="text-center text-amber-700">{t.shift.suspendedHint}</p>
      </Card>
    </Screen>
  )
}

/**
 * «بلاغ حادثة» (SRS C-1): the driver flags a mid-shift incident to the branch. He can't suspend the
 * shift himself — that's a manager act — so this only rings the branch bell with a note.
 */
function ReportIncident({ shiftId }: { shiftId: string }): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  if (!asking) {
    return (
      <Button variant="ghost" onClick={() => setAsking(true)}>
        {t.shift.reportIncident}
      </Button>
    )
  }
  return (
    <Card className="flex flex-col gap-2">
      <Field label={t.shift.incidentNote}>
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.reportIncident(shiftId, note.trim() === '' ? null : note.trim())
              toast.success(t.shift.incidentReported)
              setAsking(false)
              setNote('')
            } catch {
              toast.error(t.common.actionFailed)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t.common.loading : t.shift.reportIncident}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => setAsking(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </Card>
  )
}
/**
 * The live-GPS indicator. Mounting it starts the beacon (SRS K); unmounting — when the shift leaves
 * the open/orders phase — stops it. Foreground-only, per the PWA limitation.
 */
function GpsBeacon({ shiftId }: { shiftId: string }): ReactNode {
  // Runs the beacon and renders NOTHING. The driver used to be shown a live «التتبع يعمل / متوقف»
  // line; the owner does not want the tracking state on his screen. Mounting still starts it and
  // unmounting still stops it, so behaviour is unchanged — only the readout is gone. The location
  // permission the browser itself asks for is the driver's real notice, and consent was given.
  useGpsBeacon(shiftId)
  return null
}

/**
 * Abandon a shift that never opened.
 *
 * Nothing has posted to the ledger in `draft` or `awaiting_open_approval`, so there is nothing to
 * reverse — and without this a driver who backs out of a start screen must wait for someone at
 * the office before he can work at all. The confirm step is there because it releases the bike.
 */
function DiscardButton({ onDiscard }: { onDiscard: () => Promise<void> }): ReactNode {
  const { t } = useApp()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!asking) {
    return (
      <Button variant="ghost" onClick={() => setAsking(true)}>
        {t.shift.discardShift}
      </Button>
    )
  }
  return (
    <Card className="flex flex-col gap-2">
      <p className="text-center text-sm">{t.shift.discardConfirm}</p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onDiscard()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t.common.loading : t.shift.discardShift}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => setAsking(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </Card>
  )
}
