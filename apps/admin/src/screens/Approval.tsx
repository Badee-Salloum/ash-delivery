import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L, { type CircleMarker, type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { type OcrScalar, ocrReadingDelta, slotLabel, splitSlot } from '@ash/client'
import { formatMinor, parseMinor, sub } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

/** Where the map opens when no point has been pinned yet. */
const DAMASCUS: readonly [number, number] = [33.5138, 36.2765]

interface BatteryReadingView {
  batteryId: string
  slotNo: number
  percent: number | null
  cycleCount: number | null
  capacityAh: number | null
  serialNo: string | null
  source: 'ocr' | 'manual'
  /** The pre-correction OCR reading (SRS D-3 baseline); charge + cycles only now. */
  ocrRaw?: unknown
}

interface Review {
  id: string
  state: string
  driverId: string
  vehicleId: string
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
  media: Array<{ package: 'start' | 'end'; slot: string; mediaId: string }>
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
  const { api, t } = useApp()
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The manager records the cash float + wallet top-up here, at open-approval (the driver no
  // longer types them). Empty is treated as 0.
  const [floatText, setFloatText] = useState('')
  const [topupText, setTopupText] = useState('')
  const [notes, setNotes] = useState('') // for a re-shoot request or a reject (C-7)
  const [manual, setManual] = useState({ providerOrderNo: '', payMode: 'cash', fee: '' }) // manual-order reconcile

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

  async function approve(): Promise<void> {
    if (!review) return
    setBusy(true)
    setError(null)
    try {
      if (review.state === 'awaiting_open_approval') {
        await api.post(`/shifts/${review.id}/approve-open`, {
          floatTranches: [floatText || '0'],
          topupTranches: [topupText || '0'],
        })
      } else {
        await api.post(`/shifts/${review.id}/approve-close`, { reviewedOrdersHash: review.br1.ordersHash })
      }
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
  async function reviseOps(body: Record<string, unknown>): Promise<void> {
    if (!review) return
    setBusy(true)
    setError(null)
    try {
      await api.post(`/shifts/${review.id}/operations/revise`, body)
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
    setBusy(true)
    setError(null)
    try {
      await api.voidShift(review.id, notes.trim() === '' ? '—' : notes.trim())
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
        <h1 className="text-xl font-bold">{t.approval.review}</h1>
        <Badge tone="slate">{t.shift.states[review.state as keyof typeof t.shift.states] ?? review.state}</Badge>
      </div>

      {/* ── The BR1 panel, pinned first — it is what the decision hinges on ───────────────
          Only once the shift is AT a gate. Mid-shift the driver has declared no closing cash or
          wallet yet, those nulls are read as zero, and the panel would show an alarming red
          difference the size of the whole float for a shift that is simply still running. */}
      {atGate ? (
      <Card
        title={t.br1.title}
        className={review.br1.balanced ? 'ring-2 ring-emerald-300' : 'ring-2 ring-red-300'}
      >
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <Field label={t.br1.expectedCash} value={review.br1.expectedCash} />
          <Field label={t.br1.expectedWallet} value={review.br1.expectedWallet} />
          <Field
            label={t.common.difference}
            value={review.br1.difference}
            tone={review.br1.balanced ? 'green' : 'red'}
          />
        </div>
        {!review.br1.balanced || !review.br1.splitBalanced ? (
          <div className="mt-3 flex flex-col gap-1">
            {review.br1.causes.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge tone={c.confidence === 'high' ? 'red' : 'amber'}>{c.confidence}</Badge>
                <span>{t.br1.cause[c.code as keyof typeof t.br1.cause] ?? c.code}</span>
                <Money value={c.amount} className="ms-auto text-slate-500" />
                {c.candidateOrderNos.length > 0 ? (
                  <span className="text-xs text-slate-400">({c.candidateOrderNos.slice(0, 3).join(', ')})</span>
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
          <BatteryReadings readings={review.startPackage.batteries} />
        </Card>
        <Card title={t.shift.endPackage}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Field label={t.shift.odometer} value={String(review.endPackage.odometerKm ?? '—')} />
            <Field label={t.approval.startVsEnd} value={odoDelta === null ? '—' : `+${odoDelta} كم`} />
            <Field label={t.shift.cashHandover} value={review.endPackage.cashDeclared ?? '—'} />
            <Field label={t.shift.walletBalance} value={review.endPackage.walletDeclared ?? '—'} />
          </dl>
          {isClose ? <ReviseFigures shiftId={review.id} review={review} onRevised={load} /> : null}
          {/* SRS D-3: what the driver changed from the wallet OCR. */}
          <OcrDeltaLines deltas={scalarDelta(t.shift.walletBalance, review.endPackage.walletDeclaredOcr, review.endPackage.walletDeclared)} />
          <PhotoRow pkg="end" media={review.media} />
          <BatteryReadings readings={review.endPackage.batteries} />
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
        <Table head={['', '#', t.orders.orderNo, t.orders.payMode, t.orders.fee]}>
          {review.orders.map((o, i) => (
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
              <td className="px-3 py-1 text-slate-400">{i + 1}</td>
              <td className="px-3 py-1 num">
                {o.providerOrderNo}
                {o.source === 'ocr' ? <span className="ms-1.5 align-middle"><Badge tone="slate">OCR</Badge></span> : null}
                {o.included === false ? <span className="ms-1.5 align-middle"><Badge tone="slate">{t.orders.excluded}</Badge></span> : null}
              </td>
              <td className="px-3 py-1">{t.orders.payModes[o.payMode as keyof typeof t.orders.payModes]}</td>
              <td className="px-3 py-1">
                <Money value={o.fee} />
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
                      <span className="text-slate-400">
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
                <span className="num text-xs text-slate-400">{new Date(d.decidedAt).toLocaleString()}</span>
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
        <div className="sticky bottom-4 flex flex-wrap gap-3">
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
          {isClose ? (
            <Button variant="danger" disabled={busy} onClick={() => decide('reject-close')}>
              {t.approval.reject}
            </Button>
          ) : (
            <>
              {/* At the open gate the manager chooses: send it back to be redone, or refuse it
                  outright — which cancels the shift and frees the bike. */}
              <Button variant="ghost" disabled={busy} onClick={() => decide('reject-open')}>
                {t.approval.sendBack}
              </Button>
              <Button variant="danger" disabled={busy} onClick={refuse}>
                {t.approval.refuse}
              </Button>
            </>
          )}
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
    return <p className="mt-3 text-xs text-slate-400">{t.approval.noPhotos}</p>
  }
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
            <img src={`/api/media/${m.mediaId}`} alt={label(m.slot)} loading="lazy" className="size-24 rounded object-cover" />
            <span className="text-[10px] text-slate-500">{label(m.slot)}</span>
          </button>
        ))}
      </div>
      {zoom ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4" onClick={() => setZoom(null)}>
          <img src={`/api/media/${zoom}`} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      ) : null}
    </>
  )
}

/**
 * What each pack read, at one end of the shift.
 *
 * Scaled integers come off the wire — millivolts and deci-Celsius — and are divided only here,
 * for display. The cycle count is the number worth watching over time: it is what says a pack is
 * wearing out before it strands a driver.
 */
function BatteryReadings({ readings }: { readings: BatteryReadingView[] }): ReactNode {
  const { t } = useApp()
  if (readings.length === 0) return null
  return (
    <div className="mt-3 flex flex-col gap-2">
      {readings.map((r) => (
        <div key={`${r.batteryId}-${r.slotNo}`} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">
              {t.battery.slot} {r.slotNo}
              {r.capacityAh === null ? '' : ` · ${r.capacityAh}Ah`}
            </span>
            <span className="num font-bold">{r.percent === null ? '—' : `${r.percent}%`}</span>
          </div>
          <div className="num mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500">
            {r.cycleCount === null ? null : <span>{t.battery.cycles}: {r.cycleCount}</span>}
            {r.serialNo === null ? null : <span className="text-slate-400">{r.serialNo}</span>}
          </div>
          {/* SRS D-3: what the driver changed from the OCR reading. */}
          <OcrDeltaLines deltas={bmsDeltas(r, t)} />
        </div>
      ))}
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
