/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { completedShiftsHref } from './drill.ts'

const dashboard = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')
const section = readFileSync(new URL('./screens/dashboard/SevenDaySection.tsx', import.meta.url), 'utf8')

describe('seven-day dashboard section', () => {
  it('sits directly after the live section and stays independent of the selected range', () => {
    const now = dashboard.indexOf('<NowSection')
    const sevenDays = dashboard.indexOf('<SevenDaySection')
    const selectedRange = dashboard.indexOf('{range ?')
    expect(now).toBeGreaterThan(-1)
    expect(sevenDays).toBeGreaterThan(now)
    expect(sevenDays).toBeLessThan(selectedRange)
  })

  it('uses the shared responsive table, server range formatter, role-gated columns, and day drill-down', () => {
    expect(section).toContain("useDashboardRead<LastSevenDaysSnapshot>('/dashboard/last-seven-days')")
    expect(section).toContain('formatBusinessDateRange(data.from, data.to, lang)')
    expect(section).toContain('<Table')
    expect(section).toContain('data.profitVisible')
    expect(section).toContain('drill.completedShifts({ from: day.businessDate, to: day.businessDate })')
    expect(section).toContain('aria-label={`${t.dashboard.viewDetails}: ${dayLabel}`}')
    expect(section).not.toContain('Intl.')
  })

  it('opens exactly one business day from each details link', () => {
    expect(completedShiftsHref({ from: '2026-09-26', to: '2026-09-26' })).toBe(
      '#completedShifts?range=custom&from=2026-09-26&to=2026-09-26',
    )
  })

  it('ships Arabic and English labels, with no day qualifier on fee revenue', () => {
    for (const catalog of [ar, en]) {
      for (const key of [
        'lastSevenDaysTitle', 'lastSevenDaysSubtitle', 'lastSevenDaysRange', 'totalShifts',
        'ordinaryShiftCount', 'orderValue', 'viewDetails', 'noSevenDayData',
      ] as const) {
        expect(catalog.dashboard[key].length, key).toBeGreaterThan(2)
      }
    }
    expect(ar.dashboard.revenue).toBe('إيراد الأجور')
    expect(en.dashboard.revenue).toBe('Fee revenue')
  })
})
