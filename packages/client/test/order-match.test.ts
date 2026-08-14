import { describe, expect, it } from 'vitest'
import { matchOrdersToPayments, unexplainedTotal } from '../src/order-match.ts'

/**
 * The matcher, against the client's REAL screens (transcribed from «الطلبات الحديثة» and «سجل
 * المدفوعات» of ٢٩ يوليو).
 *
 * The numbers are the point: every order's Yallago cut really is in the log at the order's own
 * minute, and three orders really do share their minute with a positive row whose ratio to the fee
 * is different every time — ١٨٥/٤٩٥, ١٠٧٫٥٠/١٦٠, ١٥٫٩٠/١٦٥. That is why nothing here may guess.
 */

const ORDERS = [
  { orderNo: 'YAL-1', fee: '495', time: '18:10' },
  { orderNo: 'YAL-2', fee: '180', time: '16:54' },
  { orderNo: 'YAL-3', fee: '400', time: '15:48' },
  { orderNo: 'YAL-4', fee: '140', time: '14:48' },
  { orderNo: 'YAL-5', fee: '165', time: '14:21' },
  { orderNo: 'YAL-6', fee: '160', time: '13:46' },
  { orderNo: 'YAL-7', fee: '120', time: '13:08' },
  { orderNo: 'YAL-8', fee: '210', time: '12:52' },
  { orderNo: 'YAL-9', fee: '165', time: '11:54' },
]

const MOVEMENTS = [
  { amount: '-144.15', time: '19:29' },
  { amount: '185', time: '18:10' },
  { amount: '-99', time: '18:10' },
  { amount: '-36', time: '16:54' },
  { amount: '-80', time: '15:48' },
  { amount: '-28', time: '14:48' },
  { amount: '-33', time: '14:21' },
  { amount: '107.50', time: '13:46' },
  { amount: '-32', time: '13:46' },
  { amount: '-24', time: '13:08' },
  { amount: '-42', time: '12:52' },
  { amount: '-50', time: '11:58' },
  { amount: '15.90', time: '11:54' },
  { amount: '-33', time: '11:54' },
  { amount: '9.75', time: '11:46' },
  { amount: '300', time: '03:33' },
]

describe('matching a real day of orders against the real payments log', () => {
  const result = matchOrdersToPayments(ORDERS, MOVEMENTS)

  it('confirms every order against Yallago’s 20% in the log', () => {
    expect(result.orders).toHaveLength(9)
    expect(result.orders.every((o) => o.cutConfirmed)).toBe(true)
    expect(result.ordersWithoutCut).toEqual([])
  })

  it('reads an order with only a cut as fully cash', () => {
    // ٤٠٠ at ٣:٤٨ م has nothing beside its −٨٠: none of that fee reached the wallet.
    const fourHundred = result.orders.find((o) => o.order.orderNo === 'YAL-3')!
    expect(fourHundred.walletAmount).toBe('0')
    expect(fourHundred.needsReview).toBe(false)
  })

  it('REFUSES to decide the three orders that share their minute with a credit', () => {
    // ١٨٥ beside ٤٩٥, ١٠٧٫٥٠ beside ١٦٠, ١٥٫٩٠ beside ١٦٥ — each is either the electronically-paid
    // part of that order or an incentive. The ratios differ every time, so no rule can tell.
    const flagged = result.orders.filter((o) => o.needsReview).map((o) => o.order.orderNo)
    expect(flagged).toEqual(['YAL-1', 'YAL-6', 'YAL-9'])
    for (const o of result.orders.filter((x) => x.needsReview)) expect(o.walletAmount).toBeNull()
  })

  it('returns the rows no order explains, rather than dropping them', () => {
    // The withdrawal, the mid-morning debit, and two incentives on their own minutes.
    expect(result.unexplained).toEqual([
      { amount: '-144.15', time: '19:29' },
      { amount: '-50', time: '11:58' },
      { amount: '9.75', time: '11:46' },
      { amount: '300', time: '03:33' },
    ])
  })

  it('totals the unexplained rows exactly, signs included', () => {
    // −144.15 − 50 + 9.75 + 300 = 115.60. This archival reconciliation total still uses
    // exact minor units even though it does not feed BR1.
    expect(unexplainedTotal(result.unexplained)).toBe('115.60')
  })
})

describe('what the matcher will not do', () => {
  it('does not pair rows across different minutes', () => {
    const r = matchOrdersToPayments([{ orderNo: 'A', fee: '100', time: '10:00' }], [{ amount: '-20', time: '10:01' }])
    expect(r.orders[0]!.cutConfirmed).toBe(false)
    expect(r.ordersWithoutCut).toHaveLength(1)
    expect(r.unexplained).toHaveLength(1)
  })

  it('does not pair a row whose clock was unreadable', () => {
    // A blank time matches nothing. Better an unexplained row a manager sees than a wrong pairing.
    const r = matchOrdersToPayments([{ orderNo: 'A', fee: '100', time: '' }], [{ amount: '-20', time: '' }])
    expect(r.orders[0]!.cutConfirmed).toBe(false)
    expect(r.unexplained).toHaveLength(1)
  })

  it('claims each log row at most once, so two orders cannot share one cut', () => {
    const r = matchOrdersToPayments(
      [
        { orderNo: 'A', fee: '100', time: '10:00' },
        { orderNo: 'B', fee: '100', time: '10:00' },
      ],
      [{ amount: '-20', time: '10:00' }],
    )
    expect(r.orders.filter((o) => o.cutConfirmed)).toHaveLength(1)
    expect(r.ordersWithoutCut).toHaveLength(1)
  })

  it('tolerates the app rounding its own display by a minor unit', () => {
    // 20% of 333 is 66.60; a log that prints 66.59 or 66.61 is the same cut, not a different one.
    for (const shown of ['-66.60', '-66.59', '-66.61']) {
      const r = matchOrdersToPayments([{ orderNo: 'A', fee: '333', time: '10:00' }], [{ amount: shown, time: '10:00' }])
      expect(r.orders[0]!.cutConfirmed).toBe(true)
    }
  })
})
