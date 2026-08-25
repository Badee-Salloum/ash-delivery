import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const liveShifts = readFileSync(new URL('./screens/LiveShifts.tsx', import.meta.url), 'utf8')

/**
 * On the morning of 2026-08-25 four shifts whose drivers had worked all night were voided one
 * after another — 10:35, 12:10, 12:18, 14:01 — discarding 4,325 SYP of deliveries between them.
 *
 * `force-close` was available the whole time and preserves the work: `forceCloseLocked` submits the
 * close draft's operations before settling, and the shift ends `approved` rather than `cancelled`.
 * The void hint already said «يتجاهل طلباتها»; what it never said was HOW MANY, or that a
 * non-destructive tool sat next to it.
 */
describe('voiding a shift states what it destroys', () => {
  it('shows the count of deliveries about to be discarded', () => {
    expect(liveShifts).toContain('voidDiscardsOrders')
    expect(liveShifts).toContain("review.orders?.length ?? 0")
    expect(ar.liveShifts.voidDiscardsOrders).toContain('{n}')
    expect(en.liveShifts.voidDiscardsOrders).toContain('{n}')
  })

  it('names force-close as the alternative that keeps the work', () => {
    expect(liveShifts).toContain('voidUseForceClose')
    expect(ar.liveShifts.voidUseForceClose).toContain('إغلاق قسري')
    expect(en.liveShifts.voidUseForceClose).toContain('Force close')
  })

  it('requires an explicit acknowledgement before the destructive button enables', () => {
    expect(liveShifts).toContain('voidAcknowledged')
    expect(liveShifts).toContain("(voidOrderCount === null || voidOrderCount > 0) && !voidAcknowledged")
  })

  /**
   * A failed count must not read as "nothing to lose". The whole point is that the manager is about
   * to destroy something; an unknown quantity is the case where he should be MOST careful.
   */
  it('treats an unknown count as dangerous, not as zero', () => {
    expect(liveShifts).toContain('if (!cancelled) setVoidOrderCount(null)')
    expect(liveShifts).toContain('voidOrderCount === null || voidOrderCount > 0')
  })
})
