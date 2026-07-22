import { describe, expect, it } from 'vitest'
import {
  type DraftOrder,
  allProblems,
  isComplete,
  nextPayMode,
  previewBr1,
  toApiPayloads,
  validateRow,
} from '../src/order-entry.ts'

/**
 * The driver order-entry model. This is the screen the product is judged on, so its logic is
 * tested in isolation from any DOM.
 */

const row = (over: Partial<DraftOrder> = {}): DraftOrder => ({
  localId: Math.random().toString(36).slice(2),
  providerOrderNo: 'YAL-1',
  payMode: 'cash',
  feeText: '5000.00',
  ...over,
})

describe('row validation', () => {
  it('flags an empty order number', () => {
    const orders = [row({ providerOrderNo: '  ' })]
    expect(validateRow(orders, 0)).toEqual({ kind: 'empty_order_no' })
  })

  it('detects a duplicate as you type, pointing at the first occurrence', () => {
    // The single most common data-entry slip: the same Yallago number twice.
    const orders = [row({ providerOrderNo: 'YAL-7' }), row({ providerOrderNo: 'YAL-7' })]
    expect(validateRow(orders, 0)).toBeNull()
    expect(validateRow(orders, 1)).toEqual({ kind: 'duplicate_order_no', firstIndex: 0 })
  })

  it('rejects a non-numeric fee', () => {
    expect(validateRow([row({ feeText: 'abc' })], 0)).toEqual({ kind: 'bad_fee' })
  })

  it('rejects a negative fee', () => {
    expect(validateRow([row({ feeText: '-100' })], 0)).toEqual({ kind: 'negative_fee' })
  })

  it('accepts a clean row', () => {
    expect(validateRow([row()], 0)).toBeNull()
  })

  it('allProblems keys by localId and isComplete reflects it', () => {
    const orders = [row({ localId: 'a' }), row({ localId: 'b', providerOrderNo: '' })]
    const problems = allProblems(orders)
    expect(problems.has('b')).toBe(true)
    expect(problems.has('a')).toBe(false)
    expect(isComplete(orders)).toBe(false)
    expect(isComplete([row()])).toBe(true)
    expect(isComplete([])).toBe(false) // an empty shift is not "complete"
  })
})

describe('one-tap pay-mode cycling', () => {
  it('cycles cash → electronic → free → cash', () => {
    expect(nextPayMode('cash')).toBe('electronic')
    expect(nextPayMode('electronic')).toBe('free')
    expect(nextPayMode('free')).toBe('cash')
  })
})

describe('the live BR1 preview — the driver fixes his own mistakes', () => {
  const twentyOrders = (): DraftOrder[] => {
    const out: DraftOrder[] = []
    for (let i = 0; i < 12; i++) out.push(row({ localId: `c${i}`, providerOrderNo: `C${i}`, payMode: 'cash' }))
    for (let i = 0; i < 6; i++) out.push(row({ localId: `e${i}`, providerOrderNo: `E${i}`, payMode: 'electronic' }))
    for (let i = 0; i < 2; i++) out.push(row({ localId: `f${i}`, providerOrderNo: `F${i}`, payMode: 'free' }))
    return out
  }

  it('reproduces the §2.3 expectations before the driver even enters his figures', () => {
    const p = previewBr1({ floatText: '100000', topupText: '50000', orders: twentyOrders() })
    expect(p).not.toBeNull()
    expect(p!.expectedCashText).toBe('160000.00')
    expect(p!.expectedWalletText).toBe('70000.00')
    expect(p!.expectedTotalText).toBe('230000.00')
    expect(p!.blockText).toBe('80000.00')
    expect(p!.differenceText).toBeNull() // no declared figures yet
    expect(p!.balanced).toBeNull()
  })

  it('once he declares, it shows the difference and whether it balances', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '160000',
      declaredWalletText: '70000',
    })
    expect(p!.differenceText).toBe('0.00')
    expect(p!.balanced).toBe(true)
  })

  it('a wrong declared figure shows immediately as a non-zero difference', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '155000', // 5,000 short
      declaredWalletText: '70000',
    })
    expect(p!.balanced).toBe(false)
    expect(p!.differenceText).toBe('-5000.00')
  })

  it('ignores half-typed invalid rows rather than flickering to nonsense', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: '', feeText: '' })]
    const p = previewBr1({ floatText: '0', topupText: '0', orders })
    // Only the one valid cash order contributes: expected cash = 0 float + 5000.
    expect(p!.expectedCashText).toBe('5000.00')
  })

  it('returns null on an unparseable float rather than throwing', () => {
    expect(previewBr1({ floatText: 'xyz', topupText: '0', orders: [] })).toBeNull()
  })
})

describe('API payloads', () => {
  it('trims order numbers and carries the fee text verbatim', () => {
    const payloads = toApiPayloads([row({ providerOrderNo: '  YAL-9  ', feeText: '5000.00' })])
    expect(payloads[0]).toEqual({ providerOrderNo: 'YAL-9', payMode: 'cash', fee: '5000.00', zone: null })
  })
})
