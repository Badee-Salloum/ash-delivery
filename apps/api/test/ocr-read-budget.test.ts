import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_OCR_READS_PER_SHIFT, loadConfig } from '../src/config.ts'
import { OCR_FIELDS, effectiveReadCeiling } from '../src/ocr.service.ts'

/**
 * The budget that cost a night's work.
 *
 * On 2026-08-24 امجد عبدالله's shift spent exactly fifteen reads — three at open, then five
 * dashboard pages, FOUR PAYMENTS-LOG PAGES, wallet and odometer at close. Read #15 was the odometer
 * at 01:33:43. His `bms_1` and `bms_2` requests at 01:35 were then refused as capped, so the two
 * readings the BR5 close gate actually requires never happened and his shift never closed. It was
 * force-cancelled the next morning and 1,870 SYP of deliveries were discarded.
 *
 * The payments log is archival by rule — CLAUDE.md money rule 7: "its absence never blocks close
 * submission". An optional page must not be able to spend the budget a mandatory one needs.
 */
describe('the per-shift OCR read budget', () => {
  it('keeps headroom back from the archival field, and only from it', () => {
    const max = 40
    expect(effectiveReadCeiling('payments_log', max)).toBeLessThan(max)
    for (const field of OCR_FIELDS.filter((f) => f !== 'payments_log')) {
      expect(effectiveReadCeiling(field, max), field).toBe(max)
    }
  })

  it('would have left room for the two BMS reads that were refused', () => {
    const max = loadConfig({ ...process.env, OCR_DRIVER: 'none' }).OCR_MAX_READS_PER_SHIFT
    const logCeiling = effectiveReadCeiling('payments_log', max)
    // Whatever the log spends, a mandatory field still has at least this much room left.
    expect(max - logCeiling).toBeGreaterThanOrEqual(2)
    // And the real shape of that night — 3 at open + 5 dashboards + 4 log pages + wallet + odometer
    // — now leaves the battery reads inside the ceiling rather than outside it.
    expect(3 + 5 + 4 + 1 + 1 + 2).toBeLessThanOrEqual(max)
  })

  it('never returns a ceiling below one, and leaves an uncapped shift uncapped', () => {
    expect(effectiveReadCeiling('payments_log', 1)).toBe(1)
    expect(effectiveReadCeiling('payments_log', 3)).toBe(1)
    // Zero means "no cap" throughout the service; the reserve must not turn that into a cap of 1.
    expect(effectiveReadCeiling('payments_log', 0)).toBe(0)
    expect(effectiveReadCeiling('bms', 0)).toBe(0)
  })

  /**
   * The ceiling was a literal in `config.ts` AND `?? 15` in five route handlers. Raising one while
   * the others stayed put would have looked like a fix and changed nothing for any request that
   * did not pass the option.
   */
  it('has exactly one default, and no route re-states it', () => {
    const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
    expect(app).not.toMatch(/maxOcrReadsPerShift \?\? \d/u)
    expect(app).toContain('opts.maxOcrReadsPerShift ?? DEFAULT_MAX_OCR_READS_PER_SHIFT')
    expect(loadConfig({ ...process.env, OCR_DRIVER: 'none' }).OCR_MAX_READS_PER_SHIFT)
      .toBe(DEFAULT_MAX_OCR_READS_PER_SHIFT)
  })

  it('ships a default that fits a real scrollable Recent Orders list', () => {
    const config = loadConfig({ ...process.env, OCR_DRIVER: 'none' })
    // 15 was measured against a bike's mandatory photos and did not allow for the pages a real
    // night produces. Anything at or below it reproduces the incident.
    expect(config.OCR_MAX_READS_PER_SHIFT).toBeGreaterThan(15)
  })
})
