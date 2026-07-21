import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import type { Actor, RoleKey } from '../../src/rbac/can.ts'
import {
  type EndPackage,
  type ShiftAction,
  type ShiftState,
  type StartPackage,
  type TransitionContext,
  endPackageGaps,
  isLive,
  startPackageGaps,
  transition,
} from '../../src/shift/state.ts'

const BRANCH = 'branch-damascus'
const DRIVER = 'driver-1'
const syp = (n: number) => minor(BigInt(n) * 100n)

const actor = (roleKey: RoleKey, over: Partial<Actor> = {}): Actor => ({
  userId: `user-${roleKey}`,
  roleKey,
  branchId: roleKey === 'driver' || roleKey === 'branch_manager' ? BRANCH : null,
  driverId: roleKey === 'driver' ? DRIVER : null,
  ...over,
})

const completeStart = (over: Partial<StartPackage> = {}): StartPackage => ({
  mediaSlots: ['odometer'],
  batteryPercent: 92,
  odometerKm: 15_320,
  floatTotal: syp(100_000),
  topupTotal: syp(50_000),
  driverConfirmedAt: '2026-07-21T06:10:00Z',
  ...over,
})

const completeEnd = (over: Partial<EndPackage> = {}): EndPackage => ({
  mediaSlots: ['dashboard', 'wallet', 'odometer', 'wallet_zeroed'],
  odometerKm: 15_412,
  batteryPercent: 18,
  cashDeclared: syp(160_000),
  walletDeclared: syp(70_000),
  orderCount: 20,
  allOrdersConfirmed: true,
  ...over,
})

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: actor('branch_manager'),
  driverId: DRIVER,
  branchId: BRANCH,
  ...over,
})

describe('the happy path', () => {
  it('walks draft → awaiting → open → pending_review → approved → week_locked', () => {
    const steps: Array<[ShiftState, ShiftAction, ShiftState, TransitionContext]> = [
      ['draft', 'driver_confirm_start', 'awaiting_open_approval',
        ctx({ actor: actor('driver'), startPackage: completeStart({ driverConfirmedAt: null }) })],
      ['awaiting_open_approval', 'manager_approve_open', 'open',
        ctx({ startPackage: completeStart() })],
      ['open', 'driver_submit_end', 'pending_review',
        ctx({ actor: actor('driver'), endPackage: completeEnd() })],
      ['pending_review', 'manager_approve_close', 'approved',
        ctx({ endPackage: completeEnd(), br1: { balanced: true, splitBalanced: true } })],
      ['approved', 'week_lock', 'week_locked', ctx({ actor: actor('system_admin') })],
    ]
    for (const [from, action, expected, context] of steps) {
      const result = transition(from, action, context)
      expect(result, `${from} --${action}-->`).toEqual({ ok: true, next: expected })
    }
  })
})

describe('the OPEN gate (BR5, AC #1)', () => {
  it('refuses to confirm without the odometer photo', () => {
    const result = transition('draft', 'driver_confirm_start',
      ctx({ actor: actor('driver'), startPackage: completeStart({ mediaSlots: [], driverConfirmedAt: null }) }))
    expect(result).toMatchObject({ ok: false, reason: 'start_package_incomplete' })
    expect(result.ok === false && result.gaps).toContainEqual({ kind: 'missing_photo', slot: 'odometer' })
  })

  it('refuses to confirm without the battery percentage', () => {
    const result = transition('draft', 'driver_confirm_start',
      ctx({ actor: actor('driver'), startPackage: completeStart({ batteryPercent: null, driverConfirmedAt: null }) }))
    expect(result).toMatchObject({ ok: false, reason: 'start_package_incomplete' })
  })

  it('refuses manager approval when the driver has not confirmed — the manager is the SECOND signature', () => {
    const result = transition('awaiting_open_approval', 'manager_approve_open',
      ctx({ startPackage: completeStart({ driverConfirmedAt: null }) }))
    expect(result).toEqual({ ok: false, reason: 'driver_not_confirmed' })
  })

  it('lets the manager send the package back for a re-shoot (C-7)', () => {
    expect(transition('awaiting_open_approval', 'manager_request_rephoto', ctx()))
      .toEqual({ ok: true, next: 'draft' })
  })

  it('accepts a zero float — a driver may start on a wallet top-up alone', () => {
    expect(
      transition('draft', 'driver_confirm_start',
        ctx({ actor: actor('driver'), startPackage: completeStart({ floatTotal: minor(0n), driverConfirmedAt: null }) })),
    ).toEqual({ ok: true, next: 'awaiting_open_approval' })
  })
})

