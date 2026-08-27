/**
 * A scanned row that a retake left behind.
 *
 * AN ORDER IS ITS PRINTED TIME AND ITS COST — decision 16. When a driver replaces a photo the
 * attachment token rotates, the old rows lose every sighting, and a copy of each delivery survives
 * carrying nothing but a printed identity. Shift `d0a5a7ec` held 21 such rows for 10 deliveries.
 *
 * WHY THIS LIVES IN THE DOMAIN. The same question is asked in three places — the driver's grid, his
 * close gate, and the server's materialisation of the close draft — and in this codebase that rule
 * has drifted between server and driver three separate times already (the BMS percent aliases, the
 * merge fallback, and this). One pure function, imported by all three, is the only way that stops.
 *
 * It is pure structure: no money arithmetic, no clock, no locale.
 */

/**
 * The minimum a caller must expose.
 *
 * `identity` IS THE CALLER'S CHOICE, and the two callers must choose differently:
 *
 *   - the server dedupes by `providerOrderNo`, because that is the uniqueness it actually enforces
 *     (`duplicate_order_in_submission`);
 *   - the driver's screen dedupes by the printed day, minute and cost, because a retake gives the
 *     same delivery a NEW `providerOrderNo` — it is synthesised from a page-scoped clientKey.
 *
 * Using the printed identity on the server would be a catastrophe rather than a bug: twenty
 * deliveries at the same minute for the same fare is an ordinary day, and collapsing them would
 * delete nineteen real orders from a submission.
 */
export interface SupersedableRow {
  /** Whatever the caller considers this row to BE. Null means "no identity" and never groups. */
  readonly identity: string | null
  /** False only when something or someone has taken it out of the money. */
  readonly included: boolean
  /** How many evidence sightings still stand behind it. A retake empties this. */
  readonly sightingCount: number
}

/**
 * Is this row a copy that another row has already superseded?
 *
 * True only when the row carries no evidence, counts for nothing, and some other row with the same
 * printed identity is a better witness. The survivor is chosen by EVIDENCE, never by position, so
 * the copy holding the screenshot is the one that lives.
 *
 * A delivery whose every photo is gone keeps exactly one row. Swallowing it would hide real work
 * from the driver and remove the only signal telling him to photograph that page again.
 */
export function isSupersededScanRow(
  row: SupersedableRow,
  siblings: readonly SupersedableRow[],
): boolean {
  if (row.sightingCount > 0) return false
  if (row.included) return false
  const identity = row.identity
  if (identity === null || identity === '') return false
  const group = siblings.filter((other) => other.identity === identity)
  if (group.length < 2) return false
  const survivor = group.find((other) => other.sightingCount > 0) ?? group[0]
  return survivor !== row
}

/** Every row except the copies another has superseded, in the order given. */
export function withoutSupersededScanRows<T extends SupersedableRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isSupersededScanRow(row, rows))
}
