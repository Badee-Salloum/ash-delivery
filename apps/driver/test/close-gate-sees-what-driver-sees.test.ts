import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DraftOrder } from '@ash/client'
import { allProblems, withoutSupersededRemnants } from '@ash/client'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

/**
 * Shift d0a5a7ec, after the duplicated tiles were hidden. His summary read «متبقي 1 — صفوف فيها
 * خطأ» while his list showed ten clean rows, because the close gate still judged all 21: every
 * stale copy raised `duplicate_order_no` against the copy that superseded it.
 *
 * That is the shape that stranded امجد on 2026-08-24 — a refusal naming something the driver cannot
 * find. The gate must judge exactly the rows he is shown.
 */
const sighting = () => ({
  readId: 'r', observationId: 'o', rowIndex: 0, dateSection: '2026-08-27',
  evidence: { mediaId: 'm', attachmentToken: 't', slot: 'dashboard' },
})

const pair = (i: number, time: string): DraftOrder[] => {
  const providerOrderNo = `YAL-${i}`
  return [
    { localId: `live-${i}`, providerOrderNo, payMode: 'cash', feeText: '135.00', timeText: time, dateText: '2026-08-27', sightings: [sighting()], included: true },
    { localId: `stale-${i}`, providerOrderNo, payMode: 'cash', feeText: '135.00', timeText: time, dateText: '2026-08-27', sightings: [], included: false, draftSource: 'manual' },
  ]
}

describe('the close gate judges the rows the driver can see', () => {
  it('a superseded copy raises a problem the driver cannot act on', () => {
    const rows = ['11:34', '12:02', '13:17'].flatMap((t, i) => pair(i, t))
    // Every stale copy collides with the one that superseded it, on the app's own duplicate check.
    expect(allProblems(rows).size).toBe(3)
    for (const [, problem] of allProblems(rows)) expect(problem.kind).toBe('duplicate_order_no')

    // None of those rows is on his screen.
    const shown = withoutSupersededRemnants(rows)
    expect(shown).toHaveLength(3)
    expect(allProblems(shown).size).toBe(0)
  })

  it('does not let a clockless already-YAL remnant block Taha from resubmitting', () => {
    const providerOrderNo = 'YAL-903d7b56dcf5122968608a5154db16ce'
    const rows: DraftOrder[] = [
      {
        localId: 'orders:c1270421415835b2b13473b43ccf967e',
        providerOrderNo,
        payMode: 'cash',
        feeText: '415.00',
        timeText: '',
        dateText: '2026-08-30',
        sightings: [sighting()],
        included: false,
        timeReviewRequired: true,
        draftSource: 'cloud_ocr',
      },
      {
        localId: `already-${providerOrderNo}`,
        providerOrderNo,
        payMode: 'cash',
        feeText: '415.00',
        timeText: '',
        dateText: '2026-08-30',
        sightings: [],
        included: false,
        timeReviewRequired: true,
        draftSource: 'manual',
      },
    ]

    expect([...allProblems(rows).values()]).toEqual([{ kind: 'duplicate_order_no', firstIndex: 0 }])
    const shown = withoutSupersededRemnants(rows)
    expect(shown).toHaveLength(1)
    expect(shown[0]!.localId).toBe('orders:c1270421415835b2b13473b43ccf967e')
    expect(allProblems(shown).size).toBe(0)
  })

  it('Shift.tsx feeds the gate the filtered rows, not the raw draft', () => {
    // The regression is invisible at runtime without a DOM, so it is pinned at the wiring: the gate
    // must never be handed `draft.orders` directly again.
    expect(shift).toContain('allProblems(withoutSupersededRemnants(draft.orders))')
    expect(shift).not.toContain('allProblems(draft.orders)')
    expect(shift).toContain('cashDeductionsAreValid(withoutSupersededRemnants(draft.cashDeductions))')
    expect(shift).not.toContain('cashDeductionsAreValid(draft.cashDeductions)')
  })
})
