import { describe, expect, it } from 'vitest'
import type { CloseDraftReadResponse } from '@ash/client'
import { linkedBmsReadState } from '../src/bms-linked-read.ts'

/**
 * Shift f61f4d73, 2026-08-26. The closing BMS read succeeded — the provider returned `percent: 9`
 * and the server stored the read as `complete` — and the driver was still shown a failed read and
 * typed the number by hand. Across the fleet, end-package battery readings sourced from OCR have
 * been ZERO every day since 2026-08-14 while start-package reads kept working.
 *
 * The cause was that the driver asked the response for a field the API has never sent. These tests
 * run the decision on the SHAPE THE SERVER ACTUALLY RETURNS, which is the thing the old source-text
 * test could not do.
 */

/** Exactly what `POST /shifts/:id/close-draft/media/:slot/read` returns — no top-level `read`. */
const serverResponse = (
  attachmentRead: Record<string, unknown> | null,
  slot = 'bms_2',
): CloseDraftReadResponse =>
  ({
    draft: {
      shiftId: 'f61f4d73-0000-4000-8000-000000000000',
      revision: 12,
      draftHash: 'hash',
      updatedAt: '2026-08-27T01:07:20.000Z',
      submittedAt: null,
      restored: true,
      figures: {},
      attachments: [
        { package: 'end', slot: 'bms_1', mediaId: 'm1', attachmentToken: 't1', attachedAtMs: 1, attachedAt: 'x', read: null },
        { package: 'end', slot, mediaId: 'm2', attachmentToken: 't2', attachedAtMs: 2, attachedAt: 'y', read: attachmentRead },
      ],
      operations: { orders: [], cashDeductions: [], movements: [] },
    },
    rows: [],
    fields: { percent: '9', voltage: '77.54', cycles: '26' },
  }) as unknown as CloseDraftReadResponse

const complete = { readId: 'r1', status: 'complete', field: 'bms', failure: null, attempts: 1 }

describe('linkedBmsReadState', () => {
  it('accepts the response shape the API really sends', () => {
    const response = serverResponse(complete)

    // The old code asked for `response.read.status`. The API has never sent `read`, so this threw a
    // TypeError, the task wrapper turned the throw into a failed read, and the percent the reader
    // had already found was never offered to the driver.
    expect(() => (response as unknown as { read: { status: string } }).read.status).toThrow(TypeError)

    const state = linkedBmsReadState(response, 'bms_2')
    expect(state.complete).toBe(true)
    expect(state.complete && state.read.readId).toBe('r1')
  })

  it('reads the status of the requested slot, not of some other pack', () => {
    // bms_1 has never been read; bms_2 has. Answering for the wrong slot is how one pack's failure
    // would silently suppress the other pack's good answer.
    const response = serverResponse(complete)
    expect(linkedBmsReadState(response, 'bms_2').complete).toBe(true)
    expect(linkedBmsReadState(response, 'bms_1').complete).toBe(false)
  })

  it('reports the server-recorded failure reason rather than a blanket "unavailable"', () => {
    for (const failure of ['no_fields', 'timeout', 'refused', 'read_budget_exhausted'] as const) {
      const state = linkedBmsReadState(serverResponse({ ...complete, status: 'failed', failure }), 'bms_2')
      expect(state.complete).toBe(false)
      expect(!state.complete && state.reason).toBe(failure)
    }
  })

  it('treats a still-running read as not complete', () => {
    const state = linkedBmsReadState(serverResponse({ ...complete, status: 'running', failure: null }), 'bms_2')
    expect(state.complete).toBe(false)
    expect(!state.complete && state.reason).toBe('unavailable')
  })

  it('falls back to unavailable when there is no response, no slot, or no read', () => {
    expect(linkedBmsReadState(null, 'bms_2')).toEqual({ complete: false, reason: 'unavailable' })
    expect(linkedBmsReadState(serverResponse(complete), 'bms_9')).toEqual({ complete: false, reason: 'unavailable' })
    expect(linkedBmsReadState(serverResponse(null), 'bms_2')).toEqual({ complete: false, reason: 'unavailable' })
  })

  it('never throws, whatever the server sends', () => {
    // The defect was an exception, not a wrong answer. A decision function that can throw puts the
    // driver back where he started.
    for (const broken of [undefined, null, {}, { draft: null }, { draft: {} }, { draft: { attachments: null } }]) {
      expect(() => linkedBmsReadState(broken as never, 'bms_2')).not.toThrow()
    }
  })
})
