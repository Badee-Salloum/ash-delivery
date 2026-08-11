import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import type { Actor, RoleKey } from '../../src/rbac/can.ts'
import {
  ALL_END_SLOTS,
  type EndPackage,
  MAX_PAGE_SLOTS,
  REQUIRED_END_SLOTS,
  type ShiftAction,
  type ShiftState,
  type StartPackage,
  type TransitionContext,
  endPackageGaps,
  isLive,
  pageSlot,
  requiredEndSlots,
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
  mediaSlots: ['dashboard', 'wallet', 'odometer'],
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

  it('refuses manager approval when the driver has not confirmed — the manager is the SECOND signature', () => {
    const result = transition('awaiting_open_approval', 'manager_approve_open',
      ctx({ startPackage: completeStart({ driverConfirmedAt: null }) }))
    expect(result).toEqual({ ok: false, reason: 'driver_not_confirmed' })
  })

  /**
   * A driver whose phone will not run the BMS app.
   *
   * It happens: an old Android, a device the manufacturer's app refuses, Bluetooth that will not
   * pair. Before this he was simply STUCK — the gate wanted a `bms_1` screenshot and a charge figure
   * that his phone was incapable of producing, so he could not open a shift at all.
   *
   * The declaration does not delete the evidence, it moves who owes it. He proceeds; the MANAGER
   * cannot approve until somebody with a working device has read that pack.
   */
  describe('a pack the driver cannot read on his own phone', () => {
    const pack = (over = {}) => ({
      batterySlots: 1,
      batteryReadings: [{ slotNo: 1, percent: null, unavailable: true }],
      mediaSlots: ['odometer'],
      ...over,
    })

    it('lets the driver confirm — he is not asked for a screenshot he cannot take', () => {
      const result = transition('draft', 'driver_confirm_start',
        ctx({ actor: actor('driver'), startPackage: completeStart({ ...pack(), driverConfirmedAt: null }) }))
      expect(result).toEqual({ ok: true, next: 'awaiting_open_approval' })
    })

    it('but STOPS the manager approving until he has read it himself', () => {
      const result = transition('awaiting_open_approval', 'manager_approve_open',
        ctx({ startPackage: completeStart(pack()) }))
      expect(result).toMatchObject({ ok: false, reason: 'start_package_incomplete' })
      expect(result.ok === false && result.gaps).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 1 })
    })

    it('and once the manager supplies the charge, the shift opens', () => {
      const result = transition('awaiting_open_approval', 'manager_approve_open',
        ctx({
          startPackage: completeStart({
            batterySlots: 1,
            batteryReadings: [{ slotNo: 1, percent: 88, unavailable: true }],
            mediaSlots: ['odometer'],
          }),
        }))
      expect(result).toEqual({ ok: true, next: 'open' })
    })

    it('does NOT waive a pack he simply has not done yet — that is still his to close', () => {
      const result = transition('draft', 'driver_confirm_start',
        ctx({
          actor: actor('driver'),
          startPackage: completeStart({
            batterySlots: 1,
            batteryReadings: [],
            mediaSlots: ['odometer'],
            driverConfirmedAt: null,
          }),
        }))
      expect(result).toMatchObject({ ok: false, reason: 'start_package_incomplete' })
      expect(result.ok === false && result.gaps).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
      expect(result.ok === false && result.gaps).toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
    })

    it('waives only the declared pack, never its neighbour', () => {
      const result = transition('draft', 'driver_confirm_start',
        ctx({
          actor: actor('driver'),
          startPackage: completeStart({
            batterySlots: 2,
            batteryReadings: [{ slotNo: 1, percent: null, unavailable: true }, { slotNo: 2, percent: 70 }],
            mediaSlots: ['odometer'],
            driverConfirmedAt: null,
          }),
        }))
      // Pack 2 still owes its screenshot; pack 1 does not.
      expect(result.ok === false && result.gaps).toContainEqual({ kind: 'missing_photo', slot: 'bms_2' })
      expect(result.ok === false && result.gaps).not.toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
    })
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

  it.each(['dashboard', 'wallet', 'odometer'])('refuses without the %s photo', (slot) => {
    const result = transition('pending_review', 'manager_approve_close',
      ctx({
        endPackage: completeEnd({ mediaSlots: ['dashboard', 'wallet', 'odometer'].filter((s) => s !== slot) }),
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
    expect(isLive('cancelled')).toBe(false)
  })
})

describe('upper-level overrides for a stuck shift', () => {
  it('force-cancels any live state to cancelled (no gate — that is the point)', () => {
    for (const from of ['open', 'suspended', 'pending_review'] as ShiftState[]) {
      expect(transition(from, 'manager_force_cancel', ctx())).toEqual({ ok: true, next: 'cancelled' })
    }
  })

  it('force-closes any live state to approved', () => {
    for (const from of ['open', 'suspended', 'pending_review'] as ShiftState[]) {
      expect(transition(from, 'manager_force_close', ctx())).toEqual({ ok: true, next: 'approved' })
    }
  })

  it('both require shift.approve — a driver is refused', () => {
    expect(transition('open', 'manager_force_cancel', ctx({ actor: actor('driver') }))).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(transition('open', 'manager_force_close', ctx({ actor: actor('driver') }))).toMatchObject({ ok: false, reason: 'forbidden' })
  })

  it('cancelled is terminal', () => {
    expect(transition('cancelled', 'resume', ctx({ actor: actor('driver') }))).toMatchObject({ ok: false, reason: 'illegal_transition' })
    expect(transition('cancelled', 'manager_force_close', ctx())).toMatchObject({ ok: false, reason: 'illegal_transition' })
  })
})

describe('gap reporting is a checklist, not a boolean', () => {
  it('lists every missing start item at once', () => {
    const gaps = startPackageGaps({
      mediaSlots: [], batteryPercent: null, odometerKm: null,
      floatTotal: syp(0), topupTotal: syp(0), driverConfirmedAt: null,
    })
    // The odometer photo and the odometer value — the bike-level battery % is no longer gated
    // (charge is per pack), and a float/top-up of zero is legitimate.
    expect(gaps).toHaveLength(2)
  })

  it('lists every missing end item at once', () => {
    const gaps = endPackageGaps({
      mediaSlots: [], odometerKm: null, batteryPercent: null,
      cashDeclared: null, walletDeclared: null, orderCount: 0, allOrdersConfirmed: false,
    })
    expect(gaps.filter((g) => g.kind === 'missing_photo')).toHaveLength(3) // dashboard, wallet, odometer
    expect(gaps).toContainEqual({ kind: 'no_orders' })
  })
})

/**
 * Per-pack battery evidence (SRS §L seam).
 *
 * The bikes carry one or two packs. A fixed slot tuple silently assumed every machine is the
 * same, so a two-pack bike could open its shift with half its charge state unevidenced. The
 * count is not a number anyone types — it is how many packs the fleet says are fitted — so
 * these tests drive it from `batterySlots` exactly as the service does.
 */
describe('battery evidence scales with the bike', () => {
  const startWith = (over: Partial<StartPackage> = {}): StartPackage => ({
    mediaSlots: ['odometer'],
    batteryPercent: 90,
    odometerKm: 1000,
    floatTotal: syp(0),
    topupTotal: syp(0),
    driverConfirmedAt: null,
    ...over,
  })

  it('a bike with no packs on file gates exactly as before', () => {
    // The default keeps every pre-battery shift, and every existing test, unchanged.
    expect(startPackageGaps(startWith())).toEqual([])
  })

  it('a one-pack bike must produce one BMS screenshot and one reading', () => {
    const missing = startPackageGaps(startWith({ batterySlots: 1 }))
    expect(missing).toContainEqual({ kind: 'missing_photo', slot: 'bms_1' })
    expect(missing).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })

    const complete = startPackageGaps(
      startWith({ batterySlots: 1, mediaSlots: ['odometer', 'bms_1'], batteryReadings: [{ slotNo: 1, percent: 100 }] }),
    )
    expect(complete).toEqual([])
  })

  it('a two-pack bike is not satisfied by the first pack alone', () => {
    const gaps = startPackageGaps(
      startWith({ batterySlots: 2, mediaSlots: ['odometer', 'bms_1'], batteryReadings: [{ slotNo: 1, percent: 100 }] }),
    )
    expect(gaps).toContainEqual({ kind: 'missing_photo', slot: 'bms_2' })
    expect(gaps).toContainEqual({ kind: 'missing_battery_reading', slotNo: 2 })
    expect(gaps).not.toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
  })

  it('a one-pack bike is never asked for a second', () => {
    const gaps = startPackageGaps(
      startWith({ batterySlots: 1, mediaSlots: ['odometer', 'bms_1'], batteryReadings: [{ slotNo: 1, percent: 100 }] }),
    )
    expect(gaps.some((g) => g.kind === 'missing_photo' && g.slot === 'bms_2')).toBe(false)
  })

  it('an uploaded screenshot the OCR could not read is still a gap', () => {
    // The photo arriving is not the same as the charge being known. Counting the row as
    // satisfied would let a null percent through the gate on the strength of a file upload.
    const gaps = startPackageGaps(
      startWith({ batterySlots: 1, mediaSlots: ['odometer', 'bms_1'], batteryReadings: [{ slotNo: 1, percent: null }] }),
    )
    expect(gaps).toEqual([{ kind: 'missing_battery_reading', slotNo: 1 }])
  })

  it('the close gate demands the same per-pack evidence', () => {
    const end: EndPackage = {
      mediaSlots: ['dashboard', 'wallet', 'odometer'],
      odometerKm: 1100,
      batteryPercent: 20,
      cashDeclared: syp(0),
      walletDeclared: syp(0),
      orderCount: 1,
      allOrdersConfirmed: true,
      batterySlots: 2,
      batteryReadings: [{ slotNo: 1, percent: 20 }],
    }
    const gaps = endPackageGaps(end)
    expect(gaps).toContainEqual({ kind: 'missing_photo', slot: 'bms_2' })
    expect(gaps).toContainEqual({ kind: 'missing_battery_reading', slotNo: 2 })
  })

  it('accepts the extra pages of a scrollable screen without ever requiring one', () => {
    // «الطلبات الحديثة» and «سجل المدفوعات» both scroll, so a day arrives as several images. The
    // vocabulary must accept them; the GATE must not ask for them — a short day genuinely fits one
    // screenful, and demanding a second would be demanding a screenshot of nothing.
    expect(ALL_END_SLOTS).toContain('dashboard_2')
    expect(ALL_END_SLOTS).toContain('payments_log_4')
    expect(ALL_END_SLOTS).not.toContain(`dashboard_${MAX_PAGE_SLOTS + 1}`)
    expect(requiredEndSlots(0)).not.toContain('dashboard_2')

    const oneImage = endPackageGaps({
      mediaSlots: ['dashboard', 'wallet', 'odometer'],
      odometerKm: 1100,
      batteryPercent: null,
      cashDeclared: syp(0),
      walletDeclared: syp(0),
      orderCount: 1,
      allOrdersConfirmed: true,
    })
    expect(oneImage).toEqual([])
  })

  it('keeps the un-numbered name as page one, so every shift already closed still reads', () => {
    expect(pageSlot('dashboard', 1)).toBe('dashboard')
    expect(pageSlot('dashboard', 2)).toBe('dashboard_2')
    expect(REQUIRED_END_SLOTS).toContain('dashboard')
  })

  it('no longer gates a bike-level battery — charge is tracked per pack now', () => {
    // The whole-bike battery % was dropped: a fitted pack with no reading is what blocks the gate
    // (see the per-pack battery tests), not a separate whole-bike percentage. A close with no
    // bike-level battery, but everything else present, is complete.
    const gaps = endPackageGaps({
      mediaSlots: ['dashboard', 'wallet', 'odometer'],
      odometerKm: 1100,
      batteryPercent: null,
      cashDeclared: syp(0),
      walletDeclared: syp(0),
      orderCount: 1,
      allOrdersConfirmed: true,
    })
    expect(gaps).toEqual([])
  })
})
