/**
 * A recorded path length (metres) for a human to read: whole metres up to a kilometre, then
 * kilometres to one decimal. Latin digits in both languages — the caller wraps it in `num`/`dir="ltr"`.
 *
 * The unit words come from the caller so the domain/wire stays language-free; pass `t.shiftPath`.
 */
export function formatDistance(metres: number, units: { readonly km: string; readonly metres: string }): string {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} ${units.km}`
  return `${Math.round(metres)} ${units.metres}`
}
