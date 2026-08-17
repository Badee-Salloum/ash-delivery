import { describe, expect, it } from 'vitest'
import { countUnresolvedWindowRows, firstMoneyField, isUnresolvedWindowRow } from './operation-window.ts'

describe('operation-window review helpers', () => {
  it('blocks only an explicit unknown row without a manager decision', () => {
    expect(isUnresolvedWindowRow({ windowStatus: 'unknown', decisionReason: null })).toBe(true)
    expect(isUnresolvedWindowRow({ windowStatus: 'unknown', decisionReason: 'verified against screenshot' })).toBe(false)
    expect(isUnresolvedWindowRow({ windowStatus: 'open_minute_boundary' })).toBe(false)
    expect(isUnresolvedWindowRow({})).toBe(false)
  })

  it('blocks a durable reader conflict even when its clock is exact or an older decision exists', () => {
    expect(isUnresolvedWindowRow({
      windowStatus: 'in_window',
      decisionReason: 'older review before rephoto',
      closeDraftReviewReasons: ['reader_conflict'],
    })).toBe(true)
  })

  it('does not classify manager-entered manual orders as automatic-window blockers', () => {
    expect(
      countUnresolvedWindowRows(
        [
          { kind: 'manual', windowStatus: 'unknown' },
          { kind: 'yallago', windowStatus: 'unknown' },
          { kind: 'yallago', windowStatus: 'in_window' },
        ],
        [{ windowStatus: 'unknown', decisionReason: 'manager included it' }],
      ),
    ).toBe(1)
  })

  it('reads additive settlement fields while remaining compatible with the old response', () => {
    expect(firstMoneyField({ cashDeductionTotal: '50.00' }, ['cashDeductionTotal'])).toBe('50.00')
    expect(firstMoneyField({ deductionOverflow: '10.00' }, ['cashDeductionReceivable', 'deductionOverflow'])).toBe('10.00')
    expect(firstMoneyField({ toOfficeCash: '100.00' }, ['netDriverShare'])).toBeNull()
  })
})
