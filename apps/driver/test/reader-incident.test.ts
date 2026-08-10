import { describe, expect, it } from 'vitest'
import { type OcrLine, cancelledCardsIn, glyphListFee, isBadgeToken, isCancelLine, routesFor } from '../src/ocr.ts'

/**
 * The Aug-4 live test, encoded.
 *
 * A driver scanned «الطلبات الحديثة» and the app: accepted «1105» for a ٢٣٥ SYP fare, dropped the
 * ٥:٤٢ order without a word, showed «Crispy Way» — the English tail of the PICKUP's own name — as
 * the destination, and rendered «المدخل الاول» as «!المد». A cancelled card and a GPS-pair
 * destination were on the same screen, neither of which the reader had ever been shown.
 *
 * Everything here is one of those four failures, written so it fails again if the fix goes away.
 */

const line = (text: string, y0: number, words?: string[]): OcrLine => ({
  text,
  y0,
  y1: y0 + 20,
  words: (words ?? text.split(' ')).map((w, i) => ({ text: w, x0: i * 40, x1: i * 40 + 35, y0, y1: y0 + 20 })),
})
const anchor = (y0: number) => ({ x0: 10, x1: 60, y0, y1: y0 + 20 })

describe('a glyph-read fee must LOOK like a fee before it is offered as money', () => {
  it('takes a plain amount', () => {
    expect(glyphListFee('235')).toBe('235')
  })

  it('refuses a leading zero — the clearest signature of a guessed glyph', () => {
    // «−٥٢ read as −07» is in the record. No Yallago screen has ever shown «07 SYP».
    expect(glyphListFee('07')).toBeNull()
  })

  it('refuses a signed value — an order fee is never negative, that is the wallet log', () => {
    expect(glyphListFee('-235')).toBeNull()
    expect(glyphListFee('+235')).toBeNull()
  })

  it('refuses anything that is not digits and separators', () => {
    expect(glyphListFee('2:5')).toBeNull()
    expect(glyphListFee('م35')).toBeNull()
  })

  it('passes a refusal through as a refusal', () => {
    expect(glyphListFee(null)).toBeNull()
  })

  it('keeps a four-figure fare — there is deliberately no length cap', () => {
    // A rule like "a fee has three digits" refuses a real fare the day prices rise.
    expect(glyphListFee('1105')).toBe('1105')
  })
})

describe("point A's own name, wrapped, is not a destination", () => {
  it('THE CRISPY CASE: a lone English tail continuing an English word belongs to A', () => {
    const routes = routesFor(
      [line('القصور, ساحة القصور', 130), line('القصور Crispy', 160), line('Way', 190)],
      [anchor(100)],
    )
    expect(routes[0]!.pointB).toBeNull()
    expect(routes[0]!.pointA).toContain('Crispy')
    expect(routes[0]!.pointA).toContain('Way')
  })

  it('keeps an English destination under an ARABIC pickup — «Baghdad Avenue» is a real place', () => {
    const routes = routesFor(
      [line('سناك الرواد, الروضة', 130), line('الأمير عز الدين', 160), line('Baghdad Avenue', 190)],
      [anchor(100)],
    )
    expect(routes[0]!.pointB).toBe('Baghdad Avenue')
  })

  it('keeps a GPS pair as the destination — it carries digits, so it is not a wrapped word', () => {
    const routes = routesFor(
      [line('مأكولات الشام شارع بغداد', 130), line('موقف السادات', 160), line('(36.2969 33.5157)', 190)],
      [anchor(100)],
    )
    expect(routes[0]!.pointB).toContain('36.2969')
  })

  it('keeps the last line on an all-Latin card — nothing there says a word wrapped', () => {
    const routes = routesFor([line('Chicken World Mazzeh', 130), line('Hamra', 160)], [anchor(100)])
    expect(routes[0]!.pointB).toBe('Hamra')
  })
})

describe('the badge stripper must not eat English place words', () => {
  it('still strips every rendering of the circled badge', () => {
    for (const badge of ['A', 'B', '©', '(P', '[A]', 'EP', 'CA']) {
      expect(isBadgeToken(badge), badge).toBe(true)
    }
  })

  it('leaves two-letter words that are part of an address', () => {
    // «Al Jalaa» lost its «Al» and became «Jalaa» — a different place on a map.
    for (const word of ['Al', 'St', 'El']) {
      expect(isBadgeToken(word), word).toBe(false)
    }
  })

  it('keeps «Al» inside the label it belongs to', () => {
    const routes = routesFor([line('عالم الدجاج المزة', 130), line('Al Jalaa', 160)], [anchor(100)])
    expect(routes[0]!.pointB).toBe('Al Jalaa')
  })
})

describe('bidi debris on a place line', () => {
  it('strips the leading «!» the RTL run leaves behind — «!المد» was «المدخل»', () => {
    const routes = routesFor([line('القصور ساحة القصور', 130), line('!المدخل الاول', 160)], [anchor(100)])
    expect(routes[0]!.pointB).toBe('المدخل الاول')
  })

  it('leaves interior punctuation alone — «القصور, ساحة» is one address', () => {
    const routes = routesFor([line('القصور, ساحة القصور', 130), line('المدخل', 160)], [anchor(100)])
    expect(routes[0]!.pointA).toBe('القصور, ساحة القصور')
  })
})

describe('the cancelled card is carved, not stepped over', () => {
  it('recognises the chip in the forms the recogniser produces', () => {
    for (const text of ['تم إلغاؤه', 'ملغاة', 'إلغاء', 'Cancelled']) {
      expect(isCancelLine(text), text).toBe(true)
    }
    expect(isCancelLine('مأكولات الشام')).toBe(false)
  })

  it('returns the cancelled card with its own route', () => {
    const lines = [
      line('عالم الدجاج', 130),
      line('جادة عارف الشهابي', 160),
      line('تم إلغاؤه', 190),
      line('المدخل ساحة الهدى', 220),
      line('كراج البولمان القابون', 250),
    ]
    const cards = cancelledCardsIn(lines, [anchor(100)])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.pointA).toBe('المدخل ساحة الهدى')
    expect(cards[0]!.pointB).toBe('كراج البولمان القابون')
  })

  it('leaves the order ABOVE it untouched — its addresses stay its own', () => {
    const lines = [
      line('عالم الدجاج', 130),
      line('جادة عارف الشهابي', 160),
      line('تم إلغاؤه', 190),
      line('المدخل ساحة الهدى', 220),
    ]
    const routes = routesFor(lines, [anchor(100)])
    expect(routes[0]!.pointA).toBe('عالم الدجاج')
    expect(routes[0]!.pointB).toBe('جادة عارف الشهابي')
  })

  it('stops at the next priced order rather than swallowing it', () => {
    const lines = [
      line('تم إلغاؤه', 100),
      line('المدخل ساحة الهدى', 130),
      line('كراج البولمان', 160),
      line('صيدلية سلمى', 320),
    ]
    const cards = cancelledCardsIn(lines, [anchor(290)])
    expect(cards).toHaveLength(1)
    expect(`${cards[0]!.pointA} ${cards[0]!.pointB}`).not.toContain('صيدلية')
  })

  it('reports nothing when the chip has no addresses under it', () => {
    expect(cancelledCardsIn([line('تم إلغاؤه', 100)], [])).toHaveLength(0)
  })
})
