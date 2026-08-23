import { ApiClient } from '../src/api.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('linked BMS cancellation transport', () => {
  it('forwards the same AbortSignal to the linked read and evidence-bound reading write', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ draft: {}, read: {}, rows: [], fields: {}, readings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = new ApiClient('/api')
    const controller = new AbortController()

    await api.readCloseDraftAttachment(
      'shift-1',
      'bms_1',
      {
        expectedRevision: 7,
        mediaId: 'media-1',
        attachmentToken: 'attachment-1',
        field: 'bms',
      },
      { signal: controller.signal },
    )
    await api.putBatteryReadings(
      'shift-1',
      'end',
      [{ batteryId: 'battery-1', percent: 73, source: 'manual' }],
      { signal: controller.signal },
    )

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal)
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).signal).toBe(controller.signal)
  })
})
