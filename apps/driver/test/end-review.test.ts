import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { endReviewWarningKeys } from '../src/end-review.ts'

describe('driver end-shift review warnings', () => {
  it('does not turn either warning into a driver submission blocker', () => {
    expect(endReviewWarningKeys({ difference: 'balanced', batteriesReady: true })).toEqual([])
    expect(endReviewWarningKeys({ difference: 'shortage', batteriesReady: true })).toEqual(['moneyMismatch'])
    expect(endReviewWarningKeys({ difference: 'balanced', batteriesReady: false })).toEqual(['batteryIncomplete'])
    expect(endReviewWarningKeys({ difference: 'surplus', batteriesReady: false })).toEqual([
      'moneyMismatch',
      'batteryIncomplete',
    ])
  })

  it('asks the API to transfer incomplete end-battery evidence to manager review', () => {
    const source = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
    const endPackageSource = source.slice(source.indexOf('function EndPackage('))
    expect(source).toContain('deferMissingBatteryEvidenceToManager: true')
    // The opening gate remains strict; only EndPackage stops treating this as a blocker.
    expect(endPackageSource).not.toContain('...(batteriesReady ? [] : [t.battery.percent])')
    // Other in-flight evidence is still a real submission blocker.
    expect(endPackageSource).toContain('...(readingAttachment ? [t.shift.reading] : [])')
  })
})
