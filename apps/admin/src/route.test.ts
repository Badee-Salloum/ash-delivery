/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PARAM_KEYS,
  SECTIONS,
  formatHash,
  formatParams,
  paramsKey,
  parseHash,
  sameView,
  sanitizeParams,
} from './route.ts'
import { replaceHashParams } from './use-hash-params.ts'

const appSource = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')
const UUID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e'

describe('parseHash — the links that already exist keep working', () => {
  it('opens every known section from a bare #section', () => {
    for (const section of SECTIONS) {
      expect(parseHash(`#${section}`)).toEqual({ section, openShift: null, params: {} })
    }
  })

  it('opens the review overlay from #shift:<id>, with or without the #', () => {
    expect(parseHash(`#shift:${UUID}`)).toEqual({ section: 'dashboard', openShift: UUID, params: {} })
    expect(parseHash(`shift:${UUID}`)).toEqual({ section: 'dashboard', openShift: UUID, params: {} })
    // The old router decoded the whole hash; an encoded colon still opens the shift.
    expect(parseHash(`#shift%3A${UUID}`)).toEqual({ section: 'dashboard', openShift: UUID, params: {} })
  })

  it('falls back to the dashboard for an empty, unknown or malformed hash', () => {
    for (const hash of ['', '#', '#nope', '#shift:', '#shift:has space', '#%E0%A4%A', '#Dashboard']) {
      expect(parseHash(hash), hash).toEqual({ section: 'dashboard', openShift: null, params: {} })
    }
  })

  it('drops the params of an unknown section rather than applying them to the dashboard', () => {
    expect(parseHash('#nope?driver=abc&short=1')).toEqual({ section: 'dashboard', openShift: null, params: {} })
  })
})

describe('parseHash — filter params', () => {
  it('reads every known key with a valid value', () => {
    expect(
      parseHash(
        `#completedShifts?range=custom&from=2026-09-01&to=2026-09-17&driver=${UUID}&vehicle=vehicle-1&pattern=full&short=1&abandoned=1`,
      ),
    ).toEqual({
      section: 'completedShifts',
      openShift: null,
      params: {
        range: 'custom',
        from: '2026-09-01',
        to: '2026-09-17',
        driver: UUID,
        vehicle: 'vehicle-1',
        pattern: 'full',
        short: true,
        abandoned: true,
      },
    })
    expect(parseHash('#liveShifts?state=suspended&over=1').params).toEqual({ state: 'suspended', over: true })
    expect(parseHash('#expenses?tab=due').params).toEqual({ tab: 'due' })
    expect(parseHash(`#fleet?id=${UUID}`).params).toEqual({ id: UUID })
  })

  it('drops unknown keys and invalid values, keeping the rest', () => {
    const view = parseHash(
      '#completedShifts?evil=<script>&driver=a%20b&vehicle=' + 'x'.repeat(65) + '&pattern=unknown&short=yes&state=closed&over=0&tab=1bad&id=a/b&range=last_year',
    )
    expect(view).toEqual({ section: 'completedShifts', openShift: null, params: {} })
    expect(parseHash('#completedShifts?driver=ok-1&pattern=night').params).toEqual({ driver: 'ok-1' })
  })

  it('validates dates with the domain parser and keeps ranges coherent', () => {
    // An impossible date is dropped, and a custom range without both ends is dropped whole.
    expect(parseHash('#completedShifts?range=custom&from=2026-02-31&to=2026-03-01').params).toEqual({})
    expect(parseHash('#completedShifts?range=custom&from=2026-03-02&to=2026-03-01').params).toEqual({})
    expect(parseHash('#completedShifts?range=custom&from=2026-03-01').params).toEqual({})
    // A pair with no preset is still a custom range.
    expect(parseHash('#completedShifts?from=2026-03-01&to=2026-03-05').params).toEqual({ from: '2026-03-01', to: '2026-03-05' })
    // A lone `to` means nothing.
    expect(parseHash('#completedShifts?to=2026-03-05').params).toEqual({})
    // A week needs its date; a simple preset ignores stray dates.
    expect(parseHash('#completedShifts?range=week&from=2026-09-13').params).toEqual({ range: 'week', from: '2026-09-13' })
    expect(parseHash('#completedShifts?range=week').params).toEqual({})
    expect(parseHash('#completedShifts?range=this_month&from=2026-09-01&to=2026-09-17').params).toEqual({ range: 'this_month' })
    expect(parseHash('#completedShifts?range=2026-09-01').params).toEqual({})
  })

  it('takes the first value of a repeated key', () => {
    expect(parseHash('#liveShifts?state=open&state=suspended').params).toEqual({ state: 'open' })
  })
})

