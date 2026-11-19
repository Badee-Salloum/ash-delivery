/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { bucketTrend, trendHeight, trendTickIndexes } from './components/TrendBars.tsx'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrendBars } from './components/TrendBars.tsx'
import { createElement } from 'react'

const dashboard = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')
const trend = readFileSync(new URL('./components/TrendBars.tsx', import.meta.url), 'utf8')
const owner = readFileSync(new URL('./screens/dashboard/OwnerFundingSection.tsx', import.meta.url), 'utf8')
const companyFund = readFileSync(new URL('./screens/dashboard/CompanyFundSection.tsx', import.meta.url), 'utf8')

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

  it('separates all-history owner funding from the operation period', () => {
    expect(dashboard).toContain('<OwnerFundingSection range={range}')
    expect(dashboard).not.toContain('<CompanyOwnerPanel from=')
    expect(owner).toContain('all-owner-history:${asOf')
    expect(dashboard).toContain('asOf: meta.today')
    expect(owner).toContain('useState<DateRange | null>(null)')
    expect(owner).toContain('from={appliedRange.from} to={appliedRange.to}')
    expect(owner).not.toContain('aria-pressed')
  })

  it('keeps branch matching compact and card prices separate in a folded asset group', () => {
    expect(companyFund).toContain('t.financeReview.companyInBranch')
    expect(companyFund).not.toContain('lg:grid-cols-[minmax(18rem,1fr)_2fr]')
    expect(companyFund).toContain('<details data-dashboard-assets')
    expect(companyFund.indexOf('<details data-dashboard-assets')).toBeGreaterThan(companyFund.indexOf('</Card>'))
    expect(companyFund).toContain('t.dashboard.cardPriceNotBookValue')
    expect(companyFund).toContain('data.assetSummary.pendingRecognitionCards')
  })

  it('exposes old unlinked restorations separately even when the proposal count is zero', () => {
    expect(companyFund).toContain('branch.unlinkedHistoricalCount !== undefined && branch.unlinkedHistoricalCount > 0')
    expect(companyFund).toContain('t.financeReview.unlinkedRestorations')
    expect(companyFund).toContain('<bdi>{branch.unlinkedHistoricalCount}</bdi>')
    expect(companyFund).toContain('<bdi>{branch.pendingReviewCount}</bdi>')
    expect(companyFund).not.toMatch(/pendingReviewCount\s*\+\s*(?:branch\.)?unlinkedHistoricalCount/)
  })

  it('renders zero without a fictitious positive bar and bounds chart labels', () => {
    expect(trendHeight(0n, 500n)).toBe(0n)
    expect(trendHeight(-500n, 500n)).toBe(1800n)
    expect(trendTickIndexes(1)).toEqual([0])
    expect(trendTickIndexes(40)).toEqual([0, 8, 16, 23, 31, 39])
    const html = renderToStaticMarkup(createElement(TrendBars, {
      from: '2026-09-01', to: '2026-09-02', currencyLabel: 'SYP', label: 'Profit',
      points: [{ date: '2026-09-01', value: '-123.45' }, { date: '2026-09-02', value: '0.00' }], tableLabels: { summary: 'Table values', date: 'Date', amount: 'Profit' },
    }))
    expect(html).toContain('-123.45 SYP')
    expect(html).not.toContain('-12345')
    expect(html).toContain('height="0"')
    expect(html).toContain('Table values')
    expect(html).toContain('<th class="px-3 py-2 text-end" scope="col">Profit</th>')
    expect(bucketTrend('2026-09-01', '2026-09-02', [{ date: '2026-08-31', value: '5.00' }])).toHaveLength(2)
  })
})
