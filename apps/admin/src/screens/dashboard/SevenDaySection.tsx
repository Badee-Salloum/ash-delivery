import type { ReactNode } from 'react'
import { formatBusinessDate, formatBusinessDateRange } from '@ash/client'
import { minor, parseMinor } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Card, FOCUS_RING, Money, Pending, Table } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { LastSevenDaysSnapshot } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/**
 * A compact history under the live facts. It owns a fixed server-side lookback rather than the
 * page's period selection, so a manager always sees the last seven business days at a glance.
 */
export function SevenDaySection(): ReactNode {
  const { lang, t } = useApp()
  const { data, error, retry } = useDashboardRead<LastSevenDaysSnapshot>('/dashboard/last-seven-days')
  const range = data ? formatBusinessDateRange(data.from, data.to, lang) : null
  const subtitle = range
    ? t.dashboard.lastSevenDaysRange.replace('{from}', range.from).replace('{to}', range.to)
    : t.dashboard.lastSevenDaysSubtitle

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-last-seven-days">
      <SectionHeading id="dashboard-last-seven-days" title={t.dashboard.lastSevenDaysTitle} subtitle={subtitle} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <Card>
          <Table
              head={[
                t.dashboard.day,
                { label: t.dashboard.totalShifts, numeric: true },
                { label: t.dashboard.ordinaryShiftCount, numeric: true },
                { label: t.dashboard.doubleCount, numeric: true },
                { label: t.dashboard.orders, numeric: true },
                { label: t.dashboard.orderValue, numeric: true },
                ...(data.profitVisible
                  ? [
                      { label: t.dashboard.companyShareLabel, numeric: true } as const,
                      { label: t.dashboard.expensesLabel, numeric: true } as const,
                      { label: t.dashboard.netProfit, numeric: true } as const,
                    ]
                  : []),
                t.dashboard.viewDetails,
              ]}
              isEmpty={data.days.length === 0}
              empty={t.dashboard.noSevenDayData}
            >
              {data.days.map((day) => {
                const net = day.netProfitSyp ?? '0.00'
                const dayLabel = formatBusinessDate(day.businessDate, lang)
                return (
                  <tr key={day.businessDate}>
                    <td className="px-3 py-2 font-medium">
                      <span>{dayLabel}</span>
                      <span dir="ltr" className="num mt-0.5 block text-label text-ink-muted">{day.businessDate}</span>
                    </td>
                    <td className="num px-3 py-2 text-end">{day.shifts}</td>
                    <td className="num px-3 py-2 text-end">{day.ordinaryShifts}</td>
                    <td className="num px-3 py-2 text-end">{day.doubleShifts}</td>
                    <td className="num px-3 py-2 text-end">{day.orders}</td>
                    <td className="px-3 py-2 text-end"><Money value={day.feesSyp} /></td>
                    {data.profitVisible ? (
                      <>
                        <td className="px-3 py-2 text-end"><Money value={day.companyShareSyp ?? '0.00'} /></td>
                        <td className="px-3 py-2 text-end"><Money value={day.expensesSyp ?? '0.00'} /></td>
                        <td className={`px-3 py-2 text-end font-semibold ${parseMinor(net) < minor(0n) ? 'text-danger-ink' : 'text-success-ink'}`}>
                          <Money value={net} />
                        </td>
                      </>
                    ) : null}
                    <td className="px-3 py-2 text-end">
                      <a
                        className={`text-label font-semibold text-brand underline ${FOCUS_RING}`}
                        href={drill.completedShifts({ from: day.businessDate, to: day.businessDate })}
                        aria-label={`${t.dashboard.viewDetails}: ${dayLabel}`}
                      >
                        {t.dashboard.viewDetails} ›
                      </a>
                    </td>
                  </tr>
                )
              })}
          </Table>
        </Card>
      )}
    </section>
  )
}