describe('formatHash — one spelling per view', () => {
  it('writes params in a fixed order, so equal views are equal strings', () => {
    expect(
      formatHash({
        section: 'completedShifts',
        openShift: null,
        params: { short: true, driver: 'd-1', range: 'this_week', pattern: 'day' },
      }),
    ).toBe('completedShifts?range=this_week&driver=d-1&pattern=day&short=1')
    expect(formatHash({ section: 'dashboard', openShift: null, params: {} })).toBe('dashboard')
    expect(PARAM_KEYS[0]).toBe('range')
  })

  it('writes the overlay as shift:<id>, and never an id the parser would refuse', () => {
    expect(formatHash({ section: 'completedShifts', openShift: UUID, params: { short: true } })).toBe(`shift:${UUID}`)
    expect(formatHash({ section: 'queue', openShift: 'bad id', params: {} })).toBe('queue')
  })

  it('round-trips through parseHash', () => {
    const views = [
      { section: 'completedShifts', openShift: null, params: { range: 'week', from: '2026-09-13', vehicle: 'vehicle-2', abandoned: true } },
      { section: 'liveShifts', openShift: null, params: { state: 'open', driver: UUID, over: true } },
      { section: 'expenses', openShift: null, params: { tab: 'due' } },
      { section: 'treasury', openShift: null, params: {} },
    ] as const
    for (const view of views) {
      expect(parseHash(`#${formatHash(view)}`)).toEqual(view)
      expect(sameView(parseHash(formatHash(view)), view)).toBe(true)
    }
  })

  it('sanitises what it writes, like what it reads', () => {
    expect(formatParams(sanitizeParams({ driver: 'has space', from: '2026-02-31', short: false, over: true }))).toBe('over=1')
    expect(paramsKey({})).toBe('')
    expect(paramsKey({ driver: 'a' })).not.toBe(paramsKey({ driver: 'b' }))
  })
})

describe('replaceHashParams — filter changes do not add history entries', () => {
  const fakeWindow = (hash: string) => {
    const calls: Array<[unknown, string, string | null | undefined]> = []
    const target = {
      location: { hash },
      history: {
        state: { idx: 3 },
        replaceState(data: unknown, unused: string, url?: string | null) {
          calls.push([data, unused, url])
        },
      },
    }
    return { target, calls }
  }

  it('replaces the current entry, keeping its history state', () => {
    const { target, calls } = fakeWindow('#completedShifts')
    expect(replaceHashParams('completedShifts', { range: 'today', short: true }, target)).toBe(true)
    expect(calls).toEqual([[{ idx: 3 }, '', '#completedShifts?range=today&short=1']])
  })

  it('does nothing when the URL already says it', () => {
    const { target, calls } = fakeWindow('#liveShifts?state=open')
    expect(replaceHashParams('liveShifts', { state: 'open' }, target)).toBe(false)
    expect(calls).toEqual([])
  })

  it('never throws out of a browser that refuses replaceState', () => {
    const target = {
      location: { hash: '' },
      history: {
        state: null,
        replaceState() {
          throw new Error('SecurityError')
        },
      },
    }
    expect(replaceHashParams('dashboard', { tab: 'x' }, target)).toBe(false)
  })
})

describe('the shell keeps params (AdminApp wiring)', () => {
  it('parses and formats through the pure router instead of stripping the hash to the section', () => {
    expect(appSource).toContain("from './route.ts'")
    expect(appSource).toContain('function viewFromHash(): RouteView {\n  return parseHash(location.hash)\n}')
    expect(appSource).toContain('const view = formatHash({ section, openShift, params: liveParams.current })')
    expect(appSource).toContain('if (formatHash(viewFromHash()) !== view) location.hash = view')
    // The old reflect wrote the bare section and lost every filter.
    expect(appSource).not.toContain('decodeURIComponent(location.hash.slice(1)) !== view')
    expect(appSource).not.toContain('const SECTIONS = [')
  })

  it('restores the filtered view when a shift overlay closes, and mounts filtered screens by key', () => {
    // Filter changes report the live params; the overlay's close formats them back into the hash.
    expect(appSource).toContain('liveParams.current = params\n      replaceHashParams(section, params, window)')
    expect(appSource).toContain('<HashParamsContext.Provider value={replaceParams}>')
    expect(appSource).toContain('<LiveShifts key={mountKey} initial={liveParams.current} onOpen={setOpenShift} />')
    expect(appSource).toContain('<CompletedShifts key={mountKey} initial={liveParams.current} onOpen={setOpenShift} />')
    // Every navigation remounts — the rail item already on screen included — via a nonce in the key.
    expect(appSource).toContain('const mountKey = `${mountNonce}:${paramsKey(mountedParams)}`')
    expect(appSource).toContain('setMountNonce((n) => n + 1)')
    // Returning to the view already on screen does not remount it.
    expect(appSource).toContain('if (sectionRef.current === next.section && paramsKey(next.params) === paramsKey(liveParams.current)) return')
  })
})
