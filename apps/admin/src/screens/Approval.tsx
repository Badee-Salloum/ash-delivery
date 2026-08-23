import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import L, { type CircleMarker, type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  type ManagerOrderEvidenceRereadResponse,
  type ManagerOrderEvidenceRereadTarget,
  type OcrScalar,
  type PhotoAge,
  br1DifferencePresentation,
  br1Verdict,
  groupThousands,
  ocrReadingDelta,
  slotLabel,
  splitSlot,
  formatDateTime,
} from '@ash/client'
import { add, formatMinor, minor, parseMinor, sub } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { evidenceReviewWarning } from '../evidence-warning.ts'
import { useConfirm, useToast } from '../feedback.tsx'
import { LatestRequestGuard } from '../latest-request.ts'
import { isValidOpeningFundInput, openingApprovalRequest } from '../opening-funds.ts'
import {
  buildOrderDuplicateRevision,
  buildOrderTimingRevision,
  closeDraftReviewReasonLabel,
  closeWorkspaceApprovalReady,
  countAwaitingCloseBatteryReadings,
  deductionHasDashboardEvidenceOrigin,
  guardPhysicalSettlementConfirmations,
  orderHasDashboardEvidenceOrigin,
  orderNeedsAttention,
  positionEvidenceLabel,
  summarizeOrders,
  type CloseDraftReviewReason,
} from '../approval-workspace.ts'
import {
  type OperationWindowStatus,
  countUnresolvedWindowRows,
} from '../operation-window.ts'
import {
  activeForcePreparation,
  closeApprovalRequest,
  isKnownSettlementAction,
  settlementApprovalReady,
  settlementHasVariance,
  settlementVarianceMagnitude,
} from '../settlement-review.ts'
import { FOCUS_RING, Badge, Button, Card, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

/** Where the map opens when no point has been pinned yet. */
const DAMASCUS: readonly [number, number] = [33.5138, 36.2765]

interface BatteryReadingView {
  batteryId: string
  slotNo: number
  percent: number | null
  cycleCount: number | null
  capacityAh: number | null
  serialNo: string | null
  source: 'ocr' | 'manual' | 'manager'
  /** The driver declared his phone cannot run the BMS app; this pack is the MANAGER's to read. */
  unavailable?: boolean
  /** The pre-correction OCR reading (SRS D-3 baseline); charge + cycles only now. */
  ocrRaw?: unknown
}

interface Review {
  id: string
  state: string
  driverId: string
  vehicleId: string
  /** Inline identity is additive; older API deployments still use the fallback lookups below. */
  driverNameAr?: string | null
  driverNameEn?: string | null
  vehicleCode?: string | null
  shiftNo: number
  businessDate: string
  /** Actual operation-window edges. Optional during a staggered API/admin rollout. */
  openApprovedAt?: string | null
  submittedAt?: string | null
  /** Current branch+driver shift funding captured by the locked manager-review read. */
  shiftFunding: { cash: string; wallet: string }
  startPackage: {
    odometerKm: number | null
    batteryPercent: number | null
    odometerKmOcr: number | null
    batteryPercentOcr: number | null
    floatTotal: string
    topupTotal: string
    mediaSlots: string[]
    batteries: BatteryReadingView[]
  }
  endPackage: {
    odometerKm: number | null
    odometerKmOcr?: number | null
    odometerAnomalyConfirmedAt?: string | null
    odometerAnomalyConfirmedBy?: string | null
    batteryPercent: number | null
    cashDeclared: string | null
    walletDeclared: string | null
    walletDeclaredOcr: string | null
    mediaSlots: string[]
    batteries: BatteryReadingView[]
  }
  orders: Array<{
    providerOrderNo: string
    payMode: string
    fee: string
    zone: string | null
    source?: 'manual' | 'ocr'
    feeOcr?: string | null
    kind?: 'yallago' | 'manual'
    driverShare?: string | null
    companyShare?: string | null
    notes?: string | null
    points?: Array<{ role: string; label: string; lat: number | null; lng: number | null }>
    /** Checked. Unchecked rows are still listed — a row hidden here is a row nobody can put back. */
    included?: boolean
    walletAmount?: string | null
    occurredMinute?: string | null
    /** The day the SCREEN said — not always the shift's day, because the list scrolls back. */
    occurredDate?: string | null
    windowStatus?: OperationWindowStatus
    decisionReason?: string | null
    decidedBy?: string | null
    windowBasis?: 'printed_time' | 'screen_position' | 'manager' | null
    positionEvidence?: {
      lowerInstant?: string | null
      upperInstant?: string | null
      anchorObservationIds?: string[]
    } | null
    closeDraftReviewReasons?: CloseDraftReviewReason[]
  }>
  /** A negative Recent-Orders row: positive magnitude, but a distinct cash deduction operation. */
  cashDeductions?: Array<{
    id: string
    operationKey: string
    amount: string
    occurredMinute: string | null
    occurredDate: string | null
    source: 'manual' | 'ocr'
    amountOcr?: string | null
    pointA: string | null
    pointB: string | null
    included: boolean
    windowStatus: OperationWindowStatus
    decisionReason: string | null
    decidedBy?: string | null
    windowBasis?: 'printed_time' | 'screen_position' | 'manager' | null
    positionEvidence?: {
      lowerInstant?: string | null
      upperInstant?: string | null
      anchorObservationIds?: string[]
    } | null
    closeDraftReviewReasons?: CloseDraftReviewReason[]
  }>
  /** «سجل المدفوعات» as read: archival evidence only, never a financial input. */
  movements: Array<{
    id: string
    amount: string
    occurredMinute: string
    role: 'yalago_cut' | 'order_credit' | 'unmatched'
    ambiguous: boolean
    included: boolean
  }>
  batterySwaps?: Array<{
    seqNo: number
    slotNo: number
    occurredAt: string
    outSerial: string | null
    inSerial: string | null
    outPercent: number | null
    inPercent: number | null
  }>
  media: Array<{
    package: 'start' | 'end'
    slot: string
    mediaId: string
    /** The phone's clock — a CLAIM. Null when the picker gave no usable timestamp. */
    clientTakenAt?: string | null
    /** The server's receipt — authoritative. */
    receivedAt?: string | null
    /** When these bytes were attached to this exact shift/slot, independent of deduplication. */
    attachedAt?: string | null
    /** An earlier shift that already used these immutable bytes. */
    reusedFromShiftId?: string | null
    /** Explicit driver acknowledgement for this old/reused attachment. */
    staleAcknowledgedAt?: string | null
    staleAcknowledgedBy?: string | null
  }>
  decisions: Array<{
    gate: 'open' | 'close'
    decision: 'approved' | 'rejected' | 'rephoto_requested' | 'force_close_prepared'
    notes: string | null
    decidedAt: string
  }>
  br1: {
    expectedCash: string
    expectedWallet: string
    difference: string
    cashDifference: string
    walletDifference: string
    balanced: boolean
    splitBalanced: boolean
    minWalletBalance: string
    causes: Array<{ code: string; confidence: string; amount: string; candidateOrderNos: string[] }>
    ordersHash: string
    cashDeductionTotal?: string
  }
}

function isNonnegativeSettlementMoney(value: string): boolean {
  try {
    return value.trim() !== '' && parseMinor(value.trim()) >= 0n
  } catch {
    return false
  }
}

function positiveSettlementClaim(value: string): string {
  const amount = parseMinor(value)
  return formatMinor(amount > 0n ? amount : minor(0n))
}

type SettlementView = Awaited<ReturnType<ReturnType<typeof useApp>['api']['shiftSettlement']>>

/**
 * The branch-manager approval screen (SRS C-7) — the screen the paying client judges the product
 * on. Side-by-side start/end numbers, the odometer compare (the anti-fraud read), and a pinned
 * BR1 panel whose ranked causes come straight from the domain: every term the manager needs to
 * decide, in one view.
 */
export function Approval({ shiftId, onDone }: { shiftId: string; onDone(): void }): ReactNode {
  const { api, t, lang } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const [review, setReview] = useState<Review | null>(null)
  /** Remount the close workspace only after a new server review snapshot is accepted. */
  const [reviewGeneration, setReviewGeneration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The manager records the cash float + wallet top-up here, at open-approval (the driver no
  // longer types them). Empty is treated as 0.
  const [floatText, setFloatText] = useState('')
  const [topupText, setTopupText] = useState('')
  const floatInputId = useId()
  const topupInputId = useId()
  const [notes, setNotes] = useState('') // for a re-shoot request or a reject (C-7)
  const [manual, setManual] = useState({ providerOrderNo: '', payMode: 'cash', fee: '' }) // manual-order reconcile
  /**
   * WHOSE shift this is.
   *
   * The payload has carried `driverId`/`vehicleId` all along and the screen rendered neither, so a
   * manager working through a queue — or arriving from a bell notification or a #shift: deep link
   * — signed off real cash on a page headed only «مراجعة النوبة». Same lookup Queue.tsx does.
   */
  const [who, setWho] = useState<{ driver: string | null; vehicle: string | null }>({ driver: null, vehicle: null })

  /**
   * «كشف التسوية». It is read-only until both physical actions are confirmed, but it is mandatory:
   * no manager may approve against a missing or stale statement. Declared with the other hooks,
   * above the `if (!review)` guard, because a hook reached only after loading would trigger React
   * #310 and leave this financial screen blank.
   */
  const [settlement, setSettlement] = useState<SettlementView | null>(null)
  const [settlementLoadError, setSettlementLoadError] = useState<string | null>(null)
  const [walletTransferConfirmed, setWalletTransferConfirmed] = useState(false)
  const [cashSettlementConfirmed, setCashSettlementConfirmed] = useState(false)
  const [varianceReason, setVarianceReason] = useState('')
  const [cashReceivableDeferred, setCashReceivableDeferred] = useState('0')
  const [walletReceivableDeferred, setWalletReceivableDeferred] = useState('0')
  const [settlementRecalculating, setSettlementRecalculating] = useState(false)
  /** Suggestion-only reads of exact stored dashboard slots, keyed by the reviewed operation. */
  const [orderRereads, setOrderRereads] = useState<Record<string, ManagerOrderEvidenceRereadResponse>>({})
  /** A copied AI time is only a draft until the audited revision endpoint accepts it. */
  const [pendingTimingDraftKeys, setPendingTimingDraftKeys] = useState<ReadonlySet<string>>(new Set())
  const setTimingDraftPending = useCallback((key: string, pending: boolean) => {
    setPendingTimingDraftKeys((current) => {
      const next = new Set(current)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
    if (pending) {
      // The physical handover ticks belonged to the pre-correction snapshot. Even though copying a
      // suggestion is local-only, retaining them would make the eventual accounting edit appear
      // pre-confirmed.
      setWalletTransferConfirmed(false)
      setCashSettlementConfirmed(false)
    }
  }, [])

  /**
   * Which orders the table shows — see `flagged()` below for what "worth attention" means.
   *
   * It lives UP HERE, with every other hook, because everything below the `if (!review)` guard runs
   * only on the renders where the review has arrived. Declared next to its logic — which is where I
   * first put it — this is a `useState` the first render does not reach and the second one does, so
   * React counts one more hook than last time, throws #310, and unmounts the tree: a blank page on
   * the screen that approves cash. There is no error boundary to catch it (see main.tsx), so the
   * whole app goes white. Hooks stay above the guard, unconditionally.
   */
  const [showAllOrders, setShowAllOrders] = useState(false)

  /**
   * One explicit, visible reason for every window decision. The server audits it with the row;
   * keeping it above the tables also makes the manager state the reason before a checkbox moves.
   */
  const [operationReason, setOperationReason] = useState('')

  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const reviewRequests = useRef(new LatestRequestGuard())
  const fetchReview = useCallback((preserveVisibleReview: boolean) => {
    const request = reviewRequests.current.next()
    setLoadError(null)
    setRefreshing(preserveVisibleReview)
    // A financial edit invalidates the settlement but should not throw the manager back to a full
    // screen spinner. Keep the evidence visible, clear both physical confirmations immediately,
    // and make approval impossible until the new review + settlement hashes arrive.
    if (!preserveVisibleReview) setReview(null)
    setSettlement(null)
    setSettlementLoadError(null)
    setWalletTransferConfirmed(false)
    setCashSettlementConfirmed(false)
    setVarianceReason('')
    setCashReceivableDeferred('0')
    setWalletReceivableDeferred('0')
    setSettlementRecalculating(false)
    setOrderRereads({})
    void api
      .shiftReview<Review>(shiftId, { cache: 'no-store', signal: request.signal })
      .then((next) => {
        if (!request.isCurrent()) return
        // Local AI suggestions/drafts belong to the previous hash. Clear the guard and remount its
        // cards in the same accepted-snapshot render, so no hidden stale draft can survive while
        // the parent thinks there are zero pending edits.
        setPendingTimingDraftKeys(new Set())
        setReviewGeneration((generation) => generation + 1)
        setReview(next)
        setRefreshing(false)
      })
      .catch((e: { error?: string }) => {
        if (!request.isCurrent()) return
        // Not a spinner: a review that cannot be fetched (the shift was cancelled, or this role
        // may not see it) has to say so, or the manager waits on a screen that will never fill.
        if (!preserveVisibleReview) setReview(null)
        setRefreshing(false)
        setLoadError(e.error ?? 'error')
      })
  }, [api, shiftId])
  const load = useCallback(() => fetchReview(false), [fetchReview])
  const refreshVisible = useCallback(() => fetchReview(true), [fetchReview])
  useEffect(() => {
    load()
    return () => reviewRequests.current.cancel()
  }, [load])

  // This statement is the manager's physical handover checklist, not an optional report. A close
  // cannot post without the exact snapshot hash and both confirmations, so a load failure is shown
  // and blocks the close rather than silently falling back to an older cash-only flow.
  useEffect(() => {
    if (!review || review.state !== 'pending_review') return
    if (
      !isNonnegativeSettlementMoney(cashReceivableDeferred) ||
      !isNonnegativeSettlementMoney(walletReceivableDeferred)
    ) {
      setSettlementLoadError('invalid_receivable_amount')
      setSettlementRecalculating(false)
      return
    }
    let cancelled = false
    setSettlementLoadError(null)
    setSettlementRecalculating(true)
    const timer = window.setTimeout(() => {
      void api
        .shiftSettlement(review.id, undefined, {
          cashReceivableDeferred: cashReceivableDeferred.trim(),
          walletReceivableDeferred: walletReceivableDeferred.trim(),
        })
        .then((next) => {
          if (cancelled) return
          if (!isKnownSettlementAction(next)) throw new Error('invalid_settlement_action')
          setSettlement(next)
          setSettlementRecalculating(false)
        })
        .catch((e: { error?: string; message?: string }) => {
          if (cancelled) return
          setSettlementLoadError(e.error ?? e.message ?? 'settlement_unavailable')
          setSettlementRecalculating(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [api, cashReceivableDeferred, review, walletReceivableDeferred])

  // A changed hash means changed money. Earlier ticks must never carry across to a new statement.
  useEffect(() => {
    setWalletTransferConfirmed(false)
    setCashSettlementConfirmed(false)
    setVarianceReason('')
  }, [cashReceivableDeferred, review?.id, settlement?.settlementHash, walletReceivableDeferred])

  useEffect(() => {
    const prepared = activeForcePreparation(review?.submittedAt, review?.decisions ?? [])
    if (prepared?.notes && notes.trim() === '') setNotes(prepared.notes)
  }, [notes, review?.decisions, review?.submittedAt])

  useEffect(() => {
    if (!review) return
    const inlineDriver = (lang === 'en' ? review.driverNameEn : null) ?? review.driverNameAr ?? null
    const inlineVehicle = review.vehicleCode ?? null
    setWho({ driver: inlineDriver, vehicle: inlineVehicle })

    if (!inlineDriver) {
      void api
        .get<{ drivers: Array<{ id: string; fullNameAr: string; fullNameEn: string | null }> }>('/drivers')
        .then((r) => {
          const d = r.drivers.find((x) => x.id === review.driverId)
          setWho((w) => ({ ...w, driver: d ? ((lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr) : null }))
        })
        .catch(() => undefined)
    }
    if (!inlineVehicle) {
      void api
        .get<{ vehicles: Array<{ id: string; code: string }> }>('/vehicles')
        .then((r) => setWho((w) => ({ ...w, vehicle: r.vehicles.find((x) => x.id === review.vehicleId)?.code ?? null })))
        .catch(() => undefined)
    }
  }, [api, lang, review])

  if (!review) {
    return (
      <Pending
        error={loadError}
        loadingLabel={t.common.loading}
        errorLabel={explainError(loadError, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  const operationCopy = operationReviewCopy(lang)
  const openingFundsValid = isValidOpeningFundInput(floatText) && isValidOpeningFundInput(topupText)
  const cashDeductions = review.cashDeductions ?? []
  const unresolvedWindowCount = countUnresolvedWindowRows(review.orders, cashDeductions)
  const operationReasonReady = operationReason.trim().length > 0
  const forcePreparation = activeForcePreparation(review.submittedAt, review.decisions)
  const forcePrepared = forcePreparation !== null
  const settlementDraft = {
    walletTransferConfirmed,
    cashSettlementConfirmed,
    varianceReason: forcePrepared ? notes : varianceReason,
  }
  const deferralMatchesSettlement =
    settlement !== null &&
    isNonnegativeSettlementMoney(cashReceivableDeferred) &&
    isNonnegativeSettlementMoney(walletReceivableDeferred) &&
    parseMinor(cashReceivableDeferred.trim()) === parseMinor(settlement.cashReceivableDeferred) &&
    parseMinor(walletReceivableDeferred.trim()) === parseMinor(settlement.walletReceivableDeferred)
  const closeSettlementReady =
    !settlementRecalculating &&
    deferralMatchesSettlement &&
    settlementApprovalReady(settlement, settlementDraft)

  /**
   * WHICH ORDERS DESERVE THE MANAGER'S EYE.
   *
   * A row earns attention by being something a person should look at: the machine read it, someone
   * edited it away from what the machine read, it is excluded from the money, or it is a manual job
   * priced by hand. Everything else is an ordinary delivery that agrees with itself.
   *
   * The rest are never hidden in the sense of being lost — they are counted and totalled, one tap
   * away. See the button above the table.
   */
  const flagged = (o: Review['orders'][number]): boolean =>
    o.source === 'ocr' ||
    o.included === false ||
    o.kind === 'manual' ||
    (o.windowStatus !== undefined && o.windowStatus !== 'in_window') ||
    Boolean(o.decisionReason) ||
    (o.feeOcr != null && o.feeOcr !== o.fee)

  /**
   * The day in the order it happened.
   *
   * The list arrived in the order rows were WRITTEN — the sequence the driver's screenshots were
   * scanned in, which is roughly the reverse of the day and not reliably anything. A manager
   * checking ten deliveries against a dashboard he is reading by the clock had to hunt for each one.
   *
   * `occurredDate` leads because the driver's list scrolls back past midnight, so a bare «13:10» can
   * belong to yesterday; a row without one is on the shift's own day. A row the reader could not
   * time at all cannot be placed in the day, so it sits at the END rather than claiming a position
   * it does not have — and it is already flagged, so it is never out of sight.
   */
  const day = review.businessDate.slice(0, 10)
  const occurrenceKey = (o: Review['orders'][number]): string =>
    `${(o.occurredDate ?? day).slice(0, 10)} ${o.occurredMinute ?? ''}`
  const byOccurrence = (a: Review['orders'][number], b: Review['orders'][number]): number => {
    if (!a.occurredMinute !== !b.occurredMinute) return a.occurredMinute ? -1 : 1
    return occurrenceKey(a).localeCompare(occurrenceKey(b))
  }
  const ordered = [...review.orders].sort(byOccurrence)

  const shownOrders = showAllOrders ? ordered : ordered.filter(flagged)
  const hiddenOrders = showAllOrders ? [] : ordered.filter((o) => !flagged(o))
  const hiddenTotal = formatMinor(
    hiddenOrders.reduce((sum, o) => add(sum, parseMinor(o.fee || '0')), parseMinor('0')),
  )

  const isClose = review.state === 'pending_review'
  /**
   * Is this shift actually AT a gate, waiting for a signature?
   *
   * The screen is now reachable for a RUNNING shift too — that is how a manager records an order on
   * a driver who is still out — and none of the gate controls make sense there, several are
   * actively dangerous: the approve button would post an illegal transition, and «رفض نهائي» voids,
   * which IS a legal edge from `open` and would cancel a live shift and throw away its orders on one
   * click. So on a running shift the screen is a read-only view plus the order form.
   */
  const atGate = review.state === 'awaiting_open_approval' || review.state === 'pending_review'
  /** The CLOSE gate specifically: the operations only exist to be revised while a shift is here. */
  const underReview = review.state === 'pending_review'
  const odoDelta =
    review.startPackage.odometerKm !== null && review.endPackage.odometerKm !== null
      ? review.endPackage.odometerKm - review.startPackage.odometerKm
      : null

  /**
   * What the equation actually says — and THE SCALAR ALONE DOES NOT SAY IT.
   *
   * `difference` is blind to a pay-mode error: flip one order cash↔electronic and it stays exactly
   * zero while the cash is short by the fee and the wallet is over by the same amount. The server
   * has always sent `splitBalanced` for precisely this, and this screen read `balanced` only — so
   * the one case the zero-sum equation exists to catch was the one it painted green, with a live
   * approve button. Three states now, not two, and the middle one is a warning the manager must
   * see rather than a colour he might not.
   */
  const { verdict: br1State } = br1Verdict(review.br1)
  const difference = br1DifferencePresentation(review.br1.difference)
  const differenceLabel = t.br1[difference.direction]
  const differenceColour =
    difference.direction === 'surplus'
      ? 'text-amber-700'
      : difference.direction === 'shortage'
        ? 'text-red-700'
        : 'text-emerald-700'
  const verdict =
    br1State === 'not_balanced'
      ? { tone: 'red' as const, label: t.br1.notBalanced }
      : br1State === 'split_off'
        ? { tone: 'amber' as const, label: t.br1.splitOff }
        : { tone: 'green' as const, label: t.br1.balanced }

  async function approve(): Promise<void> {
    if (!review) return
    const opening = review.state === 'awaiting_open_approval'
    if (opening && !openingFundsValid) {
      setError('invalid_request')
      return
    }
    if (!opening && unresolvedWindowCount > 0) return
    if (!opening && pendingTimingDraftKeys.size > 0) {
      setError('unsaved_timing_correction')
      return
    }
    if (!opening && (!settlement || !closeSettlementReady)) {
      setError('settlement_confirmation_incomplete')
      return
    }
    // Opening still reads back the float because the manager has just typed it. Closing already
    // has two audited, amount-bearing action confirmations in the workspace; adding a third modal
    // only repeats those exact figures and slows the ordinary handover. Force-close keeps its
    // separate final confirmation below because it is the exceptional bypass.
    if (opening) {
      const ok = await confirm({
        title: t.approval.confirmOpenTitle,
        body:
          `${who.driver ?? ''} · ${t.shift.cashFloat}: ${floatText || '0'} · ` +
          `${t.shift.walletTopup}: ${topupText || '0'} · ` +
          `${t.treasury.receivableKinds.shift_funding} / ${t.treasury.receivableChannels.cash}: ` +
          `${review.shiftFunding.cash} · ${t.treasury.receivableKinds.shift_funding} / ` +
          `${t.treasury.receivableChannels.wallet}: ${review.shiftFunding.wallet}`,
        confirmLabel: t.common.approve,
      })
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      if (opening) {
        await api.approveOpenShift(
          review.id,
          openingApprovalRequest(floatText, topupText, review.shiftFunding),
        )
      } else {
        await api.approveCloseShift(
          review.id,
          closeApprovalRequest(review.br1.ordersHash, settlement!, settlementDraft),
        )
      }
      // SAY SO. The screen used to simply vanish back to the queue, which is the most common
      // "did that actually work?" moment in the product and it had no answer.
      toast.success(`${t.approval.approved}${who.driver ? ` — ${who.driver}` : ''}`)
      onDone()
    } catch (err) {
      // Either hash changing means the money changed after these confirmations. Reload both the
      // operations and the settlement, then require two fresh ticks against the new snapshot.
      const code = (err as { error?: string }).error
      if (
        code === 'orders_changed_since_review' ||
        code === 'settlement_changed_since_review' ||
        code === 'shift_funding_changed'
      ) {
        setError(code)
        load()
      } else {
        setError(code ?? 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  async function forceApprove(): Promise<void> {
    if (!review || !settlement || !forcePrepared || !closeSettlementReady || notes.trim() === '') return
    if (unresolvedWindowCount > 0 || pendingTimingDraftKeys.size > 0) return
    const ok = await confirm({
      title: t.approval.confirmForceCloseTitle,
      body:
        `${who.driver ?? ''} · ${t.settlement.walletAction[settlement.walletAction]}: ` +
        `${groupThousands(settlement.walletAmount)} · ${t.settlement.cashAction[settlement.cashAction]}: ` +
        groupThousands(settlement.cashAmount),
      confirmLabel: t.approval.forceApprove,
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await api.forceCloseShift(review.id, {
        reason: notes.trim(),
        cashDeclared: settlement.actualCash,
        walletDeclared: settlement.actualWallet,
        reviewedSettlementHash: settlement.settlementHash,
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
        cashReceivableDeferred: settlement.cashReceivableDeferred,
        walletReceivableDeferred: settlement.walletReceivableDeferred,
      })
      toast.success(`${t.approval.approved} — ${who.driver ?? ''}`)
      onDone()
    } catch (err) {
      const code = (err as { error?: string }).error
      setError(code ?? 'error')
      if (code === 'orders_changed_since_review' || code === 'settlement_changed_since_review') load()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Change what counts, without approving and without bouncing the shift back to the driver.
   *
   * Reloads afterwards rather than patching state locally, because the response changes BR1 and the
   * review hash — and approving against a hash this screen no longer shows is precisely what
   * `orders_changed_since_review` exists to prevent.
   */
  /**
   * The charge the manager just read on his own device, for a pack the driver's phone could not.
   *
   * Its own endpoint because it is its own permission: `shift.operate` is scoped `own` to the
   * driver, so the manager cannot post to the ordinary readings route at all — which is exactly the
   * case this exists for. The server stamps `source: 'manager'`; it is not taken from here.
   */
  async function managerRead(pkg: 'start' | 'end', batteryId: string, percent: number): Promise<void> {
    if (!review) return
    try {
      await api.put(`/shifts/${review.id}/battery-readings/manager`, {
        package: pkg,
        readings: [{ batteryId, percent }],
      })
      toast.success(t.common.saved)
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? null, t))
    }
    refreshVisible()
  }

  async function reviseOps(body: Record<string, unknown>): Promise<boolean> {
    if (!review) return false
    setBusy(true)
    setError(null)
    try {
      await api.post(`/shifts/${review.id}/operations/revise`, body)
      // The checkbox that just moved re-ran the whole equation, and the verdict is a card away.
      // Unannounced, the manager sees a flicker and a changed colour without knowing he caused it.
      toast.success(t.approval.recomputed)
      refreshVisible()
      return true
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * Read one explicitly selected stored dashboard page. This produces suggestions only; it does
   * not send the shift back to the driver and does not carry an AI row into accounting by itself.
   */
  async function rereadOrderEvidence(
    target: ManagerOrderEvidenceRereadTarget,
    slot: string,
    reason: string,
  ): Promise<void> {
    if (!review || reason.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const response = await api.rereadOrderEvidence(review.id, {
        package: 'end',
        slot,
        target,
        reason: reason.trim(),
      })
      // No values changed in this request. A different hash therefore proves a concurrent edit;
      // do not show suggestions beside a stale operation snapshot.
      if (
        response.reviewedOrdersHash !== review.br1.ordersHash ||
        (settlement !== null && response.settlementHash !== settlement.settlementHash)
      ) {
        setError('orders_changed_since_review')
        refreshVisible()
        return
      }
      const targetKey = target.kind === 'order'
        ? `order:${target.providerOrderNo}`
        : `cash_deduction:${target.id ?? target.operationKey ?? ''}`
      setOrderRereads((current) => ({ ...current, [targetKey]: response }))
      if (!response.ok) {
        const failed = managerEvidenceRereadCopy(lang).failed
        toast.error(`${failed}: ${response.reason ?? 'unavailable'}`)
        return
      }
      toast.success(lang === 'ar' ? 'اكتملت قراءة الصورة المحفوظة' : 'Stored image read completed')
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  // C-7: send the package back for a re-shoot (both gates), or reject the shift — at the close gate
  // (`reject-close`) or at the open gate (`reject-open`). All of them bounce the shift to the driver
  // with the note as the reason he sees. To refuse an unopened shift OUTRIGHT rather than send it
  // back, `refuse()` below voids it instead.
  async function decide(
    path: 'request-rephoto' | 'reject-close' | 'reject-open',
    noteOverride?: string,
  ): Promise<void> {
    if (!review) return
    setBusy(true)
    setError(null)
    try {
      const auditedNote = noteOverride?.trim() || notes.trim()
      await api.post(`/shifts/${review.id}/${path}`, { notes: auditedNote || null })
      toast.success(path === 'request-rephoto' ? t.approval.rephotoSent : t.approval.sentBack)
      onDone()
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Refuse an unopened shift outright: it is cancelled, not returned. The bike is released and the
   * driver must start again. Voiding rather than deleting keeps the reason, the decision and the
   * audit row — nothing has posted at this gate, so its money reversals are no-ops.
   */
  async function refuse(): Promise<void> {
    if (!review) return
    // A REASON, not «—». This writes the permanent audit row for cancelling a driver's shift, and
    // the identical action in LiveShifts has always demanded one; here it defaulted to a dash.
    if (notes.trim() === '') {
      setError('void_reason_required')
      return
    }
    const ok = await confirm({
      title: t.approval.confirmVoidTitle,
      body: `${who.driver ?? ''} ${who.vehicle ?? ''} — ${t.approval.confirmVoidBody}`,
      confirmLabel: t.approval.refuse,
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await api.voidShift(review.id, notes.trim())
      toast.success(t.approval.voided)
      onDone()
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  // Closing is a task workspace, not the long evidence report used for opening and live shifts.
  // Keep those existing flows untouched and give the close gate its own responsive hierarchy.
  if (isClose) {
    const inlineDriver = (lang === 'en' ? review.driverNameEn : null) ?? review.driverNameAr ?? who.driver
    const inlineVehicle = review.vehicleCode ?? who.vehicle
    return (
      <CloseApprovalWorkspace
        key={`${review.id}:${reviewGeneration}`}
        review={review}
        who={{ driver: inlineDriver, vehicle: inlineVehicle }}
        settlement={settlement}
        settlementLoadError={settlementLoadError}
        refreshing={refreshing || settlementRecalculating}
        busy={busy}
        error={error ?? loadError}
        walletTransferConfirmed={walletTransferConfirmed}
        cashSettlementConfirmed={cashSettlementConfirmed}
        varianceReason={varianceReason}
        cashReceivableDeferred={cashReceivableDeferred}
        walletReceivableDeferred={walletReceivableDeferred}
        notes={notes}
        onWalletTransferConfirmed={setWalletTransferConfirmed}
        onCashSettlementConfirmed={setCashSettlementConfirmed}
        onVarianceReason={setVarianceReason}
        onCashReceivableDeferred={setCashReceivableDeferred}
        onWalletReceivableDeferred={setWalletReceivableDeferred}
        onNotes={setNotes}
        onBack={onDone}
        onRefresh={refreshVisible}
        onRevise={reviseOps}
        onManagerRead={managerRead}
        onApprove={approve}
        onForceApprove={forceApprove}
        orderRereads={orderRereads}
        onRereadOrder={rereadOrderEvidence}
        pendingTimingDraftKeys={pendingTimingDraftKeys}
        onTimingDraftPending={setTimingDraftPending}
        onRequestRephoto={() => decide('request-rephoto')}
        onSendBack={() => decide('reject-close')}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onDone} aria-label={t.common.back}>
          {/* Points toward the inline-start — left in LTR, mirrored to the right in RTL. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="rtl:-scale-x-100">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        {/* WHOSE shift. The payload has always carried the driver and the vehicle and the screen
            showed neither, so a manager working a queue signed off real cash on a page headed
            «مراجعة النوبة» and nothing else. */}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">
            {who.driver ?? t.approval.review}
            {who.vehicle ? <span className="num ms-2 text-base font-medium text-slate-500">{who.vehicle}</span> : null}
          </h1>
          <p className="num text-sm text-slate-600">
            {review.businessDate} · #{review.shiftNo}
          </p>
        </div>
        <Badge tone="slate">{t.shift.states[review.state as keyof typeof t.shift.states] ?? review.state}</Badge>
      </div>

      <OperationWindowAdvisory
        openApprovedAt={review.openApprovedAt ?? null}
        submittedAt={review.submittedAt ?? null}
        unresolvedCount={unresolvedWindowCount}
        reason={operationReason}
        onReasonChange={setOperationReason}
        editable={underReview && !busy}
        lang={lang}
        copy={operationCopy}
      />

      {/* ── The BR1 panel, pinned first — it is what the decision hinges on ───────────────
          Only once the shift is AT a gate. Mid-shift the driver has declared no closing cash or
          wallet yet, those nulls are read as zero, and the panel would show an alarming red
          difference the size of the whole float for a shift that is simply still running. */}
      {atGate ? (
      <Card
        title={t.br1.title}
        /* STICKY. A real review means scrolling through two packages, the photos, the batteries
           and an unbounded orders list; unpinned, the equation is far off-screen by the time the
           manager reaches the approve bar, and he signs from memory. */
        className={`sticky top-2 z-10 ring-2 ${verdict.tone === 'green' ? 'ring-emerald-300' : 'ring-red-300'}`}
      >
        {/* THE VERDICT, IN WORDS. It was a 2px ring and nothing else — invisible to a colour-blind
            manager and easy to misread at a glance on the screen that signs off real cash. */}
        {/* Two states, not three. `br1Verdict` stopped returning `split_off` when pay mode was
            retired, so the amber path was unreachable code pretending to be a warning. */}
        <p className={`text-lg font-bold ${verdict.tone === 'green' ? 'text-emerald-700' : 'text-red-700'}`}>
          {verdict.label}
        </p>

        {/* Expected against DECLARED, and the difference — as three lines, not a table.
            It WAS a table: four columns and a `min-w-[28rem]`, i.e. 448px of horizontal scroll on a
            card 280px wide, to render one row of three numbers. The manager had to drag the panel
            carrying the verdict sideways to read it. Rows stack; a table of one row was never a
            table. */}
        <dl className="mt-3 flex flex-col gap-1 text-sm">
          {[
            {
              key: 'expected',
              label: t.br1.expected,
              value: formatMinor(add(parseMinor(review.br1.expectedCash), parseMinor(review.br1.expectedWallet))),
            },
            {
              key: 'declared',
              label: t.br1.declared,
              value: formatMinor(
                add(parseMinor(review.endPackage.cashDeclared || '0'), parseMinor(review.endPackage.walletDeclared || '0')),
              ),
            },
          ].map((line) => (
            <div key={line.key} className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">{line.label}</dt>
              <dd className="num font-semibold" dir="ltr">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* The net difference, biggest thing on the screen — it is the number that decides. */}
        <div className="mt-3 flex items-baseline justify-between border-t border-slate-100 pt-3">
          <span className={`text-sm font-semibold ${differenceColour}`}>{differenceLabel}</span>
          <span dir="ltr" className={`num text-3xl font-bold ${differenceColour}`}>
            {difference.amountText}
          </span>
        </div>

        {/* The causes explain the VERDICT, so they appear exactly when it is bad. This used to also
            fire on `!splitBalanced` — which is routinely false on an honest shift now that pay mode
            is no longer collected (decision 8), so a green «المعادلة متوازنة ✓» could sit directly
            above a red-badged list of things supposedly wrong. Contradicting yourself on the screen
            that signs off cash is worse than saying nothing. */}
        {!review.br1.balanced ? (
          <div className="mt-3 flex flex-col gap-1">
            {review.br1.causes.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge tone={c.confidence === 'high' ? 'red' : c.confidence === 'medium' ? 'amber' : 'slate'}>
                  {t.br1.confidence[c.confidence as keyof typeof t.br1.confidence] ?? c.confidence}
                </Badge>
                <span>{t.br1.cause[c.code as keyof typeof t.br1.cause] ?? c.code}</span>
                <Money value={c.amount} className="ms-auto text-base font-semibold" />
                {c.candidateOrderNos.length > 0 ? (
                  <span className="text-xs text-slate-500">
                    ({c.candidateOrderNos.length} {t.orders.title})
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Card>
      ) : null}

      {/* The physical handover comes immediately after BR1: first what to transfer, then why. */}
      {settlement ? (
        <Card title={t.settlement.title}>
          <p className="text-xs text-slate-600">{t.settlement.hint}</p>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div
              className={`rounded-xl border-2 p-4 ${
                settlement.walletAction === 'collect'
                  ? 'border-sky-300 bg-sky-50'
                  : settlement.walletAction === 'fund'
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-emerald-300 bg-emerald-50'
              }`}
            >
              <p className="text-xs font-bold text-slate-600">{t.settlement.walletInstruction}</p>
              <p className="mt-1 text-base font-bold text-slate-900">
                {t.settlement.walletAction[settlement.walletAction]}
              </p>
              <Money value={settlement.walletAmount} className="mt-2 block text-3xl font-extrabold text-sky-800" />
            </div>
            <div
              className={`rounded-xl border-2 p-4 ${
                settlement.cashAction === 'collect'
                  ? 'border-emerald-300 bg-emerald-50'
                  : settlement.cashAction === 'pay'
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-slate-300 bg-slate-50'
              }`}
            >
              <p className="text-xs font-bold text-slate-600">{t.settlement.cashInstruction}</p>
              <p className="mt-1 text-base font-bold text-slate-900">
                {t.settlement.cashAction[settlement.cashAction]}
              </p>
              <Money
                value={settlement.cashAmount}
                className={`mt-2 block text-3xl font-extrabold ${
                  settlement.cashAction === 'pay' ? 'text-amber-800' : 'text-emerald-800'
                }`}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-sm font-bold text-slate-800">{t.settlement.breakdown}</p>
            <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
              {(
                [
                  ['deliveryFeeTotal', settlement.deliveryFeeTotal],
                  ['fixedDriverShare', settlement.fixedDriverShare],
                  ['manualDriverShare', settlement.manualDriverShare],
                  ['grossDriverShare', settlement.grossDriverShare],
                  ['cashDeductionTotal', settlement.cashDeductionTotal],
                  ['baseDriverShare', settlement.baseDriverShare],
                  ['expectedTotal', settlement.expectedTotal],
                  ['actualTotal', settlement.actualTotal],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="flex items-baseline gap-2 border-b border-slate-100 py-1 text-sm">
                  <span className="text-slate-600">{t.settlement[key]}</span>
                  <Money value={value} className="ms-auto font-semibold text-slate-900" />
                </div>
              ))}
              <div
                className={`flex items-baseline gap-2 border-b py-1 text-sm font-bold md:col-span-2 ${
                  settlement.varianceDirection === 'surplus'
                    ? 'border-emerald-200 text-emerald-800'
                    : settlement.varianceDirection === 'shortage'
                      ? 'border-red-200 text-red-800'
                      : 'border-slate-100 text-slate-700'
                }`}
              >
                <span>{t.settlement.varianceDirection[settlement.varianceDirection]}</span>
                <Money value={settlementVarianceMagnitude(settlement)} className="ms-auto text-lg" />
              </div>
              <div className="flex items-baseline gap-2 pt-2 text-base font-extrabold md:col-span-2">
                <span>{t.settlement.finalEmployeeCash}</span>
                <Money
                  value={settlement.finalEmployeeCash}
                  className={`ms-auto text-2xl ${
                    parseMinor(settlement.finalEmployeeCash) < 0n ? 'text-red-700' : 'text-brand'
                  }`}
                />
              </div>
            </div>
          </div>

          {settlementHasVariance(settlement) && !forcePrepared ? (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <label className="text-sm font-bold text-amber-950" htmlFor="settlement-variance-reason">
                {t.settlement.varianceReason}
              </label>
              <textarea
                id="settlement-variance-reason"
                value={varianceReason}
                onChange={(event) => setVarianceReason(event.target.value)}
                disabled={busy}
                maxLength={500}
                rows={2}
                className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                placeholder={t.settlement.varianceReasonPlaceholder}
              />
            </div>
          ) : null}

          <fieldset className="mt-4 flex flex-col gap-2" disabled={busy}>
            <legend className="mb-1 text-sm font-bold text-slate-800">{t.settlement.confirmationsTitle}</legend>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                checked={walletTransferConfirmed}
                onChange={(event) => setWalletTransferConfirmed(event.target.checked)}
                className="size-5 shrink-0 accent-emerald-600"
              />
              <span>{t.settlement.walletConfirmed}</span>
            </label>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                checked={cashSettlementConfirmed}
                onChange={(event) => setCashSettlementConfirmed(event.target.checked)}
                className="size-5 shrink-0 accent-emerald-600"
              />
              <span>{t.settlement.cashConfirmed}</span>
            </label>
          </fieldset>
        </Card>
      ) : isClose ? (
        <Card title={t.settlement.title}>
          <p className="text-sm font-medium text-red-700">
            {settlementLoadError ? explainError(settlementLoadError, t) : t.settlement.loading}
          </p>
          {settlementLoadError ? (
            <Button variant="ghost" className="mt-3" onClick={load} disabled={busy}>
              {t.common.retry}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {/* ── Start vs end, side by side — the odometer delta is the anti-fraud read ──────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={t.shift.startPackage}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Field label={t.shift.odometer} value={String(review.startPackage.odometerKm ?? '—')} />
            {review.state === 'awaiting_open_approval' ? (
              <>
                <div>
                  <dt className="text-xs text-slate-500"><label htmlFor={floatInputId}>{t.shift.cashFloat}</label></dt>
                  <dd className="mt-1">
                    <MoneyInput
                      id={floatInputId}
                      value={floatText}
                      aria-invalid={!isValidOpeningFundInput(floatText)}
                      onChange={(e) => setFloatText(e.target.value)}
                      className="w-full"
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500"><label htmlFor={topupInputId}>{t.shift.walletTopup}</label></dt>
                  <dd className="mt-1">
                    <MoneyInput
                      id={topupInputId}
                      value={topupText}
                      aria-invalid={!isValidOpeningFundInput(topupText)}
                      onChange={(e) => setTopupText(e.target.value)}
                      className="w-full"
                    />
                  </dd>
                </div>
                <Field
                  label={`${t.treasury.receivableKinds.shift_funding} / ${t.treasury.receivableChannels.cash}`}
                  value={review.shiftFunding.cash}
                />
                <Field
                  label={`${t.treasury.receivableKinds.shift_funding} / ${t.treasury.receivableChannels.wallet}`}
                  value={review.shiftFunding.wallet}
                />
                {!openingFundsValid ? (
                  <div className="col-span-2">
                    <dt className="sr-only">{t.liveShifts.openingAmountInvalid}</dt>
                    <dd className="text-xs font-medium text-red-700">{t.liveShifts.openingAmountInvalid}</dd>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <Field label={t.shift.cashFloat} value={review.startPackage.floatTotal} />
                <Field label={t.shift.walletTopup} value={review.startPackage.topupTotal} />
              </>
            )}
          </dl>
          {/* SRS D-3: what the driver changed from the dashboard OCR (odometer only now). */}
          <OcrDeltaLines
            deltas={scalarDelta(
              t.shift.odometer,
              review.startPackage.odometerKmOcr === null ? null : String(review.startPackage.odometerKmOcr),
              review.startPackage.odometerKm === null ? null : String(review.startPackage.odometerKm),
            )}
          />
          <PhotoRow pkg="start" media={review.media} />
          <BatteryReadings readings={review.startPackage.batteries} pkg="start" onManagerRead={managerRead} />
        </Card>
        <Card title={t.shift.endPackage}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Field label={t.shift.odometer} value={String(review.endPackage.odometerKm ?? '—')} />
            {/* The sign was unconditional, so a tampered end-odometer rendered as «+-5 كم»; and the
                unit was a literal in the TSX, unreachable by the English catalogue. A delta that is
                zero or negative is the anti-fraud read failing, so it is coloured. */}
            <Field
              label={t.approval.startVsEnd}
              value={odoDelta === null ? '—' : `${odoDelta} ${t.shift.km}`}
              {...(odoDelta !== null && odoDelta <= 0 ? { tone: 'red' as const } : {})}
            />
            <Field label={t.shift.cashHandover} value={review.endPackage.cashDeclared ?? '—'} />
            <Field label={t.shift.walletBalance} value={review.endPackage.walletDeclared ?? '—'} />
          </dl>
          {review.endPackage.odometerAnomalyConfirmedAt ? (
            <p className="mt-2 text-xs font-medium text-red-700">
              {t.approval.odometerAnomalyConfirmed}: {' '}
              <span className="num">{formatDateTime(review.endPackage.odometerAnomalyConfirmedAt, lang)}</span>
              {' · '}{review.endPackage.odometerAnomalyConfirmedBy ?? '—'}
            </p>
          ) : null}
          {isClose && !forcePrepared ? (
            <ReviseFigures shiftId={review.id} review={review} onRevised={refreshVisible} />
          ) : null}
          {/* Both close readers now preserve their baseline; a manual correction remains visible. */}
          <OcrDeltaLines
            deltas={[
              ...scalarDelta(
                t.shift.odometer,
                review.endPackage.odometerKmOcr == null ? null : String(review.endPackage.odometerKmOcr),
                review.endPackage.odometerKm === null ? null : String(review.endPackage.odometerKm),
              ),
              ...scalarDelta(t.shift.walletBalance, review.endPackage.walletDeclaredOcr, review.endPackage.walletDeclared),
            ]}
          />
          <PhotoRow pkg="end" media={review.media} />
          <BatteryReadings readings={review.endPackage.batteries} pkg="end" onManagerRead={managerRead} />
        </Card>
      </div>

      {/* Mid-shift battery swaps (SRS §L seam): the pack on a slot came off, a charged spare went on. */}
      {review.batterySwaps && review.batterySwaps.length > 0 ? (
        <Card title={t.battery.swap.title}>
          <Table head={['#', t.battery.swap.slot, t.battery.swap.outReading, t.battery.swap.inReading]}>
            {review.batterySwaps.map((s) => (
              <tr key={s.seqNo}>
                <td className="px-3 py-1 num text-slate-500">{s.seqNo}</td>
                <td className="px-3 py-1 num">{t.battery.swap.slotLabel.replace('{{n}}', String(s.slotNo))}</td>
                <td className="px-3 py-1 num">
                  {s.outSerial ?? '—'} · {s.outPercent ?? '—'}%
                </td>
                <td className="px-3 py-1 num">
                  {s.inSerial ?? '—'} · {s.inPercent ?? '—'}%
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {cashDeductions.length > 0 ? (
        <Card title={`${operationCopy.cashDeductions} — ${cashDeductions.length}`}>
          <p className="mb-2 text-xs text-slate-600">{operationCopy.cashDeductionHint}</p>
          <Table
            head={[
              operationCopy.included,
              operationCopy.time,
              operationCopy.route,
              operationCopy.amount,
              operationCopy.source,
              operationCopy.windowStatus,
            ]}
          >
            {cashDeductions.map((deduction) => (
              <tr key={deduction.id} className={deduction.included ? '' : 'opacity-60'}>
                <td className="px-3 py-1">
                  <input
                    type="checkbox"
                    checked={deduction.included}
                    disabled={!underReview || busy || !operationReasonReady}
                    title={!operationReasonReady ? operationCopy.reasonRequired : undefined}
                    onChange={(event) =>
                      void reviseOps({
                        cashDeductions: [
                          {
                            id: deduction.id,
                            included: event.target.checked,
                            reason: operationReason.trim(),
                          },
                        ],
                      })
                    }
                    aria-label={operationCopy.included}
                    className="size-5 accent-emerald-600"
                  />
                </td>
                <td className="num whitespace-nowrap px-3 py-1">
                  <div>{deduction.occurredDate ?? '—'}</div>
                  <div className="text-xs text-slate-500">{deduction.occurredMinute ?? '—'}</div>
                </td>
                <td className="px-3 py-1 text-xs text-slate-600">
                  {[deduction.pointA, deduction.pointB].filter(Boolean).join(' ← ') || '—'}
                </td>
                <td className="px-3 py-1">
                  <span dir="ltr" className="inline-flex items-baseline font-semibold text-red-700">
                    −<Money value={deduction.amount} />
                  </span>
                  <OcrDeltaLines
                    deltas={scalarDelta(operationCopy.amount, deduction.amountOcr ?? null, deduction.amount)}
                  />
                </td>
                <td className="px-3 py-1">
                  {deduction.source === 'ocr' ? <Badge tone="slate">OCR</Badge> : operationCopy.manual}
                </td>
                <td className="min-w-64 px-3 py-1">
                  <WindowStatusBadge status={deduction.windowStatus} copy={operationCopy} />
                  {!deduction.included ? <span className="ms-1"><Badge tone="slate">{operationCopy.excluded}</Badge></span> : null}
                  {deduction.decisionReason ? (
                    <p className="mt-1 text-xs text-slate-600">{operationCopy.decisionReason}: {deduction.decisionReason}</p>
                  ) : null}
                  {underReview ? (
                    <WindowCorrection
                      occurredDate={deduction.occurredDate}
                      occurredMinute={deduction.occurredMinute}
                      disabled={busy || !operationReasonReady}
                      reasonRequired={!operationReasonReady}
                      copy={operationCopy}
                      onSave={(occurredDate, occurredMinute) =>
                        reviseOps({
                          cashDeductions: [
                            {
                              id: deduction.id,
                              occurredDate,
                              occurredMinute,
                              reason: operationReason.trim(),
                            },
                          ],
                        })
                      }
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Card title={`${t.orders.title} — ${review.orders.length}`}>
        {/* ONLY THE ROWS WORTH ATTENTION, by default.
            Twelve orders was ~840px of table on a phone, nearly all of it rows with nothing to say.
            A row earns a place here by being machine-read, edited away from what OCR said, excluded,
            or a manual job the manager priced himself.

            THE SAFEGUARD THAT MAKES THAT HONEST: the rest are COUNTED AND TOTALLED in the line
            below, always, and one tap shows them. Hiding a row is a statement about the order of
            attention, never about its existence — a manager who cannot see that eleven rows exist
            is a manager approving something he was not shown. */}
        {hiddenOrders.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowAllOrders((v) => !v)}
            className={`mb-2 flex w-full items-baseline justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm ${FOCUS_RING}`}
          >
            <span className="text-slate-600">
              {showAllOrders ? t.approval.showFlaggedOnly : t.approval.ordersHidden.replace('{n}', String(hiddenOrders.length))}
            </span>
            <Money value={hiddenTotal} className="font-semibold text-slate-700" />
          </button>
        ) : null}
        <Table head={['', '#', t.orders.route, t.orders.payMode, t.orders.fee, operationCopy.windowStatus]}>
          {shownOrders.map((o, i) => (
            <tr key={o.providerOrderNo} className={o.included === false ? 'opacity-60' : ''}>
              {/* Every operation shows, checked or not, and an excluded row keeps its PLACE —
                  hiding it or moving it to the bottom is how a manager stops noticing it. */}
              <td className="px-3 py-1">
                <input
                  type="checkbox"
                  checked={o.included !== false}
                  disabled={!underReview || busy || !operationReasonReady}
                  title={!operationReasonReady ? operationCopy.reasonRequired : undefined}
                  onChange={(e) =>
                    void reviseOps({
                      orders: [
                        {
                          providerOrderNo: o.providerOrderNo,
                          included: e.target.checked,
                          reason: operationReason.trim(),
                        },
                      ],
                    })
                  }
                  aria-label={t.orders.included}
                  className="size-5 accent-emerald-600"
                />
              </td>
              <td className="px-3 py-1 text-slate-600">{i + 1}</td>
              {/* WHAT THE ORDER IS. Not `providerOrderNo` — that is a generated key, unique and
                  meaningless, and printing it here told the manager nothing he could check against
                  the driver's screenshot. The clock and the two places are what both of them see. */}
              <td className="px-3 py-1">
                <span className="num">{o.occurredDate ?? review.businessDate.slice(0, 10)} · {o.occurredMinute ?? '—'}</span>
                {o.source === 'ocr' ? <span className="ms-1.5 align-middle"><Badge tone="slate">OCR</Badge></span> : null}
                {o.included === false ? <span className="ms-1.5 align-middle"><Badge tone="slate">{t.orders.excluded}</Badge></span> : null}
                {(o.points ?? []).length > 0 ? (
                  <div className="text-xs text-slate-500">
                    {(o.points ?? []).find((p) => p.role === 'start')?.label ?? '—'} ←{' '}
                    {(o.points ?? []).find((p) => p.role === 'end')?.label ?? '—'}
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-1">{t.orders.payModes[o.payMode as keyof typeof t.orders.payModes]}</td>
              <td className="px-3 py-1">
                <FeeCell
                  fee={o.fee}
                  editable={underReview && !busy}
                  onSave={async (fee) => { await reviseOps({ orders: [{ providerOrderNo: o.providerOrderNo, fee }] }) }}
                />
                {/* What the payments log measured actually reached the wallet. Its absence is not a
                    gap — it means nobody measured it and the pay mode decides, as it always did. */}
                {o.walletAmount ? (
                  <div className="num text-xs text-slate-500">
                    {t.orders.toWallet}: {o.walletAmount}
                    {o.occurredMinute ? ` · ${o.occurredMinute}` : ''}
                  </div>
                ) : null}
                {/* SRS D-3: a fee the driver changed from what OCR read (money strings compare exact). */}
                <OcrDeltaLines deltas={scalarDelta(t.orders.fee, o.feeOcr ?? null, o.fee)} />
                {/* A manual job carries its agreed split and its route with it — the numbers a
                    manager is signing for are not derivable from the fee alone. */}
                {o.kind === 'manual' ? (
                  <div className="mt-1 flex flex-col gap-0.5 text-xs text-slate-500">
                    <span className="num">
                      {t.orders.driverShare}: {o.driverShare ?? '—'} · {t.orders.companyShare}: {o.companyShare ?? '—'}
                    </span>
                    {o.points && o.points.length > 0 ? (
                      <span>
                        {t.orders.route}: {o.points.map((p) => p.label).join(' ← ')}
                      </span>
                    ) : null}
                    {o.notes ? <span>{o.notes}</span> : null}
                  </div>
                ) : null}
              </td>
              <td className="min-w-64 px-3 py-1">
                {o.kind === 'manual' ? (
                  <Badge tone="sky">{operationCopy.manualOutsideWindow}</Badge>
                ) : o.windowStatus ? (
                  <WindowStatusBadge status={o.windowStatus} copy={operationCopy} />
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
                {o.decisionReason ? (
                  <p className="mt-1 text-xs text-slate-600">{operationCopy.decisionReason}: {o.decisionReason}</p>
                ) : null}
                {underReview && o.kind !== 'manual' ? (
                  <WindowCorrection
                    occurredDate={o.occurredDate ?? null}
                    occurredMinute={o.occurredMinute ?? null}
                    disabled={busy || !operationReasonReady}
                    reasonRequired={!operationReasonReady}
                    copy={operationCopy}
                    onSave={(occurredDate, occurredMinute) =>
                      reviseOps({
                        orders: [
                          {
                            providerOrderNo: o.providerOrderNo,
                            occurredDate,
                            occurredMinute,
                            reason: operationReason.trim(),
                          },
                        ],
                      })
                    }
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </Table>

        {/* The payments log is deliberately read-only here. It remains useful evidence, but its
            rows do not change BR1, order fees, the fixed share or ledger postings. */}
        {review.movements.length > 0 ? (
          <div className="mt-4">
            <p className="mb-1 text-sm font-semibold">{t.shift.paymentsLog}</p>
            <p className="mb-2 text-xs text-slate-600">{operationCopy.paymentsLogArchiveHint}</p>
            <Table head={[t.orders.time, t.orders.fee]}>
              {review.movements.map((m) => (
                <tr key={m.id}>
                  <td className="num px-3 py-1 text-slate-500">{m.occurredMinute || '—'}</td>
                  <td className="num px-3 py-1">
                    <Money value={m.amount} />
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}

        <AddOrderForm shiftId={review.id} onAdded={refreshVisible} />
      </Card>

      {review.decisions.length > 0 ? (
        <Card title={t.approval.decisionLog}>
          <ul className="flex flex-col gap-1 text-sm">
            {review.decisions.map((d, i) => (
              <li key={i} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
                <span className="flex items-center gap-2">
                  <Badge tone={d.decision === 'approved' ? 'green' : d.decision === 'rejected' ? 'red' : 'amber'}>
                    {t.approval.decisions[d.decision]}
                  </Badge>
                  {d.notes ? <span className="text-slate-500">{d.notes}</span> : null}
                </span>
                <span className="num text-xs text-slate-600">{formatDateTime(d.decidedAt, lang)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* A reason for the re-shoot / reject the driver will see — only where a decision is taken. */}
      {atGate ? (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t.approval.notes}
          aria-label={t.approval.notes}
          rows={2}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
      ) : null}

      {error ? <p className="text-sm font-medium text-red-600">{explainError(error, t)}</p> : null}
      {/* No gate controls on a running shift — see `atGate`. The manager acts on a live shift from
          «النوبات الجارية» (suspend, force-close, void), each of which asks for a reason first. */}
      {atGate ? (
        /* A BACKDROP. Rows and photos used to scroll visibly through the gaps between the
           buttons, and on a narrow window the wrapped rows overlapped the content beneath. */
        <div
          /* z-50 to match the toast stack: a toast from `reviseOps` is `fixed bottom-0 z-50` and was
             landing squarely on top of the approve button. And the safe-area padding, because
             `viewport-fit=cover` is now set — without it this bar sits under an Android gesture bar,
             where the tap that should approve a shift dismisses the app instead. */
          className="sticky bottom-0 z-50 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {/* WHY the button is dead. A 40%-opacity ghost with no explanation is how a manager
              concludes the console is broken and goes looking for a way around the gate. */}
          {isClose && !settlement ? (
            <p className="mb-2 text-sm font-medium text-red-700">{t.settlement.unavailable}</p>
          ) : null}
          {isClose && settlement && (!walletTransferConfirmed || !cashSettlementConfirmed) ? (
            <p className="mb-2 text-sm font-medium text-amber-800">{t.settlement.confirmBeforeApproval}</p>
          ) : null}
          {isClose && unresolvedWindowCount > 0 ? (
            <p className="mb-2 text-sm font-medium text-amber-800">
              {operationCopy.cannotApproveUnknown.replace('{n}', String(unresolvedWindowCount))}
            </p>
          ) : null}
          {isClose && forcePrepared && settlementDraft.varianceReason.trim() === '' ? (
            <p className="mb-2 text-sm font-medium text-red-700">{t.approval.forceReasonRequired}</p>
          ) : null}
          {isClose && forcePrepared ? (
            <p className="mb-2 text-sm font-medium text-amber-800">{t.approval.forcePreparedHint}</p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {isClose && forcePrepared ? null : (
              <Button
                variant="success"
                disabled={busy || (!isClose && !openingFundsValid) || (isClose && (unresolvedWindowCount > 0 || !closeSettlementReady))}
                onClick={approve}
                className="flex-1"
              >
                {isClose ? t.approval.approveClose : t.common.approve}
              </Button>
            )}
            {isClose && forcePrepared ? (
              <Button
                variant="danger"
                disabled={busy || unresolvedWindowCount > 0 || !closeSettlementReady || notes.trim() === ''}
                onClick={forceApprove}
                className="flex-1"
              >
                {t.approval.forceApprove}
              </Button>
            ) : null}
            {/* Re-shoot is legal on both gates. */}
            <Button variant="ghost" disabled={busy} onClick={() => decide('request-rephoto')}>
              {t.approval.requestRetake}
            </Button>
            {/* BOTH reject paths return the shift to the driver, so both are labelled «إعادة
                للسائق» and neither is red. Red is now reserved for the one action that destroys
                a shift — the manager used to learn «رفض» = send back at one gate and meet
                «رفض نهائي» = void at the other, one word apart. */}
            <Button variant="ghost" disabled={busy} onClick={() => decide(isClose ? 'reject-close' : 'reject-open')}>
              {t.approval.sendBack}
            </Button>
            {isClose ? null : (
              <Button variant="danger" disabled={busy} onClick={refuse}>
                {t.approval.refuse}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

interface CloseApprovalWorkspaceProps {
  review: Review
  who: { driver: string | null; vehicle: string | null }
  settlement: SettlementView | null
  settlementLoadError: string | null
  refreshing: boolean
  busy: boolean
  error: string | null
  walletTransferConfirmed: boolean
  cashSettlementConfirmed: boolean
  varianceReason: string
  cashReceivableDeferred: string
  walletReceivableDeferred: string
  notes: string
  onWalletTransferConfirmed(value: boolean): void
  onCashSettlementConfirmed(value: boolean): void
  onVarianceReason(value: string): void
  onCashReceivableDeferred(value: string): void
  onWalletReceivableDeferred(value: string): void
  onNotes(value: string): void
  onBack(): void
  onRefresh(): void
  onRevise(body: Record<string, unknown>): Promise<boolean>
  onManagerRead(pkg: 'start' | 'end', batteryId: string, percent: number): Promise<void>
  onApprove(): Promise<void>
  onForceApprove(): Promise<void>
  orderRereads: Record<string, ManagerOrderEvidenceRereadResponse>
  onRereadOrder(target: ManagerOrderEvidenceRereadTarget, slot: string, reason: string): Promise<void>
  pendingTimingDraftKeys: ReadonlySet<string>
  onTimingDraftPending(key: string, pending: boolean): void
  onRequestRephoto(): Promise<void>
  onSendBack(): Promise<void>
}

/** Fast close-only workspace: exceptions on the left, physical settlement fixed on the right. */
function CloseApprovalWorkspace({
  review,
  who,
  settlement,
  settlementLoadError,
  refreshing,
  busy,
  error,
  walletTransferConfirmed,
  cashSettlementConfirmed,
  varianceReason,
  cashReceivableDeferred,
  walletReceivableDeferred,
  notes,
  onWalletTransferConfirmed,
  onCashSettlementConfirmed,
  onVarianceReason,
  onCashReceivableDeferred,
  onWalletReceivableDeferred,
  onNotes,
  onBack,
  onRefresh,
  onRevise,
  onManagerRead,
  onApprove,
  onForceApprove,
  orderRereads,
  onRereadOrder,
  pendingTimingDraftKeys,
  onTimingDraftPending,
  onRequestRephoto,
  onSendBack,
}: CloseApprovalWorkspaceProps): ReactNode {
  const { t, lang } = useApp()
  const copy = closeWorkspaceCopy(lang)
  const operationCopy = operationReviewCopy(lang)
  const cashDeductions = review.cashDeductions ?? []
  const unresolvedCount = countUnresolvedWindowRows(review.orders, cashDeductions)
  const physicalConfirmationGuard = guardPhysicalSettlementConfirmations(unresolvedCount, {
    walletTransferConfirmed,
    cashSettlementConfirmed,
  })
  const physicalConfirmationsLocked = !physicalConfirmationGuard.allowed

  // A previous tick belongs to a financial statement that is no longer actionable once an
  // unresolved timestamp appears. Clear the source state as well as rendering guarded values so
  // the ticks cannot reappear after the manager resolves the exception and a new hash arrives.
  useEffect(() => {
    if (!physicalConfirmationsLocked) return
    if (walletTransferConfirmed) onWalletTransferConfirmed(false)
    if (cashSettlementConfirmed) onCashSettlementConfirmed(false)
  }, [
    cashSettlementConfirmed,
    onCashSettlementConfirmed,
    onWalletTransferConfirmed,
    physicalConfirmationsLocked,
    walletTransferConfirmed,
  ])
  // BR5's manager close gate evaluates the END package. An unavailable BMS read was waived only
  // for the driver; it is now explicitly the manager's job and must not produce a green close CTA.
  const managerBatteryReadingCount = countAwaitingCloseBatteryReadings(review.endPackage.batteries)
  const forcePrepared = activeForcePreparation(review.submittedAt, review.decisions) !== null
  const settlementDraft = {
    walletTransferConfirmed: physicalConfirmationGuard.walletTransferConfirmed,
    cashSettlementConfirmed: physicalConfirmationGuard.cashSettlementConfirmed,
    varianceReason: forcePrepared ? notes : varianceReason,
  }
  const deferralInputsValid =
    isNonnegativeSettlementMoney(cashReceivableDeferred) &&
    isNonnegativeSettlementMoney(walletReceivableDeferred)
  const deferralMatchesSettlement =
    settlement !== null &&
    deferralInputsValid &&
    parseMinor(cashReceivableDeferred.trim()) === parseMinor(settlement.cashReceivableDeferred) &&
    parseMinor(walletReceivableDeferred.trim()) === parseMinor(settlement.walletReceivableDeferred)
  const approvalReady = closeWorkspaceApprovalReady({
    settlementReady: deferralMatchesSettlement && settlementApprovalReady(settlement, settlementDraft),
    unresolvedOperationCount: unresolvedCount,
    managerBatteryReadingCount,
    pendingTimingDraftCount: pendingTimingDraftKeys.size,
    refreshing,
  })

  const day = review.businessDate.slice(0, 10)
  const occurrenceKey = (order: Review['orders'][number]): string =>
    `${(order.occurredDate ?? day).slice(0, 10)} ${order.occurredMinute ?? ''}`
  const orders = [...review.orders].sort((a, b) => {
    if (!a.occurredMinute !== !b.occurredMinute) return a.occurredMinute ? -1 : 1
    return occurrenceKey(a).localeCompare(occurrenceKey(b))
  })
  const summary = summarizeOrders(orders)
  const attentionOrders = orders.filter(orderNeedsAttention)
  const ordinaryOrders = orders.filter((order) => !orderNeedsAttention(order))
  const attentionCount = attentionOrders.length + cashDeductions.length
  const dashboardEvidence = review.media
    .filter((item) => item.package === 'end' && splitSlot(item.slot).base === 'dashboard')
    .sort((left, right) => splitSlot(left.slot).n - splitSlot(right.slot).n)

  const odoDelta =
    review.startPackage.odometerKm !== null && review.endPackage.odometerKm !== null
      ? review.endPackage.odometerKm - review.startPackage.odometerKm
      : null
  const evidenceHasAnomaly =
    odoDelta === null ||
    odoDelta <= 0 ||
    Boolean(review.endPackage.odometerAnomalyConfirmedAt) ||
    [...review.startPackage.batteries, ...review.endPackage.batteries].some(
      (reading) => reading.unavailable === true && reading.percent === null,
    ) ||
    review.media.some((item) => {
      const warning = evidenceReviewWarning(item)
      return (warning.age.kind === 'stale' || warning.reusedFromShiftId !== null) && !warning.acknowledged
    })

  const difference = br1DifferencePresentation(review.br1.difference)
  const differenceColour =
    difference.direction === 'surplus'
      ? 'text-emerald-700'
      : difference.direction === 'shortage'
        ? 'text-red-700'
        : 'text-slate-700'
  const { verdict: br1State } = br1Verdict(review.br1)
  const readyTone =
    refreshing || unresolvedCount > 0 || managerBatteryReadingCount > 0 || pendingTimingDraftKeys.size > 0
      ? 'amber'
      : approvalReady
        ? 'green'
        : 'slate'
  const readyLabel = refreshing
    ? copy.recalculating
    : unresolvedCount > 0 || managerBatteryReadingCount > 0 || pendingTimingDraftKeys.size > 0
      ? copy.needsAttention
      : approvalReady
        ? copy.ready
        : copy.awaitingHandover

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl bg-white p-3 shadow-sm">
        <Button variant="ghost" onClick={onBack} aria-label={t.common.back} className="shrink-0 px-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="rtl:-scale-x-100">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h1 className="truncate text-lg font-bold">{who.driver ?? t.approval.review}</h1>
            {who.vehicle ? <span className="num text-sm font-semibold text-slate-500">{who.vehicle}</span> : null}
          </div>
          <p className="num text-xs text-slate-500">{review.businessDate} · #{review.shiftNo}</p>
        </div>
        <Badge tone={readyTone}>{readyLabel}</Badge>
      </header>

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]">
        <main className="order-2 flex min-w-0 flex-col gap-4 xl:order-1">
          <Card title={`${copy.attentionTitle} — ${attentionCount}`}>
            <p className="mb-3 text-xs text-slate-600">{copy.attentionHint}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <OperationSummaryTile label={copy.included} count={summary.included.count} total={summary.included.total} tone="green" />
              <OperationSummaryTile label={copy.excluded} count={summary.excluded.count} total={summary.excluded.total} tone="slate" />
              <OperationSummaryTile label={copy.unresolved} count={summary.unresolved.count} total={summary.unresolved.total} tone={summary.unresolved.count > 0 ? 'amber' : 'slate'} />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-sky-50 p-3 text-xs sm:grid-cols-2">
              <Field label={operationCopy.opened} value={review.openApprovedAt ? formatDateTime(review.openApprovedAt, lang) : '—'} />
              <Field label={operationCopy.submitted} value={review.submittedAt ? formatDateTime(review.submittedAt, lang) : operationCopy.notSubmitted} />
            </div>

            {attentionCount === 0 ? (
              <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                {copy.noAttention}
              </p>
            ) : (
              <div className="mt-3 flex min-w-0 flex-col gap-3">
                {attentionOrders.map((order, index) => (
                  <OrderAttentionCard
                    key={order.providerOrderNo}
                    order={order}
                    index={orders.indexOf(order) + 1 || index + 1}
                    businessDate={day}
                    disabled={busy || refreshing}
                    copy={copy}
                    operationCopy={operationCopy}
                    onRevise={onRevise}
                    dashboardEvidence={dashboardEvidence}
                    {...(orderRereads[`order:${order.providerOrderNo}`]
                      ? { reread: orderRereads[`order:${order.providerOrderNo}`] }
                      : {})}
                    onReread={onRereadOrder}
                    timingDraftPending={pendingTimingDraftKeys.has(`order:${order.providerOrderNo}`)}
                    onTimingDraftPending={(pending) => onTimingDraftPending(`order:${order.providerOrderNo}`, pending)}
                  />
                ))}
                {cashDeductions.map((deduction) => (
                  <DeductionAttentionCard
                    key={deduction.id}
                    deduction={deduction}
                    disabled={busy || refreshing}
                    copy={copy}
                    operationCopy={operationCopy}
                    onRevise={onRevise}
                    dashboardEvidence={dashboardEvidence}
                    {...(orderRereads[`cash_deduction:${deduction.id}`]
                      ? { reread: orderRereads[`cash_deduction:${deduction.id}`] }
                      : {})}
                    onReread={onRereadOrder}
                    timingDraftPending={pendingTimingDraftKeys.has(`cash_deduction:${deduction.id}`)}
                    onTimingDraftPending={(pending) => onTimingDraftPending(`cash_deduction:${deduction.id}`, pending)}
                  />
                ))}
              </div>
            )}

            <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <summary className={`cursor-pointer text-sm font-bold text-brand ${FOCUS_RING}`}>
                {copy.ordinaryOrders.replace('{n}', String(ordinaryOrders.length))}
              </summary>
              <p className="mt-1 text-xs text-slate-600">{copy.ordinaryHint}</p>
              <ul className="mt-3 flex min-w-0 flex-col gap-2">
                {ordinaryOrders.map((order) => (
                  <OrdinaryOrderRow key={order.providerOrderNo} order={order} businessDate={day} />
                ))}
              </ul>
            </details>

            <details className="mt-3 rounded-lg border border-slate-200 p-3">
              <summary className={`cursor-pointer text-sm font-bold text-brand ${FOCUS_RING}`}>{copy.addOrder}</summary>
              <AddOrderForm shiftId={review.id} onAdded={onRefresh} />
            </details>
          </Card>

          <details
            open={evidenceHasAnomaly ? true : undefined}
            className={`rounded-xl bg-white p-4 shadow-sm ${evidenceHasAnomaly ? 'ring-2 ring-amber-300' : ''}`}
          >
            <summary className={`cursor-pointer text-sm font-bold text-slate-700 ${FOCUS_RING}`}>
              {copy.evidenceTitle}
              {evidenceHasAnomaly ? <span className="ms-2 text-amber-700">· {copy.evidenceAnomaly}</span> : null}
            </summary>
            <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
              <section className="min-w-0 rounded-lg border border-slate-200 p-3">
                <h3 className="text-sm font-bold text-slate-700">{t.shift.startPackage}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <Field label={t.shift.odometer} value={String(review.startPackage.odometerKm ?? '—')} />
                  <Field label={t.shift.cashFloat} value={review.startPackage.floatTotal} />
                  <Field label={t.shift.walletTopup} value={review.startPackage.topupTotal} />
                </dl>
                <OcrDeltaLines deltas={scalarDelta(t.shift.odometer, review.startPackage.odometerKmOcr === null ? null : String(review.startPackage.odometerKmOcr), review.startPackage.odometerKm === null ? null : String(review.startPackage.odometerKm))} />
                <PhotoRow pkg="start" media={review.media} />
                <BatteryReadings readings={review.startPackage.batteries} pkg="start" onManagerRead={onManagerRead} />
              </section>
              <section className="min-w-0 rounded-lg border border-slate-200 p-3">
                <h3 className="text-sm font-bold text-slate-700">{t.shift.endPackage}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <Field label={t.shift.odometer} value={String(review.endPackage.odometerKm ?? '—')} />
                  <Field label={t.approval.startVsEnd} value={odoDelta === null ? '—' : `${odoDelta} ${t.shift.km}`} {...(odoDelta !== null && odoDelta <= 0 ? { tone: 'red' as const } : {})} />
                  <Field label={t.shift.cashHandover} value={review.endPackage.cashDeclared ?? '—'} />
                  <Field label={t.shift.walletBalance} value={review.endPackage.walletDeclared ?? '—'} />
                </dl>
                <ReviseFigures shiftId={review.id} review={review} onRevised={onRefresh} />
                <OcrDeltaLines deltas={[
                  ...scalarDelta(t.shift.odometer, review.endPackage.odometerKmOcr == null ? null : String(review.endPackage.odometerKmOcr), review.endPackage.odometerKm === null ? null : String(review.endPackage.odometerKm)),
                  ...scalarDelta(t.shift.walletBalance, review.endPackage.walletDeclaredOcr, review.endPackage.walletDeclared),
                ]} />
                <PhotoRow pkg="end" media={review.media} />
                <BatteryReadings readings={review.endPackage.batteries} pkg="end" onManagerRead={onManagerRead} />
              </section>
            </div>

            {review.batterySwaps && review.batterySwaps.length > 0 ? (
              <EvidenceList title={t.battery.swap.title}>
                {review.batterySwaps.map((swap) => (
                  <li key={swap.seqNo} className="rounded-lg border border-slate-200 p-2 text-sm">
                    <span className="num font-semibold">#{swap.seqNo} · {t.battery.swap.slotLabel.replace('{{n}}', String(swap.slotNo))}</span>
                    <p className="num text-xs text-slate-600">{swap.outSerial ?? '—'} · {swap.outPercent ?? '—'}% → {swap.inSerial ?? '—'} · {swap.inPercent ?? '—'}%</p>
                  </li>
                ))}
              </EvidenceList>
            ) : null}

            {review.movements.length > 0 ? (
              <EvidenceList title={t.shift.paymentsLog} hint={operationCopy.paymentsLogArchiveHint}>
                {review.movements.map((movement) => (
                  <li key={movement.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2 text-sm">
                    <span className="num text-slate-500">{movement.occurredMinute || '—'}</span>
                    <Money value={movement.amount} className="font-semibold" />
                  </li>
                ))}
              </EvidenceList>
            ) : null}

            {review.decisions.length > 0 ? (
              <EvidenceList title={t.approval.decisionLog}>
                {review.decisions.map((decision, index) => (
                  <li key={index} className="rounded-lg border border-slate-200 p-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge tone={decision.decision === 'approved' ? 'green' : decision.decision === 'rejected' ? 'red' : 'amber'}>{t.approval.decisions[decision.decision]}</Badge>
                      <span className="num text-slate-500">{formatDateTime(decision.decidedAt, lang)}</span>
                    </div>
                    {decision.notes ? <p className="mt-1 text-slate-600">{decision.notes}</p> : null}
                  </li>
                ))}
              </EvidenceList>
            ) : null}
          </details>
        </main>

        <aside className="order-1 min-w-0 xl:order-2 xl:sticky xl:top-2">
          <Card className={`ring-2 ${br1State === 'balanced' ? 'ring-emerald-300' : 'ring-amber-300'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-slate-500">{copy.settlementAndBalance}</p>
                <p className={`mt-1 text-lg font-extrabold ${br1State === 'balanced' ? 'text-emerald-700' : 'text-amber-800'}`}>
                  {br1State === 'balanced' ? t.br1.balanced : t.br1.notBalanced}
                </p>
              </div>
              <Badge tone={readyTone}>{readyLabel}</Badge>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
              <Field label={t.br1.expected} value={formatMinor(add(parseMinor(review.br1.expectedCash), parseMinor(review.br1.expectedWallet)))} />
              <Field label={t.br1.declared} value={formatMinor(add(parseMinor(review.endPackage.cashDeclared || '0'), parseMinor(review.endPackage.walletDeclared || '0')))} />
              <div className="col-span-2 flex items-baseline justify-between border-t border-slate-200 pt-2">
                <dt className={`font-bold ${differenceColour}`}>{t.br1[difference.direction]}</dt>
                <dd dir="ltr" className={`num text-2xl font-extrabold ${differenceColour}`}>{difference.amountText}</dd>
              </div>
            </dl>

            {settlement ? (
              <>
                <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-3">
                  <p className="text-sm font-extrabold text-violet-950">{t.settlement.receivableDeferralTitle}</p>
                  <p className="mt-1 text-xs text-violet-900">{t.settlement.receivableDeferralHint}</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-bold text-violet-950">
                      <span>{t.settlement.cashReceivableDeferred}</span>
                      <MoneyInput
                        value={cashReceivableDeferred}
                        min="0"
                        aria-invalid={!isNonnegativeSettlementMoney(cashReceivableDeferred)}
                        disabled={busy}
                        onChange={(event) => onCashReceivableDeferred(event.target.value)}
                        className="bg-white"
                      />
                      <span className="font-normal text-violet-800">
                        {t.settlement.receivableMaximum}: <Money value={positiveSettlementClaim(settlement.cashClaimToOffice)} />
                      </span>
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-bold text-violet-950">
                      <span>{t.settlement.walletReceivableDeferred}</span>
                      <MoneyInput
                        value={walletReceivableDeferred}
                        min="0"
                        aria-invalid={!isNonnegativeSettlementMoney(walletReceivableDeferred)}
                        disabled={busy}
                        onChange={(event) => onWalletReceivableDeferred(event.target.value)}
                        className="bg-white"
                      />
                      <span className="font-normal text-violet-800">
                        {t.settlement.receivableMaximum}: <Money value={positiveSettlementClaim(settlement.walletClaimToOffice)} />
                      </span>
                    </label>
                  </div>
                  {refreshing ? (
                    <p className="mt-2 text-xs font-semibold text-violet-800">{t.settlement.receivableRecalculating}</p>
                  ) : settlementLoadError ? (
                    <p role="alert" className="mt-2 text-xs font-semibold text-red-700">
                      {explainError(settlementLoadError, t)}
                    </p>
                  ) : null}
                </div>

                {physicalConfirmationsLocked ? (
                  <p role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-950">
                    {copy.resolveUnknownBeforeHandover.replace('{n}', String(unresolvedCount))}
                  </p>
                ) : null}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <SettlementConfirmationCard
                    label={t.settlement.walletInstruction}
                    action={t.settlement.walletAction[settlement.walletAction]}
                    amount={settlement.walletAmount}
                    confirmedLabel={t.settlement.walletConfirmed}
                    confirmed={physicalConfirmationGuard.walletTransferConfirmed}
                    disabled={busy || refreshing || physicalConfirmationsLocked}
                    tone={settlement.walletAction === 'fund' ? 'amber' : 'sky'}
                    onChange={onWalletTransferConfirmed}
                  />
                  <SettlementConfirmationCard
                    label={t.settlement.cashInstruction}
                    action={t.settlement.cashAction[settlement.cashAction]}
                    amount={settlement.cashAmount}
                    confirmedLabel={t.settlement.cashConfirmed}
                    confirmed={physicalConfirmationGuard.cashSettlementConfirmed}
                    disabled={busy || refreshing || physicalConfirmationsLocked}
                    tone={settlement.cashAction === 'pay' ? 'amber' : 'green'}
                    onChange={onCashSettlementConfirmed}
                  />
                </div>

                {settlementHasVariance(settlement) && !forcePrepared ? (
                  <label className="mt-3 flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <span className="text-sm font-bold text-amber-950">{t.settlement.varianceReason}</span>
                    <textarea value={varianceReason} onChange={(event) => onVarianceReason(event.target.value)} disabled={busy || refreshing} maxLength={500} rows={2} className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" placeholder={t.settlement.varianceReasonPlaceholder} />
                  </label>
                ) : null}

                <details className="mt-3 rounded-lg border border-slate-200 p-3">
                  <summary className={`cursor-pointer text-sm font-bold text-brand ${FOCUS_RING}`}>{copy.accountingDetails}</summary>
                  <div className="mt-2 flex flex-col gap-1">
                    {([
                      ['deliveryFeeTotal', settlement.deliveryFeeTotal],
                      ['fixedDriverShare', settlement.fixedDriverShare],
                      ['manualDriverShare', settlement.manualDriverShare],
                      ['cashDeductionTotal', settlement.cashDeductionTotal],
                      ['baseDriverShare', settlement.baseDriverShare],
                      ['expectedTotal', settlement.expectedTotal],
                      ['actualTotal', settlement.actualTotal],
                    ] as const).map(([key, value]) => (
                      <div key={key} className="flex items-baseline justify-between gap-2 border-b border-slate-100 py-1 text-xs">
                        <span className="text-slate-600">{t.settlement[key]}</span>
                        <Money value={value} className="font-semibold" />
                      </div>
                    ))}
                    <div className={`flex items-baseline justify-between gap-2 py-1 text-sm font-bold ${settlement.varianceDirection === 'shortage' ? 'text-red-700' : settlement.varianceDirection === 'surplus' ? 'text-emerald-700' : 'text-slate-700'}`}>
                      <span>{t.settlement.varianceDirection[settlement.varianceDirection]}</span>
                      <Money value={settlementVarianceMagnitude(settlement)} />
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-t border-slate-200 pt-2 font-extrabold">
                      <span>{t.settlement.finalEmployeeCash}</span>
                      <Money value={settlement.finalEmployeeCash} className={parseMinor(settlement.finalEmployeeCash) < 0n ? 'text-red-700' : 'text-brand'} />
                    </div>
                  </div>
                </details>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
                {refreshing ? copy.recalculating : settlementLoadError ? explainError(settlementLoadError, t) : error ? explainError(error, t) : t.settlement.loading}
                {settlementLoadError || error ? <Button variant="ghost" className="mt-2 w-full" onClick={onRefresh} disabled={busy}>{t.common.retry}</Button> : null}
              </div>
            )}

            {forcePrepared ? (
              <label className="mt-3 flex flex-col gap-1 rounded-lg border border-red-200 bg-red-50 p-3">
                <span className="text-sm font-bold text-red-900">{t.approval.forceReasonRequired}</span>
                <textarea value={notes} onChange={(event) => onNotes(event.target.value)} disabled={busy || refreshing} maxLength={500} rows={2} className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
              </label>
            ) : null}

            <ApprovalBlockers
              refreshing={refreshing}
              settlement={settlement}
              walletConfirmed={physicalConfirmationGuard.walletTransferConfirmed}
              cashConfirmed={physicalConfirmationGuard.cashSettlementConfirmed}
              unresolvedCount={unresolvedCount}
              managerBatteryReadingCount={managerBatteryReadingCount}
              pendingTimingDraftCount={pendingTimingDraftKeys.size}
              varianceReason={settlementDraft.varianceReason}
              forcePrepared={forcePrepared}
              copy={copy}
              operationCopy={operationCopy}
            />
            {error ? <p className="mt-2 text-sm font-medium text-red-700">{explainError(error, t)}</p> : null}

            {forcePrepared ? (
              <Button variant="danger" className="mt-3 w-full" disabled={busy || !approvalReady || notes.trim() === ''} onClick={onForceApprove}>
                {t.approval.forceApprove}
              </Button>
            ) : (
              <Button variant="success" className="mt-3 w-full" disabled={busy || !approvalReady} onClick={onApprove}>
                {t.approval.approveClose}
              </Button>
            )}

            <details className="mt-3 border-t border-slate-200 pt-3">
              <summary className={`cursor-pointer text-sm font-semibold text-slate-600 ${FOCUS_RING}`}>{copy.secondaryActions}</summary>
              {!forcePrepared ? (
                <textarea value={notes} onChange={(event) => onNotes(event.target.value)} placeholder={t.approval.notes} aria-label={t.approval.notes} rows={2} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
              ) : null}
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <Button variant="ghost" disabled={busy} onClick={() => void onRequestRephoto()}>{t.approval.requestRetake}</Button>
                <Button variant="ghost" disabled={busy} onClick={onSendBack}>{t.approval.sendBack}</Button>
              </div>
            </details>
          </Card>
        </aside>
      </div>
    </div>
  )
}

interface CloseWorkspaceCopy {
  attentionTitle: string
  attentionHint: string
  included: string
  excluded: string
  unresolved: string
  noAttention: string
  ordinaryOrders: string
  ordinaryHint: string
  addOrder: string
  evidenceTitle: string
  evidenceAnomaly: string
  settlementAndBalance: string
  accountingDetails: string
  secondaryActions: string
  ready: string
  awaitingHandover: string
  needsAttention: string
  recalculating: string
  auditReason: string
  auditReasonPlaceholder: string
  includeException: string
  markDuplicate: string
  excludeOrder: string
  saveTimingPreserve: string
  correctAndInclude: string
  excludeDeduction: string
  cashDeduction: string
  changedByManager: string
  managerBatteryRequired: string
  unsavedTimingDraft: string
  discardTimingDraft: string
  requestReread: string
  resolveUnknownBeforeHandover: string
}

function closeWorkspaceCopy(lang: 'ar' | 'en'): CloseWorkspaceCopy {
  if (lang === 'en') {
    return {
      attentionTitle: 'Needs your attention',
      attentionHint: 'Only exceptions and audited changes appear here. An accepted OCR order is not an exception.',
      included: 'Included orders',
      excluded: 'Excluded orders',
      unresolved: 'Unknown time',
      noAttention: 'No operation exceptions. The ordinary orders remain available below.',
      ordinaryOrders: 'Show {n} ordinary orders',
      ordinaryHint: 'These rows are included, inside the shift window and unchanged.',
      addOrder: 'Add a missing or manual order',
      evidenceTitle: 'Evidence and details',
      evidenceAnomaly: 'check required',
      settlementAndBalance: 'Balance and final handover',
      accountingDetails: '40% share and accounting details',
      secondaryActions: 'Return, request new evidence, or add a note',
      ready: 'Ready to close',
      awaitingHandover: 'Complete handover',
      needsAttention: 'Resolve exceptions',
      recalculating: 'Recalculating…',
      auditReason: 'Audited reason',
      auditReasonPlaceholder: 'What did you verify in the image or record?',
      includeException: 'Include exceptionally',
      markDuplicate: 'Mark as duplicate',
      excludeOrder: 'Exclude order',
      saveTimingPreserve: 'Save time and keep current decision',
      correctAndInclude: 'Correct time and include',
      excludeDeduction: 'Exclude deduction',
      cashDeduction: 'Cash deduction',
      changedByManager: 'Manager-adjusted',
      managerBatteryRequired: 'Read {n} end-of-shift battery pack(s) on a working device before approval.',
      unsavedTimingDraft: 'A copied time is not saved yet. Save the audited correction or discard it before approval.',
      discardTimingDraft: 'Discard copied time',
      requestReread: 'Request a new photo and AI reading',
      resolveUnknownBeforeHandover:
        'Resolve the {n} unknown-time operation(s) above before confirming either wallet or cash handover. Any previous confirmations have been cleared.',
    }
  }
  return {
    attentionTitle: 'يحتاج انتباهك',
    attentionHint: 'تظهر هنا الاستثناءات والتعديلات المدققة فقط. طلب OCR المقبول ليس استثناءً.',
    included: 'طلبات مشمولة',
    excluded: 'طلبات مستبعدة',
    unresolved: 'توقيت غير محسوم',
    noAttention: 'لا توجد استثناءات في العمليات. تبقى الطلبات الطبيعية متاحة أدناه.',
    ordinaryOrders: 'عرض {n} طلبات طبيعية',
    ordinaryHint: 'هذه الطلبات مشمولة وداخل نافذة النوبة ولم تُعدّل.',
    addOrder: 'إضافة طلب ناقص أو يدوي',
    evidenceTitle: 'الأدلة والتفاصيل',
    evidenceAnomaly: 'تحتاج فحصاً',
    settlementAndBalance: 'المعادلة والتسليم النهائي',
    accountingDetails: 'تفاصيل حصة 40% والمحاسبة',
    secondaryActions: 'إعادة للسائق أو طلب دليل جديد أو إضافة ملاحظة',
    ready: 'جاهزة للإغلاق',
    awaitingHandover: 'أكمل التسليم',
    needsAttention: 'احسم الاستثناءات',
    recalculating: 'جارٍ إعادة الحساب…',
    auditReason: 'السبب المدقّق',
    auditReasonPlaceholder: 'ما الذي تحققت منه في الصورة أو السجل؟',
    includeException: 'تضمين استثنائي',
    markDuplicate: 'تثبيت كتكرار',
    excludeOrder: 'استبعاد الطلب',
    saveTimingPreserve: 'حفظ الوقت مع إبقاء القرار الحالي',
    correctAndInclude: 'تصحيح الوقت وتضمين الطلب',
    excludeDeduction: 'استبعاد الحسم',
    cashDeduction: 'حسم نقدي',
    changedByManager: 'معدّل من المدير',
    managerBatteryRequired: 'اقرأ {n} بطارية من حزمة نهاية النوبة على جهاز يعمل قبل الاعتماد.',
    unsavedTimingDraft: 'الوقت المنسوخ لم يُحفظ بعد. احفظ التصحيح المدقّق أو ألغِ المسودة قبل الاعتماد.',
    discardTimingDraft: 'إلغاء الوقت المنسوخ',
    requestReread: 'طلب إعادة تصوير وقراءة AI',
    resolveUnknownBeforeHandover:
      'احسم توقيت {n} عملية أعلاه قبل تأكيد تحويل المحفظة أو معاملة الكاش. أُلغيت أي تأكيدات سابقة.',
  }
}

function OperationSummaryTile({
  label,
  count,
  total,
  tone,
}: {
  label: string
  count: number
  total: string
  tone: 'green' | 'amber' | 'slate'
}): ReactNode {
  const styles = {
    green: 'border-emerald-200 bg-emerald-50',
    amber: 'border-amber-300 bg-amber-50',
    slate: 'border-slate-200 bg-slate-50',
  }
  return (
    <div className={`min-w-0 rounded-lg border p-3 ${styles[tone]}`}>
      <p className="truncate text-xs font-semibold text-slate-600">{label}</p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="num text-xl font-extrabold">{count}</span>
        <Money value={total} className="text-sm font-semibold" />
      </div>
    </div>
  )
}

/** Copy that names the safe action precisely: the stored image is read in full, not re-shot. */
function managerEvidenceRereadCopy(lang: 'ar' | 'en') {
  if (lang === 'en') {
    return {
      action: 'Re-read the stored image with AI',
      fullImageHint: 'AI reads the complete selected image. It is not automatically linked to this order.',
      noStoredDashboard: 'No stored Recent Orders image is available, so re-reading is unavailable.',
      chooseStoredDashboard: 'Choose the stored Recent Orders image',
      results: 'Complete-image suggestions',
      noAutomaticLink: 'Compare the route, fee and printed time yourself, then apply one suggestion through the audited correction below.',
      failed: 'AI could not read this stored image',
      noRows: 'AI returned no rows from this image.',
      cancelled: 'Cancelled',
      copyToFields: 'Copy this date/time to the correction fields',
    }
  }
  return {
    action: 'إعادة قراءة الصورة المحفوظة بالذكاء الاصطناعي',
    fullImageHint: 'يقرأ الذكاء الاصطناعي الصورة المختارة كاملة، ولا يربطها بهذا الطلب تلقائياً.',
    noStoredDashboard: 'لا توجد صورة محفوظة لشاشة الطلبات الحديثة، لذلك لا يمكن تكرار القراءة.',
    chooseStoredDashboard: 'اختر صورة الطلبات الحديثة المحفوظة',
    results: 'اقتراحات قراءة الصورة كاملة',
    noAutomaticLink: 'طابق المسار والأجرة والوقت المطبوع بنفسك، ثم طبّق اقتراحاً واحداً من خلال التصحيح المدقّق أدناه.',
    failed: 'تعذّرت قراءة هذه الصورة المحفوظة',
    noRows: 'لم يُرجع الذكاء الاصطناعي أي صف من هذه الصورة.',
    cancelled: 'ملغى',
    copyToFields: 'نسخ التاريخ والوقت إلى حقول التصحيح',
  }
}

function OrderAttentionCard({
  order,
  index,
  businessDate,
  disabled,
  copy,
  operationCopy,
  onRevise,
  dashboardEvidence,
  reread,
  onReread,
  timingDraftPending,
  onTimingDraftPending,
}: {
  order: Review['orders'][number]
  index: number
  businessDate: string
  disabled: boolean
  copy: CloseWorkspaceCopy
  operationCopy: OperationReviewCopy
  onRevise(body: Record<string, unknown>): Promise<boolean>
  dashboardEvidence: Review['media']
  reread?: ManagerOrderEvidenceRereadResponse
  onReread(target: ManagerOrderEvidenceRereadTarget, slot: string, reason: string): Promise<void>
  timingDraftPending: boolean
  onTimingDraftPending(pending: boolean): void
}): ReactNode {
  const { t, lang } = useApp()
  const rereadCopy = managerEvidenceRereadCopy(lang)
  const [reason, setReason] = useState('')
  const [timingDate, setTimingDate] = useState(order.occurredDate ?? businessDate)
  const [timingMinute, setTimingMinute] = useState(order.occurredMinute ?? '')
  const [timingEditorOpen, setTimingEditorOpen] = useState(false)
  const [selectedEvidenceSlot, setSelectedEvidenceSlot] = useState(
    dashboardEvidence.length === 1 ? dashboardEvidence[0]!.slot : '',
  )
  const reasonReady = reason.trim() !== ''
  const canRereadStoredDashboard = orderHasDashboardEvidenceOrigin(order)
  const positionalBounds = positionEvidenceLabel(order.positionEvidence)
  const reviewReasons = order.closeDraftReviewReasons ?? []
  const date = order.occurredDate ?? businessDate
  const route = [
    (order.points ?? []).find((point) => point.role === 'start')?.label,
    (order.points ?? []).find((point) => point.role === 'end')?.label,
  ].filter(Boolean).join(' ← ')

  const revise = (patch: Record<string, unknown>): Promise<boolean> =>
    onRevise({ orders: [{ providerOrderNo: order.providerOrderNo, ...patch, reason: reason.trim() }] })
  useEffect(() => {
    setTimingDate(order.occurredDate ?? businessDate)
    setTimingMinute(order.occurredMinute ?? '')
  }, [businessDate, order.occurredDate, order.occurredMinute])
  useEffect(() => {
    setSelectedEvidenceSlot((current) => {
      if (dashboardEvidence.some((item) => item.slot === current)) return current
      return dashboardEvidence.length === 1 ? dashboardEvidence[0]!.slot : ''
    })
  }, [dashboardEvidence])
  const timingChanged =
    timingDate !== (order.occurredDate ?? businessDate) || timingMinute !== (order.occurredMinute ?? '')
  const timingRevision = (decision: 'preserve' | 'include' | 'duplicate'): Record<string, unknown> =>
    buildOrderTimingRevision(order.included, timingDate || null, timingMinute || null, decision)
  const updateTimingDraft = (nextDate: string, nextMinute: string): void => {
    setTimingDate(nextDate)
    setTimingMinute(nextMinute)
    setTimingEditorOpen(true)
    onTimingDraftPending(
      nextDate !== (order.occurredDate ?? businessDate) || nextMinute !== (order.occurredMinute ?? ''),
    )
  }
  const discardTimingDraft = (): void => {
    setTimingDate(order.occurredDate ?? businessDate)
    setTimingMinute(order.occurredMinute ?? '')
    setTimingEditorOpen(false)
    onTimingDraftPending(false)
  }
  const saveTimingDraft = async (decision: 'preserve' | 'include'): Promise<void> => {
    const saved = await revise(timingRevision(decision))
    if (!saved) return
    onTimingDraftPending(false)
    setTimingEditorOpen(false)
  }
  const timingEditor = (
    <div className="mt-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-500">{operationCopy.date}</span>
          <TextInput
            type="date"
            dir="ltr"
            value={timingDate}
            disabled={disabled}
            onChange={(event) => updateTimingDraft(event.target.value, timingMinute)}
            className="num w-full"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-slate-500">{operationCopy.minute}</span>
          <TextInput
            type="time"
            dir="ltr"
            value={timingMinute}
            disabled={disabled}
            onChange={(event) => updateTimingDraft(timingDate, event.target.value)}
            className="num w-full"
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={disabled || !reasonReady || !timingChanged} onClick={() => void saveTimingDraft('preserve')}>
          {copy.saveTimingPreserve}
        </Button>
        {order.included === false ? (
          <Button variant="primary" disabled={disabled || !reasonReady || !timingChanged} onClick={() => void saveTimingDraft('include')}>
            {copy.correctAndInclude}
          </Button>
        ) : null}
        {timingDraftPending ? (
          <Button variant="ghost" disabled={disabled} onClick={discardTimingDraft}>
            {copy.discardTimingDraft}
          </Button>
        ) : null}
      </div>
    </div>
  )

  return (
    <article className={`min-w-0 rounded-xl border p-3 ${reviewReasons.length > 0 || order.windowStatus === 'unknown' ? 'border-amber-300 bg-amber-50/40' : order.included === false ? 'border-slate-300 bg-slate-50' : 'border-sky-200 bg-white'}`}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <span className="num rounded bg-slate-100 px-2 py-1 text-xs font-bold">#{index}</span>
        <div className="min-w-0 flex-1">
          <p className="num text-sm font-semibold">{date} · {order.occurredMinute ?? '—'}</p>
          {route ? <p className="truncate text-xs text-slate-600" title={route}>{route}</p> : null}
        </div>
        <div className="min-w-24 text-end">
          <FeeCell
            fee={order.fee}
            editable={!disabled && reasonReady}
            onSave={async (fee) => { await onRevise({ orders: [{ providerOrderNo: order.providerOrderNo, fee, reason: reason.trim() }] }) }}
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {order.windowStatus ? <WindowStatusBadge status={order.windowStatus} copy={operationCopy} /> : null}
        {order.windowBasis === 'screen_position' ? <Badge tone="sky">{operationCopy.positionBasis}</Badge> : null}
        {order.included === false ? <Badge tone="slate">{operationCopy.excluded}</Badge> : null}
        {order.kind === 'manual' ? <Badge tone="sky">{operationCopy.manual}</Badge> : null}
        {order.feeOcr != null && order.feeOcr !== order.fee ? <Badge tone="amber">{copy.changedByManager}</Badge> : null}
        {reviewReasons.map((reviewReason) => (
          <Badge
            key={reviewReason}
            tone={reviewReason === 'missing_money' || reviewReason === 'cancelled_conflict' || reviewReason === 'evidence_removed' ? 'red' : 'amber'}
          >
            {closeDraftReviewReasonLabel(reviewReason, lang)}
          </Badge>
        ))}
      </div>
      {order.windowBasis === 'screen_position' ? (
        <p className="num mt-2 text-xs text-sky-800">
          {operationCopy.positionBasis}{positionalBounds ? ` · ${positionalBounds}` : ''}
        </p>
      ) : null}
      {order.decisionReason ? <p className="mt-2 text-xs text-slate-600">{operationCopy.decisionReason}: {order.decisionReason}</p> : null}
      {order.kind === 'manual' ? (
        <p className="num mt-2 text-xs text-slate-600">{t.orders.driverShare}: {order.driverShare ?? '—'} · {t.orders.companyShare}: {order.companyShare ?? '—'}</p>
      ) : null}
      <label className="mt-3 flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold text-slate-600">{copy.auditReason}</span>
        <TextInput value={reason} onChange={(event) => setReason(event.target.value)} disabled={disabled} maxLength={500} placeholder={copy.auditReasonPlaceholder} className="w-full" />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        {order.included === false ? <Button variant="ghost" disabled={disabled || !reasonReady} onClick={() => void revise({ included: true })}>{copy.includeException}</Button> : null}
        {order.kind === 'manual' && order.included !== false ? <Button variant="ghost" disabled={disabled || !reasonReady} onClick={() => void revise({ included: false })}>{copy.excludeOrder}</Button> : null}
        {order.kind !== 'manual' ? (
          <Button
            variant="ghost"
            disabled={disabled || !reasonReady}
            onClick={() =>
              void revise(
                buildOrderDuplicateRevision(
                  order.occurredDate ?? businessDate,
                  order.occurredMinute ?? null,
                  timingDate || null,
                  timingMinute || null,
                ),
              )
            }
          >
            {copy.markDuplicate}
          </Button>
        ) : null}
        {canRereadStoredDashboard ? (
          <Button
            variant="ghost"
            disabled={disabled || !reasonReady || selectedEvidenceSlot === ''}
            onClick={() =>
              void onReread(
                { kind: 'order', providerOrderNo: order.providerOrderNo },
                selectedEvidenceSlot,
                reason.trim(),
              )
            }
          >
            {rereadCopy.action}
          </Button>
        ) : null}
      </div>
      {canRereadStoredDashboard ? (
        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs">
          <p className="font-semibold text-sky-900">{rereadCopy.fullImageHint}</p>
          {dashboardEvidence.length === 0 ? (
            <p className="mt-1 font-medium text-amber-800">{rereadCopy.noStoredDashboard}</p>
          ) : dashboardEvidence.length === 1 ? (
            <p className="num mt-1 text-slate-600">
              {slotLabel(dashboardEvidence[0]!.slot, t.shift.slotNames, lang)}
            </p>
          ) : (
            <label className="mt-2 flex min-w-0 flex-col gap-1">
              <span className="font-semibold text-slate-600">{rereadCopy.chooseStoredDashboard}</span>
              <Select
                value={selectedEvidenceSlot}
                disabled={disabled}
                onChange={(event) => setSelectedEvidenceSlot(event.target.value)}
                className="w-full"
              >
                <option value="">{rereadCopy.chooseStoredDashboard}</option>
                {dashboardEvidence.map((item) => (
                  <option key={`${item.slot}:${item.mediaId}`} value={item.slot}>
                    {slotLabel(item.slot, t.shift.slotNames, lang)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {reread ? (
            <div className="mt-2 border-t border-sky-200 pt-2">
              <p className="font-bold text-sky-900">
                {rereadCopy.results} · {slotLabel(reread.evidence.slot, t.shift.slotNames, lang)}
              </p>
              <p className="mt-1 text-slate-600">{rereadCopy.noAutomaticLink}</p>
              {!reread.ok ? (
                <p className="mt-2 font-semibold text-red-700">
                  {rereadCopy.failed}: {reread.reason ?? 'unavailable'}
                </p>
              ) : reread.rows.length === 0 ? (
                <p className="mt-2 text-slate-600">{rereadCopy.noRows}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {reread.rows.map((row, rowIndex) => {
                    const rereadRoute = [row.pointA, row.pointB].filter(Boolean).join(' → ')
                    return (
                      <li key={`${rowIndex}:${row.value ?? ''}:${row.time ?? ''}`} className="rounded-md bg-white p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="num font-bold">
                            #{rowIndex + 1} · {row.value ?? '—'} · {row.dateIso ?? '—'} {row.time ?? '—'}
                          </span>
                          {row.cancelled ? <Badge tone="red">{rereadCopy.cancelled}</Badge> : null}
                        </div>
                        {rereadRoute ? <p className="mt-1 text-slate-600">{rereadRoute}</p> : null}
                        {!row.cancelled && (row.time !== null || row.dateIso !== null) ? (
                          <Button
                            variant="ghost"
                            className="mt-2 min-h-8 px-2 text-xs"
                            disabled={disabled}
                            onClick={() => {
                              updateTimingDraft(
                                row.dateIso ?? timingDate,
                                row.time ?? timingMinute,
                              )
                            }}
                          >
                            {rereadCopy.copyToFields}
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {order.kind !== 'manual' ? (
        timingDraftPending ? (
          <section className="mt-2 rounded-lg border-2 border-amber-300 bg-amber-50 p-2 text-xs">
            <p className="font-bold text-amber-900">{copy.unsavedTimingDraft}</p>
            {timingEditor}
          </section>
        ) : (
          <details
            open={timingEditorOpen}
            onToggle={(event) => setTimingEditorOpen(event.currentTarget.open)}
            className="mt-2 text-xs"
          >
            <summary className={`cursor-pointer text-brand ${FOCUS_RING}`}>{operationCopy.correctTiming}</summary>
            {timingEditor}
          </details>
        )
      ) : null}
    </article>
  )
}

function DeductionAttentionCard({
  deduction,
  disabled,
  copy,
  operationCopy,
  onRevise,
  dashboardEvidence,
  reread,
  onReread,
  timingDraftPending,
  onTimingDraftPending,
}: {
  deduction: NonNullable<Review['cashDeductions']>[number]
  disabled: boolean
  copy: CloseWorkspaceCopy
  operationCopy: OperationReviewCopy
  onRevise(body: Record<string, unknown>): Promise<boolean>
  dashboardEvidence: Review['media']
  reread?: ManagerOrderEvidenceRereadResponse
  onReread(target: ManagerOrderEvidenceRereadTarget, slot: string, reason: string): Promise<void>
  timingDraftPending: boolean
  onTimingDraftPending(pending: boolean): void
}): ReactNode {
  const { t, lang } = useApp()
  const rereadCopy = managerEvidenceRereadCopy(lang)
  const [reason, setReason] = useState('')
  const [selectedEvidenceSlot, setSelectedEvidenceSlot] = useState(
    dashboardEvidence.length === 1 ? dashboardEvidence[0]!.slot : '',
  )
  const [timingSuggestion, setTimingSuggestion] = useState<{
    key: string
    date: string | null
    minute: string | null
  } | null>(null)
  const reasonReady = reason.trim() !== ''
  const canRereadStoredDashboard = deductionHasDashboardEvidenceOrigin(deduction)
  const positionalBounds = positionEvidenceLabel(deduction.positionEvidence)
  const reviewReasons = deduction.closeDraftReviewReasons ?? []
  const revise = (patch: Record<string, unknown>): Promise<boolean> =>
    onRevise({ cashDeductions: [{ id: deduction.id, ...patch, reason: reason.trim() }] })
  useEffect(() => {
    setSelectedEvidenceSlot((current) => {
      if (dashboardEvidence.some((item) => item.slot === current)) return current
      return dashboardEvidence.length === 1 ? dashboardEvidence[0]!.slot : ''
    })
  }, [dashboardEvidence])

  return (
    <article className="min-w-0 rounded-xl border border-red-200 bg-red-50/40 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-red-800">{copy.cashDeduction}</p>
          <p className="num text-xs text-slate-600">{deduction.occurredDate ?? '—'} · {deduction.occurredMinute ?? '—'}</p>
          <p className="truncate text-xs text-slate-600">{[deduction.pointA, deduction.pointB].filter(Boolean).join(' ← ') || '—'}</p>
        </div>
        <span dir="ltr" className="num text-lg font-extrabold text-red-700">−<Money value={deduction.amount} /></span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <WindowStatusBadge status={deduction.windowStatus} copy={operationCopy} />
        {deduction.windowBasis === 'screen_position' ? <Badge tone="sky">{operationCopy.positionBasis}</Badge> : null}
        {!deduction.included ? <Badge tone="slate">{operationCopy.excluded}</Badge> : null}
        {reviewReasons.map((reviewReason) => (
          <Badge
            key={reviewReason}
            tone={reviewReason === 'missing_money' || reviewReason === 'cancelled_conflict' || reviewReason === 'evidence_removed' ? 'red' : 'amber'}
          >
            {closeDraftReviewReasonLabel(reviewReason, lang)}
          </Badge>
        ))}
      </div>
      {deduction.windowBasis === 'screen_position' ? (
        <p className="num mt-2 text-xs text-sky-800">
          {operationCopy.positionBasis}{positionalBounds ? ` · ${positionalBounds}` : ''}
        </p>
      ) : null}
      {deduction.decisionReason ? <p className="mt-2 text-xs text-slate-600">{operationCopy.decisionReason}: {deduction.decisionReason}</p> : null}
      <label className="mt-3 flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold text-slate-600">{copy.auditReason}</span>
        <TextInput value={reason} onChange={(event) => setReason(event.target.value)} disabled={disabled} maxLength={500} placeholder={copy.auditReasonPlaceholder} className="w-full" />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={disabled || !reasonReady} onClick={() => void revise({ included: !deduction.included })}>
          {deduction.included ? copy.excludeDeduction : copy.includeException}
        </Button>
        {canRereadStoredDashboard ? (
          <Button
            variant="ghost"
            disabled={disabled || !reasonReady || selectedEvidenceSlot === ''}
            onClick={() =>
              void onReread(
                { kind: 'cash_deduction', id: deduction.id, operationKey: deduction.operationKey },
                selectedEvidenceSlot,
                reason.trim(),
              )
            }
          >
            {rereadCopy.action}
          </Button>
        ) : null}
      </div>
      {canRereadStoredDashboard ? (
        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs">
          <p className="font-semibold text-sky-900">{rereadCopy.fullImageHint}</p>
          {dashboardEvidence.length === 0 ? (
            <p className="mt-1 font-medium text-amber-800">{rereadCopy.noStoredDashboard}</p>
          ) : dashboardEvidence.length === 1 ? (
            <p className="num mt-1 text-slate-600">
              {slotLabel(dashboardEvidence[0]!.slot, t.shift.slotNames, lang)}
            </p>
          ) : (
            <label className="mt-2 flex min-w-0 flex-col gap-1">
              <span className="font-semibold text-slate-600">{rereadCopy.chooseStoredDashboard}</span>
              <Select
                value={selectedEvidenceSlot}
                disabled={disabled}
                onChange={(event) => setSelectedEvidenceSlot(event.target.value)}
                className="w-full"
              >
                <option value="">{rereadCopy.chooseStoredDashboard}</option>
                {dashboardEvidence.map((item) => (
                  <option key={`${item.slot}:${item.mediaId}`} value={item.slot}>
                    {slotLabel(item.slot, t.shift.slotNames, lang)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {reread ? (
            <div className="mt-2 border-t border-sky-200 pt-2">
              <p className="font-bold text-sky-900">
                {rereadCopy.results} · {slotLabel(reread.evidence.slot, t.shift.slotNames, lang)}
              </p>
              <p className="mt-1 text-slate-600">{rereadCopy.noAutomaticLink}</p>
              {!reread.ok ? (
                <p className="mt-2 font-semibold text-red-700">
                  {rereadCopy.failed}: {reread.reason ?? 'unavailable'}
                </p>
              ) : reread.rows.length === 0 ? (
                <p className="mt-2 text-slate-600">{rereadCopy.noRows}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {reread.rows.map((row, rowIndex) => {
                    const suggestionKey = `${rowIndex}:${row.value ?? ''}:${row.dateIso ?? ''}:${row.time ?? ''}`
                    return (
                      <li key={suggestionKey} className="rounded-md bg-white p-2">
                        <p className="num font-bold">
                          #{rowIndex + 1} · {row.value ?? '—'} · {row.dateIso ?? '—'} {row.time ?? '—'}
                        </p>
                        {[row.pointA, row.pointB].filter(Boolean).length > 0 ? (
                          <p className="mt-1 text-slate-600">{[row.pointA, row.pointB].filter(Boolean).join(' → ')}</p>
                        ) : null}
                        {!row.cancelled && (row.time !== null || row.dateIso !== null) ? (
                          <Button
                            variant="ghost"
                            className="mt-2 min-h-8 px-2 text-xs"
                            disabled={disabled}
                            onClick={() => setTimingSuggestion({
                              key: suggestionKey,
                              date: row.dateIso,
                              minute: row.time,
                            })}
                          >
                            {rereadCopy.copyToFields}
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <WindowCorrection
        occurredDate={deduction.occurredDate}
        occurredMinute={deduction.occurredMinute}
        disabled={disabled}
        reasonRequired={!reasonReady}
        copy={operationCopy}
        draftPending={timingDraftPending}
        unsavedLabel={copy.unsavedTimingDraft}
        discardLabel={copy.discardTimingDraft}
        onDraftPending={onTimingDraftPending}
        onDiscard={() => setTimingSuggestion(null)}
        {...(timingSuggestion ? { suggestion: timingSuggestion } : {})}
        onSave={async (occurredDate, occurredMinute) => {
          const saved = await revise({ occurredDate, occurredMinute, included: deduction.included })
          if (saved) setTimingSuggestion(null)
          return saved
        }}
      />
    </article>
  )
}

function OrdinaryOrderRow({ order, businessDate }: { order: Review['orders'][number]; businessDate: string }): ReactNode {
  const route = [
    (order.points ?? []).find((point) => point.role === 'start')?.label,
    (order.points ?? []).find((point) => point.role === 'end')?.label,
  ].filter(Boolean).join(' ← ')
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="num font-semibold">{order.occurredDate ?? businessDate} · {order.occurredMinute ?? '—'}</p>
        {route ? <p className="truncate text-xs text-slate-500" title={route}>{route}</p> : null}
      </div>
      <Money value={order.fee} className="shrink-0 font-bold" />
    </li>
  )
}

function SettlementConfirmationCard({
  label,
  action,
  amount,
  confirmedLabel,
  confirmed,
  disabled,
  tone,
  onChange,
}: {
  label: string
  action: string
  amount: string
  confirmedLabel: string
  confirmed: boolean
  disabled: boolean
  tone: 'sky' | 'green' | 'amber'
  onChange(value: boolean): void
}): ReactNode {
  const styles = {
    sky: 'border-sky-300 bg-sky-50',
    green: 'border-emerald-300 bg-emerald-50',
    amber: 'border-amber-300 bg-amber-50',
  }
  return (
    <div className={`min-w-0 rounded-xl border-2 p-3 ${styles[tone]} ${confirmed ? 'ring-2 ring-emerald-400' : ''}`}>
      <p className="text-xs font-bold text-slate-600">{label}</p>
      <p className="mt-1 text-sm font-extrabold text-slate-900">{action}</p>
      <Money value={amount} className="mt-1 block text-2xl font-extrabold text-brand" />
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 border-t border-slate-900/10 pt-2 text-xs font-bold">
        <input type="checkbox" checked={confirmed} onChange={(event) => onChange(event.target.checked)} disabled={disabled} className="size-5 shrink-0 accent-emerald-600" />
        <span>{confirmedLabel}</span>
      </label>
    </div>
  )
}

function ApprovalBlockers({
  refreshing,
  settlement,
  walletConfirmed,
  cashConfirmed,
  unresolvedCount,
  managerBatteryReadingCount,
  pendingTimingDraftCount,
  varianceReason,
  forcePrepared,
  copy,
  operationCopy,
}: {
  refreshing: boolean
  settlement: SettlementView | null
  walletConfirmed: boolean
  cashConfirmed: boolean
  unresolvedCount: number
  managerBatteryReadingCount: number
  pendingTimingDraftCount: number
  varianceReason: string
  forcePrepared: boolean
  copy: CloseWorkspaceCopy
  operationCopy: OperationReviewCopy
}): ReactNode {
  const { t } = useApp()
  const blockers: string[] = []
  if (refreshing) blockers.push(copy.recalculating)
  else if (!settlement) blockers.push(t.settlement.unavailable)
  if (settlement && (!walletConfirmed || !cashConfirmed)) blockers.push(t.settlement.confirmBeforeApproval)
  if (unresolvedCount > 0) blockers.push(operationCopy.cannotApproveUnknown.replace('{n}', String(unresolvedCount)))
  if (pendingTimingDraftCount > 0) blockers.push(copy.unsavedTimingDraft)
  if (managerBatteryReadingCount > 0) {
    blockers.push(copy.managerBatteryRequired.replace('{n}', String(managerBatteryReadingCount)))
  }
  if (forcePrepared && varianceReason.trim() === '') blockers.push(t.approval.forceReasonRequired)
  if (blockers.length === 0) return null
  return (
    <ul className="mt-3 flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900">
      {blockers.map((blocker, index) => <li key={index}>• {blocker}</li>)}
    </ul>
  )
}

function EvidenceList({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <section className="mt-4 min-w-0 border-t border-slate-200 pt-3">
      <h3 className="text-sm font-bold text-slate-700">{title}</h3>
      {hint ? <p className="mt-1 text-xs text-slate-600">{hint}</p> : null}
      <ul className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">{children}</ul>
    </section>
  )
}

interface OperationReviewCopy {
  windowTitle: string
  windowHint: string
  opened: string
  submitted: string
  notSubmitted: string
  unresolved: string
  managerReason: string
  reasonPlaceholder: string
  reasonRequired: string
  cashDeductions: string
  cashDeductionHint: string
  paymentsLogArchiveHint: string
  included: string
  excluded: string
  time: string
  date: string
  minute: string
  route: string
  amount: string
  source: string
  manual: string
  windowStatus: string
  decisionReason: string
  positionBasis: string
  correctTiming: string
  saveTiming: string
  manualOutsideWindow: string
  cannotApproveUnknown: string
  statuses: Record<OperationWindowStatus, string>
}

function operationReviewCopy(lang: 'ar' | 'en'): OperationReviewCopy {
  if (lang === 'en') {
    return {
      windowTitle: 'Operations window',
      windowHint:
        'All provider operations from open approval through close submission are included, including after midnight. Boundary-minute rows count; an unknown time needs a manager decision.',
      opened: 'Open approved',
      submitted: 'Close submitted',
      notSubmitted: 'Shift is still running',
      unresolved: '{n} operation(s) still need a window decision.',
      managerReason: 'Reason for inclusion, exclusion, or time correction',
      reasonPlaceholder: 'State what you verified before changing an operation',
      reasonRequired: 'Enter the audited reason above first',
      cashDeductions: 'Cash deductions',
      cashDeductionHint:
        'These are not orders or wallet movements. Each included amount reduces expected cash and the driver’s share.',
      paymentsLogArchiveHint:
        'Optional archive only. These rows do not change orders, BR1, the 40% employee share or ledger postings.',
      included: 'Included',
      excluded: 'Excluded',
      time: 'Date / time',
      date: 'Date',
      minute: 'Time',
      route: 'Route',
      amount: 'Amount',
      source: 'Source',
      manual: 'Manual',
      windowStatus: 'Window status',
      decisionReason: 'Manager reason',
      positionBasis: 'Inside shift by screen order',
      correctTiming: 'Correct date / time',
      saveTiming: 'Save timing',
      manualOutsideWindow: 'Manager-entered · outside auto-classification',
      cannotApproveUnknown: 'Approval is blocked: resolve {n} operation time(s).',
      statuses: {
        in_window: 'Inside window',
        pre_open: 'Before open',
        post_close: 'After submission',
        open_minute_boundary: 'Open minute · included',
        close_minute_boundary: 'Submission minute · included',
        unknown: 'Needs manager review',
      },
    }
  }
  return {
    windowTitle: 'نافذة عمليات النوبة',
    windowHint:
      'تُشمل جميع عمليات المزود من لحظة اعتماد الفتح حتى تسليم الإغلاق، بما فيها ما بعد منتصف الليل. دقيقة الحد محسوبة، أما التوقيت المجهول فيحتاج قرار المدير.',
    opened: 'اعتماد الفتح',
    submitted: 'تسليم الإغلاق',
    notSubmitted: 'النوبة ما زالت جارية',
    unresolved: 'ما زالت {n} عملية بحاجة إلى حسم توقيتها.',
    managerReason: 'سبب التضمين أو الاستبعاد أو تصحيح التوقيت',
    reasonPlaceholder: 'اكتب ما تحققت منه قبل تعديل العملية',
    reasonRequired: 'أدخل السبب المدقّق أعلاه أولاً',
    cashDeductions: 'الحسومات النقدية',
    cashDeductionHint: 'ليست طلبات ولا حركات محفظة. كل حسم مشمول ينقص الكاش المتوقع وحصة السائق.',
    paymentsLogArchiveHint:
      'أرشيف اختياري فقط. هذه الصفوف لا تغيّر الطلبات أو BR1 أو حصة الموظف الثابتة 40% أو الدفتر.',
    included: 'مشمول',
    excluded: 'مستبعد',
    time: 'التاريخ / الوقت',
    date: 'التاريخ',
    minute: 'الوقت',
    route: 'المسار',
    amount: 'المبلغ',
    source: 'المصدر',
    manual: 'يدوي',
    windowStatus: 'حالة النافذة',
    decisionReason: 'سبب المدير',
    positionBasis: 'ضمن النوبة حسب ترتيب الشاشة',
    correctTiming: 'تصحيح التاريخ / الوقت',
    saveTiming: 'حفظ التوقيت',
    manualOutsideWindow: 'طلب مدير · خارج التصنيف الآلي',
    cannotApproveUnknown: 'الاعتماد متوقف: يجب حسم توقيت {n} عملية.',
    statuses: {
      in_window: 'داخل النافذة',
      pre_open: 'قبل الفتح',
      post_close: 'بعد التسليم',
      open_minute_boundary: 'دقيقة الفتح · مشمولة',
      close_minute_boundary: 'دقيقة التسليم · مشمولة',
      unknown: 'بحاجة لمراجعة المدير',
    },
  }
}

function OperationWindowAdvisory({
  openApprovedAt,
  submittedAt,
  unresolvedCount,
  reason,
  onReasonChange,
  editable,
  lang,
  copy,
}: {
  openApprovedAt: string | null
  submittedAt: string | null
  unresolvedCount: number
  reason: string
  onReasonChange(value: string): void
  editable: boolean
  lang: 'ar' | 'en'
  copy: OperationReviewCopy
}): ReactNode {
  return (
    <Card title={copy.windowTitle}>
      <aside role="note" className="rounded-lg border border-sky-200 bg-sky-50 p-3">
        <p className="text-sm text-sky-950">{copy.windowHint}</p>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Field label={copy.opened} value={openApprovedAt ? formatDateTime(openApprovedAt, lang) : '—'} />
          <Field
            label={copy.submitted}
            value={submittedAt ? formatDateTime(submittedAt, lang) : copy.notSubmitted}
          />
        </dl>
        {unresolvedCount > 0 ? (
          <p className="mt-2 font-semibold text-amber-800">{copy.unresolved.replace('{n}', String(unresolvedCount))}</p>
        ) : null}
      </aside>
      {editable ? (
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-xs font-semibold text-slate-600">{copy.managerReason}</span>
          <TextInput
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder={copy.reasonPlaceholder}
            maxLength={500}
          />
          {reason.trim() === '' ? <span className="text-xs text-amber-700">{copy.reasonRequired}</span> : null}
        </label>
      ) : null}
    </Card>
  )
}

function WindowStatusBadge({ status, copy }: { status: OperationWindowStatus; copy: OperationReviewCopy }): ReactNode {
  const tone =
    status === 'in_window'
      ? 'green'
      : status === 'pre_open' || status === 'post_close'
        ? 'red'
        : 'amber'
  return <Badge tone={tone}>{copy.statuses[status]}</Badge>
}

function WindowCorrection({
  occurredDate,
  occurredMinute,
  disabled,
  reasonRequired,
  copy,
  suggestion,
  draftPending = false,
  unsavedLabel = '',
  discardLabel = '',
  onDraftPending = () => undefined,
  onDiscard = () => undefined,
  onSave,
}: {
  occurredDate: string | null
  occurredMinute: string | null
  disabled: boolean
  reasonRequired: boolean
  copy: OperationReviewCopy
  suggestion?: { key: string; date: string | null; minute: string | null }
  draftPending?: boolean
  unsavedLabel?: string
  discardLabel?: string
  onDraftPending?(pending: boolean): void
  onDiscard?(): void
  onSave(date: string | null, minute: string | null): Promise<boolean | void>
}): ReactNode {
  const [date, setDate] = useState(occurredDate ?? '')
  const [minute, setMinute] = useState(occurredMinute ?? '')
  const [editorOpen, setEditorOpen] = useState(false)
  useEffect(() => {
    setDate(occurredDate ?? '')
    setMinute(occurredMinute ?? '')
  }, [occurredDate, occurredMinute])
  useEffect(() => {
    if (!suggestion) return
    const nextDate = suggestion.date ?? date
    const nextMinute = suggestion.minute ?? minute
    setDate(nextDate)
    setMinute(nextMinute)
    setEditorOpen(true)
    onDraftPending(nextDate !== (occurredDate ?? '') || nextMinute !== (occurredMinute ?? ''))
    // The suggestion key is the explicit manager selection. Current draft values are intentionally
    // omitted so editing the opened form does not re-apply the AI proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion])

  const changed = date !== (occurredDate ?? '') || minute !== (occurredMinute ?? '')
  const updateDraft = (nextDate: string, nextMinute: string): void => {
    setDate(nextDate)
    setMinute(nextMinute)
    setEditorOpen(true)
    onDraftPending(nextDate !== (occurredDate ?? '') || nextMinute !== (occurredMinute ?? ''))
  }
  const discard = (): void => {
    setDate(occurredDate ?? '')
    setMinute(occurredMinute ?? '')
    setEditorOpen(false)
    onDraftPending(false)
    onDiscard()
  }
  const save = async (): Promise<void> => {
    const saved = await onSave(date || null, minute || null)
    if (saved === false) return
    onDraftPending(false)
    setEditorOpen(false)
  }
  const editor = (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-slate-500">{copy.date}</span>
        <TextInput
          type="date"
          dir="ltr"
          value={date}
          disabled={disabled || reasonRequired}
          onChange={(event) => updateDraft(event.target.value, minute)}
          className="num w-40"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-slate-500">{copy.minute}</span>
        <TextInput
          type="time"
          dir="ltr"
          value={minute}
          disabled={disabled || reasonRequired}
          onChange={(event) => updateDraft(date, event.target.value)}
          className="num w-28"
        />
      </label>
      <Button
        variant="ghost"
        disabled={disabled || reasonRequired || !changed}
        title={reasonRequired ? copy.reasonRequired : undefined}
        onClick={() => void save()}
      >
        {copy.saveTiming}
      </Button>
      {draftPending ? (
        <Button variant="ghost" disabled={disabled} onClick={discard}>
          {discardLabel}
        </Button>
      ) : null}
    </div>
  )
  return (
    draftPending ? (
      <section className="mt-2 rounded-lg border-2 border-amber-300 bg-amber-50 p-2 text-xs">
        <p className="font-bold text-amber-900">{unsavedLabel}</p>
        {editor}
      </section>
    ) : (
      <details
        open={editorOpen}
        onToggle={(event) => setEditorOpen(event.currentTarget.open)}
        className="mt-2 text-xs"
      >
        <summary className={`cursor-pointer text-brand ${FOCUS_RING}`}>{copy.correctTiming}</summary>
        {editor}
      </details>
    )
  )
}

/**
 * Correct a closing figure the driver's screenshots could not give us.
 *
 * The close is read off the phone rather than typed, so a reader that misses used to leave the
 * manager with two blunt instruments and nothing in between: bounce the whole shift back to the
 * driver, or force-close it — which bypasses BR1 altogether. Neither is the right answer to one
 * wrong odometer. Saving here re-runs the equation and leaves the shift under review, so the close
 * gate still has to pass on its own merits afterwards.
 */
function ReviseFigures({
  shiftId,
  review,
  onRevised,
}: {
  shiftId: string
  review: {
    startPackage: { odometerKm: number | null }
    endPackage: { odometerKm: number | null; cashDeclared: string | null; walletDeclared: string | null }
  }
  onRevised(): void
}): ReactNode {
  const { api, t } = useApp()
  const [open, setOpen] = useState(false)
  const [odo, setOdo] = useState(String(review.endPackage.odometerKm ?? ''))
  const [cash, setCash] = useState(review.endPackage.cashDeclared ?? '')
  const [wallet, setWallet] = useState(review.endPackage.walletDeclared ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <div className="mt-2">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {t.approval.reviseFigures}
        </Button>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const odometerKm = odo.trim() === '' ? null : Number(odo)
      const anomalous =
        odometerKm !== null &&
        Number.isFinite(odometerKm) &&
        review.startPackage.odometerKm !== null &&
        odometerKm < review.startPackage.odometerKm
      if (anomalous && !window.confirm(t.approval.odometerAnomalyConfirm)) return
      await api.post(`/shifts/${shiftId}/close-figures`, {
        odometerKm,
        odometerAnomalyConfirmed: anomalous,
        cashDeclared: cash.trim() === '' ? null : cash,
        walletDeclared: wallet.trim() === '' ? null : wallet,
      })
      setOpen(false)
      onRevised()
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 pt-2">
      <p className="text-xs text-slate-500">{t.approval.reviseHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          inputMode="numeric"
          aria-label={t.shift.odometer}
          placeholder={t.shift.odometer}
          value={odo}
          onChange={(e) => setOdo(e.target.value)}
          className="w-28"
        />
        <MoneyInput
          aria-label={t.shift.cashHandover}
          placeholder={t.shift.cashHandover}
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          className="w-32"
        />
        <MoneyInput
          aria-label={t.shift.walletBalance}
          placeholder={t.shift.walletBalance}
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          className="w-32"
        />
      </div>
      {error ? <p className="text-sm font-medium text-red-600">{explainError(error, t)}</p> : null}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? t.common.loading : t.common.save}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </div>
  )
}

interface PointDraft {
  role: 'start' | 'stop' | 'end'
  label: string
  lat: number | null
  lng: number | null
}

/**
 * Add an order to a shift, of either kind.
 *
 * A YALLAGO order is a reconciliation — the «missing order» BR1 ranked — and needs only its number,
 * pay mode and fee; its employee share is the fixed 40%, computed at approval.
 *
 * A MANUAL order is the branch's own job. Yallago takes nothing from it, so the fee is divided
 * between the driver and the company by agreement, and BOTH shares are typed. They must add up to
 * the fee exactly: the server refuses anything else, because the approval posting has to exhaust
 * the fee and a one-unit disagreement would fail the close in front of a manager with no way out.
 * The form therefore does that arithmetic in front of him — type the driver's share and the
 * company's is what remains — and says so if it does not add up.
 *
 * Adding either kind changes the orders hash, so a manager who was mid-review must look again
 * before he can approve.
 */
function AddOrderForm({ shiftId, onAdded }: { shiftId: string; onAdded(): void }): ReactNode {
  const { api, t } = useApp()
  const [kind, setKind] = useState<'yallago' | 'manual'>('yallago')
  const [orderNo, setOrderNo] = useState('')
  const [payMode, setPayMode] = useState('cash')
  const [fee, setFee] = useState('')
  const [driverShare, setDriverShare] = useState('')
  const [notes, setNotes] = useState('')
  const [points, setPoints] = useState<PointDraft[]>([
    { role: 'start', label: '', lat: null, lng: null },
    { role: 'end', label: '', lat: null, lng: null },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The company takes what the driver does not. Money is decimal strings on the wire, so this is
  // done in minor units and formatted back — never with a float.
  const companyShare = ((): string | null => {
    if (fee.trim() === '' || driverShare.trim() === '') return null
    try {
      const rest = sub(parseMinor(fee), parseMinor(driverShare))
      return rest < 0n ? null : formatMinor(rest)
    } catch {
      return null
    }
  })()

  const isManual = kind === 'manual'
  const routeComplete = points.every((p) => p.label.trim() !== '')
  const ready =
    orderNo.trim() !== '' &&
    fee.trim() !== '' &&
    (!isManual || (driverShare.trim() !== '' && companyShare !== null && routeComplete))

  const setPoint = (i: number, patch: Partial<PointDraft>): void =>
    setPoints((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.addManualOrder(shiftId, {
        providerOrderNo: orderNo.trim(),
        payMode,
        fee,
        zone: null,
        kind,
        ...(isManual
          ? {
              driverShare,
              companyShare,
              notes: notes.trim() === '' ? null : notes.trim(),
              points: points.map((p) => ({ role: p.role, label: p.label.trim(), lat: p.lat, lng: p.lng })),
            }
          : {}),
      })
      setOrderNo('')
      setFee('')
      setDriverShare('')
      setNotes('')
      setPoints([
        { role: 'start', label: '', lat: null, lng: null },
        { role: 'end', label: '', lat: null, lng: null },
      ])
      onAdded()
    } catch (err) {
      setError((err as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t.orders.kind} value={kind} onChange={(e) => setKind(e.target.value as 'yallago' | 'manual')}>
          <option value="yallago">{t.orders.kinds.yallago}</option>
          <option value="manual">{t.orders.kinds.manual}</option>
        </Select>
        <TextInput
          placeholder={t.orders.orderNo}
          aria-label={t.orders.orderNo}
          value={orderNo}
          onChange={(e) => setOrderNo(e.target.value)}
          className="w-32"
        />
        <Select aria-label={t.orders.payMode} value={payMode} onChange={(e) => setPayMode(e.target.value)}>
          {(['cash', 'electronic', 'free'] as const).map((m) => (
            <option key={m} value={m}>
              {t.orders.payModes[m]}
            </option>
          ))}
        </Select>
        <MoneyInput
          placeholder={t.orders.fee}
          aria-label={t.orders.fee}
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          className="w-28"
        />
      </div>

      {isManual ? (
        <>
          {/* The two shares. Yallago has no claim on this job, so the fee divides in two. */}
          <div className="flex flex-wrap items-center gap-2">
            <MoneyInput
              placeholder={t.orders.driverShare}
              aria-label={t.orders.driverShare}
              value={driverShare}
              onChange={(e) => setDriverShare(e.target.value)}
              className="w-32"
            />
            <span className="text-sm text-slate-500">
              {t.orders.companyShare}: <span className="num">{companyShare ?? '—'}</span>
            </span>
            {fee.trim() !== '' && driverShare.trim() !== '' && companyShare === null ? (
              <span className="text-sm font-medium text-red-600">{t.orders.sharesMismatch}</span>
            ) : null}
          </div>

          {/* Where it went. The written place is what people actually say; the pin is optional. */}
          <div className="flex flex-col gap-2">
            {points.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-xs text-slate-500">{t.orders.pointRoles[p.role]}</span>
                <TextInput
                  placeholder={t.orders.pointLabel}
                  aria-label={`${t.orders.pointRoles[p.role]} — ${t.orders.pointLabel}`}
                  value={p.label}
                  onChange={(e) => setPoint(i, { label: e.target.value })}
                  className="min-w-48 flex-1"
                />
                <MapPin
                  lat={p.lat}
                  lng={p.lng}
                  onPick={(lat, lng) => setPoint(i, { lat, lng })}
                  onClear={() => setPoint(i, { lat: null, lng: null })}
                />
                {p.role === 'stop' ? (
                  <Button variant="ghost" onClick={() => setPoints((cur) => cur.filter((_, j) => j !== i))}>
                    ×
                  </Button>
                ) : null}
              </div>
            ))}
            <div>
              <Button
                variant="ghost"
                onClick={() =>
                  // A stop always goes BEFORE the end, so the route reads start → stops → end.
                  setPoints((cur) => [...cur.slice(0, -1), { role: 'stop', label: '', lat: null, lng: null }, cur[cur.length - 1]!])
                }
              >
                {t.orders.addStop}
              </Button>
            </div>
          </div>

          <TextInput
            placeholder={t.orders.notes}
            aria-label={t.orders.notes}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </>
      ) : null}

      {error ? <p className="text-sm font-medium text-red-600">{explainError(error, t)}</p> : null}
      <div>
        <Button variant="ghost" disabled={busy || !ready} onClick={submit}>
          {isManual ? t.orders.addManualJob : t.orders.addManual}
        </Button>
      </div>
    </div>
  )
}

/**
 * An optional pin for one point.
 *
 * Most jobs are described by name — «مطعم الشام، شارع بغداد» — and forcing a map on every one would
 * slow the manager down for nothing. So the map opens only when he wants it, and closes as soon as
 * he has clicked. Leaflet is already a dependency here (the live map); `circleMarker` avoids the
 * marker-image problem that bites every bundled Leaflet build.
 */
function MapPin({
  lat,
  lng,
  onPick,
  onClear,
}: {
  lat: number | null
  lng: number | null
  onPick(lat: number, lng: number): void
  onClear(): void
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement | null>(null)
  const map = useRef<LeafletMap | null>(null)
  const marker = useRef<CircleMarker | null>(null)

  useEffect(() => {
    if (!open || !host.current || map.current) return
    const m = L.map(host.current).setView([lat ?? DAMASCUS[0], lng ?? DAMASCUS[1]], lat === null ? 12 : 16)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m)
    if (lat !== null && lng !== null) {
      marker.current = L.circleMarker([lat, lng], { radius: 8, color: '#1e3a8a', fillOpacity: 0.9 }).addTo(m)
    }
    m.on('click', (e: LeafletMouseEvent) => {
      const { lat: y, lng: x } = e.latlng
      marker.current?.remove()
      marker.current = L.circleMarker([y, x], { radius: 8, color: '#1e3a8a', fillOpacity: 0.9 }).addTo(m)
      onPick(Number(y.toFixed(6)), Number(x.toFixed(6)))
    })
    map.current = m
    return () => {
      m.remove()
      map.current = null
      marker.current = null
    }
  }, [open, lat, lng, onPick])

  const pinned = lat !== null && lng !== null
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
        {pinned ? `📍 ${lat!.toFixed(4)}, ${lng!.toFixed(4)}` : t.orders.pinOnMap}
      </Button>
      {pinned ? (
        <Button variant="ghost" onClick={onClear}>
          ×
        </Button>
      ) : null}
      {open ? <div ref={host} className="h-64 w-full rounded-lg" /> : null}
    </>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }): ReactNode {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      {/* dir=ltr: every value here is a figure (money, %, «+12 كم») — numbers read left-to-right in
          both languages, so this keeps a sign/unit from landing on the wrong side in RTL. */}
      <dd dir="ltr" className={`num text-lg font-semibold ${tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-700' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

/**
 * The evidence photos for one end of the shift (C-7). Renders each uploaded slot as a thumbnail
 * from the same-origin, RBAC-checked `/api/media/:id`; a tap opens it full-screen so the manager
 * can actually read the odometer / dashboard / wallet against the numbers beside it.
 */
/** Says something only when there is something to say. */
function PhotoAgeLine({ age }: { age: PhotoAge }): ReactNode {
  const { t } = useApp()
  if (age.kind === 'fresh') return null
  return (
    <span className={`text-[10px] ${age.kind === 'stale' ? 'text-amber-700' : 'text-slate-400'}`}>
      {age.kind === 'stale' ? t.shift.photoOld.replace('{n}', String(minutesLabel(age.minutes))) : t.shift.photoAgeUnknown}
    </span>
  )
}

/** Old/reused evidence is allowed, but the manager must see the warning and its confirmation. */
function EvidenceWarningLines({ media }: { media: Review['media'][number] }): ReactNode {
  const { t, lang } = useApp()
  const warning = evidenceReviewWarning(media)
  const warned = warning.age.kind === 'stale' || warning.reusedFromShiftId !== null

  return (
    <span className="flex flex-col items-center gap-0.5">
      <PhotoAgeLine age={warning.age} />
      {warning.reusedFromShiftId !== null ? (
        <span className="text-[10px] font-medium text-amber-700">{t.shift.photoReused}</span>
      ) : null}
      {warned ? (
        <span
          className={`text-[10px] font-medium ${warning.acknowledged ? 'text-emerald-700' : 'text-red-700'}`}
          title={media.staleAcknowledgedBy ?? undefined}
        >
          {warning.acknowledged
            ? t.shift.photoWarningAcknowledged.replace(
                '{at}',
                warning.acknowledgedAt ? formatDateTime(warning.acknowledgedAt, lang) : '—',
              )
            : t.shift.photoWarningUnacknowledged}
        </span>
      ) : null}
    </span>
  )
}

/** Minutes up to an hour, then whole hours — «قبل ١٨٠ دقيقة» is not how anyone reads a clock. */
function minutesLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

function PhotoRow({ pkg, media }: { pkg: 'start' | 'end'; media: Review['media'] }): ReactNode {
  const { t, lang } = useApp()
  const [zoom, setZoom] = useState<string | null>(null)
  // Grouped and page-ordered: a scrollable screen now arrives as several images, and «الداشبورد ٣»
  // sitting between a battery and the odometer tells the manager nothing about which day it covers.
  const shots = media
    .filter((m) => m.package === pkg)
    .slice()
    .sort((a, b) => {
      const A = splitSlot(a.slot)
      const B = splitSlot(b.slot)
      return A.base === B.base ? A.n - B.n : A.base.localeCompare(B.base)
    })
  // `slotLabel` rather than a bare lookup: `payments_log` and every `bms_*` have been rendering as
  // raw keys here since those slots existed, because the catalogue only holds un-numbered names.
  const label = (slot: string): string => slotLabel(slot, t.shift.slotNames, lang)

  if (shots.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">{t.approval.noPhotos}</p>
  }
  const at = shots.findIndex((m) => m.mediaId === zoom)
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {shots.map((m) => (
          <button
            key={m.slot}
            onClick={() => setZoom(m.mediaId)}
            aria-label={label(m.slot)}
            className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 p-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {/* `object-contain`, not `object-cover`: a cover-cropped 96px thumbnail of an odometer
                shows the middle of the dial and none of the digits. */}
            <img
              src={`/api/media/${m.mediaId}`}
              alt={label(m.slot)}
              loading="lazy"
              className="size-24 rounded bg-slate-100 object-contain"
            />
            <span className="text-[10px] text-slate-600">{label(m.slot)}</span>
            {/* HOW OLD THE PICTURE WAS WHEN IT ARRIVED.
                Every slot can now be filled from the gallery, so «taken just now» stopped being a
                guarantee of the capture flow. A fresh photo says nothing — the common case stays
                quiet; an old one says so, because that is the thing worth seeing before signing for
                the cash behind it. It is a prompt to look, never an accusation. */}
            <EvidenceWarningLines media={m} />
          </button>
        ))}
      </div>
      {zoom ? (
        <Lightbox
          shots={shots}
          index={at === -1 ? 0 : at}
          label={label}
          onIndex={(i) => setZoom(shots[i]?.mediaId ?? null)}
          onClose={() => setZoom(null)}
        />
      ) : null}
    </>
  )
}

/**
 * The evidence viewer — the screen's stated anti-fraud read actually being performable.
 *
 * It was an `<img>` fitted to the viewport inside a div that closed on any click. No zoom, so an
 * odometer photographed at an angle could not be read at all; no keyboard, so no Esc and no way to
 * step between shots; no caption, so nothing said which slot you were looking at; and clicking the
 * image itself dismissed it. Comparing the start odometer against the end one — the whole point —
 * meant open, close, scroll, open, and holding five digits in your head.
 */
function Lightbox({
  shots,
  index,
  label,
  onIndex,
  onClose,
}: {
  shots: Review['media']
  index: number
  label(slot: string): string
  onIndex(i: number): void
  onClose(): void
}): ReactNode {
  const { t } = useApp()
  const [scale, setScale] = useState(1)
  const shot = shots[index]

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      // The chevrons follow reading order; the ARRAY does not, so both keys are mapped plainly.
      if (e.key === 'ArrowRight') onIndex(Math.min(shots.length - 1, index + 1))
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, index - 1))
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(6, s + 0.5))
      if (e.key === '-') setScale((s) => Math.max(1, s - 0.5))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, shots.length, onIndex, onClose])

  // A new shot starts unzoomed, or the next photo opens showing a corner of itself.
  useEffect(() => setScale(1), [index])
  if (!shot) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/90" role="dialog" aria-modal="true">
      <div className="flex items-center gap-3 p-3 text-white">
        <span className="font-semibold">{label(shot.slot)}</span>
        <span className="num text-sm text-white/70">
          {index + 1}/{shots.length}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="ghost" onClick={() => setScale((s) => Math.max(1, s - 0.5))} aria-label="−">
            −
          </Button>
          <span className="num w-12 text-center text-sm">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" onClick={() => setScale((s) => Math.min(6, s + 0.5))} aria-label="+">
            +
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>
      </div>
      {/* Scrolls when zoomed, so a magnified odometer can actually be panned to its digits. */}
      <div className="flex-1 overflow-auto p-3">
        <img
          src={`/api/media/${shot.mediaId}`}
          alt={label(shot.slot)}
          className="mx-auto origin-top rounded-lg"
          style={{ width: `${scale * 100}%`, maxWidth: scale === 1 ? '100%' : 'none' }}
        />
      </div>
      <div className="flex items-center justify-between p-3">
        <Button variant="ghost" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          ‹
        </Button>
        <Button variant="ghost" disabled={index === shots.length - 1} onClick={() => onIndex(index + 1)}>
          ›
        </Button>
      </div>
    </div>
  )
}

/**
 * What each pack read, at one end of the shift.
 *
 * Scaled integers come off the wire — millivolts and deci-Celsius — and are divided only here,
 * for display. The cycle count is the number worth watching over time: it is what says a pack is
 * wearing out before it strands a driver.
 */
function BatteryReadings({
  readings,
  pkg,
  onManagerRead,
}: {
  readings: BatteryReadingView[]
  pkg?: 'start' | 'end'
  /** Supplying a reading the driver's phone could not produce. Absent ⇒ read-only. */
  onManagerRead?(pkg: 'start' | 'end', batteryId: string, percent: number): Promise<void>
}): ReactNode {
  const { t } = useApp()
  if (readings.length === 0) return null
  return (
    <div className="mt-3 flex flex-col gap-2">
      {readings.map((r) => {
        // The driver said his phone will not run the BMS app, and nobody has read it since. This is
        // the one thing on the screen that is the MANAGER's to do rather than to check.
        const owed = r.unavailable === true && r.percent === null
        return (
          <div
            key={`${r.batteryId}-${r.slotNo}`}
            className={`rounded-lg border px-3 py-2 text-sm ${owed ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {t.battery.slot} {r.slotNo}
                {r.capacityAh === null ? '' : ` · ${r.capacityAh}Ah`}
              </span>
              <span className="num font-bold">{r.percent === null ? '—' : `${r.percent}%`}</span>
            </div>
            <div className="num mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500">
              {r.cycleCount === null ? null : <span>{t.battery.cycles}: {r.cycleCount}</span>}
              {r.serialNo === null ? null : <span className="text-slate-600">{r.serialNo}</span>}
            </div>
            {/* Stays visible after he fills it: it is the record of WHY a manager's figure is here,
                and hiding it would erase that the driver could not read the pack at all. */}
            {r.unavailable === true ? (
              <p className="mt-1 text-xs text-amber-800">
                {r.percent === null ? t.battery.managerMustRead : t.battery.readByManager}
              </p>
            ) : null}
            {owed && onManagerRead && pkg ? <ManagerReading pkg={pkg} batteryId={r.batteryId} onRead={onManagerRead} /> : null}
            {/* SRS D-3: what the driver changed from the OCR reading. */}
            <OcrDeltaLines deltas={bmsDeltas(r, t)} />
          </div>
        )
      })}
    </div>
  )
}

/** The manager typing the charge he just read on his own device. */
function ManagerReading({
  pkg,
  batteryId,
  onRead,
}: {
  pkg: 'start' | 'end'
  batteryId: string
  onRead(pkg: 'start' | 'end', batteryId: string, percent: number): Promise<void>
}): ReactNode {
  const { t } = useApp()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const n = Number(value)
  const ready = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100 && !busy

  return (
    <div className="mt-2 flex items-end gap-2">
      <label className="flex w-28 flex-col gap-1">
        <span className="text-xs text-slate-600">{t.battery.percent}</span>
        <TextInput inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Button
        disabled={!ready}
        onClick={async () => {
          setBusy(true)
          try {
            await onRead(pkg, batteryId, n)
          } finally {
            setBusy(false)
          }
        }}
      >
        {t.common.save}
      </Button>
    </div>
  )
}

/** How each scaled-integer BMS field labels + formats for the D-3 delta line — charge + cycles. */
const BMS_FIELDS = ['percent', 'cycleCount'] as const
type BmsFieldKey = (typeof BMS_FIELDS)[number]
const bmsFmt: Record<BmsFieldKey, { label: (t: ReturnType<typeof useApp>['t']) => string; show: (v: number) => string }> = {
  percent: { label: (t) => t.battery.percent, show: (v) => `${v}%` },
  cycleCount: { label: (t) => t.battery.cycles, show: (v) => `${v}` },
}

function bmsDeltas(r: BatteryReadingView, t: ReturnType<typeof useApp>['t']): DeltaLine[] {
  const ocrRaw = (r.ocrRaw ?? null) as Partial<Record<BmsFieldKey, OcrScalar>> | null
  return ocrReadingDelta(BMS_FIELDS, ocrRaw, r).map((d) => ({
    label: bmsFmt[d.key].label(t),
    ocr: d.ocr === null ? null : bmsFmt[d.key].show(d.ocr),
    confirmed: d.confirmed === null ? '—' : bmsFmt[d.key].show(d.confirmed),
  }))
}

interface DeltaLine {
  label: string
  /** null = OCR read nothing (driver filled it). */
  ocr: string | null
  confirmed: string
}

/**
 * The SRS D-3 delta lines: for each field the driver changed from OCR, «label: OCR → confirmed»,
 * or a "filled by the driver" note when OCR read nothing. Reused by BMS, odometer/battery, wallet
 * and order-fee. The figure row is `dir="ltr"` because numbers read left-to-right in both languages.
 */
function OcrDeltaLines({ deltas }: { deltas: DeltaLine[] }): ReactNode {
  const { t } = useApp()
  if (deltas.length === 0) return null
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {deltas.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <Badge tone="amber">{t.approval.ocrEdited}</Badge>
          {d.ocr === null ? (
            <span>{d.label}: {t.approval.ocrFilled}</span>
          ) : (
            <span dir="ltr" className="num">{d.label}: {d.ocr} → {d.confirmed}</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** A one-field delta (odometer/battery/wallet/fee): [] when OCR was blank-and-unchanged or absent. */
function scalarDelta(label: string, ocr: string | null, confirmed: string | null): DeltaLine[] {
  if (ocr === null) return []
  if (confirmed !== null && ocr === confirmed) return []
  return [{ label, ocr, confirmed: confirmed ?? '—' }]
}

/**
 * The fee, and — while the shift is under review — a way to correct it.
 *
 * This is the manager's own comparison made actionable: he is holding the cash, so when the number
 * on the screen disagrees with the notes in his hand he is the one who knows which is right. His
 * only previous move was the include checkbox, i.e. deleting a real delivery to fix one figure.
 *
 * Closed, it is a button and not an input, for two reasons. A row of live number fields invites a
 * fat thumb to change money by scrolling past it, and a screen of inputs reads as a form to fill in
 * rather than a set of figures to check. Editing is deliberately a decision he takes on one row.
 *
 * The target is `min-h-11` — 44px — because this one moves money and the include checkbox beside it
 * (20px) is already the smallest thing on the screen that should not be.
 */
function FeeCell({
  fee,
  editable,
  onSave,
}: {
  fee: string
  editable: boolean
  onSave: (fee: string) => Promise<void>
}): ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(fee)

  // A reload after somebody else's revision must not leave a stale draft sitting in the box.
  useEffect(() => {
    if (!editing) setDraft(fee)
  }, [fee, editing])

  if (!editable || !editing) {
    return editable ? (
      <button
        type="button"
        onClick={() => {
          setDraft(fee)
          setEditing(true)
        }}
        className={`-mx-1 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-1 text-start hover:bg-slate-50 ${FOCUS_RING}`}
        aria-label={`${t.orders.correctFee}: ${fee}`}
      >
        <Money value={fee} />
        <span aria-hidden className="text-xs text-slate-400">✎</span>
      </button>
    ) : (
      <Money value={fee} />
    )
  }

  const changed = draft.trim() !== '' && draft.trim() !== fee
  const commit = (): void => {
    setEditing(false)
    // Saving the same number would still move `orders_hash` and force him to re-read the whole
    // shift for nothing, so an unchanged draft closes the editor and posts nothing.
    if (changed) void onSave(draft.trim())
  }

  return (
    <div className="flex flex-col gap-1">
      <MoneyInput
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        aria-label={t.orders.correctFee}
        className="w-full"
      />
      <div className="flex gap-1">
        <Button onClick={commit} disabled={!changed} className="px-3">
          {t.common.save}
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)} className="px-3">
          {t.common.cancel}
        </Button>
      </div>
      {/* He is about to change money. Say what the change is before he taps, not after. */}
      {changed ? <span className="num text-xs text-slate-500">{fee} →</span> : null}
    </div>
  )
}
