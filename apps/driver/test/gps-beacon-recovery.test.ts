import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
  send: vi.fn(), enqueue: vi.fn(), peek: vi.fn(), drop: vi.fn(), reject: vi.fn(),
  position: null as ((value: GeolocationPosition) => void) | null,
}))
vi.mock('react', () => ({
  useEffect: (effect: () => (() => void) | undefined) => { fixture.effects.push(effect) },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
}))
vi.mock('../src/app-context.tsx', () => ({ useApp: () => ({ api: { sendGpsBatch: fixture.send }, session: { userId: 'driver' } }) }))
vi.mock('../src/native-tracker.ts', () => ({ nativeTrackerAvailable: () => false }))
vi.mock('../src/gps-outbox.ts', () => ({
  enqueueFix: fixture.enqueue, peekFixes: fixture.peek, dropFixes: fixture.drop, markRejectedFixes: fixture.reject,
  sweepOutbox: vi.fn(), gpsBatchDisposition: () => ({ acknowledged: ['point-1'], rejected: [] }),
}))
import { useGpsBeacon } from '../src/use-gps-beacon.ts'

const position = (): GeolocationPosition => ({ timestamp: Date.now(), coords: { latitude: 0, longitude: 0, accuracy: 10 } }) as GeolocationPosition
let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.clearAllMocks()
  fixture.effects = []
  fixture.peek.mockResolvedValue([{ key: 'point-1', pointId: 'point-1', capturedAtMs: 0 }])
  fixture.enqueue.mockResolvedValue(undefined)
  fixture.drop.mockResolvedValue(undefined)
  fixture.reject.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { geolocation: {
    watchPosition: (callback: (value: GeolocationPosition) => void) => { fixture.position = callback; return 1 },
    clearWatch: vi.fn(),
  } })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('actual foreground beacon lifecycle', () => {
  it.each([401, 403])('retains points on %s and sends them after re-entry with a fresh session', async status => {
    fixture.send.mockRejectedValueOnce({ status })
    useGpsBeacon('shift')
    cleanup = fixture.effects.at(-1)!()
    fixture.position!(position())
    await vi.advanceTimersByTimeAsync(15_000)
    fixture.position!(position())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.enqueue).toHaveBeenCalledTimes(2)
    expect(fixture.drop).not.toHaveBeenCalled()
    expect(fixture.reject).not.toHaveBeenCalled()
    cleanup?.()
    fixture.send.mockResolvedValueOnce({ results: [{ pointId: 'point-1', status: 'stored' }] })
    useGpsBeacon('shift')
    cleanup = fixture.effects.at(-1)!()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fixture.send).toHaveBeenCalledTimes(2)
    expect(fixture.send.mock.calls[1]![1].fixes[0].pointId).toBe('point-1')
    expect(fixture.drop).toHaveBeenCalledWith(['point-1'])
  })

  it('continues capturing during server backoff and never runs overlapping flushes', async () => {
    let release!: (value: unknown) => void
    fixture.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    useGpsBeacon('shift')
    cleanup = fixture.effects.at(-1)!()
    fixture.position!(position())
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fixture.send).toHaveBeenCalledTimes(1)
    release({})
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.drop).toHaveBeenCalledTimes(1)
  })
})
