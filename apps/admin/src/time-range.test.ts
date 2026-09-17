/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import {
  DEFAULT_SELECTION,
  RANGE_STORAGE_PREFIX,
  SIMPLE_PRESETS,
  dayStartLabel,
  epochOf,
  initialSelection,
  cappedRange,
  narrowedSelection,
  paramsFromSelection,
  parseSelection,
  rangeDays,
  rangeStorageKey,
  readStoredSelection,
  resolveSelection,
  sameSelection,
  selectionFromParams,
  serializeSelection,
  writeStoredSelection,
  type RangeMeta,
} from './time-range.ts'
import { parseHash, sanitizeParams } from './route.ts'

const barSource = readFileSync(new URL('./components/TimeRangeBar.tsx', import.meta.url), 'utf8')

const meta: RangeMeta = {
  today: '2026-09-17',
  goLiveBusinessDate: '2026-08-11',
  firstActivityDate: '2026-07-01',
  weekStart: '2026-09-13',
  monthStart: '2026-09-01',
  dayStartMinutes: 240,
}

/** A Storage stand-in; `broken` throws on every access, like a private window. */
function memoryStorage(broken = false) {
  const values = new Map<string, string>()
  return {
    values,
    getItem(key: string): string | null {
      if (broken) throw new Error('SecurityError')
      return values.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      if (broken) throw new Error('QuotaExceededError')
      values.set(key, value)
    },
  }
}

describe('selection precedence: hash > this user’s stored choice > «الكل منذ البدء»', () => {
  it('defaults to all since go-live', () => {
    expect(initialSelection({ params: {}, storage: memoryStorage(), userId: 'u-1' })).toEqual({ preset: 'all' })
    expect(DEFAULT_SELECTION).toEqual({ preset: 'all' })
  })

  it('uses the stored choice of THIS user only', () => {
    const storage = memoryStorage()
    writeStoredSelection(storage, 'u-1', { preset: 'last_month' })
    expect(storage.values.get(`${RANGE_STORAGE_PREFIX}u-1`)).toBe('last_month')
    expect(rangeStorageKey('u-1')).toBe('ash.admin.range.v1:u-1')
    expect(initialSelection({ params: {}, storage, userId: 'u-1' })).toEqual({ preset: 'last_month' })
    expect(initialSelection({ params: {}, storage, userId: 'u-2' })).toEqual({ preset: 'all' })
    expect(initialSelection({ params: {}, storage, userId: null })).toEqual({ preset: 'all' })
  })

  it('lets the URL win over storage', () => {
    const storage = memoryStorage()
    writeStoredSelection(storage, 'u-1', { preset: 'last_month' })
    const params = parseHash('#completedShifts?range=week&from=2026-09-09').params
    expect(initialSelection({ params, storage, userId: 'u-1' })).toEqual({ preset: 'week', week: '2026-09-06' })
  })

  it('survives storage that throws or holds junk', () => {
    const broken = memoryStorage(true)
    expect(readStoredSelection(broken, 'u-1')).toBeNull()
    expect(writeStoredSelection(broken, 'u-1', { preset: 'today' })).toBe(false)
    expect(initialSelection({ params: {}, storage: broken, userId: 'u-1' })).toEqual({ preset: 'all' })
    expect(readStoredSelection(null, 'u-1')).toBeNull()
    expect(writeStoredSelection(undefined, 'u-1', { preset: 'today' })).toBe(false)

    const junk = memoryStorage()
    junk.values.set(rangeStorageKey('u-1'), 'custom:2026-09-17..2026-09-01')
    expect(readStoredSelection(junk, 'u-1')).toBeNull()
  })
})

describe('serialisation', () => {
  it('round-trips every kind of selection', () => {
    for (const selection of [
      ...SIMPLE_PRESETS.map((preset) => ({ preset })),
      { preset: 'week', week: '2026-09-13' },
      { preset: 'custom', from: '2026-09-01', to: '2026-09-17' },
    ] as const) {
      expect(parseSelection(serializeSelection(selection))).toEqual(selection)
    }
    expect(serializeSelection({ preset: 'week', week: '2026-09-16' })).toBe('week:2026-09-13')
    expect(serializeSelection({ preset: 'custom', from: '2026-09-01', to: '2026-09-17' })).toBe(
      'custom:2026-09-01..2026-09-17',
    )
  })

  it('refuses anything it did not write', () => {
    for (const raw of [null, 7, '', 'week', 'custom', 'week:2026-02-31', 'custom:2026-09-01', 'custom:a..b..c', 'last_year']) {
      expect(parseSelection(raw), String(raw)).toBeNull()
    }
  })

  it('maps selections to URL params and back', () => {
    const cases = [
      { preset: 'this_month' },
      { preset: 'week', week: '2026-09-13' },
      { preset: 'custom', from: '2026-08-01', to: '2026-08-31' },
    ] as const
    for (const selection of cases) {
      const params = sanitizeParams(paramsFromSelection(selection))
      expect(selectionFromParams(params)).toEqual(selection)
    }
    // Every key is always present, so a stale `from` is overwritten, not left behind.
    expect(paramsFromSelection({ preset: 'today' })).toEqual({ range: 'today', from: undefined, to: undefined })
    // A pair without a preset is a custom range; nonsense is no selection at all.
    expect(selectionFromParams({ from: '2026-08-01', to: '2026-08-02' })).toEqual({
      preset: 'custom',
      from: '2026-08-01',
      to: '2026-08-02',
    })
    expect(selectionFromParams({})).toBeNull()
    expect(selectionFromParams({ range: 'custom', from: '2026-08-02', to: '2026-08-01' })).toBeNull()
    expect(selectionFromParams({ range: 'week' })).toBeNull()
    expect(sameSelection({ preset: 'week', week: '2026-09-15' }, { preset: 'week', week: '2026-09-13' })).toBe(true)
  })
})

