import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Pending } from '../ui.tsx'

interface ShiftRow {
  id: string
  driverId: string
  vehicleId: string
  shiftNo: number
  state: string
  /** All already on the wire from GET /shifts and, until now, all thrown away by this screen. */
  businessDate?: string
  orderCount?: number
  /** BR1's scalar difference as last evaluated — null until the driver submits a closing package. */
  equationDiff?: string | null
  floatTotal?: string
}
interface DriverLite {
  id: string
  code: string
  fullNameAr: string
  fullNameEn: string | null
}
interface VehicleLite {
  id: string
  code: string
}

/** The two states that actually want a manager's signature. */
export const AWAITING_STATES = new Set(['awaiting_open_approval', 'pending_review'])

/**
 * The approval queue — the shifts that are genuinely waiting for a manager, read from the SHIFTS
 * themselves.
 *
 * It used to be driven off the notification bell, and that was wrong in two ways at once. A bell
 * row is pushed to `branch:<id>` once and never cleared, so an APPROVED shift kept appearing here
 * for ever — the manager approved it and the queue still said «بانتظار الاعتماد». And a general
 * manager or system admin has no `branchId` of his own, so he was never a recipient of any branch's
 * bell: his queue was permanently empty in every branch, even though the §3 matrix lets him approve
 * every shift in the organisation.
 *
 * Reading `GET /shifts` fixes both. It is branch-scoped through the same picker every other screen
 * uses, and the state it returns is the truth — so a shift leaves this list the moment it is
 * approved, and an upper-level manager sees whichever branch he has selected. The bell keeps doing
 * its own job: telling him something arrived.
 */
export function Queue({ onOpen }: { onOpen(shiftId: string): void }): ReactNode {
  const { api, t, lang, branchId } = useApp()
  const [rows, setRows] = useState<ShiftRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .get<{ shifts: ShiftRow[] }>('/shifts')
      .then((r) =>
        setRows(
          r.shifts
            .filter((s) => AWAITING_STATES.has(s.state))
            /*
             * OPENS FIRST, THEN OLDEST.
             *
             * An open gate means a driver is standing at the branch unable to start; a close can
             * wait ten minutes. And with eight shifts pending, unsorted, a manager could not tell
             * which had been waiting since six in the morning — so he opened them one at a time to
             * find out. The list arrived in whatever order the query returned.
             */
            .sort((a, b) => {
              const rank = (x: ShiftRow): number => (x.state === 'awaiting_open_approval' ? 0 : 1)
              if (rank(a) !== rank(b)) return rank(a) - rank(b)
              return (a.businessDate ?? '').localeCompare(b.businessDate ?? '')
            }),
        ),
      )
      .catch((e: { error?: string }) => {
        setRows([])
        setError(e.error ?? 'error')
      })
    void api
      .get<{ drivers: DriverLite[] }>('/drivers')
      .then((r) => setDrivers(Object.fromEntries(r.drivers.map((d) => [d.id, d]))))
      .catch(() => undefined)
    void api
      .get<{ vehicles: VehicleLite[] }>('/vehicles')
      .then((r) => setVehicles(Object.fromEntries(r.vehicles.map((v) => [v.id, v]))))
      .catch(() => undefined)
  }, [api])

  // Re-poll on `branchId` so switching branch reloads that branch's queue, exactly like LiveShifts.
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load, branchId])

  if (!rows) {
    return (
      <Pending
        error={error}
        loadingLabel={t.common.loading}
        errorLabel={explainError(error, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  if (rows.length === 0) {
    return (
      <Card>
        <p className="py-8 text-center text-slate-600">{t.approval.queueEmpty}</p>
      </Card>
    )
  }

  const driverName = (id: string): string => {
    const d = drivers[id]
    if (!d) return id.slice(0, 8)
    return (lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr
  }
  const vehicleCode = (id: string): string => vehicles[id]?.code ?? id.slice(0, 8)

  return (
    <div className="flex flex-col gap-2">
      {rows.map((s) => (
        <Card key={s.id} className="flex flex-wrap items-center gap-3">
          {/* The badge reads the shift's REAL state, not the kind of a notification that fired once. */}
          <Badge tone={s.state === 'pending_review' ? 'amber' : 'sky'}>
            {t.shift.states[s.state as keyof typeof t.shift.states] ?? s.state}
          </Badge>
          <span className="font-medium">{driverName(s.driverId)}</span>
          <span className="num text-sm text-slate-600">
            {vehicleCode(s.vehicleId)} · #{s.shiftNo}
            {s.businessDate ? ` · ${s.businessDate}` : ''}
          </span>
          {/* How much work is on it — the difference between a two-order shift and a thirty-order
              one, which is the whole of "which of these should I open first". */}
          {/* BALANCED OR NOT, before he opens it. Approving from the list is deliberately not
              offered — opening the shift is the speed bump on the tap that moves cash — so the
              list's whole job is telling him which one to open first. A zero here means the
              arithmetic already agrees and the review is a confirmation; anything else is where
              his time should go. */}
          {s.state === 'pending_review' && s.equationDiff != null ? (
            <Badge tone={s.equationDiff === '0.00' ? 'green' : 'red'}>
              {s.equationDiff === '0.00' ? t.br1.balanced : `${t.common.difference} ${s.equationDiff}`}
            </Badge>
          ) : null}
          {s.state === 'pending_review' && s.orderCount !== undefined ? (
            <span className="num text-sm text-slate-600">
              {t.orders.title}: {s.orderCount}
            </span>
          ) : null}
          <Button variant="ghost" className="ms-auto inline-flex items-center gap-1.5" onClick={() => onOpen(s.id)}>
            {t.approval.review}
            {/* Forward chevron — points inline-end, mirrored in RTL. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="rtl:-scale-x-100">
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Card>
      ))}
    </div>
  )
}
