import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/screens/OrderEntry.tsx', import.meta.url), 'utf8')

const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n')

/**
 * Shift d0a5a7ec read «محسوبة 10 من 21» — ten deliveries drawn twice, half of them announcing a
 * manager decision that had no photo behind it. The grid, the counter and the summary must all read
 * from the filtered list; any one of them left on the raw list puts the phantom count back.
 */
describe('the driver grid is built from the filtered list', () => {
  it('filters remnants once and reuses that list everywhere', () => {
    expect(code).toContain('withoutSupersededRemnants(orders)')
    expect(code).toContain('withoutSupersededRemnants(cashDeductions)')
  })

  it('counts, summarises and renders the same rows', () => {
    expect(code).toContain('closeOperationsSummary(visibleOrders, visibleDeductions)')
    expect(code).toContain("replace('{total}', String(visibleOrders.length))")
    expect(code).toContain('return visibleOrders')
  })

  it('leaves no raw-list reference that would restore the phantom count', () => {
    // `orders.length` in the counter is exactly what showed 21. The only surviving raw reference
    // may be the empty-state check, which is about having nothing at all.
    const rawLengthUses = code.match(/\borders\.length\b/g) ?? []
    expect(rawLengthUses).toHaveLength(1)
    expect(code).toContain('{orders.length === 0 ?')
  })
})
