/**
 * What the fleet is actually doing — the questions the admin fleet screen has to answer before it
 * can show anything true, expressed as pure functions so they can be tested. `apps/admin` has no
 * test setup at all; this package does.
 */

/** The shift states in which a bike is not available to anybody else. */
const OCCUPYING = new Set(['draft', 'awaiting_open_approval', 'open', 'suspended', 'pending_review'])

/**
 * Where a bike is, from the branch manager's point of view.
 *
 * The domain's `LIVE_STATES` says a shift "still occupies its driver and vehicle" for five states,
 * which is the right rule for availability and the wrong answer for a screen: a manager standing in
 * the branch needs to know WHICH of those, because they put the bike in three different places.
 *
 *   `waiting_to_start` — at the branch, gate not yet approved. This is the stranded case the screen
 *                        already offers «تحرير الآلية» for.
 *   `out`              — physically gone, with a driver on it. Nobody else can take it.
 *   `awaiting_review`  — back at the branch, but its money has not been approved, so the shift and
 *                        the bike are still bound together.
 *
 * `free` means no shift holds it. It says nothing about `state`/`active` — a bike can be free and in
 * maintenance, which is a different axis and gets its own badge.
 */
export type Occupancy = 'free' | 'waiting_to_start' | 'out' | 'awaiting_review'

export interface LiveShiftRow {
  id: string
  vehicleId: string
  driverId: string
  state: string
}

export interface VehicleOccupancy {
  kind: Occupancy
  shiftId: string | null
  driverId: string | null
  /** The shift state as the server gave it, so the caller can label it from `t.shift.states`. */
  shiftState: string | null
}

const FREE: VehicleOccupancy = { kind: 'free', shiftId: null, driverId: null, shiftState: null }

/**
 * IMPORTANT — feed this `GET /shifts?live=1`, never `?date=`.
 *
 * A shift opened before midnight and still running belongs to YESTERDAY's business date, so a
 * date-filtered read reports that bike as free and the screen invites a manager to hand it to a
 * second driver. `?live=1` is date-independent for exactly this reason. The same mistake, in the
 * approval queue, made closed shifts vanish from the only screen that shows them.
 */
export function occupancyOf(vehicleId: string, liveShifts: readonly LiveShiftRow[]): VehicleOccupancy {
  // Deliberately the FIRST occupying shift rather than a search for the "best" one: two live shifts
  // on one bike is a data fault, not a state to render prettily, and picking a winner would hide it.
  const held = liveShifts.find((s) => s.vehicleId === vehicleId && OCCUPYING.has(s.state))
  if (!held) return FREE

  const kind: Occupancy =
    held.state === 'pending_review'
      ? 'awaiting_review'
      : held.state === 'draft' || held.state === 'awaiting_open_approval'
        ? 'waiting_to_start'
        : 'out'

  return { kind, shiftId: held.id, driverId: held.driverId, shiftState: held.state }
}

/** Can this bike be handed to a driver right now? Availability, not location. */
export const isTakeable = (o: VehicleOccupancy): boolean => o.kind === 'free'

/**
 * The next free battery slot on a bike, counting EVERY fitted pack.
 *
 * The screen used to count only `active` packs, which disagrees with the database: the unique index
 * is on `(vehicle_id, slot_no)` regardless of `active`, so an inactive pack sitting in slot 1 made
 * the UI offer slot 1 and the API answer `battery_slot_taken`. A slot is occupied by whatever is
 * bolted into it.
 *
 * Returns `null` when the bike is full, so the caller refuses instead of posting a doomed request.
 */
export function firstFreeSlot(
  fitted: readonly { vehicleId: string | null; slotNo: number | null; id: string }[],
  vehicleId: string,
  maxSlots: number,
  ignoreBatteryId?: string,
): number | null {
  const taken = new Set(
    fitted
      .filter((b) => b.vehicleId === vehicleId && b.slotNo !== null && b.id !== ignoreBatteryId)
      .map((b) => b.slotNo as number),
  )
  for (let slot = 1; slot <= maxSlots; slot++) if (!taken.has(slot)) return slot
  return null
}

