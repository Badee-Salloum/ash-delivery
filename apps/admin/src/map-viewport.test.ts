import { describe, expect, it } from 'vitest'
import { mapViewportKey, readMapViewport, validMapViewport, writeMapViewport, type ViewportStorage } from './map-viewport.ts'
const view = { lat: 33.52, lng: 36.29, zoom: 15 }
function store(): ViewportStorage {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}
describe('branch-scoped live map display preferences', () => {
  it('restores a valid chosen view without keeping driver data', () => {
    const storage = store(), key = mapViewportKey('manager', 'branch')
    expect(writeMapViewport(storage, key, view)).toBe(true)
    expect(readMapViewport(storage, key)).toEqual(view)
    expect(Object.keys(JSON.parse(storage.getItem(key!)!)).sort()).toEqual(['lat', 'lng', 'zoom'])
  })
  it('isolates branches and users, requiring both identities', () => {
    const storage = store()
    writeMapViewport(storage, mapViewportKey('user1', 'branch1'), view)
    expect(readMapViewport(storage, mapViewportKey('user1', 'branch2'))).toBeNull()
    expect(readMapViewport(storage, mapViewportKey('user2', 'branch1'))).toBeNull()
    expect(mapViewportKey(null, 'branch1')).toBeNull()
    expect(mapViewportKey('user1', null)).toBeNull()
    expect(mapViewportKey('a:b', 'c')).not.toBe(mapViewportKey('a', 'b:c'))
  })
  it('ignores missing, malformed, out-of-range or nonnumeric preferences', () => {
    for (const value of ['{', 'null', '[]', '{}', '{"lat":"33","lng":36,"zoom":15}', ...[
      { ...view, lat: 90 }, { ...view, lng: 181 }, { ...view, zoom: -1 }, { ...view, zoom: 20 },
    ].map(value => JSON.stringify(value))]) {
      expect(readMapViewport({ getItem: () => value, setItem() {} }, 'key')).toBeNull()
    }
    for (const value of [{ ...view, zoom: NaN }, { ...view, lat: Infinity }, { ...view, lng: -Infinity }]) expect(validMapViewport(value)).toBe(false)
    expect(readMapViewport(store(), 'missing')).toBeNull()
  })
  it('survives denied storage and quota errors without preventing map use', () => {
    const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') } }
    expect(readMapViewport(blocked, 'key')).toBeNull()
    expect(writeMapViewport(blocked, 'key', view)).toBe(false)
    expect(writeMapViewport(null, 'key', view)).toBe(false)
    expect(readMapViewport(null, 'key')).toBeNull()
    expect(writeMapViewport(store(), null, view)).toBe(false)
  })
  it('stores an equivalent longitude when Leaflet is panned across the date line', () => {
    const storage = store()
    writeMapViewport(storage, 'key', { ...view, lng: 396.29 })
    expect(readMapViewport(storage, 'key')!.lng).toBeCloseTo(36.29, 8)
    expect(writeMapViewport(storage, 'key', { ...view, lat: NaN })).toBe(false)
  })
})
