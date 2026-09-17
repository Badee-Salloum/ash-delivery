import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import {
  MAX_COMPLETED_SHIFT_RANGE_DAYS,
  MAX_NARROWED_SHIFT_RANGE_DAYS,
  classifyShiftHistory,
  completedShiftFinancialTotals,
  completedShiftDates,
  type CompletedShiftFinancial,
  type CompletedShiftRangeError,
} from '../completed-shifts.ts'
import { SHIFT_TARGET_MINUTES, type ShiftPattern, type ShiftSlot, shortfallMinutes } from '@ash/domain'
import type { RangeSelection } from '@ash/domain'
import { type RouteParams, sanitizeParams } from '../route.ts'
import { useHashParams } from '../use-hash-params.ts'
import {
  browserStorage,
  cappedRange,
  initialSelection,
  narrowedSelection,
  paramsFromSelection,
  rangeDays,
  resolveSelection,
  sameSelection,
  writeStoredSelection,
} from '../time-range.ts'
import { TimeRangeBar, useRangeMeta } from '../components/TimeRangeBar.tsx'
import { damascusParts } from '@ash/client'
import { explainError } from '../errors.ts'
import { shiftPatternLabel, shiftPatternTone } from '../shift-shape.ts'
import { Badge, Button, Card, FOCUS_RING, Field, Money, Pending, Select, Stat, Table } from '../ui.tsx'

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
  /** `slot` is absent on an older API; the badge then reads the pattern alone. */
  worked?: { minutes: number | null; pattern: ShiftPattern; slot?: ShiftSlot | null; abandoned: boolean }
}

/*
 * How long each pattern is expected to run comes from the domain's `SHIFT_TARGET_MINUTES` — the
 * owner's schedule of 2026-09-17: eight hours for a morning or an evening, twelve for a double. A
 * double is judged against its own twelve, so a 10.5-hour double reads ninety minutes short rather
 * than two and a half hours of overtime. One table, shared with the dashboard, so the two screens
 * cannot disagree. Making it editable per branch belongs in `settings`, and is not yet wired.
 */

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
 * The period comes from the shared time filter (P2): the URL first, then this manager's last
 * choice, then «الكل منذ البدء». The server reads at most 31 days for the whole branch and 400 once
 * a driver or a vehicle narrows it; a longer selection shows «ضيّق الفترة» instead of a request.
 *
 * It never treats `cancelled` as a completed settlement: cancellation reverses funding and discards
 * the work, and is therefore displayed separately below the completed list.
 */