/**
 * The packs bolted to one bike, in slot order.
 *
 * Includes inactive packs — see `firstFreeSlot`. A pack that is fitted but retired is still occupying
 * a socket, and a manager who cannot see it cannot work out why the slot will not take a new one.
 */
export function packsOn<T extends { vehicleId: string | null; slotNo: number | null }>(
  batteries: readonly T[],
  vehicleId: string,
): T[] {
  return batteries
    .filter((b) => b.vehicleId === vehicleId)
    .slice()
    .sort((a, b) => (a.slotNo ?? 0) - (b.slotNo ?? 0))
}

/** Ready spares on the shelf — what a swap draws from, and the only packs no bike card shows. */
export function spareBatteries<T extends { vehicleId: string | null; active: boolean }>(
  batteries: readonly T[],
): T[] {
  return batteries.filter((b) => b.vehicleId === null && b.active)
}

/** The header line: what the fleet is, and how much of it is unavailable right now. */
export function fleetSummary(
  vehicles: readonly { id: string }[],
  batteries: readonly { vehicleId: string | null; active: boolean }[],
  liveShifts: readonly LiveShiftRow[],
): { total: number; busy: number; packs: number; spares: number } {
  return {
    total: vehicles.length,
    busy: vehicles.filter((v) => !isTakeable(occupancyOf(v.id, liveShifts))).length,
    packs: batteries.length,
    spares: spareBatteries(batteries).length,
  }
}

/**
 * How old the picture was when it reached us — the control that replaced the forced camera.
 *
 * Every evidence slot can now be filled from the gallery, so «this photo was taken just now» stopped
 * being a guarantee of the capture flow and became a question about the file. The phone's clock is a
 * CLAIM and the server's receipt is authoritative, so this reports the gap between them rather than
 * trusting either alone.
 *
 * `fresh` means the picture was taken within minutes of arriving — the old `capture` behaviour.
 * `stale` means it was already old when it was uploaded, which is not misconduct on its own (a
 * driver may photograph the odometer before his phone finds signal) but is exactly the thing a
 * manager should see before he signs for the cash behind it.
 * `unknown` means the picker gave no usable timestamp; silence is reported as silence, never as fresh.
 */
export type PhotoAge =
  | { kind: 'fresh'; minutes: number }
  | { kind: 'stale'; minutes: number }
  | { kind: 'unknown' }

/** Beyond this, the photo predates its own upload by enough that a manager should look. */
export const PHOTO_STALE_MINUTES = 30

export function photoAge(clientTakenAt: string | null, receivedAt: string | null): PhotoAge {
  if (clientTakenAt === null || receivedAt === null) return { kind: 'unknown' }
  const taken = Date.parse(clientTakenAt)
  const received = Date.parse(receivedAt)
  if (Number.isNaN(taken) || Number.isNaN(received)) return { kind: 'unknown' }

  const ageMs = received - taken
  const minutes = Math.round(ageMs / 60_000)
  // A phone clock running AHEAD of the server produces a negative gap. That is a clock problem, not
  // an old photo, and reporting it as «taken -3 minutes ago» would be nonsense — so it reads fresh.
  if (ageMs <= 0) return { kind: 'fresh', minutes: 0 }
  return ageMs >= PHOTO_STALE_MINUTES * 60_000 ? { kind: 'stale', minutes } : { kind: 'fresh', minutes }
}

/** The upload endpoint already calculated the same receipt/capture gap for the driver UI. */
export function photoAgeFromClockSkew(clockSkewMs: number | null): PhotoAge {
  if (clockSkewMs === null || !Number.isFinite(clockSkewMs)) return { kind: 'unknown' }
  const ageMs = Math.max(0, clockSkewMs)
  const minutes = Math.round(ageMs / 60_000)
  return ageMs >= PHOTO_STALE_MINUTES * 60_000 ? { kind: 'stale', minutes } : { kind: 'fresh', minutes }
}
