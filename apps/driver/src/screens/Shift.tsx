import {
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { MAX_PAGE_SLOTS, PAYMENTS_LOG_SLOT, type PayMode, pageSlot } from '@ash/domain'
import type { DraftMovement, DraftOrder } from '@ash/client'
import {
  allProblems,
  compressImage,
  driverPhaseFor,
  plural,
  mergeScannedMovements,
  healCutOffRoutes,
  mergeScannedOrders,
  previewBr1,
  splitSlot,
  submittableOrders,
  uploadEvidencePath,
} from '@ash/client'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { useGpsBeacon } from '../use-gps-beacon.ts'
import { Button, Card, Field, Money, MoneyInput, Screen, TextInput } from '../ui.tsx'
import { OperationsList } from './OrderEntry.tsx'
import { BatteryPanel, type FittedBattery, type PackState } from './BatteryPanel.tsx'
import { BatterySwap, type SpareBattery } from './BatterySwap.tsx'
import { PhotoSlot } from './PhotoSlot.tsx'

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

interface ShiftState {
  id: string
  floatText: string
  topupText: string
  /** The shift's own day — what a scanned row's date is compared against. */
  businessDate: string
}

/** What the payments-log reader made of «سجل المدفوعات», said out loud rather than left silent. */
type LogState = { kind: 'idle' | 'reading' | 'failed' } | { kind: 'read'; rows: number; refused: number; cutOff?: number }

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
  cash: string
  wallet: string
  /** What `readWallet` OCR'd, kept even if the driver edits the field (SRS D-3 baseline). */
  walletOcr: string | null
  odo: string
  /** Evidence slots already uploaded, so the tiles come back showing their taken state. */
  slots: ReadonlySet<string>
  log: LogState
  /** Per-pack BMS readings, so the charge fields come back filled and the gate stays satisfied. */
  packs: Record<string, PackState>
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
  opsError: string | null
}

const EMPTY_END_DRAFT: EndDraft = {
  cash: '',
  wallet: '',
  walletOcr: null,
  odo: '',
  slots: new Set(),
  log: { kind: 'idle' },
  packs: {},
  dashboardPages: 1,
  logPages: 1,
  dash: { kind: 'idle' },
  orders: [],
  movements: [],
  opsError: null,
}

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

