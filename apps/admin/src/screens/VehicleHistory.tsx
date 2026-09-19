import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { type DateRange, type RangeSelection, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { TimeRangeBar, useRangeMeta } from '../components/TimeRangeBar.tsx'
import { explainError } from '../errors.ts'
import type { RouteParams } from '../route.ts'
import {
  browserStorage,
  initialSelection,
  paramsFromSelection,
  resolveSelection,
  writeStoredSelection,
} from '../time-range.ts'
import { Card, FOCUS_RING, Money, PageHeader, Pending, Stat, Table } from '../ui.tsx'
import { useHashParams } from '../use-hash-params.ts'
import { useDashboardRead } from './dashboard/use-dashboard-read.ts'

interface HistoryOrder {
  id: string
  providerOrderNo: string
  fee: string
  included: boolean
}

interface HistoryShift {
  id: string
  businessDate: string
  shiftNo: number
  state: string
  driverName: string
  windowOpensAt: string | null
  submittedAt: string | null
  worked: { minutes: number | null; pattern: string; abandoned: boolean }
  odometerStart: number | null
  odometerEnd: number | null
  distance: { recorded: true; km: number } | { recorded: false; reason: string }
  orderCount: number
  orders: HistoryOrder[]
  financial: { deliveryFees: string; companyShare: string } | null
  batteryReadings: Array<{ batteryId: string; package: string; percent: number | null; slotNo: number }>
  batterySwaps: Array<{ id: string; slotNo: number; occurredAt: string }>
}

interface VehicleHistoryResponse {
  from: string
  to: string
  vehicle: { id: string; code: string; groundNo: string | null; state: string; active: boolean }
  distance: {
    distance: { km: number; recordedShifts: number; unrecordedShifts: number; missing: number; rollbacks: number }
    unloggedKm: number
    boundaryRollbacks: number
    unknownBoundaries: number
  }
  shifts: HistoryShift[]
  expenses: Array<{ id: string; businessDate: string; categoryName: string; description: string; amount: string }>
  events: Array<{
    id: number
    kind: string
    businessDate: string
    odometerKm: number | null
    cost: string | null
    expenseId: string | null
    notes: string | null
  }>
  asset?: null | {
    id: string
    currency: 'SYP_NEW' | 'USD'
    price: string
    purchasedOn: string
    paidNow: string
    outstanding: string
    bookValue: string
    depreciationDue: string
    depreciationFunded: string
  }
  companyExpenses?: Array<{
    id: string
    businessDate: string
    occurredOn: string
    currency: 'SYP_NEW' | 'USD'
    amount: string
    description: string
  }>
}

function paramsFor(id: string, selection: RangeSelection): RouteParams {
  const range = paramsFromSelection(selection)
  return {
    id,
    range: range.range,
    ...(range.from === undefined ? {} : { from: range.from }),
    ...(range.to === undefined ? {} : { to: range.to }),
  }
}

export function VehicleHistory({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { session, t } = useApp()
  const replaceParams = useHashParams()
  const vehicleId = initial.id ?? ''
  const [selection, setSelection] = useState<RangeSelection>(() =>
    initialSelection({ params: initial, storage: browserStorage(), userId: session?.userId }),
  )
  const { meta, error: metaError, retry: retryMeta } = useRangeMeta()
  const range = useMemo(() => (meta ? resolveSelection(selection, meta) : null), [meta, selection])
  const changeSelection = useCallback((next: RangeSelection): void => {
    setSelection(next)
    replaceParams(paramsFor(vehicleId, next))
    if (session) writeStoredSelection(browserStorage(), session.userId, next)
  }, [replaceParams, session, vehicleId])

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t.vehicleHistory.title}
        subtitle={t.vehicleHistory.subtitle}
        actions={<a className={`text-label font-semibold text-brand underline ${FOCUS_RING}`} href="#fleet">{t.vehicleHistory.backToFleet}</a>}
      />
      <TimeRangeBar
        selection={selection}
        onChange={changeSelection}
        meta={meta}
        metaError={metaError}
        onRetryMeta={retryMeta}
      />
      {vehicleId === '' ? (
        <Card><p className="text-body text-ink-muted">{t.vehicleHistory.noVehicle}</p></Card>
      ) : range ? (
        <VehicleHistoryData vehicleId={vehicleId} range={range} />
      ) : null}
    </div>
  )
}

