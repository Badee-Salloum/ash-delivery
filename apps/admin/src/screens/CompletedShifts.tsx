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
import { explainError } from '../errors.ts'
import { Badge, Button, Card, DateField, Money, Pending, Stat, Table } from '../ui.tsx'

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

const READ_BATCH_SIZE = 7

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
        const pages: ShiftHistoryRow[][] = []
        // Keep the fan-out bounded even when the operator asks for the full 31-day window.
        for (let index = 0; index < range.dates.length; index += READ_BATCH_SIZE) {
          const dates = range.dates.slice(index, index + READ_BATCH_SIZE)
          const batch = await Promise.all(
            dates.map((date) =>
              api.get<{ shifts: ShiftHistoryRow[] }>(
                `/shifts?date=${encodeURIComponent(date)}`,
                { cache: 'no-store', signal: controller.signal },
              ),
            ),
          )
          pages.push(...batch.map((page) => page.shifts))
        }

        const [driverResponse, vehicleResponse] = await Promise.all([
          api.get<{ drivers: DriverLite[] }>('/drivers', { cache: 'no-store', signal: controller.signal }),
          api.get<{ vehicles: VehicleLite[] }>('/vehicles', { cache: 'no-store', signal: controller.signal }),
        ])
        if (!active) return
        setRows(pages.flat())
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
  const history = classifyShiftHistory(rows ?? [])
  const financialTotals = completedShiftFinancialTotals(history.completed)

  const table = (items: ShiftHistoryRow[], showDetails: boolean): ReactNode => (
    <Table
      head={[
        t.completedShifts.date,
        t.completedShifts.driver,
        t.completedShifts.vehicle,
        t.completedShifts.shiftNo,
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
          <td className="num whitespace-nowrap px-3 py-2 text-slate-600">{shift.businessDate}</td>
          <td className="px-3 py-2 font-medium">{driverName(shift.driverId)}</td>
          <td className="num px-3 py-2">{vehicleCode(shift.vehicleId)}</td>
          <td className="num px-3 py-2">#{shift.shiftNo}</td>
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
                        ? 'text-red-700'
                        : shift.financial.varianceDirection === 'surplus'
                          ? 'text-emerald-700'
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
                  <td key={index} className="px-3 py-2 text-center text-slate-400">—</td>
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
        <p className="mb-3 text-sm leading-6 text-slate-600">{t.completedShifts.intro}</p>
        <div className="flex flex-wrap items-end gap-3">
          <DateField label={t.completedShifts.from} value={from} onChange={setFrom} />
          <DateField label={t.completedShifts.to} value={to} onChange={setTo} />
          <Button variant="primary" onClick={applyRange}>{t.completedShifts.show}</Button>
          {rows ? (
            <span className="ms-auto text-sm text-slate-600">
              {t.completedShifts.count}: <strong className="num text-slate-900">{history.completed.length}</strong>
            </span>
          ) : null}
        </div>
        {rangeError ? <p className="mt-2 text-sm font-medium text-red-700">{rangeErrorLabel(rangeError)}</p> : null}
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
              <p className="mt-3 text-xs font-medium text-amber-700">
                {t.completedShifts.financialUnavailable.replace('{n}', String(financialTotals.missingCount))}
              </p>
            ) : null}
          </Card>
          <Card title={t.completedShifts.completedTitle}>
            {table(history.completed, true)}
          </Card>
          <Card title={`${t.completedShifts.cancelledTitle} · ${history.cancelled.length}`}>
            <p className="mb-3 text-xs leading-5 text-slate-600">{t.completedShifts.cancelledHint}</p>
            {table(history.cancelled, false)}
          </Card>
        </>
      )}
    </div>
  )
}
