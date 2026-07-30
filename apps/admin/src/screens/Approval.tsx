import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type OcrScalar, ocrReadingDelta } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

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
  orders: Array<{ providerOrderNo: string; payMode: string; fee: string; zone: string | null; source?: 'manual' | 'ocr'; feeOcr?: string | null }>
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

  // C-7: send the package back for a re-shoot (both gates), or reject a close. Both bounce the shift
  // to the driver, with the note as the reason he sees.
  async function decide(path: 'request-rephoto' | 'reject-close'): Promise<void> {
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

      {/* ── The BR1 panel, pinned first — it is what the decision hinges on ─────────────── */}
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
        <Table head={['#', t.orders.orderNo, t.orders.payMode, t.orders.fee]}>
          {review.orders.map((o, i) => (
            <tr key={o.providerOrderNo}>
              <td className="px-3 py-1 text-slate-400">{i + 1}</td>
              <td className="px-3 py-1 num">
                {o.providerOrderNo}
                {o.source === 'ocr' ? <span className="ms-1.5 align-middle"><Badge tone="slate">OCR</Badge></span> : null}
              </td>
              <td className="px-3 py-1">{t.orders.payModes[o.payMode as keyof typeof t.orders.payModes]}</td>
              <td className="px-3 py-1">
                <Money value={o.fee} />
                {/* SRS D-3: a fee the driver changed from what OCR read (money strings compare exact). */}
                <OcrDeltaLines deltas={scalarDelta(t.orders.fee, o.feeOcr ?? null, o.fee)} />
              </td>
            </tr>
          ))}
        </Table>

        {/* Reconcile a «missing order» BR1 flagged: add it manually. Changes the orders hash, so the
            manager re-reviews before approving. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <TextInput
            placeholder={t.orders.orderNo}
            aria-label={t.orders.orderNo}
            value={manual.providerOrderNo}
            onChange={(e) => setManual({ ...manual, providerOrderNo: e.target.value })}
            className="w-32"
          />
          <Select
            aria-label={t.orders.payMode}
            value={manual.payMode}
            onChange={(e) => setManual({ ...manual, payMode: e.target.value })}
          >
            {(['cash', 'electronic', 'free'] as const).map((m) => (
              <option key={m} value={m}>
                {t.orders.payModes[m]}
              </option>
            ))}
          </Select>
          <MoneyInput
            placeholder={t.orders.fee}
            aria-label={t.orders.fee}
            value={manual.fee}
            onChange={(e) => setManual({ ...manual, fee: e.target.value })}
            className="w-28"
          />
          <Button
            variant="ghost"
            disabled={busy || !manual.providerOrderNo || !manual.fee}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await api.addManualOrder(review.id, { providerOrderNo: manual.providerOrderNo, payMode: manual.payMode, fee: manual.fee, zone: null })
                setManual({ providerOrderNo: '', payMode: 'cash', fee: '' })
                load()
              } catch (err) {
                setError((err as { error?: string }).error ?? 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            {t.orders.addManual}
          </Button>
        </div>
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

      {/* A reason for the re-shoot / reject the driver will see. */}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t.approval.notes}
        aria-label={t.approval.notes}
        rows={2}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
      />

      {error ? <p className="text-sm font-medium text-red-600">{explainError(error, t)}</p> : null}
      <div className="sticky bottom-4 flex flex-wrap gap-3">
        <Button
          variant="success"
          disabled={busy || (isClose && !review.br1.balanced)}
          onClick={approve}
          className="flex-1"
        >
          {isClose ? t.approval.approveClose : t.common.approve}
        </Button>
        {/* Re-shoot is legal on both gates; reject only on a close. */}
        <Button variant="ghost" disabled={busy} onClick={() => decide('request-rephoto')}>
          {t.approval.requestRetake}
        </Button>
        {isClose ? (
          <Button variant="danger" disabled={busy} onClick={() => decide('reject-close')}>
            {t.approval.reject}
          </Button>
        ) : null}
      </div>
    </div>
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
  const { t } = useApp()
  const [zoom, setZoom] = useState<string | null>(null)
  const shots = media.filter((m) => m.package === pkg)
  const label = (slot: string): string => t.shift.slotNames[slot as keyof typeof t.shift.slotNames] ?? slot

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
