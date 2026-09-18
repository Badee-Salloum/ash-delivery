import { describe, expect, it } from 'vitest'
import { defaultRereadSlot, rowEvidencePage } from './approval-workspace.ts'

/**
 * Which screenshot a disputed row is shown against.
 *
 * The failure this guards is quiet and expensive: a manager decides whether a delivery happened by
 * looking at a page that is not the page the row came from, and both look alike. Every rule below
 * is the difference between the right page and a plausible wrong one.
 */

const PAGE_1 = { slot: 'dashboard', mediaId: 'm-1' }
const PAGE_2 = { slot: 'dashboard_2', mediaId: 'm-2' }
const TWO = [PAGE_1, PAGE_2]

describe('rowEvidencePage', () => {
  it('takes the exact bytes the reader read', () => {
    expect(rowEvidencePage(TWO, { evidenceSlot: 'dashboard', evidenceMediaId: 'm-2', hasScanOrigin: true }))
      .toBe(PAGE_2)
  })

  it('falls back to the slot when a retake replaced the bytes', () => {
    // A retake rotates the attachment token and stores a NEW image, so the id recorded at read time
    // names nothing on the screen any more. The slot still names the right page, and the retaken
    // photo is the one the manager wants to look at.
    const retaken = [{ slot: 'dashboard', mediaId: 'm-retaken' }]
    expect(rowEvidencePage(retaken, { evidenceSlot: 'dashboard', evidenceMediaId: 'm-1', hasScanOrigin: true }))
      .toEqual({ slot: 'dashboard', mediaId: 'm-retaken' })
  })

  it('uses the only page there is for a row read before the link existed', () => {
    expect(rowEvidencePage([PAGE_1], { hasScanOrigin: true })).toBe(PAGE_1)
  })

  it('shows a linkless row NOTHING when more than one page could be it', () => {
    // This is the whole point. One of the two is right and the screen cannot tell which; a manager
    // shown the wrong screenshot believes it, so he is shown none.
    expect(rowEvidencePage(TWO, { hasScanOrigin: true })).toBeNull()
  })

  it('never lends a page to a hand-typed row', () => {
    // `hasScanOrigin` gates only the GUESS. A row that names no page and was typed by hand gets
    // nothing, even on a single-page shift where the guess would have been available.
    expect(rowEvidencePage([PAGE_1], { hasScanOrigin: false })).toBeNull()
  })

  it('believes a resolved slot over the client-side origin flag', () => {
    // The two disagree only if the server resolved a real observation for a row the client thinks
    // was typed. The server's answer came from the observation table; the flag is a heuristic over
    // the row's own fields. Trust the record, not the heuristic.
    expect(rowEvidencePage([PAGE_1], { evidenceSlot: 'dashboard', hasScanOrigin: false })).toBe(PAGE_1)
  })

  it('survives a slot or id that no longer names any stored page', () => {
    expect(rowEvidencePage(TWO, { evidenceSlot: 'dashboard_9', evidenceMediaId: 'gone', hasScanOrigin: true }))
      .toBeNull()
    expect(rowEvidencePage([], { evidenceSlot: 'dashboard', hasScanOrigin: true })).toBeNull()
  })
})

describe('defaultRereadSlot', () => {
  it('targets the page the row came from instead of asking', () => {
    // Nothing stopped a manager on a two-page shift from re-reading the page the row was NOT on.
    expect(defaultRereadSlot(TWO, { evidenceSlot: 'dashboard_2', hasScanOrigin: true })).toBe('dashboard_2')
  })

  it('keeps the old behaviour exactly when the row names no page', () => {
    expect(defaultRereadSlot([PAGE_1], { hasScanOrigin: false })).toBe('dashboard')
    expect(defaultRereadSlot(TWO, { hasScanOrigin: false })).toBe('')
    expect(defaultRereadSlot([], { hasScanOrigin: true })).toBe('')
  })
})
