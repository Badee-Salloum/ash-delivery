/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { deriveExchangeField, type ExchangeFormValues } from './screens/CompanyFund.tsx'

const screen = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')

const usdToSyp: ExchangeFormValues = {
  fromCurrency: 'USD',
  toCurrency: 'SYP_NEW',
  fromAmount: '100.00',
  toAmount: '13050.00',
  rate: '130.50',
}

describe('company currency exchange', () => {
  it('calculates any one of the three visible values from the other two in minor units', () => {
    expect(deriveExchangeField({ ...usdToSyp, toAmount: '' }, 'toAmount')).toBe('13050.00')
    expect(deriveExchangeField({ ...usdToSyp, fromAmount: '' }, 'fromAmount')).toBe('100.00')
    expect(deriveExchangeField({ ...usdToSyp, rate: '' }, 'rate')).toBe('130.50')
    expect(deriveExchangeField({
      fromCurrency: 'SYP_NEW', toCurrency: 'USD', fromAmount: '13050.00', toAmount: '', rate: '130.50',
    }, 'toAmount')).toBe('100.00')
  })

  it('uses exact bigint arithmetic beyond JavaScript number precision', () => {
    expect(deriveExchangeField({
      fromCurrency: 'USD',
      toCurrency: 'SYP_NEW',
      fromAmount: '9007199254740993.00',
      toAmount: '',
      rate: '1.00',
    }, 'toAmount')).toBe('9007199254740993.00')
  })

  it('rejects incomplete, non-positive, and same-currency previews', () => {
    expect(deriveExchangeField({ ...usdToSyp, rate: '0.00' }, 'toAmount')).toBeNull()
    expect(deriveExchangeField({ ...usdToSyp, fromCurrency: 'USD', toCurrency: 'USD' }, 'rate')).toBeNull()
    expect(deriveExchangeField({ ...usdToSyp, fromAmount: 'not-money' }, 'rate')).toBeNull()
  })

  it('uses the accessible confirmation and posts the actual two amounts to the existing endpoint', () => {
    expect(screen).toContain("import { useConfirm, useTextPrompt } from '../feedback.tsx'")
    expect(screen).toContain('const confirm = useConfirm()')
    expect(screen).toContain('title: t.companyFinance.exchangeConfirmTitle')
    expect(screen).toContain('confirmLabel: t.companyFinance.exchangeSubmit')
    expect(screen).toContain("api.post('/company/exchanges'")
    expect(screen).toContain('idempotencyKey: crypto.randomUUID(), fromCurrency, fromAmount: formatMinor(from)')
    expect(screen).toContain('toCurrency, toAmount: formatMinor(to), reason: reason.trim()')
  })

  it('shows both actual exchange sides and its frozen rate in the movement log', () => {
    expect(screen).toContain('fromCurrency: command.fromCurrency')
    expect(screen).toContain('toCurrency: command.toCurrency')
    expect(screen).toContain('<Money value={exchange.fromAmount} currency={exchange.fromCurrency} />')
    expect(screen).toContain('<Money value={exchange.toAmount} currency={exchange.toCurrency} />')
    expect(screen).toContain('normalizedFrozenRate(command?.sypMinorPerUsd ?? row.entry.sypMinorPerUsd)')
  })

  it('has complete Arabic and English labels for the direct calculation and confirmation', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.companyFinance.exchange.length).toBeGreaterThan(3)
      expect(catalog.companyFinance.exchangeHint.length).toBeGreaterThan(10)
      expect(catalog.companyFinance.exchangeConfirmTitle.length).toBeGreaterThan(3)
      expect(catalog.companyFinance.exchangeConfirmBody).toContain('{from}')
      expect(catalog.companyFinance.exchangeConfirmBody).toContain('{to}')
      expect(catalog.companyFinance.ratePerUsd.length).toBeGreaterThan(3)
    }
  })
})
