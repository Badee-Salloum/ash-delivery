import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Field, Pending, TextInput } from '../ui.tsx'

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

/** The live-shift set a manager can act on: out working, or on hold. */
const LIVE_STATES = new Set(['open', 'suspended'])

/**
 * «النوبات الجارية» — who is out right now. A manager suspends a shift for a mid-shift incident
 * (SRS C-1 / س29) here; the driver resumes it himself from his phone once he can carry on. A
 * suspended shift still closes under the same BR1 — suspension is never a way around the equation.
 */
export function LiveShifts(): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const [rows, setRows] = useState<ShiftRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)

  // Suspend is `shift.approve` — the branch manager and GM hold it; the sysadmin does not.
  const canApprove = session?.roleKey === 'branch_manager' || session?.roleKey === 'general_manager'

  const load = useCallback(() => {
    setError(null)
    void api
      .get<{ shifts: ShiftRow[] }>('/shifts')
      .then((r) => setRows(r.shifts.filter((s) => LIVE_STATES.has(s.state))))
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

  // Poll: a driver's report-incident or a fresh open shift should surface without a manual refresh.
  useEffect(() => {
    load()
    const timer = setInterval(load, 8000)
    return () => clearInterval(timer)
  }, [load, branchId])

  if (!rows) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  const driverName = (id: string): string => {
    const d = drivers[id]
    if (!d) return id.slice(0, 8)
    return (lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr
  }
  const vehicleCode = (id: string): string => vehicles[id]?.code ?? id.slice(0, 8)

  if (rows.length === 0) {
    return (
      <Card>
        <p className="py-8 text-center text-slate-400">{t.liveShifts.none}</p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((s) => (
        <LiveRow key={s.id} shift={s} driverName={driverName(s.driverId)} vehicleCode={vehicleCode(s.vehicleId)} canApprove={canApprove} onChanged={load} />
      ))}
    </div>
  )
}

function LiveRow({
  shift,
  driverName,
  vehicleCode,
  canApprove,
  onChanged,
}: {
  shift: ShiftRow
  driverName: string
  vehicleCode: string
  canApprove: boolean
  onChanged: () => void
}): ReactNode {
  const { api, t } = useApp()
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const suspend = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.suspendShift(shift.id, note.trim() === '' ? null : note.trim())
      setAsking(false)
      setNote('')
      onChanged()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Badge tone={shift.state === 'suspended' ? 'amber' : 'green'}>
          {t.shift.states[shift.state as keyof typeof t.shift.states] ?? shift.state}
        </Badge>
        <span className="font-medium">{driverName}</span>
        <span className="num text-sm text-slate-500">
          {vehicleCode} · #{shift.shiftNo}
        </span>
        {shift.state === 'open' && canApprove ? (
          <Button variant="ghost" className="ms-auto" onClick={() => setAsking((v) => !v)}>
            {t.liveShifts.suspend}
          </Button>
        ) : null}
      </div>
      {shift.state === 'suspended' ? <p className="text-sm text-amber-700">{t.liveShifts.suspendedHint}</p> : null}
      {asking ? (
        <div className="flex flex-col gap-2">
          <Field label={t.liveShifts.incidentNote}>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {err ? <p className="text-sm text-red-600">{explainError(err, t)}</p> : null}
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" disabled={busy} onClick={suspend}>
              {busy ? t.common.loading : t.liveShifts.suspend}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setAsking(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
