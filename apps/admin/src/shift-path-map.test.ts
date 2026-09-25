/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { SECTIONS } from './route.ts'

/**
 * Wiring pins for the recorded-path map. The segmentation is proven in the domain and the endpoint
 * in the API; these guard that the one reusable component stays token-painted and stays mounted in
 * every surface the owner asked for — the review overlay, the vehicle history, and the standalone
 * screen — so a refactor cannot quietly drop one.
 */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const map = read('./components/ShiftPathMap.tsx')

describe('ShiftPathMap', () => {
  it('reads its colours from the semantic tokens, never raw literals', () => {
    expect(map).toContain('leafletPathPaints()')
    // A new file has a raw-colour budget of zero; the map must not slip a hex past check:tokens.
    expect(map).not.toMatch(/#[0-9a-fA-F]{6}\b/)
  })

  it('loads the trail from the path endpoint and draws it as a polyline', () => {
    expect(map).toContain('.getShiftGpsPath(shiftId)')
    expect(map).toContain('L.polyline')
    expect(map).toContain('openstreetmap.org')
  })

  it('shows the before-first, after-close and untimed buckets', () => {
    for (const key of ['beforeFirst', 'afterClose', 'untimed', 'noSegment']) {
      expect(map).toContain(`t.shiftPath.${key}`)
    }
  })

  it('shows each order’s path length and the whole-trail total', () => {
    expect(map).toContain('formatDistance')
    expect(map).toContain('totalDistanceMetres')
    expect(map).toContain('distanceMetres')
  })
})

describe('the map is mounted in every surface', () => {
  it('the review overlay shows it, hidden when the shift has no trail', () => {
    const approval = read('./screens/Approval.tsx')
    expect(approval).toContain('ShiftPathMap')
    expect(approval).toMatch(/<ShiftPathMap[^>]*hideWhenEmpty/)
  })

  it('the vehicle history shows a per-shift path', () => {
    const vehicle = read('./screens/VehicleHistory.tsx')
    expect(vehicle).toContain('<ShiftPathMap')
    expect(vehicle).toContain('t.vehicleHistory.path')
  })

  it('the standalone recorded-paths screen exists, is a section, and is mounted', () => {
    expect(SECTIONS).toContain('recordedPaths')
    const screen = read('./screens/RecordedPaths.tsx')
    expect(screen).toContain('<ShiftPathMap')
    const shell = read('./AdminApp.tsx')
    expect(shell).toContain('RecordedPaths')
    expect(shell).toMatch(/recordedPaths.*canSeeMap/)
  })
})

describe('i18n', () => {
  it('both locales carry the shiftPath and recordedPaths copy', () => {
    for (const dict of [ar, en]) {
      expect(dict.shiftPath.title).toBeTruthy()
      expect(dict.shiftPath.beforeFirst).toBeTruthy()
      expect(dict.shiftPath.distance).toBeTruthy()
      expect(dict.shiftPath.totalDistance).toBeTruthy()
      expect(dict.shiftPath.km).toBeTruthy()
      expect(dict.shiftPath.metres).toBeTruthy()
      expect(dict.recordedPaths.title).toBeTruthy()
    }
  })
})
