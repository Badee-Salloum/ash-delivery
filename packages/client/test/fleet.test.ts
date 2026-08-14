import { describe, expect, it } from 'vitest'
import {
  type LiveShiftRow,
  firstFreeSlot,
  fleetSummary,
  isTakeable,
  occupancyOf,
  packsOn,
  spareBatteries,
  photoAge,
  photoAgeFromClockSkew,
} from '../src/fleet.ts'

/**
 * The fleet screen showed ten bikes as «جاهزة» while three were out with drivers.
 *
 * Nothing hid them — `GET /vehicles` filters on branch and nothing else. What was missing was the
 * other half of the sentence: which of them somebody already has. The screen even fetched the shift
 * list and used it for one narrow case, so the data was there and discarded.
 */

const shift = (over: Partial<LiveShiftRow> = {}): LiveShiftRow => ({
  id: 'sh-1',
  vehicleId: 'v-1',
  driverId: 'd-1',
  state: 'open',
  ...over,
})

describe('who has this bike', () => {
  it('names the driver of a bike that is out', () => {
    const o = occupancyOf('v-1', [shift()])
    expect(o.kind).toBe('out')
    expect(o.driverId).toBe('d-1')
    expect(o.shiftId).toBe('sh-1')
    expect(isTakeable(o)).toBe(false)
  })

  it('is free when no shift holds it', () => {
    expect(occupancyOf('v-2', [shift()])).toEqual({
      kind: 'free',
      shiftId: null,
      driverId: null,
      shiftState: null,
    })
    expect(isTakeable(occupancyOf('v-2', []))).toBe(true)
  })

  /**
   * THE REGRESSION THAT JUSTIFIES `?live=1`.
   *
   * A shift opened at 23:40 and still running belongs to yesterday's business date. Read the shift
   * list by date and that bike reports free, so the screen offers it to a second driver while the
   * first one is still riding it. This function never sees a date, which is the point — the caller
   * must hand it the date-independent list.
   */
  it('does not care what day the shift started — a live shift is a live shift', () => {
    const yesterdaysStillRunning = [shift({ id: 'sh-late', state: 'open' })]
    expect(occupancyOf('v-1', yesterdaysStillRunning).kind).toBe('out')
  })

  it('separates the three places an occupied bike can be', () => {
    expect(occupancyOf('v-1', [shift({ state: 'draft' })]).kind).toBe('waiting_to_start')
    expect(occupancyOf('v-1', [shift({ state: 'awaiting_open_approval' })]).kind).toBe('waiting_to_start')
    expect(occupancyOf('v-1', [shift({ state: 'open' })]).kind).toBe('out')
    // Suspended is a mid-shift incident: the driver still has the bike.
    expect(occupancyOf('v-1', [shift({ state: 'suspended' })]).kind).toBe('out')
    // Back at the branch, but its money is unapproved, so bike and shift are still bound.
    expect(occupancyOf('v-1', [shift({ state: 'pending_review' })]).kind).toBe('awaiting_review')
  })

  it('releases the bike once the shift is finished or cancelled', () => {
    for (const state of ['approved', 'week_locked', 'cancelled']) {
      expect(occupancyOf('v-1', [shift({ state })]).kind).toBe('free')
    }
  })

  it('carries the raw state through, so the caller labels it from the catalogue', () => {
    expect(occupancyOf('v-1', [shift({ state: 'suspended' })]).shiftState).toBe('suspended')
  })
})

