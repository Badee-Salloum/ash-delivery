import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useApp } from '../app-context.tsx'
import {
  MAX_COMPLETED_SHIFT_RANGE_DAYS,
  classifyShiftHistory,
  completedShiftFinancialTotals,
  completedShiftDates,
  defaultCompletedShiftRange,
  type CompletedShiftFinancial,
  type CompletedShiftRangeError,
} from '../completed-shifts.ts'
import { type ShiftPattern, shortfallMinutes } from '@ash/domain'
import { damascusParts } from '@ash/client'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, DateField, Field, Money, Pending, Select, Stat, Table } from '../ui.tsx'

interface ShiftHistoryRow {
  id: string
  driverId: string
  vehicleId: string
  shiftNo: number
  state: string
  businessDate: string
  floatTotal: string
  topupTotal: string
  orderCount: number
  /** Optional during the additive API/admin rollout; old API rows are treated as unavailable. */
  financial?: CompletedShiftFinancial | null
  /** When it ran. Absent on a bundle talking to an older API; the columns then read «—». */
  windowOpensAt?: string | null
  submittedAt?: string | null
  worked?: { minutes: number | null; pattern: ShiftPattern; abandoned: boolean }
}

/**
 * How long each pattern is expected to run.
 *
 * The owner's rule is eight hours, and a `full` shift covers both slots — so judging it against one
 * slot would present a 13-hour shift as five hours of overtime when it is three hours short of the
 * two slots it replaced. Measured medians for context: day 8.10 h, evening 6.73 h, full ~13 h.
 *
 * Named here as the policy default. Making it editable per branch belongs in `settings`, beside the
 * FX rate, and is not yet wired.
 */
const TARGET_MINUTES: Record<ShiftPattern, number | null> = {
  day: 8 * 60,
  evening: 8 * 60,
  full: 16 * 60,
  unknown: null,
}

/** «7:24». Latin digits and a fixed shape, like every other figure in the console. */
function hoursAndMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

interface DriverLite {
  id: string
  fullNameAr: string
  fullNameEn: string | null
}

interface VehicleLite {
  id: string
  code: string
}

interface AppliedRange {
  from: string
  to: string
}

/**
 * Prior financially completed shifts for the selected branch.
 *
 * GET /shifts is intentionally date-scoped, so this view reads a bounded range in small batches.
 * It never treats `cancelled` as a completed settlement: cancellation reverses funding and discards
 * the work, and is therefore displayed separately below the completed list.
 */
