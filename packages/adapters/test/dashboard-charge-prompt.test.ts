import { describe, expect, it } from 'vitest'
import { readPrompt } from '../src/ocr/prompt.ts'

describe('dashboard charge prompt', () => {
  it('asks for the two independent values shown in the supplied dashboard photo', () => {
    const prompt = readPrompt('odometer')
    expect(prompt).toContain('`fields.odometer`')
    expect(prompt).toContain('`fields.percent`')
    expect(prompt).toContain('«ODO 00005 km»')
    expect(prompt).toContain('`odometer` 5 and `percent` 84')
  })
})
