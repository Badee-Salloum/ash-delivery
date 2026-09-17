import { describe, expect, it } from 'vitest'
import { money, minor } from '@ash/domain'
import { currencyMoneySchema, currencySchema, serializeCurrencyMoney } from '../src/wire.ts'

/** «صندوق الشركة» amounts cross the wire WITH their currency, as decimal strings (C1). */
describe('currency on the wire', () => {
  it('accepts exactly the two ledger currencies', () => {
    expect(currencySchema.parse('SYP_NEW')).toBe('SYP_NEW')
    expect(currencySchema.parse('USD')).toBe('USD')
    for (const bad of ['SYP', 'usd', 'EUR', '', null, 1]) {
      expect(currencySchema.safeParse(bad).success).toBe(false)
    }
  })

  it('parses {currency, amount} into Money with a Minor amount', () => {
    expect(currencyMoneySchema.parse({ currency: 'USD', amount: '12.50' })).toEqual({ currency: 'USD', amount: 1250n })
    expect(currencyMoneySchema.parse({ currency: 'SYP_NEW', amount: '-79057.26' })).toEqual({
      currency: 'SYP_NEW',
      amount: -7_905_726n,
    })
  })

  it('refuses a number, a third decimal, a missing currency or an unknown one', () => {
    for (const bad of [
      { currency: 'USD', amount: 12.5 },
      { currency: 'USD', amount: '12.505' },
      { amount: '1.00' },
      { currency: 'EUR', amount: '1.00' },
      { currency: 'USD' },
    ]) {
      expect(currencyMoneySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('serialises back to the same shape', () => {
    const value = money('USD', minor(-1n))
    expect(serializeCurrencyMoney(value)).toEqual({ currency: 'USD', amount: '-0.01' })
    expect(currencyMoneySchema.parse(serializeCurrencyMoney(value))).toEqual(value)
  })
})
