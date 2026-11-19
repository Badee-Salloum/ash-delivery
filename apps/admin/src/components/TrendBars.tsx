import type { ReactNode } from 'react'
import {
  type CalendarDate,
  bucketFor,
  bucketKey,
  bucketKeys,
  formatMinor,
  minor,
  parseMinor,
} from '@ash/domain'

export interface TrendPoint {
  date: CalendarDate
  value: string
}

export interface TrendBucket {
  key: CalendarDate
  value: bigint
}

/** Fill missing buckets and add exact minor units before any chart geometry is considered. */
export function bucketTrend(from: CalendarDate, to: CalendarDate, points: readonly TrendPoint[]): TrendBucket[] {
  const bucket = bucketFor(from, to)
  const totals = new Map<CalendarDate, bigint>(bucketKeys(from, to, bucket).map((key) => [key, 0n]))
  for (const point of points) {
    if (point.date < from || point.date > to) continue
    const key = bucketKey(point.date, bucket)
    totals.set(key, (totals.get(key) ?? 0n) + parseMinor(point.value))
  }
  return [...totals].map(([key, value]) => ({ key, value }))
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value)

/** Both endpoints and at most four intervening labels: never a wall of overlapping dates. */
export function trendTickIndexes(count: number): number[] {
  if (count <= 0) return []
  if (count <= 6) return Array.from({ length: count }, (_, index) => index)
  return Array.from({ length: 6 }, (_, index) => Math.round(index * (count - 1) / 5))
}

export function trendHeight(value: bigint, peak: bigint): bigint {
  if (value === 0n || peak === 0n) return 0n
  const ratio = abs(value) * 1800n / peak
  return ratio === 0n ? 1n : ratio
}

/** Decimal SVG units from hundredths, without converting a money value through Number. */
function svgDecimal(hundredths: bigint): string {
  const whole = hundredths / 100n
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

export function TrendBars({
  from,
  to,
  points,
  label,
  currencyLabel,
  tableLabels,
}: {
  from: CalendarDate
  to: CalendarDate
  points: readonly TrendPoint[]
  label: string
  currencyLabel?: string
  tableLabels?: { summary: string; date: string; amount: string }
}): ReactNode {
  const buckets = bucketTrend(from, to, points)
  const peak = buckets.reduce((largest, item) => (abs(item.value) > largest ? abs(item.value) : largest), 0n)
  const slot = 100 / Math.max(1, buckets.length)
  const width = slot * 0.62
  const ticks = new Set(trendTickIndexes(buckets.length))
  const amountLabel = (value: bigint): string => `${formatMinor(minor(value))}${currencyLabel ? ` ${currencyLabel}` : ''}`

  return (
    <div dir="ltr">
      <svg role="img" aria-label={`${label}: ${from} — ${to}${currencyLabel ? ` · ${currencyLabel}` : ''}`} viewBox="0 0 100 46" preserveAspectRatio="none" className="block h-36 w-full">
        <desc>{buckets.map(item => `${item.key}: ${amountLabel(item.value)}`).join('; ')}</desc>
        <rect x="0" y="20" width="100" height="0.3" className="text-line-strong" fill="currentColor" />
        {buckets.map((item, index) => {
          // 18.00 SVG units at the peak. Only the bounded ratio becomes geometry; money stays bigint.
          const height = trendHeight(item.value, peak)
          const negative = item.value < 0n
          return (
            <g key={item.key}>
              <title>{`${item.key}: ${amountLabel(item.value)}`}</title>
              <rect
                x={index * slot + (slot - width) / 2}
                y={negative ? '20' : svgDecimal(2000n - height)}
                width={width}
                height={svgDecimal(height)}
                className={negative ? 'text-danger-ink' : 'text-success-ink'}
                fill="currentColor"
              />
              {ticks.has(index) ? <text x={index === 0 ? 0 : index === buckets.length - 1 ? 100 : index * slot + slot / 2} y="43" textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'} className="fill-ink-muted text-[3px]">
                {item.key.slice(5)}
              </text> : null}
            </g>
          )
        })}
      </svg>
      {tableLabels ? <details className="mt-2" dir="auto"><summary className="cursor-pointer text-label text-brand">{tableLabels.summary}</summary><div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line"><table className="w-full text-body"><thead><tr className="border-b border-line text-label text-ink-muted"><th className="px-3 py-2 text-start" scope="col">{tableLabels.date}</th><th className="px-3 py-2 text-end" scope="col">{tableLabels.amount}</th></tr></thead><tbody>{buckets.map(item => <tr className="border-b border-line-subtle last:border-b-0" key={item.key}><td className="px-3 py-2"><bdi>{item.key}</bdi></td><td className="num px-3 py-2 text-end"><bdi dir="ltr">{amountLabel(item.value)}</bdi></td></tr>)}</tbody></table></div></details> : null}
    </div>
  )
}
