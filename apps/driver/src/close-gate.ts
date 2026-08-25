/**
 * What still stands between the driver and «تسليم» — as codes, computed once.
 *
 * ── WHY THIS IS A MODULE AND NOT A LINE IN THE COMPONENT ───────────────────────────────────────
 * On the night of 2026-08-24 five drivers finished work and could not close. The submit button was
 * enabled by
 *
 *     ready = missing.length === 0 && !odometerNeedsConfirmation && draftSaved
 *
 * while the "what is still missing" panel rendered only `if (missing.length > 0)`. Two of the three
 * conditions therefore had no words anywhere on the page. A driver blocked by `draftSaved` — which
 * is what a `500` / `500.00` autosave mismatch did to امجد عبدالله at 01:39, with thirteen photos
 * and fifteen orders all present — saw a dead green button and nothing else, forever.
 *
 * The component's own comment already claimed the invariant it was breaking: "The list IS the gate."
 * Here it is true by construction: `ready` is this array being empty, and the panel renders this
 * same array. They cannot drift apart again, because there is only one of them.
 *
 * Codes, not sentences: the driver app resolves them to Arabic, the same split the domain uses for
 * its BR1 cause codes.
 */
export type CloseGateBlocker =
  | { readonly kind: 'missing_photo'; readonly slot: string }
  | { readonly kind: 'missing_value'; readonly field: 'cash' | 'wallet' | 'odometer' }
  /** Non-empty but unsendable — «٧٠٠٠٠» off an Arabic keyboard, a stray comma, three decimals. */
  | { readonly kind: 'unreadable_money'; readonly field: 'cash' | 'wallet' }
  | { readonly kind: 'no_orders' }
  | { readonly kind: 'bad_rows' }
  | { readonly kind: 'reading_in_flight' }
  | { readonly kind: 'confirm_odometer' }
  | { readonly kind: 'draft_not_saved' }

export interface CloseGateInput {
  readonly requiredSlots: readonly string[]
  readonly presentSlots: ReadonlySet<string>
  readonly cashText: string
  readonly walletText: string
  readonly moneyIsUsable: (value: string) => boolean
  readonly odometerKm: number | null
  /** Rows carrying a provider order number, checked or not — see `endPackageGaps`. */
  readonly namedOrderCount: number
  readonly hasBadOrderRows: boolean
  readonly hasBadDeductionRows: boolean
  readonly readingInFlight: boolean
  readonly odometerNeedsConfirmation: boolean
  readonly draftSaved: boolean
}

export function closeGateBlockers(input: CloseGateInput): CloseGateBlocker[] {
  const out: CloseGateBlocker[] = []

  // A missing PHOTO and a missing NUMBER are different jobs, and the catalogue gives «العداد» to
  // both — so the footer read «العداد · … · العداد» and the driver could not tell which he owed.
  for (const slot of input.requiredSlots) {
    if (!input.presentSlots.has(slot)) out.push({ kind: 'missing_photo', slot })
  }

  if (input.cashText === '') out.push({ kind: 'missing_value', field: 'cash' })
  else if (!input.moneyIsUsable(input.cashText)) out.push({ kind: 'unreadable_money', field: 'cash' })

  if (input.walletText === '') out.push({ kind: 'missing_value', field: 'wallet' })
  else if (!input.moneyIsUsable(input.walletText)) out.push({ kind: 'unreadable_money', field: 'wallet' })

  if (input.odometerKm === null) out.push({ kind: 'missing_value', field: 'odometer' })
  if (input.namedOrderCount === 0) out.push({ kind: 'no_orders' })
  if (input.hasBadOrderRows || input.hasBadDeductionRows) out.push({ kind: 'bad_rows' })

  // A read in flight is a reason to WAIT, not a thing to go and fix — but submitting through it
  // silently drops every order it was about to add, which is the shift closing short.
  if (input.readingInFlight) out.push({ kind: 'reading_in_flight' })

  // The two that used to be invisible.
  if (input.odometerNeedsConfirmation) out.push({ kind: 'confirm_odometer' })
  if (!input.draftSaved) out.push({ kind: 'draft_not_saved' })

  return out
}
