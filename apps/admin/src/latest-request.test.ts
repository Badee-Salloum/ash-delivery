/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LatestRequestGuard } from './latest-request.ts'

const approvalSource = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')
const dashboardSource = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')
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
    expect(approvalSource).toContain("signal: request.signal")
    expect(approvalSource).toContain('if (!request.isCurrent()) return')
    expect(approvalSource).toContain('reviewRequests.current.cancel()')
  })

  it('guards every branch-bound dashboard read with the same request generation', () => {
    // The first THREE carry the selected business day, so they are template literals rather than
    // plain strings. Matched on the opening backtick so a read that quietly drops the day
    // parameter — and starts answering for today while the picker says otherwise — fails here.
    //
    // `/dashboard/treasury` was in the plain-string group, and that was the bug: it was called bare,
    // so «كشف الصندوق ورأس المال» answered for the financial week no matter which day was picked. It
    // is listed here now, which is what stops it drifting back.
    for (const endpoint of [
      '`/dashboard${dayQuery}`',
      '`/dashboard/profit${range}`',
      '`/dashboard/treasury${range}`',
      "'/documents/expiring'",
      "'/attendance'",
    ]) {
      const start = dashboardSource.indexOf(endpoint)
      expect(start, endpoint).toBeGreaterThan(-1)
      expect(dashboardSource.slice(start, start + 180), endpoint).toContain('signal: request.signal')
    }
    expect(dashboardSource).toContain('const request = dashboardRequests.current.next()')
    expect(dashboardSource).toContain('if (!request.isCurrent()) return')
    expect(dashboardSource).toContain('dashboardRequests.current.cancel()')
  })
})
