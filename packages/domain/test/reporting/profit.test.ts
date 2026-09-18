import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RECEIVABLE_WRITEOFF_LOSS_COST_CENTER } from '../../src/ledger/recipes.ts'
import {
  type ProfitLineClass,
  addProfitLine,
  classifyProfitLine,
  emptyProfitTotals,
  isProfitCost,
  isUuid,
  netProfit,
  signedCost,
  totalCost,
  vehicleIdOfCostLine,
} from '../../src/reporting/profit.ts'

const VEHICLE_UUID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e'
const BRANCH_UUID = '11111111-1111-1111-1111-111111111111'
const none = { vehicleIds: new Set<string>() }

describe('classifyProfitLine', () => {
  it('reads the three P&L funds by name', () => {
    expect(classifyProfitLine('company_revenue', none)).toBe('company')
    expect(classifyProfitLine('other_income', none)).toBe('other_income')
    expect(classifyProfitLine('yalago_income', none)).toBe('yalago')
  })

  it('THE FIX: a vehicle expense posted to cost_center:<vehicle uuid> is a vehicle cost', () => {
    // `expenses.routes.ts` writes `record.vehicleId ?? '<kind>:<branch>'` — the bare uuid.
    expect(classifyProfitLine(`cost_center:${VEHICLE_UUID}`, none)).toBe('vehicle_cost')
    expect(classifyProfitLine(`cost_center:${VEHICLE_UUID.toUpperCase()}`, none)).toBe('vehicle_cost')
  })

  it('counts a non-uuid vehicle id when the branch owns it (the in-memory harness names bikes vehicle-1)', () => {
    const ctx = { vehicleIds: new Set(['vehicle-1', 'vehicle-2']) }
    expect(classifyProfitLine('cost_center:vehicle-1', ctx)).toBe('vehicle_cost')
    expect(classifyProfitLine('cost_center:vehicle-3', ctx)).toBeNull()
    expect(classifyProfitLine('cost_center:vehicle-1', none)).toBeNull()
  })

  it('keeps the legacy vehicle: prefix', () => {
    expect(classifyProfitLine('cost_center:vehicle:v-1', none)).toBe('vehicle_cost')
  })

  it('classifies branch and general centres as operating costs', () => {
    expect(classifyProfitLine(`cost_center:branch:${BRANCH_UUID}`, none)).toBe('operating_cost')
    expect(classifyProfitLine(`cost_center:general:${BRANCH_UUID}`, none)).toBe('operating_cost')
  })

  it('classifies write-offs and wallet / cash-count gaps as losses', () => {
    expect(classifyProfitLine(`cost_center:${RECEIVABLE_WRITEOFF_LOSS_COST_CENTER}`, none)).toBe('loss')
    expect(classifyProfitLine(`cost_center:wallet_adjustment:${BRANCH_UUID}`, none)).toBe('loss')
    expect(classifyProfitLine(`cost_center:cash_count_variance:${BRANCH_UUID}:office_cash`, none)).toBe('loss')
  })

  it('never counts the owner’s capital, whatever prefix it wears', () => {
    const everything = { vehicleIds: new Set(['vehicle-1']) }
    for (const code of [
      'cost_center:owner_funding',
      'cost_center:owner_drawings',
      'cost_center:opening_balance',
      'cost_center:adjustments',
    ]) {
      expect(classifyProfitLine(code, everything), code).toBeNull()
    }
  })

  it('ignores positions and every non-P&L fund', () => {
    for (const code of [
      'office_cash',
      'office_wallet',
      'company_box',
      'fee_earned',
      'yalago_share',
      `driver_cash:${VEHICLE_UUID}`,
      `driver_share_payable:${VEHICLE_UUID}`,
      `advance_receivable_cash:${VEHICLE_UUID}`,
      // A uuid that is NOT behind the cost-centre prefix is not a vehicle cost.
      VEHICLE_UUID,
    ]) {
      expect(classifyProfitLine(code, none), code).toBeNull()
    }
  })

  it('recognises uuids by shape only', () => {
    expect(isUuid(VEHICLE_UUID)).toBe(true)
    expect(isUuid('vehicle-1')).toBe(false)
    expect(isUuid(`${VEHICLE_UUID}x`)).toBe(false)
  })
})