export function ShiftFlow({
  assignment,
  batteries,
  spares = [],
  resume,
  onDiscarded,
}: {
  assignment: { driverId: string; vehicleId: string; shiftNo: number }
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
  const [loaded, setLoaded] = useState(!resume)
  /** The resume fetch failed — shown as a retry, never as a phase we cannot actually render. */
  const [resumeFailed, setResumeFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [endDraft, setEndDraft] = useState<EndDraft>(EMPTY_END_DRAFT)

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
        toast.error(t.shift.cancelledByManager)
        onDiscarded?.()
        return true
      }
      if (gone === 'closed') {
        toast.success(t.shift.closedByManager)
        return true
      }
      return false
    },
    [toast, t, onDiscarded],
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
        setShift({
          id: st.id,
          floatText: st.startPackage.floatTotal,
          topupText: st.startPackage.topupTotal,
          businessDate: st.businessDate,
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
          cash: d.cash || (st.endPackage.cashDeclared ?? ''),
          wallet: d.wallet || (st.endPackage.walletDeclared ?? ''),
          odo: d.odo || (st.endPackage.odometerKm === null ? '' : String(st.endPackage.odometerKm)),
          packs: Object.fromEntries(
            st.endPackage.batteries
              .filter((b) => b.percent !== null)
              .map((b) => [b.batteryId, { ...(d.packs[b.batteryId] ?? {}), percent: String(b.percent) }]),
          ) as EndDraft['packs'],
          orders: st.orders.map((o) => ({
            // `already-<no>` rather than a random id: the list is rebuilt from the server on every
            // resume, and a stable key keeps React from remounting rows the driver is editing.
            localId: `already-${o.providerOrderNo}`,
            providerOrderNo: o.providerOrderNo,
            payMode: o.payMode,
            feeText: o.fee,
            recorded: true,
            included: o.included,
            walletAmountText: o.walletAmount ?? '',
            timeText: o.occurredMinute ?? '',
            dateText: o.occurredDate ?? '',
            // «A» و«B» come back from the stored route, so a resumed shift still shows where each
            // order went — the only thing on the row a person can recognise.
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
        }))
        // Trust the server's state over the one the assignment reported: the manager may have
        // approved between the two calls. A shift that is no longer LIVE goes through the same
        // rule as the watcher — landing on «بدء النوبة» for a shift the manager cancelled is how
        // a driver ends up photographing an odometer for a shift that cannot accept it.
        if (!applyServerState(st.state)) setPhase(PHASE_FOR[st.state] ?? 'start')
        // C-7: if the manager bounced this shift back for a re-shoot or rejected the close, tell the
        // driver WHY — otherwise a shift that jumped back a phase looks like a silent glitch.
        const d = st.lastDecision
        if (d && (d.decision === 'rephoto_requested' || d.decision === 'rejected')) {
          const label = d.decision === 'rejected' ? t.shift.closeRejected : t.shift.retakeRequested
          toast.error(d.notes ? `${label}: ${d.notes}` : label)
        }
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
  }, [api, resume, reloadKey])

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
        onDiscarded={onDiscarded}
        awaiting={phase === 'awaiting'}
        onOpened={(id) => {
          setShift({ id, floatText: '0', topupText: '0', businessDate: '' })
          setPhase('awaiting')
        }}
        onApproved={(funds) => {
          // The manager entered the float + top-up at approval; carry them into the order screen so
          // the live BR1 preview is right.
          setShift((s) => (s ? { ...s, ...funds } : s))
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
    return (
      <EndPackage
        shift={shift}
        batteries={fitted}
        draft={endDraft}
        onDraft={setEndDraft}
        // Back to the running shift. The operations list now lives ON this screen, so there is no
        // intermediate step to return to — and the package survives the trip either way.
        onBack={() => setPhase('orders')}
        onSubmitted={() => setPhase('done')}
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
  onDiscarded,
  awaiting,
  onOpened,
  onApproved,
}: {
  assignment: { driverId: string; vehicleId: string; shiftNo: number }
  batteries: readonly FittedBattery[]
  /** A draft that already exists. Present ⇒ attach to it; absent ⇒ create one. */
  existingShiftId?: string | null
  /** Called after the draft is cancelled, to return to bike selection. */
  onDiscarded?: (() => void) | undefined
  awaiting: boolean
  onOpened(shiftId: string): void
  /**
   * The manager approved. Carries the shift's OWN DAY as well as the money: the poller already has
   * it in hand, and without it the operations list compares every scanned row's date against an
   * empty string and stamps «يوم آخر» on all of them.
   */
  onApproved(funds: { floatText: string; topupText: string; businessDate: string }): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [shiftId, setShiftId] = useState<string | null>(existingShiftId ?? null)
  const [odo, setOdo] = useState('')
  // SRS D-3 baseline: what OCR read for the odometer, kept even if the driver then edits it, so the
  // manager sees «قراءة الآلة ← ما أكّده السائق».
  const [odoOcr, setOdoOcr] = useState<number | null>(null)
  const [odoShot, setOdoShot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [startSlots, setStartSlots] = useState<Set<string>>(new Set())
  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)

  // Assisted OCR: read the ODOMETER off the dashboard photo and pre-fill the km field the driver
  // would otherwise type. Only fills it when he has not already, and any failure is silent — the
  // driver just types. Charge is read per pack in the battery panel, not off the dash.
  const runOcr = useCallback(async (file: File): Promise<void> => {
    setOcrBusy(true)
    try {
      const { readDashboard } = await import('../ocr.ts')
      // The ORIGINAL file, not the compressed upload: 1280 px at q=0.4 puts body text under the
      // LSTM's recognition floor, and no tesseract parameter recovers from that.
      const result = await readDashboard(file)
      // A failed read is not silent any more, but the odometer tile has no status line of its own
      // — the driver simply types, which is what he was going to do anyway.
      if (!result.ok) return
      const { odometer } = result.reading
      // Record the raw read ONCE (the baseline), independent of the later pre-fill/edit.
      if (odometer != null) setOdoOcr((cur) => cur ?? odometer)
      if (odometer != null) setOdo((cur) => (cur === '' ? String(odometer) : cur))
    } finally {
      setOcrBusy(false)
    }
  }, [])

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
    setBusy(true)
    try {
      // The driver submits only the odometer + photo. The cash float and wallet top-up are the
      // branch's money, entered by the manager at approval. Charge is captured per pack, so the
      // bike-level battery % is gone (sent null — the column stays a nullable seam).
      await api.put(`/shifts/${shiftId}/start-package`, {
        odometerKm: Number(odo),
        batteryPercent: null,
        // SRS D-3: the odometer OCR baseline (null when OCR never ran).
        odometerKmOcr: odoOcr,
        batteryPercentOcr: null,
      })
      onOpened(shiftId)
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
            floatText: s.startPackage.floatTotal,
            topupText: s.startPackage.topupTotal,
            businessDate: s.businessDate,
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

  // `batteriesReady` gates too, matching the close screen and the server BR5 gate: a driver can't
  // confirm start until every fitted pack's required reading is in — the pack charges ARE the
  // battery state now, so there is no separate bike-level battery field to fill.
  // Same rule as the close gate: the list IS the gate, so what is disabled and what is explained
  // can never drift apart.
  const missing: string[] = [
    ...(odoShot ? [] : [t.shift.odometerShot]),
    ...(odo === '' ? [t.shift.odometer] : []),
    ...(batteriesReady ? [] : [t.battery.percent]),
  ]
  const ready = shiftId !== null && missing.length === 0

  return (
    <Screen
      title={t.shift.startShift}
      footer={
        <div className="flex flex-col gap-2">
          {!ready && missing.length > 0 ? (
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
          onUploaded={(slot) => {
            setOdoShot(true)
            setStartSlots((cur) => new Set(cur).add(slot))
          }}
          onImage={runOcr}
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
      {shiftId ? <DiscardButton onDiscard={discardSelf} /> : null}
      {ocrBusy ? <p className="text-center text-sm text-slate-600">{t.shift.reading}…</p> : null}
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.odometer}>
          <TextInput inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value)} />
        </Field>
      </Card>
      {/* One screenshot and one set of numbers per pack fitted — the same count the gate reads. */}
      {shiftId ? (
        <BatteryPanel
          shiftId={shiftId}
          pkg="start"
          batteries={batteries}
          slots={startSlots}
          onSlotUploaded={(slot) => setStartSlots((cur) => new Set(cur).add(slot))}
          onReadingsChanged={setBatteriesReady}
        />
      ) : null}
    </Screen>
  )
}

function EndPackage({
  shift,
  batteries,
  draft,
  onDraft,
  onBack,
  onSubmitted,
}: {
  shift: ShiftState
  batteries: readonly FittedBattery[]
  /** Held by the caller so the package survives a step back to the order list. See `EndDraft`. */
  draft: EndDraft
  onDraft: Dispatch<SetStateAction<EndDraft>>
  onBack?(): void
  onSubmitted(): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const { cash, wallet, walletOcr, odo, slots, log: logState } = draft
  const patch = useCallback((p: Partial<EndDraft>): void => onDraft((d) => ({ ...d, ...p })), [onDraft])
  // Stable, and a no-op update when the readings are unchanged — an unstable callback here would
  // loop the panel's notify-effect against this state.
  const onPacksChanged = useCallback(
    (packs: Record<string, PackState>): void => onDraft((d) => (d.packs === packs ? d : { ...d, packs })),
    [onDraft],
  )
  const [br1, setBr1] = useState<{ difference: string; balanced: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const [batteriesReady, setBatteriesReady] = useState(batteries.length === 0)
  // The zeroed-wallet photo was dropped (product owner) — the wallet screenshot is the evidence.
  // «سجل المدفوعات» joins them: the balance screen says what the wallet HOLDS, the log says what
  // MOVED, and only the log can tell a cash order from a part-electronic one (each order leaves
  // Yallago's 20% in it at its own minute). It is evidence, not a gate — a driver whose log will
  // not photograph must still be able to close, and the manager reconciles from the balance.
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
  const shown = [
    ...Array.from({ length: draft.dashboardPages }, (_, i) => pageSlot('dashboard', i + 1)),
    'wallet',
    'odometer',
    ...Array.from({ length: draft.logPages }, (_, i) => pageSlot(PAYMENTS_LOG_SLOT, i + 1)),
  ]
  const labelOf = (slot: string): string => {
    const { base, n } = splitSlot(slot)
    const name = labels[base] ?? slot
    return n === 1 ? name : `${name} ${n}`
  }
  // The dashboard, wallet and log are SCREENSHOTS the driver already has in his gallery, not things
  // to photograph with the camera; the odometer is a real photo of the bike.
  const gallery = new Set(['dashboard', 'wallet', PAYMENTS_LOG_SLOT])
  // Each fitted pack's closing charge gates the button (batteriesReady), matching the server. The
  // bike-level battery field is gone — charge is tracked per pack.
  // The close gate counts the shift's ORDERS, checked or not — see `endPackageGaps`. Deliberately
  // the total and not the checked count: a driver who unchecks everything would otherwise be
  // refused submission, and every tool that could rescue him needs the shift to reach review first.
  const named = draft.orders.filter((o) => o.providerOrderNo.trim() !== '').length
  /**
   * WHAT IS STILL MISSING, named — instead of one grey button and no explanation.
   *
   * Seven independent conditions used to collapse into a single `disabled`, at the bottom of a
   * page several thousand pixels long. The driver's worst moment in the product was standing at
   * the branch at the end of a shift, everything apparently filled in, tapping a dead button that
   * said nothing about the blank battery field or the one bad fee twenty rows up.
   *
   * The list IS the gate: `ready` is now "nothing missing", so the two can never drift apart.
   */
  const missing: string[] = [
    // A missing PHOTO and a missing NUMBER are different jobs, and the catalogue gives «العداد» to
    // both — so the footer read «العداد · … · العداد» and the driver had no way to tell which one
    // he still owed, or that he owed two things at all. The photo is named as a photo.
    ...required.filter((s) => !slots.has(s)).map((s) => `${t.shift.photoOf} ${labelOf(s)}`),
    ...(cash === '' ? [t.shift.cashHandover] : []),
    ...(wallet === '' ? [t.shift.walletBalance] : []),
    ...(odo === '' ? [t.shift.odometer] : []),
    ...(batteriesReady ? [] : [t.battery.percent]),
    ...(named === 0 ? [t.orders.title] : []),
    ...(allProblems(draft.orders).size > 0 ? [t.shift.fixOrderRows] : []),
    // A read in flight is a reason to WAIT, not a thing to go and fix — but submitting through it
    // silently drops every order it was about to add, which is the shift closing short.
    ...(draft.dash.kind === 'reading' || draft.log.kind === 'reading' ? [t.shift.reading] : []),
  ]
  const ready = missing.length === 0

  const preview = previewBr1({
    floatText: shift.floatText,
    topupText: shift.topupText,
    orders: draft.orders,
    movements: draft.movements,
    // Spread so the keys are ABSENT rather than undefined: the preview shows a difference only
    // once BOTH declared figures exist, and an explicit `undefined` would satisfy that check.
    ...(cash === '' || wallet === '' ? {} : { declaredCashText: cash, declaredWalletText: wallet }),
  })

  /**
   * The operations first, then the package.
   *
   * In that order because the close gate counts the shift's orders: sending the package first would
   * be refused for having none. The whole list goes every time — the server upserts the orders and
   * merges the movements, so re-sending is a no-op rather than a wall of duplicate-key errors.
   */
  async function submit(): Promise<void> {
    setBusy(true)
    try {
      await api.put(`/shifts/${shift.id}/operations`, {
        // A row the driver left unchecked with NO price never travels: `moneySchema` refuses an
        // empty fee and would 400 the whole request, losing every good row with it. That is a
        // cancelled card he was not paid for, or a refused row he judged was not this shift's.
        orders: submittableOrders(draft.orders)
          .filter((o) => o.providerOrderNo.trim() !== '')
          .map((o) => ({
            providerOrderNo: o.providerOrderNo.trim(),
            payMode: o.payMode,
            fee: o.feeText,
            zone: null,
            // SRS D-1/D-3: mark rows scanned off «الطلبات الحديثة», keeping what OCR read.
            // Three answers, not two. A row the reader SAW and refused is not a row somebody typed
            // from memory — it is a hard glyph with a human's correction attached, which is the most
            // valuable thing this system can teach the reader. Flattening it to 'manual' threw that
            // away at the wire.
            source: o.feeOcrText != null ? 'ocr' : o.feeRefused === true ? 'refused' : 'manual',
            feeOcr: o.feeOcrText ?? null,
            feeStrip: o.feeStrip ?? null,
            included: o.included !== false,
            walletAmount: o.walletAmountText ? o.walletAmountText : null,
            occurredMinute: o.timeText ? o.timeText : null,
            occurredDate: o.dateText ? o.dateText : null,
            pointA: o.pointA ?? null,
            pointB: o.pointB ?? null,
          })),
        movements: draft.movements.map((m) => ({
          amount: m.amountText,
          occurredMinute: m.timeText,
          role: m.role ?? 'unmatched',
          providerOrderNo: m.providerOrderNo ?? null,
          ambiguous: m.ambiguous ?? false,
          included: m.included !== false,
        })),
      })
      patch({ opsError: null })

      const res = await api.put<{ br1: { difference: string; balanced: boolean } }>(`/shifts/${shift.id}/end-package`, {
        odometerKm: Number(odo),
        // Bike-level battery % is gone — charge is captured per pack. Sent null (nullable seam).
        batteryPercent: null,
        cashDeclared: cash,
        walletDeclared: wallet,
        // SRS D-3: the wallet OCR baseline (null when readWallet never ran).
        walletDeclaredOcr: walletOcr,
      })
      setBr1(res.br1)
      if (res.br1.balanced) onSubmitted()
    } catch (e) {
      const err = e as { error?: string; detail?: { providerOrderNo?: string; businessDate?: string } }
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
        // The error card sits above a list that sits below ten photo tiles, and the driver tapping
        // submit is pinned to the footer at the bottom of a very long page. Unannounced, the
        // button simply greys and comes back and he taps it again, and again.
        toast.error(message)
        return
      }
      toast.error((err.error && (t.errors as Record<string, string>)[err.error]) || t.common.actionFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      title={t.shift.endShift}
      {...(onBack ? { back: { label: t.common.back, onBack } } : {})}
      footer={
        <div className="flex flex-col gap-2">
          {/* The equation LIVE, before he submits — so a wrong pay mode or a missing operation is
              visible while he can still fix it, rather than discovered by the manager. */}
          {/* Grouped in PAIRS. Four items spread edge-to-edge by `justify-between` left it
              genuinely ambiguous which figure belonged to which label — on the money readout. */}
          {preview ? (
            <div className="grid grid-cols-2 gap-x-4 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-600">{t.br1.expectedCash}</span>
                <Money value={preview.expectedCashText} className="font-semibold" />
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-600">{t.br1.expectedWallet}</span>
                <Money value={preview.expectedWalletText} className="font-semibold" />
              </div>
              {/* The difference, the moment both declared figures exist — it was computed all
                  along and never shown, so the driver first learned of a gap after submitting. */}
              {preview.differenceText !== null ? (
                <div className="col-span-2 flex items-baseline justify-between gap-2 border-t border-slate-200 pt-1">
                  <span className="text-slate-600">{t.common.difference}</span>
                  <Money
                    value={preview.differenceText}
                    className={`font-bold ${preview.balanced ? 'text-emerald-700' : 'text-red-700'}`}
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
          ) : null}
          {/* NAMED, not merely absent. Tapping the footer's dead button is how a driver concludes
              the app is broken; this says which thing to go and do. */}
          {!ready && missing.length > 0 ? (
            <p className="text-sm font-medium text-amber-800">
              {t.shift.stillMissing} {missing.join(' · ')}
            </p>
          ) : null}
          {br1 ? (
            <div
              className={`flex items-center justify-between rounded-2xl px-4 py-2 ${
                br1.balanced ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
              }`}
            >
              <span>{br1.balanced ? t.br1.balanced : t.br1.notBalanced}</span>
              <Money value={br1.difference} className="font-bold" />
            </div>
          ) : null}
          <Button variant="success" disabled={!ready || busy} onClick={submit}>
            {busy ? t.common.loading : t.shift.submitEnd}
          </Button>
        </div>
      }
    >
      {shown.map((slot) => {
        const { base, n } = splitSlot(slot)
        // «+ صورة أخرى» sits under the LAST page of each scrollable screen, and only once that page
        // actually holds an image — otherwise a tap adds an empty tile, and a wall of empty tiles
        // reads as a longer list of things the driver still owes.
        const lastPage =
          (base === 'dashboard' && n === draft.dashboardPages && n < MAX_PAGE_SLOTS) ||
          (base === PAYMENTS_LOG_SLOT && n === draft.logPages && n < MAX_PAGE_SLOTS)
        const addPage = (): void =>
          onDraft((d) =>
            base === 'dashboard' ? { ...d, dashboardPages: d.dashboardPages + 1 } : { ...d, logPages: d.logPages + 1 },
          )
        return (
          <Fragment key={slot}>
        <PhotoSlot
          shiftId={shift.id}
          pkg="end"
          slot={slot}
          label={labelOf(slot)}
          source={gallery.has(splitSlot(slot).base) ? 'gallery' : 'camera'}
          uploaded={slots.has(slot)}
          onUploaded={(up) => onDraft((d) => ({ ...d, slots: new Set(d.slots).add(up) }))}
          // SRS D-2: read the wallet balance off its screenshot and pre-fill the field; and read the
          // payments log, which is what tells a cash order from a part-electronic one. Both are
          // ASSISTED — a failed read leaves the field for the driver, and the manager can correct it
          // at the review. (Spread so the prop is absent, not `undefined`, on the other slots.)
          {...(slot === 'wallet'
            ? {
                onImage: async (file: File): Promise<void> => {
                  const { readWallet } = await import('../ocr.ts')
                  const r = await readWallet(file)
                  if (!r.ok) return
                  onDraft((d) => ({
                    ...d,
                    // The FIRST read is the baseline and stays it; the field is only pre-filled
                    // while the driver has not answered — his typing always wins.
                    walletOcr: d.walletOcr ?? r.reading.amountText,
                    wallet: d.wallet === '' ? r.reading.amountText : d.wallet,
                  }))
                },
              }
            : {})}
          // The dashboard tile IS the order scan. One pick: the image is the evidence AND the thing
          // that was read. Its rows are APPENDED, never replacing what is already listed — the
          // screen scrolls, so page two re-shows the bottom of page one.
          {...(splitSlot(slot).base === 'dashboard'
            ? {
                onImage: async (file: File): Promise<void> => {
                  patch({ dash: { kind: 'reading' } })
                  const { readOrders } = await import('../ocr.ts')
                  const r = await readOrders(file).catch(() => null)
                  onDraft((d) => {
                    if (!r?.ok) return { ...d, dash: { kind: 'failed' } }
                    const added = mergeScannedOrders(d.orders, r.reading.orders, () => crypto.randomUUID())
                    // A card sliced off the bottom of the previous page is usually whole at the
                    // top of this one. Its second sighting is de-duplicated away, so without this
                    // its addresses go with it and the row keeps showing a delivery to nowhere.
                    const healed = healCutOffRoutes(d.orders, r.reading.orders)
                    const patch = new Map(healed.map((h) => [h.localId, h]))
                    // NEW rows, not rows on the page: a page that fully overlaps reads 0, which is
                    // the truth — nothing was added — and not a failure. `refused` is what the
                    // reader saw but would not vouch for, and it is the driver's to type.
                    return {
                      ...d,
                      orders: [...d.orders.map((o) => { const h = patch.get(o.localId); return h ? { ...o, pointA: h.pointA, pointB: h.pointB } : o }), ...added],
                      dash: { kind: 'read', rows: added.length, refused: Math.max(0, (r.rowsSeen ?? 0) - r.fieldsFound), cutOff: r.cutOff ?? 0 },
                    }
                  })
                },
              }
            : {})}
          {...(splitSlot(slot).base === PAYMENTS_LOG_SLOT
            ? {
                onImage: async (file: File): Promise<void> => {
                  patch({ log: { kind: 'reading' } })
                  const { readPaymentsLog } = await import('../ocr.ts')
                  const r = await readPaymentsLog(file).catch(() => null)
                  onDraft((d) => {
                    if (!r?.ok) return { ...d, log: { kind: 'failed' } }
                    const added = mergeScannedMovements(d.movements, r.reading.movements, () => crypto.randomUUID())
                    return {
                      ...d,
                      movements: [...d.movements, ...added],
                      log: {
                        kind: 'read',
                        rows: added.length,
                        refused: Math.max(0, (r.rowsSeen ?? 0) - r.fieldsFound),
                      },
                    }
                  })
                },
              }
            : {})}
        />
            {lastPage && slots.has(slot) ? (
              <Button variant="ghost" onClick={addPage}>
                + {t.shift.addPage}
              </Button>
            ) : null}
            {/* What THIS screen's read did, under its own tiles. A toast would say it once and
                vanish; whether a screenshot was understood is a state the driver keeps needing
                while he decides what he still has to type. */}
            {lastPage ? <ReadStatus state={base === 'dashboard' ? draft.dash : logState} /> : null}
          </Fragment>
        )
      })}
      {/* THE list: every operation of the shift, with the checkbox that decides what counts. */}
      {draft.opsError ? (
        <Card>
          <p className="text-center text-sm font-medium text-red-600">{draft.opsError}</p>
        </Card>
      ) : null}
      <OperationsList
        orders={draft.orders}
        movements={draft.movements}
        today={shift.businessDate}
        onOrders={(orders) => onDraft((d) => ({ ...d, orders }))}
        onMovements={(movements) => onDraft((d) => ({ ...d, movements }))}
      />
      <Card className="flex flex-col gap-3">
        <Field label={t.shift.cashHandover}>
          <MoneyInput value={cash} onChange={(e) => patch({ cash: e.target.value })} />
        </Field>
        <Field label={t.shift.walletBalance}>
          <MoneyInput value={wallet} onChange={(e) => patch({ wallet: e.target.value })} />
        </Field>
        <Field label={t.shift.odometer}>
          <TextInput inputMode="numeric" value={odo} onChange={(e) => patch({ odo: e.target.value })} />
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
        onPacksChanged={onPacksChanged}
      />
    </Screen>
  )
}

/**
 * What a screenshot's reader made of it — said out loud, and left on screen.
 *
 * A silent reader is how a driver ends up believing a screenshot was understood when it was not,
 * and «قُرئت ٠ عملية» is a different statement from «تعذّرت القراءة»: the first means the page
 * added nothing because it had nothing new on it, the second means the digits could not be read at
 * all and the rows have to be typed. Both are true answers and the driver acts differently on each.
 */
function ReadStatus({ state }: { state: LogState }): ReactNode {
  const { t, lang } = useApp()
  // Checked POSITIVELY for `read`: the other member's `kind` is a union of three literals, and
  // narrowing a union by eliminating them one at a time does not reduce to the member with `rows`.
  if (state.kind === 'read') {
    return (
      <p className="text-center text-sm text-emerald-700">
        {plural(state.rows, t.shift.readAdded, lang)}
        {/* The rows the reader SAW and would not vouch for. Silence here would let the driver
            believe the page was fully read and submit a day that is short by those rows. */}
        {state.refused > 0 ? (
          <span className="text-amber-800"> · {plural(state.refused, t.shift.readRefused, lang)}</span>
        ) : null}
        {/* A card the screen sliced in half is NOT offered — its places would be a guess. Saying so
            is the whole difference between withholding a row and losing one. */}
        {(state.cutOff ?? 0) > 0 ? (
          <span className="text-amber-800"> · {plural(state.cutOff!, t.shift.readCutOff, lang)}</span>
        ) : null}
      </p>
    )
  }
  if (state.kind === 'reading') {
    /*
     * A READ TAKES 20–40 SECONDS on a cheap Android, and it was one line of `text-slate-400` —
     * 2.6:1 against white, which is to say invisible in Damascus daylight. Meanwhile the tile
     * above had already flipped to ✓ for its upload, so the driver reasonably concluded the work
     * was done, scrolled past, and submitted a shift short by everything the reader was about to
     * add. An indeterminate bar is honest here: Tesseract's progress covers only its own pass,
     * and the glyph reader that follows it reports nothing.
     */
    return (
      <div className="flex flex-col gap-1" role="status">
        <p className="text-center text-sm font-medium text-slate-700">
          {t.shift.reading}… <span className="text-slate-600">{t.shift.readingMayTake}</span>
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full w-1/3 animate-[ash-slide_1.2s_ease-in-out_infinite] rounded-full bg-brand" />
        </div>
      </div>
    )
  }
  if (state.kind === 'failed') return <p className="text-center text-sm font-medium text-amber-800">{t.shift.readUnread}</p>
  return null
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
