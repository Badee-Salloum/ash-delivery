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
      .then((r) => setRows(r.shifts.filter((s) => AWAITING_STATES.has(s.state))))
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
        <p className="py-8 text-center text-slate-400">{t.approval.queue}: —</p>
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
          <span className="num text-sm text-slate-500">
            {vehicleCode(s.vehicleId)} · #{s.shiftNo}
          </span>
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
