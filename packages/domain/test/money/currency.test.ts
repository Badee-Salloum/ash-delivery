import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FxError, toUsdMinor } from '../../src/fx/rate.ts'
import {
  type Currency,
  CURRENCIES,
  CurrencyMismatchError,
  type Money,
  addMoney,
  isCurrency,
  isZeroMoney,
  money,
  subMoney,
  sumMoney,
  sypToUsdMinor,
  usdToSypMinor,
} from '../../src/money/currency.ts'
import { minor } from '../../src/money/minor.ts'

const usd = (n: bigint): Money<'USD'> => money('USD', minor(n))
const syp = (n: bigint): Money<'SYP_NEW'> => money('SYP_NEW', minor(n))
const amount = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n })
const rate = fc.bigInt({ min: 1n, max: 10n ** 9n })

describe('Money<C> — the type rule', () => {
  /**
   * Never called: this function exists for the compiler. `pnpm typecheck` includes the domain
   * tests, so each `@ts-expect-error` below FAILS the build the day the line starts compiling.
   */
  function compileTimeOnly(): void {
    // @ts-expect-error — dollars and lira do not add.
    addMoney(usd(1n), syp(1n))
    // @ts-expect-error — nor subtract.
    subMoney(syp(1n), usd(1n))
    // @ts-expect-error — nor sum under the wrong heading.
    sumMoney('USD', [syp(1n)])
    // @ts-expect-error — a bare bigint is not an amount with a currency.
    addMoney(usd(1n), 1n)
    // @ts-expect-error — nor is an unknown currency.
    money('EUR', minor(1n))
    const same: Money<'USD'> = addMoney(usd(1n), usd(2n))
    // @ts-expect-error — the result keeps its currency.
    const wrong: Money<'SYP_NEW'> = addMoney(usd(1n), usd(2n))
    void same
    void wrong
  }
  void compileTimeOnly

  it('names exactly the two currencies the database accepts', () => {
    expect(CURRENCIES).toEqual(['SYP_NEW', 'USD'])
    expect(isCurrency('SYP_NEW')).toBe(true)
    expect(isCurrency('USD')).toBe(true)
    for (const other of ['SYP', 'syp_new', 'usd', 'EUR', '', null, 1]) expect(isCurrency(other)).toBe(false)
  })

  it('refuses a mix at runtime too, where the type is only Money<Currency>', () => {
    const fromWire = (currency: Currency, n: bigint): Money => money(currency, minor(n))
    expect(() => addMoney(fromWire('USD', 1n), fromWire('SYP_NEW', 1n))).toThrow(CurrencyMismatchError)
    expect(() => subMoney(fromWire('SYP_NEW', 1n), fromWire('USD', 1n))).toThrow(CurrencyMismatchError)
    expect(() => sumMoney<Currency>('USD', [fromWire('USD', 1n), fromWire('SYP_NEW', 1n)])).toThrow(
      CurrencyMismatchError,
    )
    expect(() => money('EUR' as Currency, minor(1n))).toThrow(RangeError)
  })

  it('adds, subtracts and sums within one currency', () => {
    expect(addMoney(usd(150n), usd(-50n))).toEqual({ currency: 'USD', amount: 100n })
    expect(subMoney(syp(150n), syp(200n))).toEqual({ currency: 'SYP_NEW', amount: -50n })
    expect(sumMoney('USD', [])).toEqual({ currency: 'USD', amount: 0n })
    expect(sumMoney('SYP_NEW', [syp(1n), syp(2n), syp(3n)])).toEqual({ currency: 'SYP_NEW', amount: 6n })
    expect(isZeroMoney(usd(0n))).toBe(true)
    expect(isZeroMoney(usd(1n))).toBe(false)
  })

  it('addition is associative and commutative, and subtraction undoes it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CURRENCIES), amount, amount, amount, (currency, a, b, c) => {
        const x = money(currency, minor(a))
        const y = money(currency, minor(b))
        const z = money(currency, minor(c))
        expect(addMoney(addMoney(x, y), z)).toEqual(addMoney(x, addMoney(y, z)))
        expect(addMoney(x, y)).toEqual(addMoney(y, x))
        expect(subMoney(addMoney(x, y), y)).toEqual(x)
        expect(sumMoney(currency, [x, y, z])).toEqual(addMoney(addMoney(x, y), z))
      }),
    )
  })
})

describe('usdToSypMinor — at a frozen rate', () => {
  it('converts cents at SYP minor units per dollar', () => {
    // $1.00 at 130 new SYP/USD (13,000 minor) is 130.00 new SYP.
    expect(usdToSypMinor(minor(100n), 13_000n)).toBe(13_000n)
    // $0.01 at 13,000 is 130 minor — exact.
    expect(usdToSypMinor(minor(1n), 13_000n)).toBe(130n)
    // $12,345.67 at 13,050 minor/USD.
    expect(usdToSypMinor(minor(1_234_567n), 13_050n)).toBe(161_110_994n) // 161,110,993.5 → half-up
  })

  it('rounds half-up on the magnitude, so it is sign-symmetric', () => {
    // 1 cent at 150 minor/USD = 1.5 minor → 2, and −1 cent → −2 (not −1).
    expect(usdToSypMinor(minor(1n), 150n)).toBe(2n)
    expect(usdToSypMinor(minor(-1n), 150n)).toBe(-2n)
    // 1 cent at 149 = 1.49 → 1.
    expect(usdToSypMinor(minor(1n), 149n)).toBe(1n)
    fc.assert(
      fc.property(amount, rate, (cents, r) => {
        expect(usdToSypMinor(minor(-cents), r)).toBe(-usdToSypMinor(minor(cents), r))
      }),
    )
  })

  it('never strays more than half a minor unit from the exact product', () => {
    fc.assert(
      fc.property(amount, rate, (cents, r) => {
        const got = usdToSypMinor(minor(cents), r)
        // |got × 100 − cents × r| ≤ 50, in integers.
        const error = got * 100n - cents * r
        expect(error <= 50n && error >= -50n).toBe(true)
      }),
    )
  })

  it('is exact whenever the rate is a whole number of lira per dollar', () => {
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 1n, max: 10n ** 7n }), (cents, lira) => {
        expect(usdToSypMinor(minor(cents), lira * 100n)).toBe(cents * lira)
      }),
    )
  })

  it('refuses a rate that is not positive', () => {
    expect(() => usdToSypMinor(minor(1n), 0n)).toThrow(FxError)
    expect(() => usdToSypMinor(minor(1n), -13_000n)).toThrow(FxError)
  })
})

describe('sypToUsdMinor — the one BR6 conversion, by its direction', () => {
  it('is toUsdMinor', () => {
    expect(sypToUsdMinor).toBe(toUsdMinor)
    const day = { businessDate: '2026-09-17', sypMinorPerUsd: 13_000n, provisional: false } as const
    expect(sypToUsdMinor(minor(13_000n), day)).toBe(100n)
  })

  it('round-trips a dollar amount through SYP at a whole-lira rate', () => {
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 1n, max: 10n ** 6n }), (cents, lira) => {
        const r = lira * 100n
        const day = { businessDate: '2026-09-17', sypMinorPerUsd: r, provisional: false } as const
        expect(sypToUsdMinor(usdToSypMinor(minor(cents), r), day)).toBe(cents)
      }),
    )
  })
})
