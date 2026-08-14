import { describe, expectTypeOf, it } from 'vitest'
import type { OperationWindowStatus, ShiftStateView } from '../src/api.ts'

describe('shift-state operation window contract', () => {
  it('types the canonical window edges exposed by the state endpoint', () => {
    expectTypeOf<ShiftStateView['openApprovedAt']>().toEqualTypeOf<string | null>()
    expectTypeOf<ShiftStateView['submittedAt']>().toEqualTypeOf<string | null>()
  })

  it('types classification and manager decision metadata for orders and deductions', () => {
    type Order = ShiftStateView['orders'][number]
    type Deduction = NonNullable<ShiftStateView['cashDeductions']>[number]

    expectTypeOf<Order['windowStatus']>().toEqualTypeOf<OperationWindowStatus>()
    expectTypeOf<Order['decisionReason']>().toEqualTypeOf<string | null>()
    expectTypeOf<Order['decidedBy']>().toEqualTypeOf<string | null>()
    expectTypeOf<Deduction['windowStatus']>().toEqualTypeOf<OperationWindowStatus>()
    expectTypeOf<Deduction['decisionReason']>().toEqualTypeOf<string | null>()
    expectTypeOf<Deduction['decidedBy']>().toEqualTypeOf<string | null>()
  })

  it('carries the exact BMS evidence generation needed after a remount', () => {
    type StartReading = ShiftStateView['startPackage']['batteries'][number]
    type EndReading = ShiftStateView['endPackage']['batteries'][number]
    expectTypeOf<StartReading['mediaId']>().toEqualTypeOf<string | null>()
    expectTypeOf<EndReading['mediaId']>().toEqualTypeOf<string | null>()
  })
})
