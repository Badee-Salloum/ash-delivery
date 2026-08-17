import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

describe('submitted close rephoto recovery', () => {
  it('polls the waiting screen and reloads the same shift canonical draft when it reopens', () => {
    expect(shift).toContain("if (phase !== 'done' || !shift) return")
    expect(shift).toContain("if (state.state === 'open')")
    expect(shift).toContain('closeDraftRevision: null')
    expect(shift).toContain('closeDraftHash: null')
    expect(shift).toContain('showManagerReturnReason(state.lastDecision)')
    expect(shift).toContain('applyServerState(state.state)')
    expect(shift).toContain('timer = setInterval(() => void check(), 8_000)')
  })
})
