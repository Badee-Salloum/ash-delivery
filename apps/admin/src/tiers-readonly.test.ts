/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const source = readFileSync(new URL('./screens/Tiers.tsx', import.meta.url), 'utf8')

describe('legacy tier history screen', () => {
  it('states the fixed 40% policy and the historical-only scope in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.tiers.fixedPolicyDescription).toContain('40%')
      expect(catalog.tiers.legacyReadOnlyNotice.length).toBeGreaterThan(40)
    }
  })

  it('loads history without exposing tier mutations or a current-policy simulation', () => {
    expect(source).toContain('.tierRules()')
    expect(source).toContain('t.tiers.fixedPolicyTitle')
    expect(source).toContain('t.tiers.historyTitle')

    for (const forbidden of [
      '.publishTier(',
      '.withdrawTier(',
      '.simulateTier(',
      'TierSimResult',
      'useConfirm',
      'useToast',
      '<DateField',
      '<TextInput',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
