import { describe, expect, it } from 'vitest'
import type {
  CashDeductionRecord,
  OperationBatch,
  ShiftOrderRecord,
  ShiftRecord,
} from '@ash/contracts'
import { minor } from '@ash/domain'
import { createMemoryDeps } from '../src/memory/index.ts'

const NOW_MS = Date.UTC(2026, 6, 21, 5, 0, 0)
const SHIFT_ID = 'shift-operation-batch'
const OTHER_SHIFT_ID = 'shift-operation-batch-other'
const ACTOR_ID = 'driver-user'

const shift = (): ShiftRecord => ({
  id: SHIFT_ID,
  branchId: 'branch-1',
  driverId: 'driver-1',
  vehicleId: 'vehicle-1',
  shiftNo: 1,
  businessDate: '2026-07-21',
  weekStartDate: '2026-07-19',
  state: 'open',
  floatTranches: [],
  topupTranches: [],
  carriedTranches: [],
  keptAsReceivable: minor(0n),
  driverSharePaid: minor(0n),
  mediaSlotsStart: [],
  mediaSlotsEnd: [],
  odoStart: null,
  odoEnd: null,
  batteryStart: null,
  batteryEnd: null,
  endCashDeclared: null,
  endWalletDeclared: null,
  odoStartOcr: null,
  odoEndOcr: null,
  odoEndAnomalyConfirmedAt: null,
  odoEndAnomalyConfirmedBy: null,
  batteryStartOcr: null,
  endWalletDeclaredOcr: null,
  driverConfirmedAt: null,
  openApprovedAt: null,
  windowOpensAt: null,
  openApprovedBy: null,
  submittedAt: null,
  equationDiff: null,
  cashDiff: null,
  walletDiff: null,
  ordersHash: null,
  approvedBy: null,
})

const order = (
  id: string,
  providerOrderNo: string,
  decidedAt: string | null = null,
): ShiftOrderRecord => ({
  id,
  shiftId: SHIFT_ID,
  providerOrderNo,
  payMode: 'cash',
  fee: minor(5_000_00n),
  zone: null,
  driverConfirmed: true,
  source: 'ocr',
  feeOcr: minor(5_000_00n),
  kind: 'yallago',
  driverShare: null,
  companyShare: null,
  notes: null,
  createdBy: ACTOR_ID,
  points: [],
  included: true,
  walletAmount: null,
  occurredMinute: '08:30',
  occurredDate: '2026-07-21',
  windowStatus: 'in_window',
  decisionReason: decidedAt === null ? null : 'manager verified this operation',
  decidedBy: decidedAt === null ? null : 'manager-user',
  decidedAt,
})

const deduction = (
  id: string,
  operationKey: string,
  decidedAt: string | null = null,
): CashDeductionRecord => ({
  id,
  shiftId: SHIFT_ID,
  operationKey,
  amount: minor(50_00n),
  occurredDate: '2026-07-21',
  occurredMinute: '08:31',
  source: 'ocr',
  amountOcr: minor(50_00n),
  pointA: null,
  pointB: null,
  included: true,
  windowStatus: 'in_window',
  decisionReason: decidedAt === null ? null : 'manager verified this deduction',
  decidedBy: decidedAt === null ? null : 'manager-user',
  decidedAt,
  createdBy: ACTOR_ID,
})

const operationBatch = (patch: Partial<OperationBatch> = {}): OperationBatch => ({
  orderCreates: [],
  orderUpdates: [],
  orderPointReplacements: [],
  cashDeductionCreates: [],
  cashDeductionUpdates: [],
  movements: [],
  ...patch,
})

