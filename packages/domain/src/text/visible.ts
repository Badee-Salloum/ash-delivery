/**
 * Is there anything a human could actually read in this string?
 *
 * ONE definition, because the system had three and they disagreed about the same column.
 *
 * A decision reason is the entire audit trail for a delivery fee entering or leaving BR1 — the
 * manager's «why». Three different answers were in play for whether one was blank:
 *
 *   • JavaScript `.trim()`  — strips ASCII whitespace, NBSP, every `Zs` and U+FEFF, but leaves
 *                             U+200B ZERO WIDTH SPACE and the rest of `Cf` in place;
 *   • Postgres `btrim(x)`   — one-argument form strips the ASCII SPACE character and nothing else,
 *                             so a lone TAB counts as content;
 *   • `ash_has_visible_text` — strips all whitespace AND the `Cf` format characters.
 *
 * In an Arabic-first product that is not a theoretical gap. U+200F RIGHT-TO-LEFT MARK and U+200E
 * ride along in pasted Arabic constantly, and `'‏'.trim()` is truthy — so a reason nobody could
 * read was accepted as evidence, while the release-blocker script simultaneously judged the same
 * row blank and reported the settlement as wrong.
 *
 * The rule is "at least one visible character SURVIVES the strip", not "contains no marks", so a
 * genuine Arabic sentence carrying bidi marks is unaffected. Only entirely invisible text is caught.
 *
 * This is the JavaScript twin of `ash_has_visible_text` (migration 0035). Keep them in step.
 */
export function hasVisibleText(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && /[^\p{White_Space}\p{Cf}]/u.test(value)
}
