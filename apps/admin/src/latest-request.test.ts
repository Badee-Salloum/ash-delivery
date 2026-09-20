/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LatestRequestGuard } from './latest-request.ts'

const approvalSource = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')
const dashboardReadSource = readFileSync(new URL('./screens/dashboard/use-dashboard-read.ts', import.meta.url), 'utf8')
const dashboardSections = [
  'NowSection', 'SevenDaySection', 'ProfitSection', 'OperationsSection', 'FleetSection',
  'CapitalSection', 'CompanyFundSection', 'DueSection', 'AlertsSection',
].map((name) => readFileSync(new URL(`./screens/dashboard/${name}.tsx`, import.meta.url), 'utf8')).join('\n')
const adminAppSource = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')

describe('LatestRequestGuard', () => {
  it('aborts and invalidates an older request when a new generation starts', () => {
    const guard = new LatestRequestGuard()
    const old = guard.next()
    const current = guard.next()

    expect(old.signal.aborted).toBe(true)
    expect(old.isCurrent()).toBe(false)
    expect(current.signal.aborted).toBe(false)
    expect(current.isCurrent()).toBe(true)
  })

  it('invalidates the current request when its owner unmounts', () => {
    const guard = new LatestRequestGuard()
    const request = guard.next()
    guard.cancel()

    expect(request.signal.aborted).toBe(true)
    expect(request.isCurrent()).toBe(false)
  })

  it('keys approval workspaces by shift and guards review responses with abort plus generation checks', () => {
    expect(adminAppSource).toContain('<Approval key={openShift} shiftId={openShift}')
    expect(approvalSource).toContain('const request = reviewRequests.current.next()')
    expect(approvalSource).toContain('signal: request.signal')
    expect(approvalSource).toContain('if (!request.isCurrent()) return')
    expect(approvalSource).toContain('reviewRequests.current.cancel()')
  })

  it('gives every dashboard section an independent latest-request guard', () => {
    expect(dashboardReadSource).toContain('useRef(new LatestRequestGuard())')
    expect(dashboardReadSource).toContain('const request = requests.current.next()')
    expect(dashboardReadSource).toContain('signal: request.signal')
    expect(dashboardReadSource).toContain('if (!request.isCurrent()) return')
    expect(dashboardReadSource).toContain('requests.current.cancel()')
    expect(dashboardSections.match(/useDashboardRead</g)).toHaveLength(9)
    for (const endpoint of ['/dashboard/last-seven-days', '/dashboard/profit', '/dashboard/shifts-summary', '/dashboard/fleet-performance', '/dashboard/treasury', '/documents/expiring']) {
      expect(dashboardSections, endpoint).toContain(endpoint)
    }
  })
})