describe('profit totals', () => {
  const ctx = { vehicleIds: new Set(['vehicle-1']) }
  const add = (totals: ReturnType<typeof emptyProfitTotals>, code: string, side: 'D' | 'C', amount: bigint): void =>
    addProfitLine(totals, classifyProfitLine(code, ctx), side, amount)

  it('net = company + other income − (operating + vehicle + loss), and depreciation is not a line here', () => {
    const t = emptyProfitTotals()
    add(t, 'company_revenue', 'C', 100_000n)
    add(t, 'other_income', 'C', 25_000n)
    add(t, 'yalago_income', 'C', 50_000n)
    add(t, `cost_center:branch:${BRANCH_UUID}`, 'D', 10_000n)
    add(t, `cost_center:${VEHICLE_UUID}`, 'D', 4_000n)
    add(t, 'cost_center:vehicle-1', 'D', 1_000n)
    add(t, `cost_center:${RECEIVABLE_WRITEOFF_LOSS_COST_CENTER}`, 'D', 500n)
    add(t, 'cost_center:owner_funding', 'C', 9_000_000n)

    expect(t).toEqual({
      company: 100_000n,
      otherIncome: 25_000n,
      yalago: 50_000n,
      operatingCost: 10_000n,
      vehicleCost: 5_000n,
      loss: 500n,
      costLineCount: 4,
    })
    expect(totalCost(t)).toBe(15_500n)
    expect(netProfit(t)).toBe(109_500n)
  })

  it('a reversed cost nets to zero but still counts its lines', () => {
    const t = emptyProfitTotals()
    add(t, `cost_center:${VEHICLE_UUID}`, 'D', 700n)
    add(t, `cost_center:${VEHICLE_UUID}`, 'C', 700n)
    expect(t.vehicleCost).toBe(0n)
    expect(t.costLineCount).toBe(2)
  })

  it('an aggregated row counts as the lines it summarises', () => {
    const t = emptyProfitTotals()
    addProfitLine(t, 'operating_cost', 'D', 300n, 3)
    addProfitLine(t, 'company', 'C', 300n, 3)
    expect(t.costLineCount).toBe(3)
  })

  it('property: the vehicle-cost fix moves net profit by exactly the vehicle costs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('company_revenue', `cost_center:${VEHICLE_UUID}`, `cost_center:general:${BRANCH_UUID}`), fc.constantFrom<'D' | 'C'>('D', 'C'), fc.bigInt({ min: 1n, max: 10n ** 12n }))),
        (lines) => {
          const fixed = emptyProfitTotals()
          const blind = emptyProfitTotals()
          let vehicle = 0n
          for (const [code, side, amount] of lines) {
            const cls = classifyProfitLine(code, none)
            addProfitLine(fixed, cls, side, amount)
            // Yesterday's reading: a bare-uuid centre was invisible.
            addProfitLine(blind, cls === 'vehicle_cost' ? null : cls, side, amount)
            if (cls === 'vehicle_cost') vehicle += side === 'D' ? amount : -amount
          }
          expect(netProfit(blind) - netProfit(fixed)).toBe(vehicle)
        },
      ),
    )
  })

  it('only the three cost classes are costs', () => {
    const all: Array<ProfitLineClass | null> = ['company', 'other_income', 'yalago', 'operating_cost', 'vehicle_cost', 'loss', null]
    expect(all.filter(isProfitCost)).toEqual(['operating_cost', 'vehicle_cost', 'loss'])
  })
})

describe('vehicleIdOfCostLine (P3 — the fleet table)', () => {
  it('names the vehicle of every line the profit figure calls a vehicle cost', () => {
    expect(vehicleIdOfCostLine(`cost_center:${VEHICLE_UUID}`, none)).toBe(VEHICLE_UUID)
    // The legacy spelling carries the id after its prefix.
    expect(vehicleIdOfCostLine(`cost_center:vehicle:${VEHICLE_UUID}`, none)).toBe(VEHICLE_UUID)
    // The harness names vehicles `vehicle-1`; membership is what makes them vehicles there.
    expect(vehicleIdOfCostLine('cost_center:vehicle-1', { vehicleIds: new Set(['vehicle-1']) })).toBe('vehicle-1')
  })

  it('answers null for everything that is not a vehicle cost', () => {
    for (const code of [
      'company_revenue',
      'other_income',
      'office_cash',
      `cost_center:branch:${BRANCH_UUID}`,
      `cost_center:general:${BRANCH_UUID}`,
      `cost_center:${RECEIVABLE_WRITEOFF_LOSS_COST_CENTER}`,
      'cost_center:owner_funding',
      'cost_center:owner_drawings',
      'cost_center:opening_balance',
      'cost_center:vehicle-1',
      'cost_center:vehicle:',
    ]) {
      expect(vehicleIdOfCostLine(code, none), code).toBeNull()
    }
  })

  it('property: per-vehicle costs add up to the vehicle cost of the profit totals', () => {
    const ids = ['vehicle-1', 'vehicle-2', VEHICLE_UUID]
    const ctx = { vehicleIds: new Set(['vehicle-1', 'vehicle-2']) }
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom(
              ...ids.map((id) => `cost_center:${id}`),
              `cost_center:vehicle:${VEHICLE_UUID}`,
              `cost_center:general:${BRANCH_UUID}`,
              'cost_center:owner_funding',
              'company_revenue',
            ),
            fc.constantFrom<'D' | 'C'>('D', 'C'),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
          ),
        ),
        (lines) => {
          const totals = emptyProfitTotals()
          const perVehicle = new Map<string, bigint>()
          for (const [code, side, amount] of lines) {
            addProfitLine(totals, classifyProfitLine(code, ctx), side, amount)
            const id = vehicleIdOfCostLine(code, ctx)
            if (id !== null) perVehicle.set(id, (perVehicle.get(id) ?? 0n) + signedCost(side, amount))
          }
          const sum = [...perVehicle.values()].reduce((a, b) => a + b, 0n)
          expect(sum).toBe(totals.vehicleCost)
        },
      ),
    )
  })

  it('signedCost adds a debit and takes a credit away', () => {
    expect(signedCost('D', 500n)).toBe(500n)
    expect(signedCost('C', 500n)).toBe(-500n)
  })
})
