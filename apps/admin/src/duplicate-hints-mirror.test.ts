import { SCAN_OVERLAP_CAUSES, SCAN_OVERLAP_PAIR_CAUSES } from '@ash/domain'
import { describe, expect, it } from 'vitest'
import type { ScanOverlapCause, ScanOverlapPairCause } from './duplicate-hints.ts'

/**
 * The admin's hand-written copy of the overlap cause vocabulary, checked against the domain.
 *
 * There are four declarations of this enum: the domain list, the Zod wire schema, this mirror, and
 * the copy record that renders it. Only the wire had a guard — so the mirror was the one that could
 * drift in silence, and its failure mode is quiet rather than loud: a cause the mirror does not
 * know still parses, still reaches React, and renders as `undefined` inside a `join(' · ')`, i.e.
 * a dangling separator and a missing fact on the very line a manager reads to decide whether two
 * rows are one delivery.
 *
 * `duplicate-hints.ts` restates the union deliberately — the admin bundle must not depend on
 * `@ash/contracts`. That decoupling is the right call and is left alone; this only removes the
 * licence to be WRONG about it. `@ash/domain` is already a dependency of this app, and the lists
 * are runtime arrays precisely so they can be compared.
 */

const sorted = (values: readonly string[]): string[] => [...values].sort()

// Every member, written out. A spread of the domain list would make this test agree with itself:
// the point is that a human transcribed the vocabulary twice and both transcriptions must match.
const MIRRORED_CAUSES: ScanOverlapCause[] = [
  'scan_overlap_timed_match',
  'scan_overlap_suffix_prefix',
  'scan_overlap_amount_only',
  'scan_overlap_direction_ambiguous',
  'scan_overlap_amount_disagrees',
]

const MIRRORED_PAIR_CAUSES: ScanOverlapPairCause[] = [
  'scan_overlap_pair_amount_agrees',
  'scan_overlap_pair_minute_agrees',
  'scan_overlap_pair_route_agrees',
  'scan_overlap_pair_amount_disagrees',
  'scan_overlap_pair_unaccounted',
]

describe('the admin mirror of the overlap causes', () => {
  it('knows exactly the page causes the domain emits', () => {
    expect(sorted(MIRRORED_CAUSES)).toEqual(sorted(SCAN_OVERLAP_CAUSES))
  })

  it('knows exactly the pair causes the domain emits', () => {
    expect(sorted(MIRRORED_PAIR_CAUSES)).toEqual(sorted(SCAN_OVERLAP_PAIR_CAUSES))
  })

  it('holds every member of its own union, so the lists above cannot rot either', () => {
    // A member added to the union in `duplicate-hints.ts` but not to the list above would leave the
    // two assertions passing against a stale transcription. TypeScript catches that here: the
    // exhaustive record has to name every member, and an unknown key is an error.
    const everyCause: Record<ScanOverlapCause, true> = {
      scan_overlap_timed_match: true,
      scan_overlap_suffix_prefix: true,
      scan_overlap_amount_only: true,
      scan_overlap_direction_ambiguous: true,
      scan_overlap_amount_disagrees: true,
    }
    const everyPairCause: Record<ScanOverlapPairCause, true> = {
      scan_overlap_pair_amount_agrees: true,
      scan_overlap_pair_minute_agrees: true,
      scan_overlap_pair_route_agrees: true,
      scan_overlap_pair_amount_disagrees: true,
      scan_overlap_pair_unaccounted: true,
    }
    expect(sorted(Object.keys(everyCause))).toEqual(sorted(MIRRORED_CAUSES))
    expect(sorted(Object.keys(everyPairCause))).toEqual(sorted(MIRRORED_PAIR_CAUSES))
  })
})