describe('resolving against the server’s dates', () => {
  it('starts «all» at go-live, else at the first activity, else today', () => {
    expect(epochOf(meta)).toBe('2026-08-11')
    expect(epochOf({ ...meta, goLiveBusinessDate: null })).toBe('2026-07-01')
    expect(epochOf({ ...meta, goLiveBusinessDate: null, firstActivityDate: null })).toBe('2026-09-17')
    expect(epochOf({ ...meta, epoch: '2026-06-06' })).toBe('2026-06-06')
    expect(resolveSelection({ preset: 'all' }, meta)).toEqual({ from: '2026-08-11', to: '2026-09-17' })
  })

  it('resolves weeks from Sunday and falls back to «all» for a selection that cannot resolve', () => {
    expect(resolveSelection({ preset: 'this_week' }, meta)).toEqual({ from: '2026-09-13', to: '2026-09-17' })
    expect(resolveSelection({ preset: 'custom', from: '2026-09-17', to: '2026-09-01' }, meta)).toEqual({
      from: '2026-08-11',
      to: '2026-09-17',
    })
  })

  it('measures and narrows a range for the 31-day cap', () => {
    const all = resolveSelection({ preset: 'all' }, meta)
    expect(rangeDays(all)).toBe(38)
    expect(narrowedSelection(all, 31)).toEqual({ preset: 'custom', from: '2026-08-18', to: '2026-09-17' })
    // The screens read this range when a selection outgrows their cap.
    expect(cappedRange(all, 31)).toEqual({ from: '2026-08-18', to: '2026-09-17' })
    expect(cappedRange({ from: '2026-09-10', to: '2026-09-17' }, 31)).toEqual({ from: '2026-09-10', to: '2026-09-17' })
    // Never widened past its own start.
    expect(narrowedSelection({ from: '2026-09-10', to: '2026-09-17' }, 31)).toEqual({
      preset: 'custom',
      from: '2026-09-10',
      to: '2026-09-17',
    })
  })

  it('labels the day start with Latin digits', () => {
    expect(dayStartLabel(240)).toBe('04:00')
    expect(dayStartLabel(0)).toBe('00:00')
    expect(dayStartLabel()).toBe('04:00')
  })
})

describe('the filter bar', () => {
  it('reads today from /dashboard/meta, never from the browser clock or the session', () => {
    expect(barSource).toContain("api\n      .get<RangeMeta>('/dashboard/meta'")
    expect(barSource).not.toContain('new Date(')
    expect(barSource).not.toContain('Date.now(')
    expect(barSource).not.toContain('businessDate')
    expect(barSource).toContain('canGoNextWeek(shownWeek, meta.today)')
  })

  it('uses design tokens and logical properties only', () => {
    expect(barSource).not.toMatch(/(?:text|bg|border)-(?:slate|gray|red|green|amber|sky|blue)-\d/)
    expect(barSource).toContain('overflow-x-auto')
  })

  it('has every pill and message in both languages', () => {
    for (const catalog of [ar, en]) {
      for (const preset of [...SIMPLE_PRESETS, 'week', 'custom'] as const) {
        expect(catalog.timeRange.presets[preset].length).toBeGreaterThan(1)
      }
      expect(catalog.timeRange.caption).toContain('{from}')
      expect(catalog.timeRange.caption).toContain('{dayStart}')
      expect(catalog.errors.range_too_large.length).toBeGreaterThan(10)
    }
    expect(ar.timeRange.presets.all).toBe('الكل منذ البدء')
    expect(ar.timeRange.presets.custom).toBe('مخصّص')
    expect(ar.timeRange.previousWeek).toBe('السابق')
    expect(ar.timeRange.nextWeek).toBe('التالي')
    expect(ar.timeRange.currentWeek).toBe('الحالي')
    expect(ar.timeRange.apply).toBe('عرض')
    expect(ar.timeRange.dateOrder).toBe('تاريخ النهاية قبل تاريخ البداية — عدّل أحدهما')
    expect(ar.completedShifts.narrowRange).toBe('ضيّق الفترة')
  })
})
