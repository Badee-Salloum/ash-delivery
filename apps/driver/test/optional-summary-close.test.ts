import {describe, expect, it} from 'vitest'
import {readBlocksClose} from '../src/close-gate.ts'

describe('the same read gate drives visibility and submit', () => {
  it.each(['daily_summary','payments_log'])('allows optional %s while reading', field => {
    expect(readBlocksClose({field,status:'running'})).toBe(false)
  })
  it.each(['orders','wallet','odometer','bms'])('waits for required %s while reading', field => {
    expect(readBlocksClose({field,status:'running'})).toBe(true)
    expect(readBlocksClose({field,status:'failed'})).toBe(false)
    expect(readBlocksClose({field,status:'complete'})).toBe(false)
  })
  it('accepts absent read metadata', () => {
    expect(readBlocksClose(null)).toBe(false)
    expect(readBlocksClose(undefined)).toBe(false)
  })
})
