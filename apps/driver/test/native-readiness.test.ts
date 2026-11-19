import { afterEach, describe, expect, it, vi } from 'vitest'
import { preflightNativeTracker } from '../src/native-tracker.ts'
afterEach(() => vi.unstubAllGlobals())
describe('native preflight bridge', () => {
  it('passes forced fresh capture intent to Android instead of rereading a cached result in JS', async () => {
    const preflight = vi.fn().mockResolvedValue({ ready: true, capturedAtMs: 100 })
    vi.stubGlobal('Capacitor', { Plugins: { AshTracker: { preflight } } })
    await preflightNativeTracker()
    await preflightNativeTracker({ forceFresh: true })
    expect(preflight.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: true }]])
  })
})
