/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { businessDateRefreshDelay, refreshedSessionSnapshot, type SessionSnapshot } from './session-business-date.ts'

const before: SessionSnapshot = { userId: 'manager', roleKey: 'general_manager', branchId: null, driverId: null, businessDate: '2026-10-03' }
const provider = readFileSync(new URL('./app-context.tsx', import.meta.url), 'utf8')
const range = readFileSync(new URL('./components/TimeRangeBar.tsx', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('./screens/dashboard/use-dashboard-read.ts', import.meta.url), 'utf8')

describe('authoritative session business-date refresh', () => {
  it('checks just after the 04:00 Damascus rollover rather than at local-browser midnight', () => {
    const now = Date.parse('2026-10-04T00:59:59.900Z')
    expect(businessDateRefreshDelay(now)).toBe(350)
    expect(new Date(now + businessDateRefreshDelay(now)).toISOString()).toBe('2026-10-04T01:00:00.250Z')
  })
  it('checks every server minute, so a configured different day boundary also remains authoritative', () => {
    const now = Date.parse('2026-10-04T02:29:41Z')
    expect(new Date(now + businessDateRefreshDelay(now)).toISOString()).toBe('2026-10-04T02:30:00.250Z')
    expect(businessDateRefreshDelay(Date.parse('2026-10-04T02:30:00.250Z'))).toBe(60_000)
  })
  it('keeps unchanged session identity stable and accepts the next server business date', () => {
    expect(refreshedSessionSnapshot(before, { ...before }, before.userId)).toBe(before)
    const next = { ...before, businessDate: '2026-10-04' }
    expect(refreshedSessionSnapshot(before, next, before.userId)).toBe(next)
  })
  it('does not revive logout or apply a response from a different authenticated user', () => {
    expect(refreshedSessionSnapshot(null, before, before.userId)).toBeNull()
    const switched = { ...before, userId: 'another-manager' }
    expect(refreshedSessionSnapshot(switched, before, before.userId)).toBe(switched)
    expect(refreshedSessionSnapshot(before, switched, before.userId)).toBe(before)
  })
  it('preserves valid permission and branch membership changes returned by the server', () => {
    const reassigned = { ...before, roleKey: 'branch_manager', branchId: 'new-branch' }
    expect(refreshedSessionSnapshot(before, reassigned, before.userId)).toBe(reassigned)
  })
  it('checks on focus/resume with no overlapping reads and scopes branch initialization by actor, not date', () => {
    expect(provider).toContain("window.addEventListener('focus', resume)")
    expect(provider).toContain("document.addEventListener('visibilitychange', resume)")
    expect(provider).toContain("document.visibilityState === 'hidden' || reading")
    expect(provider).toContain('refreshedSessionSnapshot(current, fresh, userId)')
    expect(provider).toContain('[api, session?.userId, session?.roleKey, session?.branchId]')
    expect(provider).toContain('businessDateRefreshDelay(Date.now())')
    expect(range).toContain('[api, branchId, session?.userId, session?.roleKey, session?.businessDate, attempt]')
    expect(range).toContain('setMeta(null)')
    expect(dashboard).toContain('session?.userId, session?.roleKey, session?.businessDate, branchId, path, attempt')
  })
})
