/**
 * The vehicle number: «رقم الآلية».
 *
 *     <governorate no>-<branch no>-<vehicle type no>-<machine no>
 *
 * The first electric motorbike of the first branch in Damascus is `1-1-1-1`. The four components
 * are the source of truth and live in four different tables; this module is the ONLY place that
 * knows how they become a string, so the code printed on a sticker, the code stored on the row,
 * and the code shown in the console cannot drift apart.
 *
 * `vehicles.code` holds the formatted result as a WRITTEN column rather than a generated one —
 * the same choice, for the same reason, as `business_date`: the expression reaches across
 * `branches` and `governorates`, and Postgres cannot generate from another table.
 *
 * Pure: no I/O, no clock, no locale. `formatVehicleNumber` deliberately does NOT pad or localise
 * the digits — «1-1-1-1», never «01-01-01-001» and never «١-١-١-١». The number is an identifier
 * that gets typed into a search box and read aloud over a phone, so one canonical spelling beats
 * a pretty one.
 */

export interface VehicleNumber {
  readonly governorateNo: number
  readonly branchNo: number
  readonly typeNo: number
  readonly machineNo: number
}

/** Bounds mirror the CHECK constraints in migration 0007, so a value that formats also stores. */
const LIMITS = {
  governorateNo: 99,
  branchNo: 99,
  typeNo: 99,
  machineNo: 999,
} as const

export class VehicleNumberError extends Error {}

function assertSegment(name: keyof typeof LIMITS, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > LIMITS[name]) {
    throw new VehicleNumberError(`${name} must be an integer in 1..${LIMITS[name]}, got ${value}`)
  }
}

/** `{1,1,1,1}` → `"1-1-1-1"`. Throws rather than emitting a number that could never be stored. */
export function formatVehicleNumber(n: VehicleNumber): string {
  assertSegment('governorateNo', n.governorateNo)
  assertSegment('branchNo', n.branchNo)
  assertSegment('typeNo', n.typeNo)
  assertSegment('machineNo', n.machineNo)
  return `${n.governorateNo}-${n.branchNo}-${n.typeNo}-${n.machineNo}`
}

/**
 * `"1-1-1-1"` → the four components, or `null` if it is not a vehicle number.
 *
 * Returns null rather than throwing because the common caller is a search box: a half-typed
 * `"1-1-"` is a normal keystroke, not an error worth an exception. Leading zeros are rejected —
 * `"01-1-1-1"` would format back as `"1-1-1-1"`, so accepting it would let two spellings of one
 * identifier exist.
 */
export function parseVehicleNumber(text: string): VehicleNumber | null {
  const match = /^\s*(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,3})\s*$/.exec(text)
  if (!match) return null
  const [, g, b, t, m] = match as unknown as [string, string, string, string, string]
  if ([g, b, t, m].some((part) => part.length > 1 && part.startsWith('0'))) return null

  const parsed: VehicleNumber = {
    governorateNo: Number(g),
    branchNo: Number(b),
    typeNo: Number(t),
    machineNo: Number(m),
  }
  // Round-tripping through the formatter applies the same bounds a write would, so parse and
  // format can never disagree about what is valid.
  try {
    formatVehicleNumber(parsed)
  } catch {
    return null
  }
  return parsed
}

/**
 * The next free machine number for a (branch, type).
 *
 * Lowest free rather than highest-plus-one, so retiring bike 3 of 10 hands its number to the next
 * one bought instead of leaving a permanent hole. Fleet numbers are read aloud and written on
 * paperwork; a dense range is easier to work with than a sparse one.
 */
export function nextMachineNo(taken: readonly number[]): number {
  const used = new Set(taken)
  for (let n = 1; n <= LIMITS.machineNo; n++) {
    if (!used.has(n)) return n
  }
  throw new VehicleNumberError(`no machine number free below ${LIMITS.machineNo}`)
}