export function CompletedShifts({ onOpen }: { onOpen(shiftId: string): void }): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const initialRange = useMemo(
    () => defaultCompletedShiftRange(session?.businessDate ?? ''),
    [session?.businessDate],
  )
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [applied, setApplied] = useState<AppliedRange>(initialRange)
  const [retry, setRetry] = useState(0)
  const [rows, setRows] = useState<ShiftHistoryRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)
  const [rangeError, setRangeError] = useState<CompletedShiftRangeError | null>(null)
  /*
   * Filters applied in the browser, over one range read.
   *
   * The range is the server's job because it decides how much crosses the wire; these three decide
   * what a manager is looking for inside it, and re-reading the month to hide a driver would be a
   * round trip for something already in memory.
   */
  const [driverFilter, setDriverFilter] = useState('')
  const [patternFilter, setPatternFilter] = useState<'' | ShiftPattern>('')
  const [onlyShort, setOnlyShort] = useState(false)

  useEffect(() => {
    const range = completedShiftDates(applied.from, applied.to)
    if (!range.ok) {
      setRows([])
      setRangeError(range.reason)
      return
    }

    let active = true
    const controller = new AbortController()
    setRows(null)
    setError(null)

    const load = async (): Promise<void> => {
      try {
        /*
         * ONE request for the whole range.
         *
         * This walked the range a date at a time, seven in parallel — 33 requests to cover a month,
         * every one `no-store`, all of them returning every state so the browser could throw most of
         * it away. `GET /shifts` now takes `from`/`to` over the same repo read the Sunday close
         * already uses.
         */
        const page = await api.get<{ shifts: ShiftHistoryRow[] }>(
          `/shifts?from=${encodeURIComponent(applied.from)}&to=${encodeURIComponent(applied.to)}`,
          { cache: 'no-store', signal: controller.signal },
        )

        const [driverResponse, vehicleResponse] = await Promise.all([
          api.get<{ drivers: DriverLite[] }>('/drivers', { cache: 'no-store', signal: controller.signal }),
          api.get<{ vehicles: VehicleLite[] }>('/vehicles', { cache: 'no-store', signal: controller.signal }),
        ])
        if (!active) return
        setRows(page.shifts)
        setDrivers(Object.fromEntries(driverResponse.drivers.map((driver) => [driver.id, driver])))
        setVehicles(Object.fromEntries(vehicleResponse.vehicles.map((vehicle) => [vehicle.id, vehicle])))
      } catch (cause) {
        if (!active || (cause as { name?: string }).name === 'AbortError') return
        setError((cause as { error?: string }).error ?? 'error')
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [api, applied.from, applied.to, branchId, retry])

  const applyRange = (): void => {
    const range = completedShiftDates(from, to)
    if (!range.ok) {
      setRangeError(range.reason)
      return
    }
    setRangeError(null)
    if (from === applied.from && to === applied.to) setRetry((value) => value + 1)
    else setApplied({ from, to })
  }

  const rangeErrorLabel = (reason: CompletedShiftRangeError): string => {
    if (reason === 'dates_required') return t.completedShifts.datesRequired
    if (reason === 'date_order') return t.completedShifts.dateOrder
    return t.completedShifts.rangeTooLarge.replace('{n}', String(MAX_COMPLETED_SHIFT_RANGE_DAYS))
  }

  const driverName = (id: string): string => {
    const driver = drivers[id]
    if (!driver) return id.slice(0, 8)
    return (lang === 'en' ? driver.fullNameEn : null) ?? driver.fullNameAr
  }
  const vehicleCode = (id: string): string => vehicles[id]?.code ?? id.slice(0, 8)
  /** How far short of its own pattern's target, or null when there is nothing honest to say. */
  const shortOf = (row: ShiftHistoryRow): number | null => {
    if (!row.worked) return null
    const target = TARGET_MINUTES[row.worked.pattern]
    if (target === null) return null
    return shortfallMinutes(row.worked, target)
  }

  const matches = (row: ShiftHistoryRow): boolean => {
    if (driverFilter !== '' && row.driverId !== driverFilter) return false
    if (patternFilter !== '' && (row.worked?.pattern ?? 'unknown') !== patternFilter) return false
    if (onlyShort && (shortOf(row) ?? 0) <= 0) return false
    return true
  }

  const history = classifyShiftHistory((rows ?? []).filter(matches))
  const financialTotals = completedShiftFinancialTotals(history.completed)
  /*
   * Only shifts the classifier actually JUDGED may appear on either side of this count.
   *
   * «مكتملة» was `completed.length - shortRows.length`, a subtraction from the whole population —
   * so every row `shortOf` returns null for (an unknown pattern, a forgotten close, a row from an
   * older API with no `worked` at all) fell into the complement and was reported as having MET its
   * target. The screen was crediting drivers for shifts it had explicitly refused to judge.
   */
  const judgedRows = history.completed.filter((row) => shortOf(row) !== null)
  const shortRows = judgedRows.filter((row) => (shortOf(row) ?? 0) > 0)
  const metRows = judgedRows.filter((row) => shortOf(row) === 0)
  const unjudgedCount = history.completed.length - judgedRows.length
  const shortMinutes = shortRows.reduce((total, row) => total + (shortOf(row) ?? 0), 0)

  // Only drivers who actually worked inside the chosen range. Offering the whole roster would fill
  // the list with names that can only ever return an empty table.
  const driverOptions = [...new Set((rows ?? []).map((row) => row.driverId))]
    .map((id) => ({ id, name: driverName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const PATTERN_LABEL: Record<ShiftPattern, string> = {
    day: t.completedShifts.patternDay,
    evening: t.completedShifts.patternEvening,
    full: t.completedShifts.patternFull,
    unknown: t.completedShifts.patternUnknown,
  }

  /*
   * The date column, which is the whole reason this screen was unreadable.
   *
   * It rendered a bare ISO business date, so the thirteen shifts of 2026-09-06 were thirteen rows
   * saying «2026-09-06» and «#1». A business date alone cannot identify a shift on a day that runs
   * two of them, and it also reads a day early for a night shift, because the business day ends at
   * 04:00 and nothing said so. The clock times are what tell them apart.
   */
  const whenCell = (row: ShiftHistoryRow): ReactNode => {
    const started = row.windowOpensAt ? damascusParts(new Date(row.windowOpensAt)) : null
    const ended = row.submittedAt ? damascusParts(new Date(row.submittedAt)) : null
    const weekday = started ? t.common.weekdays[started.weekday] : null
    return (
      <div className="flex flex-col">
        <span className="num" dir="ltr">
          {row.businessDate}
          <span className="text-ink-faint"> #{row.shiftNo}</span>
        </span>
        <span className="text-label text-ink-muted">
          {weekday}
          {started ? (
            <span className="num" dir="ltr">
              {' '}
              {started.time}
              {ended ? ` → ${ended.time}` : ' → …'}
            </span>
          ) : null}
        </span>
      </div>
    )
  }

  const workedCell = (row: ShiftHistoryRow): ReactNode => {
    if (!row.worked || row.worked.minutes === null) return <span className="text-ink-faint">—</span>
    // A forgotten close package is not a long day, and must not be read as one.
    if (row.worked.abandoned) {
      return <Badge tone="warning">{t.completedShifts.notClosedOnTime}</Badge>
    }
    const short = shortOf(row)
    return (
      <span className="flex flex-wrap items-baseline gap-1.5">
        <span className="num" dir="ltr">
          {hoursAndMinutes(row.worked.minutes)}
        </span>
        {short !== null && short > 0 ? (
          <Badge tone="danger">{t.completedShifts.shortBy.replace('{t}', hoursAndMinutes(short))}</Badge>
        ) : null}
      </span>
    )
  }

  const table = (items: ShiftHistoryRow[], showDetails: boolean): ReactNode => (
    <Table
      head={[
        t.completedShifts.date,
        t.completedShifts.driver,
        t.completedShifts.vehicle,
        t.completedShifts.pattern,
        t.completedShifts.worked,
        t.completedShifts.orders,
        t.shift.cashFloat,
        t.shift.walletTopup,
        ...(showDetails ? [
          t.completedShifts.deliveryFees,
          t.completedShifts.companyShare,
          t.completedShifts.netDriverShare,
          t.completedShifts.deductions,
          t.completedShifts.variance,
          t.completedShifts.shortageReceivable,
          t.completedShifts.officeReturn,
        ] : []),
        t.completedShifts.status,
        ...(showDetails ? [t.completedShifts.action] : []),
      ]}
      isEmpty={items.length === 0}
      empty={showDetails ? t.completedShifts.none : t.completedShifts.noCancelled}
    >
      {items.map((shift) => (
        <tr key={shift.id}>
          <td className="whitespace-nowrap px-3 py-2">{whenCell(shift)}</td>
          <td className="px-3 py-2 font-medium">{driverName(shift.driverId)}</td>
          <td className="num px-3 py-2">{vehicleCode(shift.vehicleId)}</td>
          <td className="px-3 py-2">
            <Badge tone={shift.worked?.pattern === 'unknown' || !shift.worked ? 'neutral' : 'info'}>
              {PATTERN_LABEL[shift.worked?.pattern ?? 'unknown']}
            </Badge>
          </td>
          <td className="whitespace-nowrap px-3 py-2">{workedCell(shift)}</td>
          <td className="num px-3 py-2">{shift.orderCount}</td>
          <td className="px-3 py-2"><Money value={shift.floatTotal} /></td>
          <td className="px-3 py-2"><Money value={shift.topupTotal} /></td>
          {showDetails ? (
            shift.financial ? (
              <>
                <td className="px-3 py-2"><Money value={shift.financial.deliveryFees} /></td>
                <td className="px-3 py-2"><Money value={shift.financial.companyShare} /></td>
                <td className="px-3 py-2"><Money value={shift.financial.netDriverShare} /></td>
                <td className="px-3 py-2"><Money value={shift.financial.deductions} /></td>
                <td className="px-3 py-2">
                  <Money
                    value={shift.financial.variance}
                    className={
                      shift.financial.varianceDirection === 'shortage'
                        ? 'text-danger-ink'
                        : shift.financial.varianceDirection === 'surplus'
                          ? 'text-success-ink'
                          : ''
                    }
                  />
                </td>
                <td className="px-3 py-2"><Money value={shift.financial.cashShortageReceivable} /></td>
                <td className="px-3 py-2"><Money value={shift.financial.officeReturn} /></td>
              </>
            ) : (
              <>
                {Array.from({ length: 7 }, (_, index) => (
                  <td key={index} className="px-3 py-2 text-center text-ink-faint">—</td>
                ))}
              </>
            )
          ) : null}
          <td className="px-3 py-2">
            <Badge tone={shift.state === 'week_locked' ? 'slate' : shift.state === 'cancelled' ? 'red' : 'green'}>
              {t.shift.states[shift.state as keyof typeof t.shift.states] ?? shift.state}
            </Badge>
          </td>
          {showDetails ? (
            <td className="px-3 py-2">
              <Button variant="ghost" className="min-h-8 px-3" onClick={() => onOpen(shift.id)}>
                {t.completedShifts.view}
              </Button>
            </td>
          ) : null}
        </tr>
      ))}
    </Table>
  )

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.completedShifts.title}>
        <p className="mb-3 text-sm leading-6 text-ink-secondary">{t.completedShifts.intro}</p>
        <div className="flex flex-wrap items-end gap-3">
          <DateField label={t.completedShifts.from} value={from} onChange={setFrom} />
          <DateField label={t.completedShifts.to} value={to} onChange={setTo} />
          <Button variant="primary" onClick={applyRange}>{t.completedShifts.show}</Button>
          {rows ? (
            <span className="ms-auto text-sm text-ink-secondary">
              {t.completedShifts.count}: <strong className="num text-ink">{history.completed.length}</strong>
            </span>
          ) : null}
        </div>
        {rangeError ? <p className="mt-2 text-label font-medium text-danger-ink">{rangeErrorLabel(rangeError)}</p> : null}
        {/*
          * The range is one read; these narrow it without another. Kept on a second line so the
          * dates — the only controls that cost a round trip — stay visually separate from the ones
          * that do not.
          */}
        {rows ? (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
            <Field label={t.completedShifts.driver}>
              <Select value={driverFilter} onChange={(event) => setDriverFilter(event.target.value)}>
                <option value="">{t.completedShifts.allDrivers}</option>
                {driverOptions.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.completedShifts.pattern}>
              <Select
                value={patternFilter}
                onChange={(event) => setPatternFilter(event.target.value as '' | ShiftPattern)}
              >
                <option value="">{t.completedShifts.allPatterns}</option>
                <option value="day">{t.completedShifts.patternDay}</option>
                <option value="evening">{t.completedShifts.patternEvening}</option>
                <option value="full">{t.completedShifts.patternFull}</option>
                <option value="unknown">{t.completedShifts.patternUnknown}</option>
              </Select>
            </Field>
            <label className="flex min-h-10 items-center gap-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={onlyShort}
                onChange={(event) => setOnlyShort(event.target.checked)}
              />
              {t.completedShifts.onlyShort}
            </label>
            {driverFilter !== '' || patternFilter !== '' || onlyShort ? (
              <Button
                variant="ghost"
                className="min-h-10 px-3"
                onClick={() => {
                  setDriverFilter('')
                  setPatternFilter('')
                  setOnlyShort(false)
                }}
              >
                {t.completedShifts.clearFilters}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* A night shift carries the PREVIOUS date by design; without this the page looks a day out. */}
        <p className="mt-3 text-label text-ink-muted">{t.completedShifts.businessDayNote}</p>
      </Card>

      {!rows ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={() => setRetry((value) => value + 1)}
          retryLabel={t.common.retry}
        />
      ) : (
        <>
          <Card title={t.completedShifts.financialSummary}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-7">
              <Stat label={t.completedShifts.deliveryFees} value={<Money value={financialTotals.deliveryFees} />} />
              <Stat label={t.completedShifts.companyShare} value={<Money value={financialTotals.companyShare} />} />
              <Stat label={t.completedShifts.netDriverShare} value={<Money value={financialTotals.netDriverShare} />} />
              <Stat label={t.completedShifts.deductions} value={<Money value={financialTotals.deductions} />} />
              <Stat label={t.completedShifts.variance} value={<Money value={financialTotals.variance} />} />
              <Stat label={t.completedShifts.shortageReceivable} value={<Money value={financialTotals.cashShortageReceivable} />} />
              <Stat label={t.completedShifts.officeReturn} value={<Money value={financialTotals.officeReturn} />} />
            </div>
            {financialTotals.missingCount > 0 ? (
              <p className="mt-3 text-label font-medium text-warning-ink">
                {t.completedShifts.financialUnavailable.replace('{n}', String(financialTotals.missingCount))}
              </p>
            ) : null}
          </Card>
          <Card title={t.completedShifts.completedTitle}>
            {/*
              * Seventy of 113 measured shifts ran under eight hours, so this is the norm rather than
              * the incident — which is exactly why it needs a number at the top instead of a badge a
              * reader has to count for himself.
              */}
            {shortRows.length > 0 ? (
              <div className="mb-3 grid gap-3 sm:grid-cols-2">
                <Stat
                  label={t.completedShifts.underTarget}
                  value={<span className="num">{shortRows.length}</span>}
                  sub={t.completedShifts.shortSummary
                    .replace('{n}', String(shortRows.length))
                    .replace('{t}', hoursAndMinutes(shortMinutes))}
                  tone="warning"
                />
                <Stat
                  label={t.completedShifts.metTarget}
                  value={<span className="num">{metRows.length}</span>}
                  {...(unjudgedCount > 0
                    ? { sub: t.completedShifts.notJudged.replace('{n}', String(unjudgedCount)) }
                    : {})}
                />
              </div>
            ) : null}
            {table(history.completed, true)}
          </Card>
          <Card title={`${t.completedShifts.cancelledTitle} · ${history.cancelled.length}`}>
            <p className="mb-3 text-label leading-5 text-ink-secondary">{t.completedShifts.cancelledHint}</p>
            {table(history.cancelled, false)}
          </Card>
        </>
      )}
    </div>
  )
}