describe('the CLOSE gate (BR5, AC #2)', () => {
  it('refuses approval when BR1 is not zero', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({ endPackage: completeEnd(), br1: { balanced: false, splitBalanced: false } })),
    ).toEqual({ ok: false, reason: 'br1_not_zero' })
  })

  it('refuses approval when BR1 was never evaluated', () => {
    expect(transition('pending_review', 'manager_approve_close', ctx({ endPackage: completeEnd() })))
      .toEqual({ ok: false, reason: 'br1_not_zero' })
  })

  it.each(['dashboard', 'wallet', 'odometer', 'wallet_zeroed'])('refuses without the %s photo', (slot) => {
    const result = transition('pending_review', 'manager_approve_close',
      ctx({
        endPackage: completeEnd({ mediaSlots: ['dashboard', 'wallet', 'odometer', 'wallet_zeroed'].filter((s) => s !== slot) }),
        br1: { balanced: true, splitBalanced: true },
      }))
    expect(result).toMatchObject({ ok: false, reason: 'end_package_incomplete' })
    expect(result.ok === false && result.gaps).toContainEqual({ kind: 'missing_photo', slot })
  })

  it('refuses while any order is still unconfirmed by the driver', () => {
    const result = transition('pending_review', 'manager_approve_close',
      ctx({ endPackage: completeEnd({ allOrdersConfirmed: false }), br1: { balanced: true, splitBalanced: true } }))
    expect(result).toMatchObject({ ok: false, reason: 'end_package_incomplete' })
    expect(result.ok === false && result.gaps).toContainEqual({ kind: 'unconfirmed_orders' })
  })
})

describe('the split gate — a pay-mode error hides behind a perfect scalar', () => {
  const splitMismatch = { balanced: true, splitBalanced: false }

  it('advisory (pilot) lets it through, because BR1 itself is zero', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({ endPackage: completeEnd(), br1: splitMismatch, splitGate: 'advisory' })),
    ).toEqual({ ok: true, next: 'approved' })
  })

  it('strict blocks it, once calibrated against Yallago’s real arithmetic', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({ endPackage: completeEnd(), br1: splitMismatch, splitGate: 'strict' })),
    ).toEqual({ ok: false, reason: 'br1_split_mismatch' })
  })

  it('defaults to advisory when unset', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({ endPackage: completeEnd(), br1: splitMismatch })),
    ).toEqual({ ok: true, next: 'approved' })
  })
})

describe('concurrent edit during review', () => {
  it('refuses approval when the driver changed an order after the manager loaded the screen', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({
          endPackage: completeEnd(),
          br1: { balanced: true, splitBalanced: true },
          reviewedOrdersHash: 'abc123',
          currentOrdersHash: 'def456',
        })),
    ).toEqual({ ok: false, reason: 'orders_changed_since_review' })
  })

  it('allows approval when the hash still matches', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({
          endPackage: completeEnd(),
          br1: { balanced: true, splitBalanced: true },
          reviewedOrdersHash: 'abc123',
          currentOrdersHash: 'abc123',
        })),
    ).toEqual({ ok: true, next: 'approved' })
  })
})

