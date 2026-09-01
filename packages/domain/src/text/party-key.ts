/**
 * Fold two spellings of one Arabic name onto one key — FOR SEARCH AND GROUPING ONLY.
 *
 * «السلفة» (owner decision 17) names its counterparty as free text, by the owner's own choice: a
 * driver, a workshop, a landlord. Free text means «أبو محمد» and «ابو  محمد» are two strings for
 * one man, and a list that shows him twice is a list nobody trusts.
 *
 * NO MONEY DEPENDS ON THIS FUNCTION, and that is a deliberate structural decision rather than a
 * caveat. Every advance carries its own ledger fund keyed by the advance's uuid, and a repayment
 * names the advance, never the party. So the worst a wrong normalisation can do is group a list
 * oddly or miss an autocomplete suggestion. Had balances been keyed by party instead, this
 * function would silently merge two people's debts — which is exactly why they are not.
 *
 * What it folds, and why each one earns its place in Damascus:
 *
 *   • leading/trailing space, and runs of space          — typing
 *   • Arabic diacritics (harakat) and tatweel ـ           — decorative, dropped at will
 *   • أ إ آ ٱ → ا                                         — hamza is routinely omitted
 *   • ى → ي, ة → ه                                        — the two classic endings
 *   • ؤ → و, ئ → ي                                        — same hamza habit
 *   • Arabic-Indic digits ٠-٩ → 0-9                       — keyboards differ
 *   • Latin case                                          — «Yallago» / «yallago»
 *
 * What it deliberately does NOT do: strip the definite article «ال», or attempt any stemming.
 * «الورشة» and «ورشة» are different words to a reader, and a normaliser that outsmarts its user
 * makes a list he cannot predict.
 */

/** Combining marks (harakat, shadda, sukun…) and the tatweel elongation character. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/gu

const LETTER_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[أإآٱ]/gu, 'ا'], // أ إ آ ٱ → ا
  [/ى/gu, 'ي'], //                     ى → ي
  [/ة/gu, 'ه'], //                     ة → ه
  [/ؤ/gu, 'و'], //                     ؤ → و
  [/ئ/gu, 'ي'], //                     ئ → ي
]

/** Arabic-Indic ٠-٩ and Eastern Arabic-Indic ۰-۹ both fold to ASCII digits. */
const digitFold = (s: string): string =>
  s.replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660)).replace(
    /[۰-۹]/gu,
    (d) => String(d.charCodeAt(0) - 0x06f0),
  )

export function normalizePartyName(value: string): string {
  let out = value.normalize('NFKC')
  // Invisible formatting marks ride along in pasted Arabic constantly; they are not part of a name.
  out = out.replace(/[\p{Cf}]/gu, '')
  out = out.replace(ARABIC_MARKS, '')
  for (const [pattern, replacement] of LETTER_FOLDS) out = out.replace(pattern, replacement)
  out = digitFold(out)
  // Collapse every run of whitespace to a single space, then trim. Done last so that removing a
  // mark between two words cannot leave two names welded together.
  out = out.replace(/\p{White_Space}+/gu, ' ').trim()
  return out.toLocaleLowerCase('en-US')
}
