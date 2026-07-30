import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, Field, MoneyInput, Pending, Select, TextInput } from '../ui.tsx'

interface ShiftRow {
  id: string
  driverId: string
  vehicleId: string
  shiftNo: number
  state: string
  /** Enough to judge a running shift without opening it. */
  businessDate?: string
  odometerStart?: number | null
  floatTotal?: string
  topupTotal?: string
  orderCount?: number
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

/**
 * The shifts that are out working right now: running, or on hold.
 *
 * DELIBERATELY narrower than the domain's `LIVE_STATES`, which also counts `draft`,
 * `awaiting_open_approval` and `pending_review` — that set answers "does this shift still occupy
 * its bike and driver", which is the right question for the GPS map and the assignment guards. This
 * screen answers a different one: "who is out on the road and can I act on him". A shift waiting for
 * a signature belongs in «قائمة الاعتماد», and listing it here as well would put the same shift in
 * two places with two different meanings.
 */
const LIVE_STATES = new Set(['open', 'suspended'])

/**
 * «النوبات الجارية» — who is out right now. A manager suspends a shift for a mid-shift incident
 * (SRS C-1 / س29) here; the driver resumes it himself from his phone once he can carry on. A
 * suspended shift still closes under the same BR1 — suspension is never a way around the equation.
 */
export function LiveShifts({ onOpen }: { onOpen(shiftId: string): void }): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const [rows, setRows] = useState<ShiftRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)

  // Suspend / tranche are `shift.approve` — held by the branch manager (his branch), the GM and the
  // system admin (both organisation-wide), per the §3 matrix. UI hiding is not security; the API
  // enforces the same grant.
  const canApprove =
    session?.roleKey === 'branch_manager' || session?.roleKey === 'general_manager' || session?.roleKey === 'system_admin'

  const load = useCallback(() => {
    setError(null)
    void api
      // `live=1`: who is out RIGHT NOW, regardless of business date — a shift that opened before
      // midnight and is still running is exactly the one a manager needs to reach, and the
      // date-filtered list dropped it.
      .get<{ shifts: ShiftRow[] }>('/shifts?live=1')
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
        <LiveRow
          key={s.id}
          shift={s}
          driverName={driverName(s.driverId)}
          vehicleCode={vehicleCode(s.vehicleId)}
          canApprove={canApprove}
          onChanged={load}
          onOpen={onOpen}
        />
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
  onOpen,
}: {
  shift: ShiftRow
  driverName: string
  vehicleCode: string
  canApprove: boolean
  onChanged: () => void
  onOpen(shiftId: string): void
}): ReactNode {
  const { api, t } = useApp()
  const [panel, setPanel] = useState<'none' | 'suspend' | 'tranche' | 'void' | 'forceClose'>('none')
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<'float' | 'topup'>('float')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [odometerKm, setOdometerKm] = useState('')
  const [cashDeclared, setCashDeclared] = useState('')
  const [walletDeclared, setWalletDeclared] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const suspend = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.suspendShift(shift.id, note.trim() === '' ? null : note.trim())
      setPanel('none')
      setNote('')
      onChanged()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  const disburse = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.addTranche(shift.id, { kind, amount })
      setPanel('none')
      setAmount('')
      onChanged()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  const voidShift = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.voidShift(shift.id, reason.trim())
      setPanel('none')
      setReason('')
      onChanged()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  const forceClose = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.forceCloseShift(shift.id, {
        reason: reason.trim(),
        odometerKm: odometerKm.trim() === '' ? null : Number(odometerKm),
        cashDeclared: cashDeclared.trim() === '' ? null : cashDeclared,
        walletDeclared: walletDeclared.trim() === '' ? null : walletDeclared,
      })
      setPanel('none')
      setReason('')
      setOdometerKm('')
      setCashDeclared('')
      setWalletDeclared('')
      onChanged()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (p: 'suspend' | 'tranche' | 'void' | 'forceClose'): void => {
    setErr(null)
    setPanel((cur) => (cur === p ? 'none' : p))
  }

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={shift.state === 'suspended' ? 'amber' : 'green'}>
          {t.shift.states[shift.state as keyof typeof t.shift.states] ?? shift.state}
        </Badge>
        <span className="font-medium">{driverName}</span>
        <span className="num text-sm text-slate-500">
          {vehicleCode} · #{shift.shiftNo}
        </span>
        {canApprove ? (
          <div className="flex flex-wrap gap-2 ms-auto">
            {/* Opens the shift's own screen — where a manager records an order on a driver who is
                still out. It was reachable only from the approval queue, so a running shift could
                not be touched at all. */}
            <Button variant="ghost" onClick={() => onOpen(shift.id)}>
              {t.liveShifts.openShift}
            </Button>
            {shift.state === 'open' ? (
              <>
                <Button variant="ghost" onClick={() => toggle('tranche')}>
                  {t.liveShifts.addTranche}
                </Button>
                <Button variant="ghost" onClick={() => toggle('suspend')}>
                  {t.liveShifts.suspend}
                </Button>
              </>
            ) : null}
            <Button variant="ghost" onClick={() => toggle('forceClose')}>
              {t.liveShifts.forceClose}
            </Button>
            <Button variant="ghost" onClick={() => toggle('void')}>
              {t.liveShifts.void}
            </Button>
          </div>
        ) : null}
      </div>
      {/* What the manager wants at a glance: the branch money the driver is carrying, how much work
          is on the shift so far, and the odometer he left on. A shift that opened yesterday and is
          still running shows its own date, so «جارية منذ أمس» is visible rather than surprising. */}
      <div className="num flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          {t.shift.cashFloat}: {shift.floatTotal ?? '—'}
        </span>
        <span>
          {t.shift.walletTopup}: {shift.topupTotal ?? '—'}
        </span>
        <span>
          {t.orders.title}: {shift.orderCount ?? 0}
        </span>
        <span>
          {t.shift.odometer}: {shift.odometerStart ?? '—'}
        </span>
        {shift.businessDate ? <span className="text-slate-400">{shift.businessDate}</span> : null}
      </div>
      {shift.state === 'suspended' ? <p className="text-sm text-amber-700">{t.liveShifts.suspendedHint}</p> : null}
      {panel === 'suspend' ? (
        <div className="flex flex-col gap-2">
          <Field label={t.liveShifts.incidentNote}>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {err ? <p className="text-sm text-red-600">{explainError(err, t)}</p> : null}
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" disabled={busy} onClick={suspend}>
              {busy ? t.common.loading : t.liveShifts.suspend}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setPanel('none')}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {panel === 'tranche' ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Field label={t.liveShifts.kind}>
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'float' | 'topup')}>
                <option value="float">{t.liveShifts.float}</option>
                <option value="topup">{t.liveShifts.topup}</option>
              </Select>
            </Field>
            <Field label={t.liveShifts.amount}>
              <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          {err ? <p className="text-sm text-red-600">{explainError(err, t)}</p> : null}
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" disabled={busy || amount.trim() === ''} onClick={disburse}>
              {busy ? t.common.loading : t.liveShifts.addTranche}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setPanel('none')}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {panel === 'forceClose' ? (
        <div className="flex flex-col gap-2 border-t border-slate-200 pt-2">
          <p className="text-sm text-slate-600">{t.liveShifts.forceCloseHint}</p>
          <Field label={t.liveShifts.overrideReason}>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Field label={t.liveShifts.cashDeclared}>
              <MoneyInput value={cashDeclared} onChange={(e) => setCashDeclared(e.target.value)} placeholder={t.liveShifts.expectedPlaceholder} />
            </Field>
            <Field label={t.liveShifts.walletDeclared}>
              <MoneyInput value={walletDeclared} onChange={(e) => setWalletDeclared(e.target.value)} placeholder={t.liveShifts.expectedPlaceholder} />
            </Field>
            <Field label={t.liveShifts.odometerKm}>
              <TextInput inputMode="numeric" value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} />
            </Field>
          </div>
          {err ? <p className="text-sm text-red-600">{explainError(err, t)}</p> : null}
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" disabled={busy || reason.trim() === ''} onClick={forceClose}>
              {busy ? t.common.loading : t.liveShifts.forceClose}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setPanel('none')}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {panel === 'void' ? (
        <div className="flex flex-col gap-2 border-t border-slate-200 pt-2">
          <p className="text-sm text-red-700">{t.liveShifts.voidHint}</p>
          <Field label={t.liveShifts.overrideReason}>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {err ? <p className="text-sm text-red-600">{explainError(err, t)}</p> : null}
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" disabled={busy || reason.trim() === ''} onClick={voidShift}>
              {busy ? t.common.loading : t.liveShifts.void}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setPanel('none')}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