export function CompletedShifts({
  onOpen,
  initial = {},
}: {
  onOpen(shiftId: string): void
  /** The filters the link that opened this screen carried. Read once, at mount. */
  initial?: RouteParams
}): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const replaceParams = useHashParams()
  const { meta, error: metaError, retry: retryMeta } = useRangeMeta()
  const [selection, setSelection] = useState<RangeSelection>(() =>
    initialSelection({ params: initial, storage: browserStorage(), userId: session?.userId }),
  )
  const [retry, setRetry] = useState(0)
  const [rows, setRows] = useState<ShiftHistoryRow[] | null>(null)
  const [drivers, setDrivers] = useState<Record<string, DriverLite>>({})
  const [vehicles, setVehicles] = useState<Record<string, VehicleLite>>({})
  const [error, setError] = useState<string | null>(null)
  const [rangeError, setRangeError] = useState<CompletedShiftRangeError | null>(null)
  /*
   * Filters applied in the browser, over one range read.
   *
   * The range is the server's job because it decides how much crosses the wire; these decide what
   * a manager is looking for inside it, and re-reading the month to hide a driver would be a round
   * trip for something already in memory. Only a range longer than a month hands the driver and
   * vehicle to the server as well, because that is what lets the server read it at all.
   */
  const [driverFilter, setDriverFilter] = useState(initial.driver ?? '')
  const [vehicleFilter, setVehicleFilter] = useState(initial.vehicle ?? '')
  const [patternFilter, setPatternFilter] = useState<'' | ShiftPattern>(initial.pattern ?? '')
  const [onlyShort, setOnlyShort] = useState(initial.short === true)
  const [onlyAbandoned, setOnlyAbandoned] = useState(initial.abandoned === true)

  const applied: AppliedRange | null = meta ? resolveSelection(selection, meta) : null
  const narrowed = driverFilter !== '' || vehicleFilter !== ''
  const maxDays = narrowed ? MAX_NARROWED_SHIFT_RANGE_DAYS : MAX_COMPLETED_SHIFT_RANGE_DAYS
  /*
   * What is actually read. «الكل منذ البدء» is the default and soon outgrows the cap; an empty page
   * that only says so would greet every manager every morning. So a longer period shows its most
   * recent `maxDays` days, and the note above the list says exactly which days those are.
   */
  const capped = applied !== null && rangeDays(applied) > maxDays
  const shown: AppliedRange | null = applied !== null && capped ? cappedRange(applied, maxDays) : applied
  const serverNarrowed = shown !== null && rangeDays(shown) > MAX_COMPLETED_SHIFT_RANGE_DAYS
  const narrowQuery = serverNarrowed
    ? `${driverFilter !== '' ? `&driverId=${encodeURIComponent(driverFilter)}` : ''}${
        vehicleFilter !== '' ? `&vehicleId=${encodeURIComponent(vehicleFilter)}` : ''
      }`
    : ''

  // The selection and the filters live in the URL (replaced, not pushed) and the period in this
  // manager's browser, so a refresh, a shared link and the next visit all show the same thing.
  useEffect(() => {
    replaceParams(
      sanitizeParams({
        ...paramsFromSelection(selection),
        driver: driverFilter,
        vehicle: vehicleFilter,
        pattern: patternFilter,
        short: onlyShort,
        abandoned: onlyAbandoned,
      }),
    )
    if (session?.userId) writeStoredSelection(browserStorage(), session.userId, selection)
  }, [replaceParams, selection, driverFilter, vehicleFilter, patternFilter, onlyShort, onlyAbandoned, session?.userId])

  // Names for the rows and the filters. Independent of the range: a manager whose period is too
  // long still needs the lists to pick the driver or bike that makes it readable.
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    void Promise.all([
      api.get<{ drivers: DriverLite[] }>('/drivers', { cache: 'no-store', signal: controller.signal }),
      api.get<{ vehicles: VehicleLite[] }>('/vehicles', { cache: 'no-store', signal: controller.signal }),
    ])
      .then(([driverResponse, vehicleResponse]) => {
        if (!active) return
        setDrivers(Object.fromEntries(driverResponse.drivers.map((driver) => [driver.id, driver])))
        setVehicles(Object.fromEntries(vehicleResponse.vehicles.map((vehicle) => [vehicle.id, vehicle])))
      })
      .catch(() => undefined)
    return () => {
      active = false
      controller.abort()
    }
  }, [api, branchId])

  useEffect(() => {
    if (!shown) return
    const range = completedShiftDates(shown.from, shown.to, maxDays)
    if (!range.ok) {
      setRows([])
      setRangeError(range.reason)
      return
    }

    let active = true
    const controller = new AbortController()
    setRows(null)
    setError(null)
    setRangeError(null)

    const load = async (): Promise<void> => {
      try {
        /*
         * ONE request for the whole range.
         *
         * This walked the range a date at a time, seven in parallel — 33 requests to cover a month,
         * every one `no-store`, all of them returning every state so the browser could throw most of
         * it away. `GET /shifts` takes `from`/`to` over the same repo read the Sunday close
         * already uses, and caps it: a month for the branch, 400 days for one driver or bike.
         */
        const page = await api.get<{ shifts: ShiftHistoryRow[] }>(
          `/shifts?from=${encodeURIComponent(shown.from)}&to=${encodeURIComponent(shown.to)}${narrowQuery}`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (!active) return
        setRows(page.shifts)
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
  }, [api, shown?.from, shown?.to, maxDays, narrowQuery, branchId, retry])

  const changeSelection = (next: RangeSelection): void => {
    if (sameSelection(next, selection)) setRetry((value) => value + 1)
    else setSelection(next)
  }

  const rangeErrorLabel = (reason: CompletedShiftRangeError): string => {
    if (reason === 'dates_required') return t.completedShifts.datesRequired
    if (reason === 'date_order') return t.completedShifts.dateOrder
    return t.completedShifts.rangeTooLarge.replace('{n}', String(maxDays))
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
    const target = SHIFT_TARGET_MINUTES[row.worked.pattern]
    if (target === null) return null
    return shortfallMinutes(row.worked, target)
  }

  const matches = (row: ShiftHistoryRow): boolean => {
    if (driverFilter !== '' && row.driverId !== driverFilter) return false
    if (vehicleFilter !== '' && row.vehicleId !== vehicleFilter) return false
    if (patternFilter !== '' && (row.worked?.pattern ?? 'unknown') !== patternFilter) return false
    if (onlyShort && (shortOf(row) ?? 0) <= 0) return false
    if (onlyAbandoned && row.worked?.abandoned !== true) return false
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
  // the list with names that can only ever return an empty table — except when the period is too
  // long for the branch, where picking one from the roster is exactly what makes it readable.
  const optionIds = (fromRows: string[], directory: string[], selected: string): string[] =>
    [...new Set([...(serverNarrowed || rangeError === 'range_too_large' ? directory : fromRows), ...(selected === '' ? [] : [selected])])]
  const driverOptions = optionIds((rows ?? []).map((row) => row.driverId), Object.keys(drivers), driverFilter)
    .map((id) => ({ id, name: driverName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const vehicleOptions = optionIds((rows ?? []).map((row) => row.vehicleId), Object.keys(vehicles), vehicleFilter)
    .map((id) => ({ id, code: vehicleCode(id) }))
    .sort((a, b) => a.code.localeCompare(b.code))

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
            {/* «صباحية · 8س» — the pattern beside the target it is judged against. Every row here is
                approved or cancelled, never running, so an unclassified one reads «غير محدّد». */}
            <Badge tone={shiftPatternTone(shift.worked)}>
              {shiftPatternLabel(shift.worked, t.completedShifts)}
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
        <TimeRangeBar
          selection={selection}
          onChange={changeSelection}
          meta={meta}
          metaError={metaError}
          onRetryMeta={retryMeta}
          maxDays={maxDays}
        />
        {rows ? (
          <p className="mt-2 text-sm text-ink-secondary">
            {t.completedShifts.count}: <strong className="num text-ink">{history.completed.length}</strong>
          </p>
        ) : null}
        {capped && applied && shown ? (
          // Say exactly which days are on screen, what would show more, and offer to keep this period.
          <div role="status" className="mt-3 rounded-lg border border-info-line bg-info-surface p-3 text-sm text-info-ink">
            {t.completedShifts.rangeCapShown
              .replace(/\{n\}/g, String(maxDays))
              .replace('{from}', shown.from)
              .replace('{to}', shown.to)}{' '}
            {narrowed ? null : t.completedShifts.rangeCapHint.replace('{m}', String(MAX_NARROWED_SHIFT_RANGE_DAYS))}{' '}
            <button
              type="button"
              className={`font-semibold underline ${FOCUS_RING}`}
              onClick={() => changeSelection(narrowedSelection(applied, maxDays))}
            >
              {t.completedShifts.narrowRange}
            </button>
          </div>
        ) : rangeError ? (
          <p className="mt-2 text-label font-medium text-danger-ink">{rangeErrorLabel(rangeError)}</p>
        ) : null}
        {/*
          * The range is one read; these narrow it without another. Kept on a second line so the
          * period — the only control that costs a round trip — stays visually separate from the
          * ones that do not.
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
            <Field label={t.completedShifts.vehicle}>
              <Select value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)}>
                <option value="">{t.completedShifts.allVehicles}</option>
                {vehicleOptions.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.code}
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
            <label className="flex min-h-10 items-center gap-2 text-sm text-ink-secondary">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={onlyAbandoned}
                onChange={(event) => setOnlyAbandoned(event.target.checked)}
              />
              {t.completedShifts.onlyAbandoned}
            </label>
            {driverFilter !== '' || vehicleFilter !== '' || patternFilter !== '' || onlyShort || onlyAbandoned ? (
              <Button
                variant="ghost"
                className="min-h-10 px-3"
                onClick={() => {
                  setDriverFilter('')
                  setVehicleFilter('')
                  setPatternFilter('')
                  setOnlyShort(false)
                  setOnlyAbandoned(false)
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
          error={error ?? metaError}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error ?? metaError, t)}
          onRetry={() => (error ? setRetry((value) => value + 1) : retryMeta())}
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