function VehicleHistoryData({ vehicleId, range }: { vehicleId: string; range: DateRange }): ReactNode {
  const { t } = useApp()
  const path = `/vehicles/${encodeURIComponent(vehicleId)}/history?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  const { data, error, retry } = useDashboardRead<VehicleHistoryResponse>(path)
  if (data === null) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={retry} retryLabel={t.common.retry} />
  }
  const orderCount = data.shifts.reduce((total, shift) => total + shift.orderCount, 0)
  const expenseTotal = data.expenses.reduce((total, expense) => total + parseMinor(expense.amount), 0n)
  const expenseText = `${expenseTotal / 100n}.${String((expenseTotal < 0n ? -expenseTotal : expenseTotal) % 100n).padStart(2, '0')}`

  return (
    <div className="flex flex-col gap-4">
      <Card title={data.vehicle.groundNo ?? data.vehicle.code} subtitle={`${data.vehicle.code} · ${data.vehicle.state}`}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label={t.vehicleHistory.shifts} value={data.shifts.length} />
          <Stat lead label={t.vehicleHistory.distance} value={data.distance.distance.km} sub={t.vehicleHistory.km} />
          <Stat label={t.vehicleHistory.unlogged} value={data.distance.unloggedKm} sub={t.vehicleHistory.km} {...(data.distance.unloggedKm > 0 ? { tone: 'warning' as const } : {})} />
          <Stat label={t.vehicleHistory.unknownDistance} value={data.distance.distance.unrecordedShifts} />
          <Stat label={t.vehicleHistory.orders} value={orderCount} />
          <Stat label={t.vehicleHistory.vehicleExpenses} value={<Money value={expenseText} />} />
        </div>
      </Card>

      <Card title={t.vehicleHistory.shiftHistory}>
        <Table
          head={[t.vehicleHistory.date, t.vehicleHistory.driver, t.vehicleHistory.status, t.vehicleHistory.duration, t.vehicleHistory.odometer, { label: t.vehicleHistory.distance, numeric: true }, { label: t.vehicleHistory.orders, numeric: true }]}
          isEmpty={data.shifts.length === 0}
          empty={t.vehicleHistory.noShifts}
        >
          {data.shifts.map((shift) => (
            <tr key={shift.id}>
              <td className="num px-3 py-2"><a className="text-brand underline" href={`#shift:${shift.id}`}>{shift.businessDate} · #{shift.shiftNo}</a></td>
              <td className="px-3 py-2">{shift.driverName}</td>
              <td className="px-3 py-2">{shift.state}</td>
              <td className="num px-3 py-2">{shift.worked.minutes === null ? '—' : `${Math.floor(shift.worked.minutes / 60)}:${String(shift.worked.minutes % 60).padStart(2, '0')}`}</td>
              <td className="num px-3 py-2">{shift.odometerStart ?? '—'} → {shift.odometerEnd ?? '—'}</td>
              <td className="num px-3 py-2 text-end">{shift.distance.recorded ? shift.distance.km : '—'}</td>
              <td className="num px-3 py-2 text-end">{shift.orderCount}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title={t.vehicleHistory.expenses}>
          <Table head={[t.vehicleHistory.date, t.vehicleHistory.category, t.vehicleHistory.description, { label: t.vehicleHistory.amount, numeric: true }]} isEmpty={data.expenses.length === 0} empty={t.vehicleHistory.noExpenses}>
            {data.expenses.map((expense) => (
              <tr key={expense.id}>
                <td className="num px-3 py-2">{expense.businessDate}</td>
                <td className="px-3 py-2">{expense.categoryName}</td>
                <td className="px-3 py-2">{expense.description}</td>
                <td className="px-3 py-2 text-end"><Money value={expense.amount} /></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={t.vehicleHistory.events}>
          {data.events.length === 0 ? <p className="text-body text-ink-muted">{t.vehicleHistory.noEvents}</p> : (
            <ul className="flex flex-col gap-2">
              {data.events.map((event) => (
                <li key={event.id} className="border-b border-line-subtle pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-ink">{event.kind}</span>
                    <span className="num text-label text-ink-muted">{event.businessDate}</span>
                  </div>
                  {event.notes ? <p className="text-body text-ink-secondary">{event.notes}</p> : null}
                  <div className="flex gap-3 text-label text-ink-muted">
                    {event.odometerKm === null ? null : <span className="num">{event.odometerKm} {t.vehicleHistory.km}</span>}
                    {event.cost === null ? null : <Money value={event.cost} />}
                    {event.expenseId === null ? null : <span>{t.vehicleHistory.linkedExpense}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {'asset' in data ? (
        data.asset === null ? (
          <Card title={t.vehicleHistory.asset}><p className="text-body text-ink-muted">{t.vehicleHistory.assetUnavailable}</p></Card>
        ) : (
          <Card title={t.vehicleHistory.asset}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label={t.companyFinance.price} value={<Money value={data.asset.price} currency={data.asset.currency} />} />
              <Stat lead label={t.companyFinance.bookValue} value={<Money value={data.asset.bookValue} currency={data.asset.currency} />} />
              <Stat label={t.companyFinance.outstanding} value={<Money value={data.asset.outstanding} currency={data.asset.currency} />} />
              <Stat label={t.companyFinance.depreciationDue} value={<Money value={data.asset.depreciationDue} currency={data.asset.currency} />} />
            </div>
          </Card>
        )
      ) : null}
      {data.companyExpenses && data.companyExpenses.length > 0 ? (
        <Card title={t.companyFinance.periodExpense}>
          <Table head={[t.companyFinance.date, t.companyFinance.description, { label: t.companyFinance.amount, numeric: true }]}>
            {data.companyExpenses.map((expense) => (
              <tr key={expense.id}>
                <td className="num px-3 py-2">{expense.occurredOn}</td>
                <td className="px-3 py-2">{expense.description}</td>
                <td className="px-3 py-2 text-end"><Money value={expense.amount} currency={expense.currency} /></td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </div>
  )
}
