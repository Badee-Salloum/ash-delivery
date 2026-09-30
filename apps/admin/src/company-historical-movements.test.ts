/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { isValidHistoricalDate } from './screens/CompanyFund.tsx'

const screen = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')

describe('historical company-fund movements', () => {
  it('admits only actual dates from 2000 through the current business date', () => {
    expect(isValidHistoricalDate('2000-01-01', '2026-10-01')).toBe(true)
    expect(isValidHistoricalDate('2026-10-01', '2026-10-01')).toBe(true)
    expect(isValidHistoricalDate('1999-12-31', '2026-10-01')).toBe(false)
    expect(isValidHistoricalDate('2026-10-02', '2026-10-01')).toBe(false)
    expect(isValidHistoricalDate('2026-02-29', '2026-10-01')).toBe(false)
    expect(isValidHistoricalDate('2026/10/01', '2026-10-01')).toBe(false)
  })

  it('keeps non-reversal and reversal wires distinct and preserves the displayed frozen USD rate', () => {
    expect(screen).toContain('pendingMoneyMove(pendingKey.current, {')
    expect(screen).toContain('pendingMoneyMove(pendingReversalKey.current, {')
    expect(screen).toContain('details: payload,')
    expect(screen).toContain("api.post('/company/historical-movements', { idempotencyKey: operation.idempotencyKey, ...payload })")
    expect(screen).toContain('pendingAfterAttempt(operation, outcome)')
    expect(screen).toContain('type: kind,')
    expect(screen).toContain('description: reason.trim(),')
    expect(screen).toContain('historicalRate: formatMinor(normalizedRate!)')
    expect(screen).toContain("type: 'reversal' as const,")
    expect(screen).toContain('targetId,')
    expect(screen).toContain('occurredOn: today,')
    expect(screen).toContain('externalReference: reversalReference.trim(),')
    expect(screen).toContain('reason: reversalReason.trim(),')
  })

  it('shows conditional USD, category, and two-sided exchange controls', () => {
    expect(screen).toContain("{currency === 'USD' ? (")
    expect(screen).toContain("{kind === 'expense' ? (")
    expect(screen).toContain("{kind === 'income' ? (")
    expect(screen).toContain("{kind === 'exchange' ? (")
    expect(screen).toContain("<HistoricalCategoryCreator kind=\"expense\"")
    expect(screen).toContain("<HistoricalCategoryCreator kind=\"income\"")
  })

  it('loads the dedicated register, protects its first entry, and shows both dates and balance after', () => {
    expect(screen).toContain("'/company/historical-movements/preflight'")
    expect(screen).toContain('const openingBlocked = rows.length === 0 && !hasPostedHistorical && !preflight.canStart')
    expect(screen).toContain('const earliestAllowedOccurrence = latestHistoricalOccurrence ?? \'2000-01-01\'')
    expect(screen).toContain('occurredOn < earliestAllowedOccurrence')
    expect(screen).toContain('pocketAfter?: Partial<Record<Currency, string>>')
    expect(screen).toContain('t.companyFinance.occurredOn, t.companyFinance.postedOn')
    expect(screen).toContain('t.companyFinance.balanceAfter')
    expect(screen).toContain('min="2000-01-01"')
    expect(screen).toContain('max={today}')
  })

  it('keeps the history tab role-gated, filterable, and responsive in both supported languages', () => {
    expect(screen).toContain("session?.roleKey === 'system_admin' || session?.roleKey === 'general_manager'")
    expect(screen).toContain('referenceFilter')
    expect(screen).toContain('kindFilter')
    expect(screen).toContain('<option value="reversal">{t.companyFinance.historicalKinds.reversal}</option>')
    expect(screen).toContain('grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4')
    for (const catalog of [ar, en]) {
      expect(catalog.companyFinance.tabs.historical.length).toBeGreaterThan(3)
      expect(catalog.companyFinance.historicalEntry.length).toBeGreaterThan(8)
      expect(catalog.companyFinance.historicalOpeningBlocked.length).toBeGreaterThan(20)
      expect(catalog.companyFinance.historicalKinds.exchange.length).toBeGreaterThan(3)
      expect(catalog.companyFinance.historicalReversalReference.length).toBeGreaterThan(8)
    }
  })
})
