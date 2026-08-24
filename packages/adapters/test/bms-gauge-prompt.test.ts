import { describe, expect, it } from 'vitest'
import { readPrompt } from '../src/ocr/prompt.ts'

describe('the black/green 50Ah BMS gauge prompt', () => {
  it('pins the central percentage and keeps both Ah cards out of percent', () => {
    const prompt = readPrompt('bms')

    expect(prompt).toContain('large «40%»')
    expect(prompt).toContain('«71.72V»')
    expect(prompt).toContain('«(Ah)Rem. Cap. 19.8»')
    expect(prompt).toContain('«(Ah)Capacity 50.0»')
    expect(prompt).toContain('`percent` is 40')
    expect(prompt).toContain('19.8Ah is not 19.8%')
    expect(prompt).toContain('50.0Ah capacity is not a 50% charge')
    expect(prompt).toContain('cycle count may be absent')
  })
})
