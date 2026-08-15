/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const treasurySource = readFileSync(new URL('./screens/Treasury.tsx', import.meta.url), 'utf8')
const dashboardSource = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')

describe('branch treasury screen contract', () => {
  it('uses unambiguous funding, count and directional transfer copy in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.ownerFunding).not.toBe(catalog.treasury.deposit)
      expect(catalog.treasury.transferToCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.transferFromCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.noMovement.length).toBeGreaterThan(3)
      expect(catalog.dashboard.companyProfitLabel).not.toBe('Company profit')
      expect(catalog.dashboard.companyProfitLabel).not.toBe('ربح الشركة')
    }
  })

  it('reloads the sealed count instead of replacing its details with a check mark', () => {
    expect(treasurySource).toContain("api.get<CashCountView>(`/cash-counts/${d.businessDate}`)")
    expect(treasurySource).toContain('restoreCountDraft(saved.lines)')
    expect(treasurySource).toContain('savedCountDetails')
  })

  it('does not fetch or render the company fund for a branch-only role', () => {
    expect(treasurySource).toContain("'profit.view_total'")
    expect(treasurySource).toContain('if (!canViewCompanyFund)')
    expect(treasurySource).toContain('{canViewCompanyFund ? <div')
  })

  it('keeps both restoration legs in the confirmation and displays the dashboard capital delta', () => {
    expect(treasurySource).toContain('restoration.legs.map((leg) =>')
    expect(treasurySource).toContain("legText.join(' • ')")
    expect(dashboardSource).toContain('differenceView(treasury.capital.delta)')
    expect(dashboardSource).toContain('capitalDelta.amount')
  })

  it('reloads the persisted preview after restoration instead of pinning the pre-action POST plan', () => {
    const action = treasurySource.slice(treasurySource.indexOf('async function doRestore'), treasurySource.indexOf('async function closeWeek'))
    expect(action).toMatch(/await api\.restore\([^\n]+\)[\s\S]*?await loadRestoration\(\)/)
    expect(action).not.toContain('setRestoration({ ...done')
    expect(action).not.toContain('setRestoreDone(true)')
  })
})
