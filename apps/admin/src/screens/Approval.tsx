import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L, { type CircleMarker, type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { type OcrScalar, type PhotoAge, br1Verdict, photoAge, ocrReadingDelta, slotLabel, splitSlot, formatDateTime } from '@ash/client'
import { add, formatMinor, parseMinor, sub } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useConfirm, useToast } from '../feedback.tsx'
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
  shiftNo: number
  businessDate: string
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
  }>
  /** «سجل المدفوعات» as read. Only the rows no order explains are a term in BR1. */
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
  }>
  decisions: Array<{ gate: 'open' | 'close'; decision: 'approved' | 'rejected' | 'rephoto_requested'; notes: string | null; decidedAt: string }>
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
  }
}

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The manager records the cash float + wallet top-up here, at open-approval (the driver no
  // longer types them). Empty is treated as 0.
  const [floatText, setFloatText] = useState('')
  const [topupText, setTopupText] = useState('')
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

  const [loadError, setLoadError] = useState<string | null>(null)
  const load = useCallback(() => {
    setLoadError(null)
    void api
      .get<Review>(`/shifts/${shiftId}/review`)
      .then(setReview)
      .catch((e: { error?: string }) => {
        // Not a spinner: a review that cannot be fetched (the shift was cancelled, or this role
        // may not see it) has to say so, or the manager waits on a screen that will never fill.
        setReview(null)
        setLoadError(e.error ?? 'error')
      })
  }, [api, shiftId])
  useEffect(load, [load])

  useEffect(() => {
    if (!review) return
    void api
      .get<{ drivers: Array<{ id: string; fullNameAr: string; fullNameEn: string | null }> }>('/drivers')
      .then((r) => {
        const d = r.drivers.find((x) => x.id === review.driverId)
        setWho((w) => ({ ...w, driver: d ? ((lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr) : null }))
      })
      .catch(() => undefined)
    void api
      .get<{ vehicles: Array<{ id: string; code: string }> }>('/vehicles')
      .then((r) => setWho((w) => ({ ...w, vehicle: r.vehicles.find((x) => x.id === review.vehicleId)?.code ?? null })))
      .catch(() => undefined)
  }, [api, lang, review?.driverId, review?.vehicleId])

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
    o.source === 'ocr' || o.included === false || o.kind === 'manual' || (o.feeOcr != null && o.feeOcr !== o.fee)

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
  const verdict =
    br1State === 'not_balanced'
      ? { tone: 'red' as const, label: t.br1.notBalanced }
      : br1State === 'split_off'
        ? { tone: 'amber' as const, label: t.br1.splitOff }
        : { tone: 'green' as const, label: t.br1.balanced }

  async function approve(): Promise<void> {
    if (!review) return
    const opening = review.state === 'awaiting_open_approval'
    // Money leaves the office on this click, in an amount typed into two boxes that silently
    // default to zero. It is read back to the manager before it is committed.
    if (opening) {
      const ok = await confirm({
        title: t.approval.confirmOpenTitle,
        body: `${who.driver ?? ''} · ${t.shift.cashFloat}: ${floatText || '0'} · ${t.shift.walletTopup}: ${topupText || '0'}`,
        confirmLabel: t.common.approve,
      })
      if (!ok) return
    } else {
      // CLOSING IS THE HEAVIER CLICK, and it was the only one without a confirmation. Opening a
      // shift disburses a float that can be recounted; approving a close POSTS THE LEDGER — it
      // splits the day's fees, credits the driver's share and seals figures a week-lock will make
      // immutable. Read back who and how much before it happens.
      const ok = await confirm({
        title: t.approval.confirmCloseTitle,
        body: `${who.driver ?? ''} · ${t.br1.expected}: ${review.br1.difference === '0.00' ? t.br1.balanced : review.br1.difference}`,
        confirmLabel: t.approval.approveClose,
      })
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      if (opening) {
        await api.post(`/shifts/${review.id}/approve-open`, {
          floatTranches: [floatText || '0'],
          topupTranches: [topupText || '0'],
        })
      } else {
        await api.post(`/shifts/${review.id}/approve-close`, { reviewedOrdersHash: review.br1.ordersHash })
      }
      // SAY SO. The screen used to simply vanish back to the queue, which is the most common
      // "did that actually work?" moment in the product and it had no answer.
      toast.success(`${t.approval.approved}${who.driver ? ` — ${who.driver}` : ''}`)
      onDone()
    } catch (err) {
      // 409 = orders changed since this screen loaded; reload so the manager reviews the truth.
      const code = (err as { error?: string }).error
      if (code === 'orders_changed_since_review') {
        setError(code)
        load()
      } else {
        setError(code ?? 'error')
      }
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
    load()
  }

  async function reviseOps(body: Record<string, unknown>): Promise<void> {
    if (!review) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/shifts/${review.id}/operations/revise`, body)
      // The checkbox that just moved re-ran the whole equation, and the verdict is a card away.
      // Unannounced, the manager sees a flicker and a changed colour without knowing he caused it.
      toast.success(t.approval.recomputed)
      load()
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
  async function decide(path: 'request-rephoto' | 'reject-close' | 'reject-open'): Promise<void> {
    if (!review) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/shifts/${review.id}/${path}`, { notes: notes || null })
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
          <span className="text-sm text-slate-600">{t.common.difference}</span>
          <span
            dir="ltr"
            className={`num text-3xl font-bold ${review.br1.balanced ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {review.br1.difference}
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

      {/* ── Start vs end, side by side — the odometer delta is the anti-fraud read ──────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={t.shift.startPackage}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Field label={t.shift.odometer} value={String(review.startPackage.odometerKm ?? '—')} />
            {review.state === 'awaiting_open_approval' ? (
              <>
                <div>
                  <dt className="text-xs text-slate-500">{t.shift.cashFloat}</dt>
                  <dd className="mt-1">
                    <MoneyInput value={floatText} onChange={(e) => setFloatText(e.target.value)} className="w-full" />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">{t.shift.walletTopup}</dt>
                  <dd className="mt-1">
                    <MoneyInput value={topupText} onChange={(e) => setTopupText(e.target.value)} className="w-full" />
                  </dd>
                </div>
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
          {isClose ? <ReviseFigures shiftId={review.id} review={review} onRevised={load} /> : null}
          {/* SRS D-3: what the driver changed from the wallet OCR. */}
          <OcrDeltaLines deltas={scalarDelta(t.shift.walletBalance, review.endPackage.walletDeclaredOcr, review.endPackage.walletDeclared)} />
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
        <Table head={['', '#', t.orders.route, t.orders.payMode, t.orders.fee]}>
          {shownOrders.map((o, i) => (
            <tr key={o.providerOrderNo} className={o.included === false ? 'opacity-60' : ''}>
              {/* Every operation shows, checked or not, and an excluded row keeps its PLACE —
                  hiding it or moving it to the bottom is how a manager stops noticing it. */}
              <td className="px-3 py-1">
                <input
                  type="checkbox"
                  checked={o.included !== false}
                  disabled={!underReview || busy}
                  onChange={(e) => void reviseOps({ orders: [{ providerOrderNo: o.providerOrderNo, included: e.target.checked }] })}
                  aria-label={t.orders.included}
                  className="size-5 accent-emerald-600"
                />
              </td>
              <td className="px-3 py-1 text-slate-600">{i + 1}</td>
              {/* WHAT THE ORDER IS. Not `providerOrderNo` — that is a generated key, unique and
                  meaningless, and printing it here told the manager nothing he could check against
                  the driver's screenshot. The clock and the two places are what both of them see. */}
              <td className="px-3 py-1">
                <span className="num">{o.occurredMinute ?? '—'}</span>
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
                  onSave={(fee) => reviseOps({ orders: [{ providerOrderNo: o.providerOrderNo, fee }] })}
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
            </tr>
          ))}
        </Table>

        {/* «سجل المدفوعات» — what the wallet actually did, beside what the orders imply it should
            have. Only the rows no order explains are a term in BR1; the others are corroboration. */}
        {review.movements.length > 0 ? (
          <div className="mt-4">
            <p className="mb-1 text-sm font-semibold">{t.shift.paymentsLog}</p>
            <Table head={['', t.orders.time, t.orders.fee, '']}>
              {review.movements.map((m) => (
                <tr key={m.id} className={m.included === false ? 'opacity-60' : ''}>
                  <td className="px-3 py-1">
                    <input
                      type="checkbox"
                      checked={m.included !== false}
                      disabled={!underReview || busy}
                      onChange={(e) => void reviseOps({ movements: [{ id: m.id, included: e.target.checked }] })}
                      aria-label={t.orders.included}
                      className="size-5 accent-emerald-600"
                    />
                  </td>
                  <td className="num px-3 py-1 text-slate-500">{m.occurredMinute || '—'}</td>
                  <td className="num px-3 py-1">
                    <Money value={m.amount} />
                  </td>
                  <td className="px-3 py-1 text-xs">
                    {/*
                      The one question no machine may answer. A credit landing at an order's minute
                      is either that order's electronic part or an unrelated incentive, and the two
                      readings agree on the wallet to the minor unit while differing on the CASH by
                      exactly the credit — so BR1 catches a wrong choice, and no second gate is
                      needed. Offered only where the reader actually flagged the doubt.
                    */}
                    {m.ambiguous ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          variant="ghost"
                          disabled={!underReview || busy}
                          onClick={() =>
                            void reviseOps({ movements: [{ id: m.id, role: 'order_credit', ambiguous: false }] })
                          }
                        >
                          {t.orders.partOfOrder}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={!underReview || busy}
                          onClick={() =>
                            void reviseOps({
                              movements: [{ id: m.id, role: 'unmatched', providerOrderNo: null, ambiguous: false }],
                            })
                          }
                        >
                          {t.orders.separateIncentive}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-slate-600">
                        {m.role === 'unmatched' ? t.orders.unexplained : t.orders.explainedByOrder}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        ) : null}

        <AddOrderForm shiftId={review.id} onAdded={load} />
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
          {isClose && !review.br1.balanced ? (
            <p className="mb-2 text-sm font-medium text-red-700">{t.approval.cannotApproveUnbalanced}</p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="success"
              disabled={busy || (isClose && !review.br1.balanced)}
              onClick={approve}
              className="flex-1"
            >
              {isClose ? t.approval.approveClose : t.common.approve}
            </Button>
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
  review: { endPackage: { odometerKm: number | null; cashDeclared: string | null; walletDeclared: string | null } }
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
      await api.post(`/shifts/${shiftId}/close-figures`, {
        odometerKm: odo.trim() === '' ? null : Number(odo),
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
 * pay mode and fee; its split is the day's tier band, computed at approval.
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
            <PhotoAgeLine age={photoAge(m.clientTakenAt ?? null, m.receivedAt ?? null)} />
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