describe('battery slots', () => {
  const pack = (id: string, vehicleId: string | null, slotNo: number | null) => ({ id, vehicleId, slotNo })

  it('gives the first empty socket', () => {
    expect(firstFreeSlot([pack('b1', 'v-1', 1)], 'v-1', 3)).toBe(2)
    expect(firstFreeSlot([pack('b1', 'v-1', 2)], 'v-1', 3)).toBe(1)
    expect(firstFreeSlot([], 'v-1', 3)).toBe(1)
  })

  /**
   * The bug this replaces: the screen counted only `active` packs, but the database's unique index
   * is `(vehicle_id, slot_no)` and does not care about `active`. So a retired pack still bolted into
   * slot 1 made the UI offer slot 1 and the API answer `battery_slot_taken` — an error the manager
   * could do nothing about, on a screen that had just told him the slot was free.
   */
  it('counts a fitted pack even when it is inactive — the socket is still full', () => {
    const retiredButFitted = [{ id: 'b1', vehicleId: 'v-1', slotNo: 1, active: false }]
    expect(firstFreeSlot(retiredButFitted, 'v-1', 3)).toBe(2)
  })

  it('refuses rather than proposing a slot the bike does not have', () => {
    const full = [pack('b1', 'v-1', 1), pack('b2', 'v-1', 2)]
    expect(firstFreeSlot(full, 'v-1', 2)).toBeNull()
    expect(firstFreeSlot(full, 'v-1', 3)).toBe(3)
  })

  it('ignores the pack being moved, so re-fitting it to its own bike is not a collision', () => {
    const fitted = [pack('b1', 'v-1', 1), pack('b2', 'v-1', 2)]
    expect(firstFreeSlot(fitted, 'v-1', 2, 'b1')).toBe(1)
  })

  it('lists a bike’s packs in slot order, inactive ones included', () => {
    const all = [
      { id: 'b2', vehicleId: 'v-1', slotNo: 2 },
      { id: 'b1', vehicleId: 'v-1', slotNo: 1 },
      { id: 'b9', vehicleId: 'v-2', slotNo: 1 },
    ]
    expect(packsOn(all, 'v-1').map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('counts a spare as unfitted AND active — a retired pack on the shelf is not a spare', () => {
    const all = [
      { vehicleId: null, active: true },
      { vehicleId: null, active: false },
      { vehicleId: 'v-1', active: true },
    ]
    expect(spareBatteries(all)).toHaveLength(1)
  })
})

describe('the fleet summary', () => {
  it('counts what is unavailable, not just what exists', () => {
    const vehicles = [{ id: 'v-1' }, { id: 'v-2' }, { id: 'v-3' }]
    const batteries = [
      { vehicleId: 'v-1', active: true },
      { vehicleId: 'v-1', active: true },
      { vehicleId: null, active: true },
    ]
    const live = [shift({ vehicleId: 'v-1' }), shift({ id: 'sh-2', vehicleId: 'v-2', state: 'pending_review' })]

    expect(fleetSummary(vehicles, batteries, live)).toEqual({ total: 3, busy: 2, packs: 3, spares: 1 })
  })
})

describe('how old the picture was', () => {
  const iso = (ms: number): string => new Date(ms).toISOString()
  const T = Date.UTC(2026, 7, 11, 12, 0, 0)

  it('reads fresh when it was taken moments before it arrived — the old camera behaviour', () => {
    expect(photoAge(iso(T), iso(T + 20_000))).toEqual({ kind: 'fresh', minutes: 0 })
    expect(photoAge(iso(T), iso(T + 5 * 60_000))).toEqual({ kind: 'fresh', minutes: 5 })
  })

  it('reads stale once the photo predates its upload by half an hour', () => {
    expect(photoAge(iso(T), iso(T + 30 * 60_000))).toEqual({ kind: 'stale', minutes: 30 })
    expect(photoAge(iso(T), iso(T + 3 * 60 * 60_000))).toEqual({ kind: 'stale', minutes: 180 })
  })

  /**
   * The picker gave no usable timestamp — `lastModified` is 0 on some Android pickers. Silence is
   * reported as silence: calling it fresh would be inventing the very guarantee that was lost when
   * the camera stopped being forced.
   */
  it('says unknown rather than fresh when there is no timestamp', () => {
    expect(photoAge(null, iso(T))).toEqual({ kind: 'unknown' })
    expect(photoAge(iso(T), null)).toEqual({ kind: 'unknown' })
    expect(photoAge('not-a-date', iso(T))).toEqual({ kind: 'unknown' })
  })

  it('treats a phone clock running ahead as fresh, not as a negative age', () => {
    expect(photoAge(iso(T + 4 * 60_000), iso(T))).toEqual({ kind: 'fresh', minutes: 0 })
  })

  it('uses upload response clock skew without inventing an age when it is absent', () => {
    expect(photoAgeFromClockSkew(30 * 60_000)).toEqual({ kind: 'stale', minutes: 30 })
    expect(photoAgeFromClockSkew(30 * 60_000 - 1)).toEqual({ kind: 'fresh', minutes: 30 })
    expect(photoAgeFromClockSkew(-60_000)).toEqual({ kind: 'fresh', minutes: 0 })
    expect(photoAgeFromClockSkew(null)).toEqual({ kind: 'unknown' })
  })
})
