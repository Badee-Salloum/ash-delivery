/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENCIES } from '@ash/domain'
import { ar, en } from '@ash/client/i18n'

const uiSource = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8')

/**
 * «صندوق الشركة» holds dollars as well as lira (C1). A bare figure is unambiguous on a branch
 * screen — the branch ledger is lira only — and ambiguous everywhere the company ledger shows.
 */
describe('Money says which currency it is in, when asked', () => {
  it('has a mark for every ledger currency, in both languages', () => {
    for (const currency of CURRENCIES) {
      expect(ar.currency[currency].length, `ar ${currency}`).toBeGreaterThan(0)
      expect(en.currency[currency].length, `en ${currency}`).toBeGreaterThan(0)
    }
    expect(ar.currency.SYP_NEW).toBe('ل.س')
    expect(ar.currency.USD).toBe('$')
    expect(Object.keys(ar.currency).sort()).toEqual([...CURRENCIES].sort())
    expect(Object.keys(en.currency).sort()).toEqual([...CURRENCIES].sort())
  })

  it('takes an optional currency and reads its mark from the catalog, never a literal', () => {
    expect(uiSource).toContain('currency?: Currency')
    expect(uiSource).toContain('{t.currency[currency]}')
    expect(uiSource).not.toMatch(/['"]ل\.س['"]/)
    // Without a currency the figure is rendered exactly as every branch screen always had it.
    expect(uiSource).toContain(
      "if (currency === undefined) return <span className={`num ${className}`}>{groupThousands(value)}</span>",
    )
  })

  it('offers CurrencyMoney for amounts that arrive as { currency, amount }', () => {
    expect(uiSource).toContain('export function CurrencyMoney(')
    expect(uiSource).toContain('value: { currency: Currency; amount: string }')
    expect(uiSource).toContain('<Money value={value.amount} currency={value.currency} className={className} />')
  })

  it('keeps the mark beside the figure with logical spacing only', () => {
    expect(uiSource).toContain('<span className="ms-1 text-[0.85em] font-normal text-ink-muted">')
  })
})
