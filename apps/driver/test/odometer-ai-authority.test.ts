import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type AiOcrAuthorityState, reduceAiOcrAuthority } from '../src/ai-ocr-authority.ts'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const from = shift.indexOf(start)
  const to = shift.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return shift.slice(from, to)
}

describe('odometer cloud-AI authority', () => {
  it('never publishes the phone reader at shift start or close', () => {
    const startLocal = section('const runOcr = useCallback', 'const odoCloudRead = useCallback')
    expect(startLocal).toContain('setOdoStrip')
    expect(startLocal).toContain('setOdoLocal')
    expect(startLocal).not.toContain('setOdoOcr')
    expect(startLocal).not.toMatch(/setOdo\s*\(/u)

    const endLocal = section('const odoImage = useCallback', 'const dashImage = useCallback')
    expect(endLocal).toContain('odoLocal: localOdometerEvent')
    expect(endLocal).toContain('odoStrip: result.sample ?? null')
    expect(endLocal).not.toContain('odoOcr: odo')
    expect(endLocal).not.toContain('String(odo)')
  })

  it('keeps a no-fields odometer read explicit in both flows', () => {
    expect(shift).toContain(
      "setOdoCloud({ status: 'failed', reason: 'no_fields', retryable: e.response.retryable })",
    )
    expect(shift).toContain("if (value === null) return { ...restored, odoCloud: null }")
    expect(shift).toContain("readLinkedAttachment('odometer', 'odometer', false, result)")
  })

  it('gates both submissions while odometer AI is reading', () => {
    expect(shift).toContain("if (odoCloud?.status === 'reading') return")
    expect(shift).toContain("attachment.read?.status === 'running'")
    expect(shift).toContain("item.read?.status === 'running'")
    expect(shift).toMatch(/const missing:[\s\S]*odoCloud\?\.status === 'reading'[\s\S]*const ready/u)
    expect(shift).toMatch(/const missing:[\s\S]*readingAttachment[\s\S]*const ready/u)
    expect(shift).toContain("readLinkedAttachment('odometer', 'odometer', false, result)")
  })

  it('keeps explicit typing while retaining the cloud-AI baseline', () => {
    const photo = {}
    const idle: AiOcrAuthorityState<number, object> = {
      generation: null,
      phase: 'idle',
      value: null,
      aiValue: null,
      humanEdited: false,
    }
    const reading = reduceAiOcrAuthority(idle, { type: 'started', generation: photo })
    const local = reduceAiOcrAuthority(reading, { type: 'local_observed', generation: photo, value: 214 })
    expect(local.value).toBeNull()
    expect(local.aiValue).toBeNull()

    const typed = reduceAiOcrAuthority(local, { type: 'human_edited', value: 6031 })
    const ai = reduceAiOcrAuthority(typed, { type: 'ai_read', generation: photo, value: 6030 })
    expect(ai).toMatchObject({ value: 6031, aiValue: 6030, humanEdited: true })
  })
})
