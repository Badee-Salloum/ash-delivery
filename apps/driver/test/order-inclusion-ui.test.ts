import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const orderEntry = readFileSync(new URL('../src/screens/OrderEntry.tsx', import.meta.url), 'utf8')
const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

describe('driver operation inclusion authority', () => {
  it('has no order inclusion toggle or bulk previous-day override', () => {
    expect(orderEntry).not.toContain('const excludeOtherDays')
    expect(orderEntry).not.toContain('t.orders.excludeOtherDays')
    expect(orderEntry).not.toContain('update(open.localId, { included:')
    expect(orderEntry).toContain('t.orders.inclusionReadOnly')
  })

  it('does not send a driver-authored order inclusion decision', () => {
    expect(shift).not.toContain('included: o.included !== false')
  })
})
