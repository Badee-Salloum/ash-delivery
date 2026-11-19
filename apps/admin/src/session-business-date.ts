export interface SessionSnapshot {
  userId: string
  roleKey: string
  branchId: string | null
  driverId: string | null
  businessDate: string
}

/** The server owns the date and zone; check just after each minute, including its 04:00 boundary. */
export function businessDateRefreshDelay(nowMs: number): number {
  const minute = 60_000
  return minute - ((nowMs % minute + minute) % minute) + 250
}

/** A background read cannot sign a logged-out/switched user back in or reset an unchanged scope. */
export function refreshedSessionSnapshot<T extends SessionSnapshot>(current: T | null, fresh: T, userId: string): T | null {
  if (!current || current.userId !== userId || fresh.userId !== userId) return current
  return current.roleKey === fresh.roleKey && current.branchId === fresh.branchId &&
    current.driverId === fresh.driverId && current.businessDate === fresh.businessDate ? current : fresh
}
