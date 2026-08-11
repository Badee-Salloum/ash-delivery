/**
 * Readings that are probably wrong — asked about, never refused.
 *
 * A pack was recorded at 1% at the START of a shift, straight from OCR, and nothing questioned it.
 * A driver does not set off on a flat battery, so that figure is almost certainly the reader
 * mistaking «100» or «10» for «1» — and it went into the evidence as fact.
 *
 * ── WHY THESE ASK RATHER THAN BLOCK ─────────────────────────────────────────────────────────
 * Every one of these can legitimately be true. A pack really can be flat because it was left on
 * charge overnight and the charger tripped. An odometer really can jump if the bike was moved on a
 * truck. Blocking would make the app wrong about the real world and teach drivers to type whatever
 * gets them past it — which is exactly how the 1% got in.
 *
 * So the answer is a question, and a CONFIRMED odd value is worth more than a quiet one: it is a
 * human asserting something surprising, which is the best training label there is.
 */

export type ReadingCheck =
  /** A charge low enough that the bike could not do a shift on it. */
  | { kind: 'battery_too_low_to_start'; percent: number }
  /** The closing odometer is below the opening one. A bike does not drive backwards. */
  | { kind: 'odometer_went_backwards'; start: number; end: number }
  /** More distance than a shift plausibly covers — usually a digit read twice or a missed one. */
  | { kind: 'odometer_jump'; km: number }
  /** A closing charge higher than the opening one, with no swap recorded to explain it. */
  | { kind: 'battery_rose_without_swap'; start: number; end: number }

/**
 * Below this at the start of a shift, ask. Ten percent is roughly the point where the bike cannot
 * finish a delivery round, so it is the threshold at which the figure stops being merely low and
 * starts being a claim nobody would act on.
 */
export const BATTERY_START_MIN_PERCENT = 10

/**
 * A shift covering more than this is worth a question. Damascus delivery rounds run tens of
 * kilometres; several hundred means a misread digit far more often than a real day.
 */
export const ODOMETER_SHIFT_MAX_KM = 500

/** The pack's charge as the shift opens. */
export function checkStartBattery(percent: number | null): ReadingCheck | null {
  if (percent === null) return null
  return percent < BATTERY_START_MIN_PERCENT ? { kind: 'battery_too_low_to_start', percent } : null
}

/** The pack's charge as the shift closes, against how it opened. */
export function checkEndBattery(
  startPercent: number | null,
  endPercent: number | null,
  swapped: boolean,
): ReadingCheck | null {
  if (startPercent === null || endPercent === null) return null
  // A swap explains a full pack at the end completely, so it is not a surprise worth interrupting
  // for. Without one, charge does not increase while a bike is out working.
  if (!swapped && endPercent > startPercent) {
    return { kind: 'battery_rose_without_swap', start: startPercent, end: endPercent }
  }
  return null
}

/** What an odometer alone can be wrong about — narrower than `ReadingCheck` so callers can narrow. */
export type OdometerCheck = Extract<ReadingCheck, { kind: 'odometer_went_backwards' | 'odometer_jump' }>

/** The closing odometer, against the one the shift opened on. */
export function checkOdometer(start: number | null, end: number | null): OdometerCheck | null {
  if (start === null || end === null) return null
  if (end < start) return { kind: 'odometer_went_backwards', start, end }
  const km = end - start
  return km > ODOMETER_SHIFT_MAX_KM ? { kind: 'odometer_jump', km } : null
}

/**
 * Every question a package raises, in the order a person would ask them.
 *
 * Returned as data so the driver's screen can put each one beside the field it is about, rather than
 * as one banner that names none of them.
 */
export function checkStartPackage(input: {
  odometerKm: number | null
  batteries: readonly { slotNo: number; percent: number | null }[]
}): Array<{ slotNo: number | null; check: ReadingCheck }> {
  return input.batteries
    .map((b) => ({ slotNo: b.slotNo, check: checkStartBattery(b.percent) }))
    .filter((x): x is { slotNo: number; check: ReadingCheck } => x.check !== null)
}

export function checkEndPackage(input: {
  odometerStart: number | null
  odometerEnd: number | null
  batteries: readonly { slotNo: number; startPercent: number | null; endPercent: number | null; swapped: boolean }[]
}): Array<{ slotNo: number | null; check: ReadingCheck }> {
  const out: Array<{ slotNo: number | null; check: ReadingCheck }> = []
  const odo = checkOdometer(input.odometerStart, input.odometerEnd)
  if (odo) out.push({ slotNo: null, check: odo })
  for (const b of input.batteries) {
    const c = checkEndBattery(b.startPercent, b.endPercent, b.swapped)
    if (c) out.push({ slotNo: b.slotNo, check: c })
  }
  return out
}
