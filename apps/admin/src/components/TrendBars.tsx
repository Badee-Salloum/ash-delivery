import type { ReactNode } from 'react'
import {
  type CalendarDate,
  bucketFor,
  bucketKey,
  bucketKeys,
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
    const key = bucketKey(point.date, bucket)
    totals.set(key, (totals.get(key) ?? 0n) + parseMinor(point.value))
  }
  return [...totals].map(([key, value]) => ({ key, value }))
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value)

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
}: {
  from: CalendarDate
  to: CalendarDate
  points: readonly TrendPoint[]
  label: string
}): ReactNode {
  const buckets = bucketTrend(from, to, points)
  const peak = buckets.reduce((largest, item) => (abs(item.value) > largest ? abs(item.value) : largest), 0n)
  const slot = 100 / Math.max(1, buckets.length)
  const width = Math.max(0.8, slot * 0.62)

  return (
    <div dir="ltr">
      <svg role="img" aria-label={label} viewBox="0 0 100 46" preserveAspectRatio="none" className="block h-28 w-full">
        <rect x="0" y="20" width="100" height="0.3" className="text-line-strong" fill="currentColor" />
        {buckets.map((item, index) => {
          // 18.00 SVG units at the peak. Only the bounded ratio becomes geometry; money stays bigint.
          const magnitude = peak === 0n ? 0n : (abs(item.value) * 1800n) / peak
          const height = magnitude === 0n ? 40n : magnitude
          const negative = item.value < 0n
          return (
            <g key={item.key}>
              <title>{`${item.key}: ${item.value}`}</title>
              <rect
                x={index * slot + (slot - width) / 2}
                y={negative ? '20' : svgDecimal(2000n - height)}
                width={width}
                height={svgDecimal(height)}
                className={negative ? 'text-danger-ink' : 'text-success-ink'}
                fill="currentColor"
              />
              <text x={index * slot + slot / 2} y="43" textAnchor="middle" className="fill-ink-muted text-[3px]">
                {item.key.slice(5)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
