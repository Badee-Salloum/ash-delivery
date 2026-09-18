import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../api/src/app.ts', import.meta.url), 'utf8')

/**
 * A resume must never empty the close draft's row lists.
 *
 * `GET /shifts/:id/state` serves the COMMITTED orders table, and draft rows only reach that table
 * at close submit — so for a shift that is still open it is ALWAYS empty. Writing it into the
 * screen unconditionally replaced the driver's real list with nothing.
 *
 * On 2026-08-25 that emptied محمد المسلماني's orders: both dashboard reads completed at 18:24, the
 * server draft held 7 orders at 18:28, and his screen showed «0 طلبات» at 18:31. The photo badges
 * still read «القراءة: تمت» because `closeDraftAttachments` is not among the fields the resume
 * block writes — the read record survived, the rows it produced did not. His shift was
 * force-cancelled at 19:28 and its 1,210 SYP of deliveries went with it.
 */
describe('resuming a shift never empties the close draft', () => {
  it('takes the row lists from /state only while no close draft is loaded', () => {
    // The guard IS the fix: once a draft exists, the draft owns these rows.
    expect(shift).toContain('...(d.closeDraftRevision === null')
    const guardAt = shift.indexOf('...(d.closeDraftRevision === null')
    for (const list of ['orders: st.orders.map', 'movements: (st.movements ?? []).map', 'cashDeductions: syncRecordedCashDeductions']) {
      const at = shift.indexOf(list)
      expect(at, `${list} not found`).toBeGreaterThan(-1)
      expect(at, `${list} must sit inside the no-draft guard`).toBeGreaterThan(guardAt)
    }
  })

  it('still restores the committed rows on a genuine first load', () => {
    // The endpoint exists precisely for a driver whose tab was evicted, or whose close was
    // rejected back to `open` with its orders already committed. That path must keep working.
    expect(shift).toContain('recorded: true')
    expect(shift).toContain('resumedOrderWindowState(o)')
  })

  /**
   * The premise the guard rests on. If `/state` ever started serving DRAFT rows this test should
   * fail loudly, because the guard would then be hiding rows the driver ought to see.
   */
  it('is justified: /state serves the committed table, not the draft', () => {
    expect(api).toContain('orders.listByShift(shiftId)')
    expect(api).not.toContain('closeDrafts.findByShift(shiftId).operations')
  })

  /**
   * Why nothing repaired the damage: the close-draft fetch is skipped once a revision exists, so
   * the emptied list could never be refilled from the server.
   */
  it('documents that the close-draft refetch cannot repair an emptied list', () => {
    expect(shift).toContain('closeDraftRevision !== null) return')
  })
})
