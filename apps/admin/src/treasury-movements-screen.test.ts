/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const screen = readFileSync(new URL('./screens/TreasuryMovements.tsx', import.meta.url), 'utf8')
const treasury = readFileSync(new URL('./screens/Treasury.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')

describe('standalone treasury movement register', () => {
  it('is a separate finance route with a retained link and no embedded movement read', () => {
    expect(shell).toContain("key: 'treasuryMovements'")
    expect(shell).toContain('<TreasuryMovements key={mountKey} initial={liveParams.current} />')
    expect(treasury).toContain('href="#treasuryMovements"')
    expect(treasury).not.toContain('.treasuryMovements(')
    expect(treasury).not.toContain('<Card title={t.treasury.movements}')
  })

  it('starts at this month, remembers only this page period, and keeps applied filters in the URL', () => {
    expect(screen).toContain("return { preset: 'this_month' }")
    expect(screen).toContain("const STORAGE_PREFIX = 'ash.admin.treasury-movements.range.v1:'")
    expect(screen).toContain('...paramsFromSelection(selection)')
    expect(screen).toContain('eventType: filters.eventType')
    expect(screen).toContain('actor: filters.actorId')
    expect(screen).toContain('q: filters.q')
    expect(screen).toContain("setSelection({ preset: 'this_month' })")
  })

  it('offers every required filter, clears a stale actor on branch changes, and continues by cursor', () => {
    for (const token of ['eventType:', 'channel:', 'flow:', 'actorId:', 'q:']) expect(screen).toContain(token)
    expect(screen).toContain('page.facets.actors.some((actor) => actor.id === actorId)')
    expect(screen).toContain("setFilters((current) => ({ ...current, actorId: '' }))")
    expect(screen).toContain('requestFilter(range, filters, page.nextCursor)')
    expect(screen).toContain('rows: [...current.rows, ...next.rows]')
    expect(screen).toContain('limit: PAGE_SIZE')
  })

  it('shows the actual Damascus timestamp to seconds separately from the business day', () => {
    expect(screen).toContain('formatDateTimeSeconds(row.createdAt, lang)')
    expect(screen).toContain('{row.businessDate}')
    expect(screen).toContain('eventLabel(row.eventType)')
    expect(screen).toContain('<Badge tone={flowTone(row.flow)}>')
    for (const catalog of [ar, en]) {
      expect(catalog.treasuryMovements.registeredAt).not.toBe(catalog.treasuryMovements.businessDay)
      expect(Object.keys(catalog.treasuryMovements.kinds).length).toBeGreaterThanOrEqual(30)
      expect(catalog.treasuryMovements.flows.internal.length).toBeGreaterThan(3)
    }
  })
})