describe('in-memory operation batch transaction', () => {
  it('rolls back order, deduction, movement, and the generated movement id after a late failure', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)

    await deps.orders.create(order('order-existing', 'ORDER-EXISTING'), ACTOR_ID)
    await deps.cashDeductions.create(deduction('deduction-existing', 'deduction-existing'), ACTOR_ID)
    const [existingMovement] = await deps.movements.merge(
      SHIFT_ID,
      [{ amount: minor(10_00n), occurredMinute: '08:00' }],
      ACTOR_ID,
    )
    expect(existingMovement?.id).toBe('wm-1')

    const batch = operationBatch({
      orderCreates: [order('order-new', 'ORDER-NEW')],
      cashDeductionCreates: [deduction('deduction-new', 'deduction-new')],
      movements: [{ amount: minor(20_00n), occurredMinute: '08:01' }],
    })

    const originalMerge = deps.movements.merge.bind(deps.movements)
    deps.movements.merge = async (...args: Parameters<typeof originalMerge>) => {
      await originalMerge(...args)
      throw Object.assign(new Error('injected failure after movement insert'), { code: 'INJECTED_FAILURE' })
    }

    try {
      await expect(deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)).rejects.toMatchObject({
        code: 'INJECTED_FAILURE',
      })
    } finally {
      deps.movements.merge = originalMerge
    }

    expect((await deps.orders.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual(['order-existing'])
    expect((await deps.cashDeductions.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual([
      'deduction-existing',
    ])
    expect((await deps.movements.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual(['wm-1'])

    const committed = await deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)
    expect(committed.insertedMovements.map((row) => row.id)).toEqual(['wm-2'])
    expect(await deps.orders.listByShift(SHIFT_ID)).toHaveLength(2)
    expect(await deps.cashDeductions.listByShift(SHIFT_ID)).toHaveLength(2)
    expect(await deps.movements.listByShift(SHIFT_ID)).toHaveLength(2)
  })

  it('rejects an order update when decidedAt changed after the batch was prepared', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const decidedAt = '2026-07-21T05:02:00.000Z'
    const current = order('order-reviewed', 'ORDER-REVIEWED', decidedAt)
    await deps.orders.create(current, 'manager-user')

    const batch = operationBatch({
      orderCreates: [order('order-transient', 'ORDER-TRANSIENT')],
      orderUpdates: [{ record: { ...current, fee: minor(4_000_00n) }, expectedDecidedAt: null }],
    })

    await expect(deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)).rejects.toMatchObject({
      code: 'STALE_OPERATION_BATCH',
    })
    expect((await deps.orders.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual(['order-reviewed'])
    expect((await deps.orders.listByShift(SHIFT_ID))[0]?.fee).toBe(minor(5_000_00n))
  })

  it('rejects a cash-deduction update when decidedAt changed and rolls back earlier rows', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const decidedAt = '2026-07-21T05:03:00.000Z'
    const current = deduction('deduction-reviewed', 'deduction-reviewed', decidedAt)
    await deps.cashDeductions.create(current, 'manager-user')

    const batch = operationBatch({
      orderCreates: [order('order-transient', 'ORDER-TRANSIENT')],
      cashDeductionUpdates: [
        { record: { ...current, amount: minor(75_00n) }, expectedDecidedAt: null },
      ],
    })

    await expect(deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)).rejects.toMatchObject({
      code: 'STALE_OPERATION_BATCH',
    })
    expect(await deps.orders.listByShift(SHIFT_ID)).toEqual([])
    expect((await deps.cashDeductions.listByShift(SHIFT_ID))[0]?.amount).toBe(minor(50_00n))
  })

  it('deletes an exact OCR duplicate atomically and restores it after a later failure', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const partial = {
      ...deduction('deduction-partial', 'recent-orders:aaaaaaaaaaaaaaaa'),
      pointA: 'Pickup',
    }
    const richer = {
      ...deduction('deduction-richer', 'recent-orders:aaaaaaaaaaaaaaaa~2'),
      pointA: 'Pickup',
      pointB: 'Dropoff',
    }
    await deps.cashDeductions.create(partial, ACTOR_ID)
    await deps.cashDeductions.create(richer, ACTOR_ID)
    const batch = operationBatch({
      cashDeductionDeletes: [{ expected: partial }],
      movements: [{ amount: minor(20_00n), occurredMinute: '08:01' }],
    })

    const originalMerge = deps.movements.merge.bind(deps.movements)
    deps.movements.merge = async (...args: Parameters<typeof originalMerge>) => {
      await originalMerge(...args)
      throw Object.assign(new Error('injected failure after duplicate deletion'), { code: 'INJECTED_FAILURE' })
    }
    try {
      await expect(deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)).rejects.toMatchObject({
        code: 'INJECTED_FAILURE',
      })
    } finally {
      deps.movements.merge = originalMerge
    }
    expect((await deps.cashDeductions.listByShift(SHIFT_ID)).map((row) => row.id).sort()).toEqual([
      'deduction-partial',
      'deduction-richer',
    ])
    expect(await deps.movements.listByShift(SHIFT_ID)).toEqual([])

    await deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)
    expect((await deps.cashDeductions.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual([
      'deduction-richer',
    ])
  })

  it('rejects an OCR duplicate deletion when a manager decided the row after inspection', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const expected = {
      ...deduction('deduction-racing-review', 'recent-orders:bbbbbbbbbbbbbbbb'),
      pointA: 'Pickup',
    }
    await deps.cashDeductions.create(expected, ACTOR_ID)
    await deps.cashDeductions.update({
      ...expected,
      decisionReason: 'manager confirmed this is a separate operation',
      decidedBy: 'manager-user',
      decidedAt: '2026-07-21T05:04:00.000Z',
    }, 'manager-user')

    await expect(deps.operationBatches.apply(SHIFT_ID, operationBatch({
      orderCreates: [order('order-transient-delete', 'ORDER-TRANSIENT-DELETE')],
      cashDeductionDeletes: [{ expected }],
    }), ACTOR_ID)).rejects.toMatchObject({ code: 'STALE_OPERATION_BATCH' })

    expect(await deps.orders.listByShift(SHIFT_ID)).toEqual([])
    expect(await deps.cashDeductions.listByShift(SHIFT_ID)).toEqual([
      expect.objectContaining({
        id: expected.id,
        decidedBy: 'manager-user',
        decisionReason: 'manager confirmed this is a separate operation',
      }),
    ])
  })

  it.each([
    ['an order owned by another shift', 'order-foreign', true],
    ['a missing order', 'order-missing', false],
  ] as const)('rejects a movement linked to %s and rolls the whole batch back', async (_label, orderId, foreign) => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    await deps.orders.create(order('order-existing', 'ORDER-EXISTING'), ACTOR_ID)
    await deps.cashDeductions.create(deduction('deduction-existing', 'deduction-existing'), ACTOR_ID)
    const [existingMovement] = await deps.movements.merge(
      SHIFT_ID,
      [{ amount: minor(10_00n), occurredMinute: '08:00', orderId: null }],
      ACTOR_ID,
    )
    expect(existingMovement?.id).toBe('wm-1')

    if (foreign) {
      await deps.shifts.create({
        ...shift(),
        id: OTHER_SHIFT_ID,
        driverId: 'driver-2',
        vehicleId: 'vehicle-2',
        shiftNo: 2,
      }, ACTOR_ID)
      await deps.orders.create({
        ...order('order-foreign', 'ORDER-FOREIGN'),
        shiftId: OTHER_SHIFT_ID,
      }, ACTOR_ID)
    }

    const batch = operationBatch({
      orderCreates: [order('order-transient', 'ORDER-TRANSIENT')],
      cashDeductionCreates: [deduction('deduction-transient', 'deduction-transient')],
      movements: [{ amount: minor(20_00n), occurredMinute: '08:01', orderId }],
    })

    await expect(deps.operationBatches.apply(SHIFT_ID, batch, ACTOR_ID)).rejects.toMatchObject({
      code: 'OPERATION_BATCH_SHIFT_MISMATCH',
    })
    expect((await deps.orders.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual(['order-existing'])
    expect((await deps.cashDeductions.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual([
      'deduction-existing',
    ])
    expect((await deps.movements.listByShift(SHIFT_ID)).map((row) => row.id)).toEqual(['wm-1'])
    if (foreign) {
      expect((await deps.orders.listByShift(OTHER_SHIFT_ID)).map((row) => row.id)).toEqual(['order-foreign'])
    }
  })

  it('atomically replaces an undecided order with its legacy deduction and neutralizes linked wallet evidence', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const currentOrder = order('order-sign-flip', 'SIGN-FLIP')
    await deps.orders.create(currentOrder, ACTOR_ID)
    await deps.movements.merge(
      SHIFT_ID,
      [{
        amount: minor(20_00n),
        occurredMinute: '08:32',
        orderId: currentOrder.id,
        role: 'order_credit',
        included: true,
      }],
      ACTOR_ID,
    )

    await deps.operationBatches.apply(SHIFT_ID, operationBatch({
      legacyKindTransitions: [{
        providerOrderNo: 'SIGN-FLIP',
        targetKind: 'cash_deduction',
        expectedOppositeId: currentOrder.id,
        expectedOppositeDecidedAt: null,
      }],
      cashDeductionCreates: [deduction('deduction-sign-flip', 'legacy:SIGN-FLIP')],
    }), ACTOR_ID)

    expect(await deps.orders.listByShift(SHIFT_ID)).toEqual([])
    expect((await deps.cashDeductions.listByShift(SHIFT_ID)).map((row) => row.operationKey)).toEqual([
      'legacy:SIGN-FLIP',
    ])
    expect(await deps.movements.listByShift(SHIFT_ID)).toEqual([
      expect.objectContaining({
        orderId: null,
        role: 'unmatched',
        included: false,
        ambiguous: true,
      }),
    ])
  })

  it('serializes opposite-sign batches so exactly one financial representation survives', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const positive = operationBatch({
      legacyKindTransitions: [{
        providerOrderNo: 'RACING-SIGN',
        targetKind: 'order',
        expectedOppositeId: null,
        expectedOppositeDecidedAt: null,
      }],
      orderCreates: [order('order-racing-sign', 'RACING-SIGN')],
    })
    const negative = operationBatch({
      legacyKindTransitions: [{
        providerOrderNo: 'RACING-SIGN',
        targetKind: 'cash_deduction',
        expectedOppositeId: null,
        expectedOppositeDecidedAt: null,
      }],
      cashDeductionCreates: [deduction('deduction-racing-sign', 'legacy:RACING-SIGN')],
    })

    const results = await Promise.allSettled([
      deps.operationBatches.apply(SHIFT_ID, positive, ACTOR_ID),
      deps.operationBatches.apply(SHIFT_ID, negative, ACTOR_ID),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'STALE_OPERATION_BATCH' }) }),
    ])

    const orders = await deps.orders.listByShift(SHIFT_ID)
    const deductions = await deps.cashDeductions.listByShift(SHIFT_ID)
    expect(orders.length + deductions.length).toBe(1)
    expect(
      orders.some((row) => row.providerOrderNo === 'RACING-SIGN') ||
      deductions.some((row) => row.operationKey === 'legacy:RACING-SIGN'),
    ).toBe(true)
  })

  it('does not delete a manager-reviewed opposite-kind row', async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(shift(), ACTOR_ID)
    const reviewedAt = '2026-07-21T05:04:00.000Z'
    await deps.cashDeductions.create(
      deduction('deduction-reviewed-kind', 'legacy:REVIEWED-KIND', reviewedAt),
      'manager-user',
    )

    await expect(deps.operationBatches.apply(SHIFT_ID, operationBatch({
      legacyKindTransitions: [{
        providerOrderNo: 'REVIEWED-KIND',
        targetKind: 'order',
        expectedOppositeId: 'deduction-reviewed-kind',
        expectedOppositeDecidedAt: reviewedAt,
      }],
      orderCreates: [order('order-reviewed-kind', 'REVIEWED-KIND')],
    }), ACTOR_ID)).rejects.toMatchObject({ code: 'STALE_OPERATION_BATCH' })

    expect(await deps.orders.listByShift(SHIFT_ID)).toEqual([])
    expect(await deps.cashDeductions.listByShift(SHIFT_ID)).toEqual([
      expect.objectContaining({
        id: 'deduction-reviewed-kind',
        decidedBy: 'manager-user',
        decidedAt: reviewedAt,
      }),
    ])
  })
})
