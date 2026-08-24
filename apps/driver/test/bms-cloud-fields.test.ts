import { describe, expect, it } from 'vitest'
import { BMS_ALIASES, pickBmsField } from '../src/screens/BatteryPanel.tsx'

/**
 * Matching the cloud reader's BMS labels onto the two fields the app actually stores.
 *
 * WRITTEN FROM PRODUCTION DATA, not from imagination. Both `fields` objects below are copied
 * verbatim out of `ocr_reads` after the first live reads on 2026-08-13 — one English pack, one
 * Arabic — and they are here because the first version of this matcher returned nothing for either.
 *
 * It compared `label.toLowerCase().replace(/[^a-z]/g, '')` against the literal strings `percent`
 * and `cycles`. The model had faithfully transcribed the app's own labels: «Remain Battery» and
 * «Cycle Count» in English, «الطاقة المتبقية» and «الدورات» in Arabic. The English ones did not
 * match; the Arabic ones stripped to the EMPTY STRING and could not have. Two reads, ten seconds
 * of a driver's time and 3.3¢, to fill zero fields — and nothing anywhere said so.
 */

/** Verbatim from ocr_reads, 13:25:36 Damascus. An English BMS app, 20 cells. */
const ENGLISH_PACK: Record<string, string | null> = {
  TIME: '16D12H26M48S',
  Charge: 'ON',
  Balance: 'OFF',
  Current: '0.00A',
  'Cell Type': 'Lion',
  Discharge: 'ON',
  'MOS Temp.': '33.9°C',
  'Battery T2': '32.5°C',
  'Cycle Count': '8',
  'Battery Power': '0.0W',
  'Cycle Capacity': '436.8Ah',
  'Remain Battery': '100%',
  'Battery Voltage': '83.37V',
  'Remain Capacity': '50.0Ah',
  'Battery Capacity': '50.0Ah',
}

/** Verbatim from ocr_reads, 13:25:43 Damascus. The same app in Arabic. */
const ARABIC_PACK: Record<string, string | null> = {
  T1: '33.7°C',
  T2: '33.6°C',
  MOS: '36.9°C',
  التيار: '0A',
  الطاقة: '0.00W',
  'MOS تفريغ': 'مفتوح',
  الدورات: '1',
  'موسفت الشحن': 'مفتوح',
  'إجمالي الجهد': '81.48V',
  'حالة البطارية': 'تشغيل طبيعي',
  'الطاقة المتبقية': '100%',
}

/** The black/green circular-gauge app used by the fleet's 50Ah packs. */
const GAUGE_50_PACK: Record<string, string | null> = {
  percent: '40%',
  voltage: '71.72V',
  'Bal.-Curr.(A)': '0.659',
  'Volt.-Diff(V)': '0.008',
  'Low Cell(V)': '3.582',
  'High Cell(V)': '3.590',
  'Cell Type': 'NCM/NCA',
  '(℃)High Temp.': '46.4',
  '(Ah)Rem. Cap.': '19.8',
  '(Ah)Capacity': '50.0',
  'Power (W)': '0.0',
  'Current (A)': '0.00',
  Status: 'Idle',
}

describe('the BMS labels production actually returned', () => {
  it('reads the charge and cycles off the ENGLISH pack', () => {
    expect(pickBmsField(ENGLISH_PACK, 'percent')).toBe('100%')
    expect(pickBmsField(ENGLISH_PACK, 'cycleCount')).toBe('8')
  })

  it('reads the charge and cycles off the ARABIC pack', () => {
    // «الطاقة المتبقية» and «الدورات». The bug this replaces stripped both to '' and matched nothing.
    expect(pickBmsField(ARABIC_PACK, 'percent')).toBe('100%')
    expect(pickBmsField(ARABIC_PACK, 'cycleCount')).toBe('1')
  })

  it('reads the pinned keys the prompt now demands', () => {
    // The prompt tells the model to answer with exactly these. The aliases above are the fallback
    // for when it answers in the app's own words anyway — which is what it did the first time.
    expect(pickBmsField({ percent: '87', cycles: '412' }, 'percent')).toBe('87')
    expect(pickBmsField({ percent: '87', cycles: '412' }, 'cycleCount')).toBe('412')
  })

  it('reads the large central charge from the black/green 50Ah gauge', () => {
    expect(pickBmsField(GAUGE_50_PACK, 'percent')).toBe('40%')
    expect(pickBmsField(GAUGE_50_PACK, 'cycleCount')).toBeNull()
  })

  it('accepts safe names for an unlabelled state-of-charge gauge', () => {
    expect(pickBmsField({ 'State of Charge': '40%' }, 'percent')).toBe('40%')
    expect(pickBmsField({ 'Remaining Charge': '40%' }, 'percent')).toBe('40%')
  })

  it('NEVER reads a capacity in Ah as a percentage', () => {
    // «Remain Capacity 50.0Ah» cleans to a perfectly plausible «50». On the English pack above the
    // real charge is 100% — so this mistake reports a full battery as half empty, and the start
    // gate would let a driver leave on it.
    expect(pickBmsField(ENGLISH_PACK, 'percent')).not.toBe('50.0Ah')
    expect(BMS_ALIASES.percent).not.toContain('remaincapacity')
    expect(BMS_ALIASES.percent).not.toContain('batterycapacity')
    expect(BMS_ALIASES.percent).not.toContain('cyclecapacity')
  })

  it('does not confuse «الطاقة» (power, in watts) with «الطاقة المتبقية» (remaining charge)', () => {
    // The Arabic pack prints both. One is 0.00W and one is 100%; they share a word.
    expect(pickBmsField(ARABIC_PACK, 'percent')).toBe('100%')
    expect(pickBmsField({ الطاقة: '0.00W' }, 'percent')).toBeNull()
  })

  it('returns null rather than guessing when the field is simply absent', () => {
    // A refusal the driver types is safe. A guess is not.
    expect(pickBmsField({ Current: '0.00A', 'MOS Temp.': '33.9°C' }, 'percent')).toBeNull()
    expect(pickBmsField({}, 'cycleCount')).toBeNull()
  })

  it('ignores a null value even under a matching label', () => {
    expect(pickBmsField({ 'Remain Battery': null }, 'percent')).toBeNull()
  })

  it('matches regardless of case, spacing and punctuation', () => {
    expect(pickBmsField({ 'REMAIN  BATTERY:': '64%' }, 'percent')).toBe('64%')
    expect(pickBmsField({ 'cycle-count': '9' }, 'cycleCount')).toBe('9')
  })
})
