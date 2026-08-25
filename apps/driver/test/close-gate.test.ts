import { readFileSync } from 'node:fs'
import { isUsableMoneyText } from '@ash/client'
import { describe, expect, it } from 'vitest'
import { closeGateBlockers, type CloseGateInput } from '../src/close-gate.ts'

/** A driver who has done everything: every photo, both figures, orders read, draft saved. */
const complete = (over: Partial<CloseGateInput> = {}): CloseGateInput => ({
  requiredSlots: ['dashboard', 'wallet', 'odometer', 'bms_1', 'bms_2'],
  presentSlots: new Set(['dashboard', 'wallet', 'odometer', 'bms_1', 'bms_2']),
  cashText: '4890.00',
  walletText: '302.80',
  moneyIsUsable: isUsableMoneyText,
  odometerKm: 9529,
  namedOrderCount: 15,
  hasBadOrderRows: false,
  hasBadDeductionRows: false,
  readingInFlight: false,
  odometerNeedsConfirmation: false,
  draftSaved: true,
  ...over,
})

describe('the close gate names every reason it refuses', () => {
  it('lets a complete package through', () => {
    expect(closeGateBlockers(complete())).toEqual([])
  })

  /**
   * THE REGRESSION. This is امجد عبدالله's shift at 01:39 on 2026-08-25: thirteen photos, fifteen
   * orders, cash 4890.00, wallet 302.80, odometer 9529, both battery readings typed in by hand —
   * and an unsaved draft, because a `500` / `500.00` autosave fingerprint mismatch kept it dirty.
   *
   * The old gate produced an EMPTY missing-list and still disabled the button, and the explanation
   * panel was guarded on the list being non-empty. So he saw a dead green button and no words at
   * all. He never submitted; the shift was force-cancelled the next morning and its 1,870 SYP of
   * deliveries were discarded.
   *
   * A blocker with no name is the bug. There must always be something to say.
   */
  it('names an unsaved draft instead of disabling the button in silence', () => {
    const blockers = closeGateBlockers(complete({ draftSaved: false }))
    expect(blockers).toEqual([{ kind: 'draft_not_saved' }])
    expect(blockers.length).toBeGreaterThan(0)
  })

  it('names the odometer confirmation, which also used to be invisible', () => {
    expect(closeGateBlockers(complete({ odometerNeedsConfirmation: true })))
      .toEqual([{ kind: 'confirm_odometer' }])
  })

  /**
   * The invariant, stated as a test rather than as a comment: the button is enabled exactly when
   * this list is empty. Previously `ready` carried two terms the list did not, which is precisely
   * how a driver ends up with a dead control and nothing to read.
   */
  it('never refuses without a reason, across every single-cause case', () => {
    const cases: Partial<CloseGateInput>[] = [
      { presentSlots: new Set(['dashboard', 'wallet', 'odometer', 'bms_1']) },
      { cashText: '' },
      { walletText: '' },
      { cashText: '160,000' },
      { odometerKm: null },
      { namedOrderCount: 0 },
      { hasBadOrderRows: true },
      { hasBadDeductionRows: true },
      { readingInFlight: true },
      { odometerNeedsConfirmation: true },
      { draftSaved: false },
    ]
    for (const over of cases) {
      const blockers = closeGateBlockers(complete(over))
      expect(blockers.length, `no reason given for ${JSON.stringify(over)}`).toBeGreaterThan(0)
    }
  })

  it('accepts an Arabic-keyboard figure rather than blocking on it', () => {
    // \u0667\u0660\u0660\u0660\u0660 is 70000. The input normalises it, so by the time the gate sees it it is ASCII;
    // this asserts the gate agrees rather than refusing a number the driver typed correctly.
    expect(closeGateBlockers(complete({ cashText: '70000' }))).toEqual([])
  })

  it('flags a figure no normalisation can rescue, naming the field', () => {
    expect(closeGateBlockers(complete({ cashText: '160,000' })))
      .toEqual([{ kind: 'unreadable_money', field: 'cash' }])
    expect(closeGateBlockers(complete({ walletText: '1.234' })))
      .toEqual([{ kind: 'unreadable_money', field: 'wallet' }])
  })

  it('reports every missing photo separately, so the footer count is truthful', () => {
    expect(closeGateBlockers(complete({ presentSlots: new Set(['dashboard']) }))).toEqual([
      { kind: 'missing_photo', slot: 'wallet' },
      { kind: 'missing_photo', slot: 'odometer' },
      { kind: 'missing_photo', slot: 'bms_1' },
      { kind: 'missing_photo', slot: 'bms_2' },
    ])
  })
})

describe('the screen cannot re-open the silent-refusal hole', () => {
  const source = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
  // Comments legitimately QUOTE the old broken forms to explain them; a guard that matched its own
  // explanation would fire forever. Assert against code only.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

  it('derives readiness from the blocker list and nothing else', () => {
    expect(code).toContain('const ready = blockers.length === 0')
    // The old form. If it comes back, so does the dead button.
    expect(code).not.toContain('missing.length === 0 && !odometerNeedsConfirmation && draftSaved')
  })

  it('renders the explanation whenever it refuses, not only when the list happens to be non-empty', () => {
    expect(code).not.toContain('{!ready && missing.length > 0 ?')
    expect(code).toContain('{!ready ?')
  })
})
