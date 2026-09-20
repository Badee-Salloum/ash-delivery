/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { bucketTrend } from './components/TrendBars.tsx'

const dashboard = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')
const trend = readFileSync(new URL('./components/TrendBars.tsx', import.meta.url), 'utf8')

describe('P3 dashboard composition', () => {
  it('keeps the dashboard a thin range owner and splits all nine sections', () => {
    for (const section of ['Now', 'SevenDay', 'Profit', 'Operations', 'Fleet', 'Capital', 'CompanyFund', 'Due', 'Alerts']) {
      expect(dashboard).toContain(`<${section}Section`)
    }
    expect(dashboard).toContain('<TimeRangeBar')
    expect(dashboard).toContain("'profit.view_total'")
    expect(dashboard).toContain("'company_fund.manage'")
  })

  it('aggregates money as bigint and never converts a money value through Number', () => {
    expect(bucketTrend('2026-09-01', '2026-09-02', [
      { date: '2026-09-01', value: '9007199254740993.01' },
      { date: '2026-09-01', value: '0.99' },
    ])[0]?.value).toBe(900719925474099400n)
    expect(trend).toContain('parseMinor(point.value)')
    expect(trend).not.toContain('Number(')
  })

  it('ships matching Arabic and English copy for every new section', () => {
    for (const catalog of [ar, en]) {
      for (const key of ['nowTitle', 'lastSevenDaysTitle', 'profitTitle', 'operationsTitle', 'fleetTitle', 'capitalTitle', 'companyFundTitle', 'dueTitle', 'alertsTitle'] as const) {
        expect(catalog.dashboard[key].length, key).toBeGreaterThan(2)
      }
    }
  })
})
