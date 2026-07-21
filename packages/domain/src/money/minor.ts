/**
 * Money is ALWAYS an integer count of minor units. Never a float, never a Number.
 *
 * 1 minor unit = 1/100 new Syrian Lira = exactly 1 old Syrian Lira.
 * (BR6: the old lira is supported at a configurable 1:100 factor. Choosing the minor unit
 * to coincide with the old lira means the old-lira factor is a presentation concern only,
 * and no stored amount ever needs re-scaling if old-lira entry is switched on later.)
 *
 * `Minor` is a branded bigint: `number` is not assignable to it, and neither is a bare
 * `bigint` without going through `minor()`. See test/money/brand.test-d.ts.
 */

declare const MINOR_BRAND: unique symbol

export type Minor = bigint & { readonly [MINOR_BRAND]: 'Minor' }

/** Basis points. 10_000 bps = 100%. Integer only — a fractional rate is a bug. */
export type Bps = number

export const ZERO: Minor = 0n as Minor

/** Lift a bigint into `Minor`. The single sanctioned entry point. */
export function minor(value: bigint): Minor {
  return value as Minor
}

/**
 * Parse a decimal string (as it arrives on the wire) into minor units.
 * Accepts "1234", "1234.5", "-1234.56". Rejects anything else — including
 * scientific notation and more fractional digits than the currency has.
 */
export function parseMinor(text: string, fractionDigits = 2): Minor {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!m) throw new RangeError(`not a decimal amount: ${JSON.stringify(text)}`)
  const sign = m[1] === '-' ? -1n : 1n
  const whole = m[2] ?? '0'
  const frac = m[3] ?? ''
  if (frac.length > fractionDigits) {
    throw new RangeError(`${text} has more than ${fractionDigits} fractional digits`)
  }
  const scaled = whole + frac.padEnd(fractionDigits, '0')
  return minor(sign * BigInt(scaled))
}

/** Render minor units as a decimal string for the wire. Never use this for arithmetic. */
export function formatMinor(value: Minor, fractionDigits = 2): string {
  const neg = value < 0n
  const digits = (neg ? -value : value).toString().padStart(fractionDigits + 1, '0')
  const cut = digits.length - fractionDigits
  const whole = digits.slice(0, cut)
  const frac = digits.slice(cut)
  return `${neg ? '-' : ''}${whole}${fractionDigits > 0 ? `.${frac}` : ''}`
}

export const add = (a: Minor, b: Minor): Minor => minor(a + b)
export const sub = (a: Minor, b: Minor): Minor => minor(a - b)
export const neg = (a: Minor): Minor => minor(-a)
export const abs = (a: Minor): Minor => minor(a < 0n ? -a : a)
export const isZero = (a: Minor): boolean => a === 0n

export function sum(values: readonly Minor[]): Minor {
  let total = 0n
  for (const v of values) total += v
  return minor(total)
}
