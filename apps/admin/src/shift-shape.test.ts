/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as domain from '@ash/domain'
import { ar, en } from '@ash/client/i18n'
import {
  shiftPatternLabel,
  shiftPatternTone,
  shiftShapeForDay,
  shiftShapeOf,
  shiftsByDriver,
} from './shift-shape.ts'

/*
 * The shape rules moved to the domain (`packages/domain/test/shift/shape.test.ts` holds their
 * behaviour). What stays here is the proof that the console uses THOSE rules rather than a copy,
 * and the words the badges are built from.
 */

const shiftShapeSource = readFileSync(new URL('./shift-shape.ts', import.meta.url), 'utf8')
const liveSource = readFileSync(new URL('./screens/LiveShifts.tsx', import.meta.url), 'utf8')
const approvalSource = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

describe('the console’s shift shape is the domain’s', () => {
  it('re-exports the domain functions rather than keeping a copy', () => {
    expect(shiftShapeOf).toBe(domain.shiftShapeOf)
    expect(shiftShapeForDay).toBe(domain.shiftShapeForDay)
    expect(shiftsByDriver).toBe(domain.shiftsByDriver)
    expect(shiftShapeSource).not.toContain('export function shiftShapeOf')
    expect(shiftShapeSource).not.toContain('16 * 60')
  })
})

describe('the pattern badge — «صباحية · 8س»', () => {
  const labels = ar.completedShifts

  it('names the pattern beside the owner’s target', () => {
    expect(shiftPatternLabel({ pattern: 'day', slot: 'day', abandoned: false }, labels)).toBe('صباحية · 8س')
    expect(shiftPatternLabel({ pattern: 'evening', slot: 'evening', abandoned: false }, labels)).toBe('مسائية · 8س')
    expect(shiftPatternLabel({ pattern: 'full', slot: 'day', abandoned: false }, labels)).toBe('دبل · 12س')
    expect(shiftPatternLabel({ pattern: 'full', slot: 'day', abandoned: false }, en.completedShifts)).toBe(
      'Double · 12h',
    )
  })

  it('says a running shift is running, with its slot, and guesses no pattern', () => {
    expect(shiftPatternLabel({ pattern: 'unknown', slot: 'day', abandoned: false }, labels, true)).toBe(
      'جارية — صباحية',
    )
    expect(shiftPatternLabel({ pattern: 'unknown', slot: 'evening', abandoned: false }, labels, true)).toBe(
      'جارية — مسائية',
    )
    // An API one version older serves no slot; the badge still says it is running.
    expect(shiftPatternLabel({ pattern: 'unknown', abandoned: false }, labels, true)).toBe('جارية')
  })

  it('never calls a shift running unless the caller knows it is', () => {
    // On the history screen an unclassified row is cancelled or never started — not running.
    expect(shiftPatternLabel({ pattern: 'unknown', slot: 'day', abandoned: false }, labels)).toBe('غير محدّد')
    expect(shiftPatternLabel(undefined, labels)).toBe('غير محدّد')
    expect(shiftPatternLabel(undefined, labels, true)).toBe('جارية')
  })

  it('drops the target for a forgotten close, which is never judged', () => {
    expect(shiftPatternLabel({ pattern: 'day', slot: 'day', abandoned: true }, labels)).toBe('صباحية')
  })

  it('makes a double stand out and nothing else', () => {
    expect(shiftPatternTone({ pattern: 'full' })).toBe('info')
    expect(shiftPatternTone({ pattern: 'day' })).toBe('neutral')
    expect(shiftPatternTone({ pattern: 'unknown', slot: 'evening' })).toBe('neutral')
    expect(shiftPatternTone(undefined)).toBe('neutral')
  })

  it('is what the live board and the approval page show', () => {
    expect(liveSource).toContain('shiftPatternLabel(shift.worked, t.completedShifts, true)')
    expect(approvalSource).toContain('shiftPatternLabel(shiftWorked, t.completedShifts, shiftRunning)')
    expect(approvalSource).toContain("review.state === 'open' || review.state === 'suspended'")
  })
})
