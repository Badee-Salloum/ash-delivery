import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { orderNeedsAttention } from './approval-workspace.ts'

const source = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const code = stripComments(source)

/**
 * Every money row on a shift can be acted on.
 *
 * Shift a3728815 is why. Its phantom 230 — one delivery counted twice because a page seam faded the
 * top off a ٣ — was clean by all eight of `orderNeedsAttention`'s rules: in window, printed clock,
 * no review reason, unedited fee, no prior decision. So it got no attention card, and the ordinary
 * list below was display-only. **Ten of that shift's eleven rows had no controls at all**, and the
 * one row that had to be removed was among them. The remove button shipped that same evening was
 * unreachable on the row it was built for.
 */
describe('every row on the review screen can be acted on', () => {
  it('gives the ordinary list the same card, not a read-only line', () => {
    // The ordinary rows render the full `OrderAttentionCard` behind a `<details>`, so exactly the
    // same controls reach every row. Two call sites: the attention list and the ordinary list.
    expect(code.split('<OrderAttentionCard').length - 1).toBe(2)
    expect(code).toContain('{ordinaryOrders.map((order) => (')
  })

  it('passes the ordinary rows the props the card needs to act', () => {
    // A card without `onRevise` renders buttons that do nothing, and one without `lookupDuplicateRow`
    // cannot show the side-by-side comparison. Both call sites must be complete.
    const ordinary = code.slice(code.indexOf('{ordinaryOrders.map((order) => ('))
    for (const prop of ['onRevise={onRevise}', 'lookupDuplicateRow={lookupDuplicateRow}', 'onReread={onRereadOrder}']) {
      expect(ordinary.slice(0, 2000), prop).toContain(prop)
    }
  })

  it('offers exclusion on every included row, not only a manual one', () => {
    // A scanned row's only exclude control was «تثبيت كتكرار». A manager who wanted to leave a real
    // delivery uncounted had to press a button claiming it was a duplicate, and his audited reason
    // went into the record under a claim he never made.
    expect(code).toContain("{order.included !== false ? <Button")
    expect(code).not.toContain("{order.kind === 'manual' && order.included !== false ? <Button")
  })

  it('keeps the three actions distinct', () => {
    // «استبعِد» a real delivery not counted here · «احذف» not a delivery at all · «تثبيت كتكرار»
    // a duplicate, kept because it carries a timing correction in the same step.
    for (const key of ['copy.excludeOrder', 'copy.removeRow', 'copy.markDuplicate']) {
      expect(code, key).toContain(key)
    }
  })

  it('still shows only the rows that need attention by default', () => {
    // Opening every row is not the same as showing every row. The ordinary ones stay collapsed, so
    // the default view is unchanged — this adds reach, not noise.
    expect(code).toContain('{copy.ordinaryOrders.replace(')
  })

  it('the attention rules alone would have left the 2026-09-01 phantom unreachable', () => {
    // The row as production actually stored it. This is the regression: if some future edit ever
    // makes the ordinary list read-only again, a row shaped exactly like this one is stranded.
    const phantom = {
      providerOrderNo: 'YAL-d95d8f470fa5a368c021931ab244e163',
      fee: '230.00',
      included: true,
      kind: 'yallago' as const,
      windowStatus: 'in_window' as const,
      windowBasis: 'printed_time' as const,
      decisionReason: null,
      closeDraftReviewReasons: [],
      feeOcr: '230.00',
    }
    expect(orderNeedsAttention(phantom), 'it looked perfectly ordinary — that was the problem').toBe(false)
  })
})
