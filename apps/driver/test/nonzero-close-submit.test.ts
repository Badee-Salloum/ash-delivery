import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

describe('non-zero close submission', () => {
  it('moves to manager review after every successful end-package response', () => {
    expect(shift).toContain('setBr1(res.br1)')
    expect(shift).toContain('onSubmitted()')
    expect(shift).not.toContain('if (res.br1.balanced) onSubmitted()')
  })
})