describe('RBAC on transitions (AC #12)', () => {
  it('a driver may not approve his own shift', () => {
    expect(
      transition('pending_review', 'manager_approve_close',
        ctx({ actor: actor('driver'), endPackage: completeEnd(), br1: { balanced: true, splitBalanced: true } })),
    ).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('a branch manager from another branch may not approve', () => {
    expect(
      transition('awaiting_open_approval', 'manager_approve_open',
        ctx({ actor: actor('branch_manager', { branchId: 'branch-aleppo' }), startPackage: completeStart() })),
    ).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('only the system admin may week-lock', () => {
    expect(transition('approved', 'week_lock', ctx())).toEqual({ ok: false, reason: 'forbidden' })
    expect(transition('approved', 'week_lock', ctx({ actor: actor('general_manager') })))
      .toEqual({ ok: false, reason: 'forbidden' })
    expect(transition('approved', 'week_lock', ctx({ actor: actor('system_admin') })))
      .toEqual({ ok: true, next: 'week_locked' })
  })

  it('another driver may not submit this driver’s end package', () => {
    expect(
      transition('open', 'driver_submit_end',
        ctx({ actor: actor('driver', { driverId: 'driver-2' }), endPackage: completeEnd() })),
    ).toEqual({ ok: false, reason: 'forbidden' })
  })
})

describe('suspended shifts (SRS C-1 / س29)', () => {
  it('can be entered from every live state', () => {
    for (const from of ['draft', 'awaiting_open_approval', 'open', 'pending_review'] as ShiftState[]) {
      expect(transition(from, 'suspend', ctx())).toEqual({ ok: true, next: 'suspended' })
    }
  })

  it('closes under exactly the same equation — suspension is not a way around BR1', () => {
    expect(
      transition('suspended', 'driver_submit_end',
        ctx({ actor: actor('driver'), endPackage: completeEnd() })),
    ).toEqual({ ok: true, next: 'pending_review' })

    expect(
      transition('suspended', 'driver_submit_end',
        ctx({ actor: actor('driver'), endPackage: completeEnd({ mediaSlots: [] }) })),
    ).toMatchObject({ ok: false, reason: 'end_package_incomplete' })
  })

  it('can resume to open', () => {
    expect(transition('suspended', 'resume', ctx({ actor: actor('driver') })))
      .toEqual({ ok: true, next: 'open' })
  })
})

describe('immutability after the week lock (BR7, AC #9)', () => {
  it('refuses every action once locked', () => {
    const actions: ShiftAction[] = [
      'driver_confirm_start', 'manager_approve_open', 'driver_submit_end',
      'manager_approve_close', 'manager_reject_close', 'suspend', 'resume',
    ]
    for (const action of actions) {
      expect(transition('week_locked', action, ctx({ actor: actor('system_admin') })))
        .toEqual({ ok: false, reason: 'week_already_locked' })
    }
  })

  it('an approved shift cannot go back to open', () => {
    expect(transition('approved', 'manager_reject_close', ctx()))
      .toEqual({ ok: false, reason: 'illegal_transition' })
  })
})

describe('occupancy', () => {
  it('a shift holds its driver and vehicle only while live', () => {
    expect(['draft', 'awaiting_open_approval', 'open', 'pending_review', 'suspended'].every((s) => isLive(s as ShiftState))).toBe(true)
    expect(isLive('approved')).toBe(false)
    expect(isLive('week_locked')).toBe(false)
  })
})

describe('gap reporting is a checklist, not a boolean', () => {
  it('lists every missing start item at once', () => {
    const gaps = startPackageGaps({
      mediaSlots: [], batteryPercent: null, odometerKm: null,
      floatTotal: syp(0), topupTotal: syp(0), driverConfirmedAt: null,
    })
    expect(gaps).toHaveLength(3)
  })

  it('lists every missing end item at once', () => {
    const gaps = endPackageGaps({
      mediaSlots: [], odometerKm: null, batteryPercent: null,
      cashDeclared: null, walletDeclared: null, orderCount: 0, allOrdersConfirmed: false,
    })
    expect(gaps.filter((g) => g.kind === 'missing_photo')).toHaveLength(4)
    expect(gaps).toContainEqual({ kind: 'no_orders' })
  })
})
