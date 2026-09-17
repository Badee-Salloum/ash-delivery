import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ShiftPattern, ShiftSlot } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { shiftPatternLabel, shiftPatternTone } from '../shift-shape.ts'
import { explainError } from '../errors.ts'
import { explainLiveShiftActionError, type LiveShiftApiError } from '../live-shift-error.ts'
import {
  forceClosePreparationReady,
} from '../settlement-review.ts'
import {
  clearPendingTranche,
  isStrictlyPositiveTrancheAmount,
  newPendingTranche,
  readPendingTranche,
  trancheRejectionDefinitelyDidNotCommit,
  writePendingTranche,
} from '../pending-tranche.ts'
import { Badge, Button, Card, Field, MoneyInput, Pending, Select, Stat, TextInput } from '../ui.tsx'
import { type LiveStateParam, type RouteParams, sanitizeParams } from '../route.ts'
import { useHashParams } from '../use-hash-params.ts'
import {
  hoursMinutes,
  liveCounts,
  liveElapsedMinutes,
  liveOverMinutes,
  liveTargetMinutes,
  matchesLiveFilters,
} from '../live-shifts.ts'

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
  /**
   * Which pattern the shift is, as far as it can be known while it is still running.
   *
   * The SLOT is known the moment the driver starts (before 15:00 local is the morning, otherwise the
   * evening); the pattern is not, because any shift that runs ten hours becomes a double. So a
   * running shift is `unknown` with its slot, and reads «جارية — صباحية».
   *
   * Optional: a console served during a rolling deploy against the previous API gets no `worked`,
   * and an API one version older serves no `slot`.
   */
  worked?: { minutes: number | null; pattern: ShiftPattern; slot?: ShiftSlot | null; abandoned: boolean }
  windowOpensAt?: string | null
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
export function LiveShifts({
  onOpen,
  initial = {},
}: {
  onOpen(shiftId: string): void
  /** The filters the link that opened this board carried (P2). Read once, at mount. */
  initial?: RouteParams
}): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const replaceParams = useHashParams()
  const [rows, setRows] = useState<ShiftRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)
  // The instant the rows were read — what «over target now» is measured at.
  const [readAtMs, setReadAtMs] = useState(() => Date.now())
  /*
   * Filters over the live read (P2). Driver, vehicle, status and «over target» travel in the URL,
   * so a dashboard tile can open the board already narrowed; the slot is a local view choice.
   */
  const [driverFilter, setDriverFilter] = useState(initial.driver ?? '')
  const [vehicleFilter, setVehicleFilter] = useState(initial.vehicle ?? '')
  const [stateFilter, setStateFilter] = useState<'' | LiveStateParam>(initial.state ?? '')
  const [slotFilter, setSlotFilter] = useState<'' | ShiftSlot>('')
  const [onlyOver, setOnlyOver] = useState(initial.over === true)

  useEffect(() => {
    replaceParams(
      sanitizeParams({ state: stateFilter, driver: driverFilter, vehicle: vehicleFilter, over: onlyOver }),
    )
  }, [replaceParams, stateFilter, driverFilter, vehicleFilter, onlyOver])

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
      .then((r) => {
        setRows(r.shifts.filter((s) => LIVE_STATES.has(s.state)))
        setReadAtMs(Date.now())
      })
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
        <p className="py-8 text-center text-slate-600">{t.liveShifts.none}</p>
      </Card>
    )
  }

  const filters = { driver: driverFilter, vehicle: vehicleFilter, state: stateFilter, slot: slotFilter, over: onlyOver }
  const shown = rows.filter((row) => matchesLiveFilters(row, filters, readAtMs))
  const counts = liveCounts(rows, readAtMs)
  // Everyone on the board, plus whoever a link named — so a filter is never a value the list lacks.
  const withSelected = (ids: string[], selected: string): string[] =>
    [...new Set([...ids, ...(selected === '' ? [] : [selected])])]
  const driverOptions = withSelected(rows.map((row) => row.driverId), driverFilter)
    .map((id) => ({ id, name: driverName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const vehicleOptions = withSelected(rows.map((row) => row.vehicleId), vehicleFilter)
    .map((id) => ({ id, code: vehicleCode(id) }))
    .sort((a, b) => a.code.localeCompare(b.code))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t.liveShifts.filterDriver}>
          <Select value={driverFilter} onChange={(e) => setDriverFilter(e.target.value)}>
            <option value="">{t.liveShifts.all}</option>
            {driverOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.liveShifts.filterVehicle}>
          <Select value={vehicleFilter} onChange={(e) => setVehicleFilter(e.target.value)}>
            <option value="">{t.liveShifts.all}</option>
            {vehicleOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.liveShifts.filterState}>
          <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as '' | LiveStateParam)}>
            <option value="">{t.liveShifts.all}</option>
            <option value="open">{t.liveShifts.stateOpen}</option>
            <option value="suspended">{t.liveShifts.stateSuspended}</option>
          </Select>
        </Field>
        <Field label={t.liveShifts.filterSlot}>
          <Select value={slotFilter} onChange={(e) => setSlotFilter(e.target.value as '' | ShiftSlot)}>
            <option value="">{t.liveShifts.all}</option>
            <option value="day">{t.completedShifts.patternDay}</option>
            <option value="evening">{t.completedShifts.patternEvening}</option>
          </Select>
        </Field>
        <label className="flex min-h-10 items-center gap-2 text-sm text-ink-secondary">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={onlyOver}
            onChange={(e) => setOnlyOver(e.target.checked)}
          />
          {t.liveShifts.onlyOver}
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t.liveShifts.countOpen} value={<span className="num">{counts.open}</span>} />
        <Stat label={t.liveShifts.countSuspended} value={<span className="num">{counts.suspended}</span>} />
        <Stat
          label={t.liveShifts.countOver}
          value={<span className="num">{counts.over}</span>}
          {...(counts.over > 0 ? { tone: 'danger' as const } : {})}
        />
      </div>
      {shown.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-ink-muted">{t.liveShifts.noneMatching}</p>
        </Card>
      ) : null}
      <div className="flex flex-col gap-2">
        {shown.map((s) => (
          <LiveRow
            key={s.id}
            shift={s}
            driverName={driverName(s.driverId)}
            vehicleCode={vehicleCode(s.vehicleId)}
            canApprove={canApprove}
            onChanged={load}
            onOpen={onOpen}
            readAtMs={readAtMs}
          />
        ))}
      </div>
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
  readAtMs,
}: {
  shift: ShiftRow
  driverName: string
  vehicleCode: string
  canApprove: boolean
  onChanged: () => void
  onOpen(shiftId: string): void
  /** When the board was read; elapsed time and «over target» are measured at this instant. */
  readAtMs: number
}): ReactNode {
  const { api, t, lang } = useApp()
  const [panel, setPanel] = useState<'none' | 'suspend' | 'tranche' | 'void' | 'forceClose'>('none')
  const [note, setNote] = useState('')
  const [trancheRecovery, setTrancheRecovery] = useState(() => readPendingTranche(shift.id))
  const [kind, setKind] = useState<'float' | 'topup'>(
    trancheRecovery.status === 'pending' ? trancheRecovery.operation.kind : 'float',
  )
  const [amount, setAmount] = useState(
    trancheRecovery.status === 'pending' ? trancheRecovery.operation.amount : '',
  )
  const trancheKindId = useId()
  const trancheAmountId = useId()
  const [reason, setReason] = useState('')
  const [odometerKm, setOdometerKm] = useState('')
  const [cashDeclared, setCashDeclared] = useState('')
  const [walletDeclared, setWalletDeclared] = useState('')
  const [forcePrefillFailed, setForcePrefillFailed] = useState(false)
  // How much work this void is about to destroy. Null until known; 0 means "nothing recorded".
  const [voidOrderCount, setVoidOrderCount] = useState<number | null>(null)
  const [voidAcknowledged, setVoidAcknowledged] = useState(false)
  const forceValuesEdited = useRef(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<LiveShiftApiError | null>(null)
  const forceCloseReady = forceClosePreparationReady(cashDeclared, walletDeclared)
  const elapsedMinutes = liveElapsedMinutes(shift.windowOpensAt, readAtMs)
  const targetMinutes = liveTargetMinutes(shift)
  const overMinutes = liveOverMinutes(shift, readAtMs)

  // A partially completed driver close may already contain real counted figures. Bring those
  // forward before asking the manager to type them again, but never overwrite a value the manager
  // starts editing while this request is in flight.
  useEffect(() => {
    if (panel !== 'forceClose') return
    let cancelled = false
    setForcePrefillFailed(false)
    void api
      .get<{ endPackage: { cashDeclared: string | null; walletDeclared: string | null } }>(`/shifts/${shift.id}/review`)
      .then((review) => {
        if (cancelled || forceValuesEdited.current) return
        setCashDeclared(review.endPackage.cashDeclared ?? '')
        setWalletDeclared(review.endPackage.walletDeclared ?? '')
      })
      .catch(() => {
        if (!cancelled) setForcePrefillFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [api, panel, shift.id])

  /*
   * WHAT THIS VOID IS ABOUT TO THROW AWAY.
   *
   * `voidHint` has always said «يتجاهل طلباتها», but it never said HOW MANY — and on the morning of
   * 2026-08-25 four shifts whose drivers had worked all night were voided one after another,
   * discarding 4,325 SYP of deliveries. `force-close` was available the whole time and preserves
   * them: `forceCloseLocked` submits the close draft's operations before settling.
   *
   * A count and a named alternative are what turn "use only when the shift produced no real
   * deliveries" from a sentence into a decision the manager can actually make.
   */
  useEffect(() => {
    if (panel !== 'void') return
    let cancelled = false
    setVoidOrderCount(null)
    void api
      .get<{ orders?: unknown[] }>(`/shifts/${shift.id}/review`)
      .then((review) => {
        if (!cancelled) setVoidOrderCount(review.orders?.length ?? 0)
      })
      .catch(() => {
        // Unknown is not zero. Leaving it null keeps the acknowledgement required.
        if (!cancelled) setVoidOrderCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [api, panel, shift.id])

  const suspend = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await api.suspendShift(shift.id, note.trim() === '' ? null : note.trim())
      setPanel('none')
      setNote('')
      onChanged()
    } catch (e) {
      setErr(e as LiveShiftApiError)
    } finally {
      setBusy(false)
    }
  }

  const disburse = async (): Promise<void> => {
    setErr(null)
    /*
     * ONE DURABLE KEY PER INTENDED DISBURSEMENT, persisted BEFORE the request and REUSED on every
     * retry. Reloading, navigating away, or losing the response must not turn the retry into a new
     * transfer of branch money.
     *
     * The server cannot tell a second tranche from a repeated one — SRS C-5 allows several a day
     * and the amounts may be identical — so it used to key the ledger on `tranches.length + 1`,
     * recomputed per request. A double tap on a slow office connection was therefore tranche #2:
     * twice the cash out, and BR1 then expecting money back the driver never received.
     *
     * The key and exact payload are cleared only after a successful/replayed response. While they
     * are pending the fields are locked: this reconciles the first handover instead of creating a
     * new handover with ambiguous details.
     */
    if (trancheRecovery.status === 'corrupt' || trancheRecovery.status === 'unavailable') return
    if (trancheRecovery.status === 'none' && !isStrictlyPositiveTrancheAmount(amount)) return

    let operation = trancheRecovery.status === 'pending' ? trancheRecovery.operation : null
    if (!operation) {
      try {
        operation = newPendingTranche(shift.id, kind, amount, crypto.randomUUID())
      } catch {
        setTrancheRecovery({ status: 'unavailable' })
        return
      }
      if (!writePendingTranche(operation)) {
        setTrancheRecovery({ status: 'unavailable' })
        return
      }
      setTrancheRecovery({ status: 'pending', operation })
    }

    setBusy(true)
    try {
      await api.addTranche(shift.id, {
        kind: operation.kind,
        amount: operation.amount,
        occurrenceKey: operation.occurrenceKey,
      })
      if (!clearPendingTranche(shift.id)) {
        // The POST succeeded, but retaining the exact locked operation is safer than allowing a
        // new key while durable storage still says this handover requires reconciliation.
        setTrancheRecovery({ status: 'pending', operation })
        return
      }
      setTrancheRecovery({ status: 'none' })
      setPanel('none')
      setAmount('')
      onChanged()
    } catch (e) {
      // An explicit client refusal (validation/auth/state) cannot have committed this request, so
      // the operator may correct it. Ambiguous transport/5xx failures and key conflicts keep the
      // exact operation locked for an idempotent reconciliation retry.
      if (trancheRejectionDefinitelyDidNotCommit(e) && clearPendingTranche(shift.id)) {
        setTrancheRecovery({ status: 'none' })
      }
      setErr(e as LiveShiftApiError)
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
      setErr(e as LiveShiftApiError)
    } finally {
      setBusy(false)
    }
  }

  const forceClose = async (): Promise<void> => {
    if (!forceCloseReady) return
    const parsedOdometer = odometerKm.trim() === '' ? null : Number(odometerKm)
    const anomalousOdometer =
      parsedOdometer !== null &&
      Number.isFinite(parsedOdometer) &&
      shift.odometerStart != null &&
      parsedOdometer < shift.odometerStart
    if (anomalousOdometer && !window.confirm(t.approval.odometerAnomalyConfirm)) return
    setBusy(true)
    setErr(null)
    try {
      await api.forceCloseShift(shift.id, {
        prepareOnly: true,
        reason: reason.trim(),
        odometerKm: parsedOdometer,
        odometerAnomalyConfirmed: anomalousOdometer,
        cashDeclared: cashDeclared.trim(),
        walletDeclared: walletDeclared.trim(),
      })
      onOpen(shift.id)
    } catch (e) {
      const error = e as LiveShiftApiError
      setErr(error)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (p: 'suspend' | 'tranche' | 'void' | 'forceClose'): void => {
    setErr(null)
    if (p === 'forceClose') {
      setForcePrefillFailed(false)
      if (panel !== 'forceClose') {
        forceValuesEdited.current = false
        setCashDeclared('')
        setWalletDeclared('')
      }
    }
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
        {/*
          * WHICH SLOT, while he is still out: «جارية — صباحية» or «جارية — مسائية».
          *
          * The slot is certain from the start; single or double is not — any shift that runs ten
          * hours becomes a double — so the badge names the slot and says the shift is running
          * rather than guessing a pattern that would relabel itself later.
          */}
        {shift.worked === undefined ? null : (
          <Badge tone={shiftPatternTone(shift.worked)}>
            {shiftPatternLabel(shift.worked, t.completedShifts, true)}
          </Badge>
        )}
        {/* P2 — past the slot's eight hours: a double only becomes one once it closes. */}
        {overMinutes !== null && overMinutes > 0 ? (
          <Badge tone="danger">{t.liveShifts.overBy.replace('{t}', hoursMinutes(overMinutes))}</Badge>
        ) : null}
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
                  {trancheRecovery.status === 'pending' ? t.liveShifts.resumeTranche : t.liveShifts.addTranche}
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
        {shift.businessDate ? <span className="text-slate-600">{shift.businessDate}</span> : null}
        {elapsedMinutes !== null && targetMinutes !== null ? (
          <span dir="ltr">
            {t.liveShifts.elapsedOfTarget
              .replace('{elapsed}', hoursMinutes(elapsedMinutes))
              .replace('{target}', hoursMinutes(targetMinutes))}
          </span>
        ) : null}
      </div>
      {shift.state === 'suspended' ? <p className="text-sm text-amber-700">{t.liveShifts.suspendedHint}</p> : null}
      {panel === 'suspend' ? (
        <div className="flex flex-col gap-2">
          <Field label={t.liveShifts.incidentNote}>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {err ? <p className="text-sm text-red-600">{explainLiveShiftActionError(err, 'suspend', lang, t)}</p> : null}
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
          {trancheRecovery.status === 'pending' ? (
            <p className="text-sm font-medium text-amber-800" role="status">
              {t.liveShifts.pendingTrancheHint}
            </p>
          ) : trancheRecovery.status === 'corrupt' ? (
            <p className="text-sm font-medium text-red-700" role="alert">
              {t.liveShifts.pendingTrancheCorrupt}
            </p>
          ) : trancheRecovery.status === 'unavailable' ? (
            <p className="text-sm font-medium text-red-700" role="alert">
              {t.liveShifts.safeRetryStorageUnavailable}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Field label={t.liveShifts.kind} htmlFor={trancheKindId}>
              <Select
                id={trancheKindId}
                value={kind}
                disabled={trancheRecovery.status === 'pending'}
                onChange={(e) => setKind(e.target.value as 'float' | 'topup')}
              >
                <option value="float">{t.liveShifts.float}</option>
                <option value="topup">{t.liveShifts.topup}</option>
              </Select>
            </Field>
            <Field
              label={t.liveShifts.amount}
              htmlFor={trancheAmountId}
              error={
                trancheRecovery.status === 'none' && amount.trim() !== '' && !isStrictlyPositiveTrancheAmount(amount)
                  ? t.liveShifts.positiveAmountRequired
                  : null
              }
            >
              <MoneyInput
                id={trancheAmountId}
                value={amount}
                disabled={trancheRecovery.status === 'pending'}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          {err ? <p className="text-sm text-red-600">{explainLiveShiftActionError(err, 'tranche', lang, t)}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              disabled={
                busy ||
                trancheRecovery.status === 'corrupt' ||
                trancheRecovery.status === 'unavailable' ||
                amount.trim() === '' ||
                (trancheRecovery.status === 'none' && !isStrictlyPositiveTrancheAmount(amount))
              }
              onClick={disburse}
            >
              {busy
                ? t.common.loading
                : trancheRecovery.status === 'pending'
                  ? t.liveShifts.resumeTranche
                  : t.liveShifts.addTranche}
            </Button>
            <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setPanel('none')}>
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
              <MoneyInput
                value={cashDeclared}
                onChange={(e) => {
                  forceValuesEdited.current = true
                  setCashDeclared(e.target.value)
                }}
                placeholder={t.liveShifts.requiredPlaceholder}
              />
            </Field>
            <Field label={t.liveShifts.walletDeclared}>
              <MoneyInput
                value={walletDeclared}
                onChange={(e) => {
                  forceValuesEdited.current = true
                  setWalletDeclared(e.target.value)
                }}
                placeholder={t.liveShifts.requiredPlaceholder}
              />
            </Field>
            <Field label={t.liveShifts.odometerKm}>
              <TextInput inputMode="numeric" value={odometerKm} onChange={(e) => setOdometerKm(e.target.value)} />
            </Field>
          </div>
          {forcePrefillFailed ? <p className="text-xs text-amber-700">{t.liveShifts.forcePrefillFailed}</p> : null}

          <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            {t.liveShifts.forcePrepareHint}
          </p>
          {err ? <p className="text-sm text-red-600">{explainLiveShiftActionError(err, 'forceClose', lang, t)}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              disabled={busy || reason.trim() === '' || !forceCloseReady}
              onClick={forceClose}
            >
              {busy ? t.common.loading : t.liveShifts.forcePrepare}
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
          {voidOrderCount !== null && voidOrderCount > 0 ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="alert">
              {t.liveShifts.voidDiscardsOrders.replace('{n}', String(voidOrderCount))}
            </p>
          ) : null}
          <p className="text-sm text-slate-700">{t.liveShifts.voidUseForceClose}</p>
          <Field label={t.liveShifts.overrideReason}>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {/* Unknown counts still require the acknowledgement: not knowing is not the same as zero. */}
          {voidOrderCount === null || voidOrderCount > 0 ? (
            <label className="flex items-start gap-2 text-sm text-red-800">
              <input
                type="checkbox"
                className="mt-1"
                checked={voidAcknowledged}
                onChange={(e) => setVoidAcknowledged(e.target.checked)}
              />
              <span>{t.liveShifts.voidAcknowledge}</span>
            </label>
          ) : null}
          {err ? <p className="text-sm text-red-600">{explainLiveShiftActionError(err, 'void', lang, t)}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              disabled={
                busy ||
                reason.trim() === '' ||
                ((voidOrderCount === null || voidOrderCount > 0) && !voidAcknowledged)
              }
              onClick={voidShift}
            >
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
