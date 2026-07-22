import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card, Money, Table } from '../ui.tsx'

interface Review {
  id: string
  state: string
  driverId: string
  vehicleId: string
  businessDate: string
  startPackage: { odometerKm: number | null; batteryPercent: number | null; floatTotal: string; topupTotal: string; mediaSlots: string[] }
  endPackage: { odometerKm: number | null; batteryPercent: number | null; cashDeclared: string | null; walletDeclared: string | null; mediaSlots: string[] }
  orders: Array<{ providerOrderNo: string; payMode: string; fee: string; zone: string | null }>
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

  const load = useCallback(() => {
    void api.get<Review>(`/shifts/${shiftId}/review`).then(setReview).catch(() => setReview(null))
  }, [api, shiftId])
  useEffect(load, [load])

  if (!review) return <Card>{t.common.loading}</Card>

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
        await api.post(`/shifts/${review.id}/approve-open`)
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onDone}>
          ←
        </Button>
        <h1 className="text-xl font-bold">{t.approval.review}</h1>
        <Badge tone="slate">{t.shift.states[review.state as keyof typeof t.shift.states] ?? review.state}</Badge>
      </div>

      {/* ── The BR1 panel, pinned first — it is what the decision hinges on ─────────────── */}
      <Card
        title={t.br1.title}
        className={review.br1.balanced ? 'ring-2 ring-emerald-300' : 'ring-2 ring-red-300'}
      >
        <div className="grid grid-cols-3 gap-3 text-sm">
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
            <Field label={t.shift.battery} value={`${review.startPackage.batteryPercent ?? '—'}%`} />
            <Field label={t.shift.cashFloat} value={review.startPackage.floatTotal} />
            <Field label={t.shift.walletTopup} value={review.startPackage.topupTotal} />
          </dl>
          <PhotoRow shiftId={review.id} pkg="start" slots={review.startPackage.mediaSlots} />
        </Card>
        <Card title={t.shift.endPackage}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Field label={t.shift.odometer} value={String(review.endPackage.odometerKm ?? '—')} />
            <Field label={t.approval.startVsEnd} value={odoDelta === null ? '—' : `+${odoDelta} كم`} />
            <Field label={t.shift.cashHandover} value={review.endPackage.cashDeclared ?? '—'} />
            <Field label={t.shift.walletBalance} value={review.endPackage.walletDeclared ?? '—'} />
          </dl>
          <PhotoRow shiftId={review.id} pkg="end" slots={review.endPackage.mediaSlots} />
        </Card>
      </div>

      <Card title={`${t.orders.title} — ${review.orders.length}`}>
        <Table head={['#', t.orders.orderNo, t.orders.payMode, t.orders.fee]}>
          {review.orders.map((o, i) => (
            <tr key={o.providerOrderNo}>
              <td className="px-3 py-1 text-slate-400">{i + 1}</td>
              <td className="px-3 py-1 num">{o.providerOrderNo}</td>
              <td className="px-3 py-1">{t.orders.payModes[o.payMode as keyof typeof t.orders.payModes]}</td>
              <td className="px-3 py-1"><Money value={o.fee} /></td>
            </tr>
          ))}
        </Table>
      </Card>

      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      <div className="sticky bottom-4 flex gap-3">
        <Button
          variant="success"
          disabled={busy || (isClose && !review.br1.balanced)}
          onClick={approve}
          className="flex-1"
        >
          {isClose ? t.approval.approveClose : t.common.approve}
        </Button>
      </div>
    </div>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }): ReactNode {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`num text-lg font-semibold ${tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-700' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

/** Thumbnails that open the RBAC-checked evidence route. The media id is not on the review yet,
 *  so this lists the slots present; a Bundle-2 nicety wires the id-addressed image endpoint. */
function PhotoRow({ shiftId, pkg, slots }: { shiftId: string; pkg: string; slots: string[] }): ReactNode {
  void shiftId
  void pkg
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {slots.map((s) => (
        <span key={s} className="rounded bg-slate-100 px-2 py-1 text-xs">
          📷 {s}
        </span>
      ))}
    </div>
  )
}
