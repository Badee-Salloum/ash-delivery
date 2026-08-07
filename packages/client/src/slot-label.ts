/**
 * Naming an evidence slot, in one place, for both apps.
 *
 * Slot names carry a number for two different reasons — `bms_2` is the second battery PACK, and
 * `dashboard_2` is the second PAGE of one scrollable screen — and both used to render as the raw
 * key, because `slotNames` only ever held the un-numbered names. The manager's review has been
 * showing literal `payments_log` and `bms_1` tiles for as long as those slots have existed.
 *
 * Splitting the suffix here means the catalogue keeps ONE key per screen instead of twenty-four,
 * and the driver's tile and the manager's thumbnail can never disagree about what a photo is.
 */

/** `dashboard_3` → `{ base: 'dashboard', n: 3 }`; `wallet` → `{ base: 'wallet', n: 1 }`. */
export function splitSlot(slot: string): { base: string; n: number } {
  const m = slot.match(/^(.*)_(\d+)$/)
  if (!m) return { base: slot, n: 1 }
  return { base: m[1]!, n: Number(m[2]) }
}

/** Arabic-Indic for the ar UI, plain ASCII for en — the number is decoration, never data. */
const numeral = (n: number, arabic: boolean): string =>
  arabic ? String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!) : String(n)

/**
 * The human name for a slot. `names` is `t.shift.slotNames`.
 *
 * An unknown base falls back to the raw slot rather than to an empty tile: a name nobody
 * translated is still a name somebody can act on, and a blank one is not.
 */
export function slotLabel(slot: string, names: Record<string, string>, lang: string): string {
  const { base, n } = splitSlot(slot)
  const name = names[base]
  if (name === undefined) return slot
  // A single-page screen and pack #1 both read better without a number: «الداشبورد», not «الداشبورد ١».
  // A battery is the exception — a bike carries several, so pack 1 is «البطارية ١» even when alone.
  if (n === 1 && base !== 'bms') return name
  return `${name} ${numeral(n, lang === 'ar')}`
}
