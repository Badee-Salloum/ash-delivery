import type { CheckInRecord, CheckInRepo, CheckInWindowRecord } from '@ash/contracts'
import type { CalendarDate } from '@ash/domain'

/** «التفقّد» in memory. Same semantics as PostgreSQL: append-only check-ins, retirable windows. */
export class MemoryCheckInRepo implements CheckInRepo {
  readonly windows: CheckInWindowRecord[] = []
  readonly checkIns: CheckInRecord[] = []

  async listWindows(branchId: string, userId?: string): Promise<CheckInWindowRecord[]> {
    return this.windows
      .filter((w) => w.branchId === branchId && w.active && (userId === undefined || w.userId === userId))
      .sort((a, b) => a.atMinute - b.atMinute)
      .map((w) => structuredClone(w))
  }

  async createWindow(w: CheckInWindowRecord): Promise<CheckInWindowRecord> {
    // Mirrors checkin_windows_user_minute_uq: one LIVE round per user per time of day, or the
    // roll-call would show the same 01:00 twice and one check-in could answer only one of them.
    if (this.windows.some((x) => x.active && x.userId === w.userId && x.atMinute === w.atMinute)) {
      throw Object.assign(new Error('duplicate check-in window'), { code: 'DUPLICATE_WINDOW' })
    }
    const stored = structuredClone(w)
    this.windows.push(stored)
    return structuredClone(stored)
  }

  async deactivateWindow(id: string): Promise<boolean> {
    const found = this.windows.find((w) => w.id === id && w.active)
    if (!found) return false
    found.active = false
    return true
  }

  async record(c: CheckInRecord): Promise<CheckInRecord> {
    const stored = structuredClone(c)
    this.checkIns.push(stored)
    return structuredClone(stored)
  }

  async listByBranchAndDate(branchId: string, businessDate: CalendarDate): Promise<CheckInRecord[]> {
    return this.checkIns
      .filter((c) => c.branchId === branchId && c.businessDate === businessDate)
      .sort((a, b) => a.capturedAtMs - b.capturedAtMs)
      .map((c) => structuredClone(c))
  }

  async listByUserAndDate(userId: string, businessDate: CalendarDate): Promise<CheckInRecord[]> {
    return this.checkIns
      .filter((c) => c.userId === userId && c.businessDate === businessDate)
      .sort((a, b) => a.capturedAtMs - b.capturedAtMs)
      .map((c) => structuredClone(c))
  }
}
