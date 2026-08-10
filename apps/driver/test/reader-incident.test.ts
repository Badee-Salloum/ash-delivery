import { describe, expect, it } from 'vitest'
import { type OcrLine, cancelledCardsIn, glyphListFee, isBadgeToken, isCancelLine, isCoordinateLine, routesFor, truncatedCards } from '../src/ocr.ts'

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

/**
 * The SECOND live run, on the same three screenshots — after the fees were already correct.
 *
 * What it found: the last card of a page is sliced by the bottom of the phone's screen, and a
 * sliced line is read as something confident and wrong («جامع الحمود Al Beirouni Street» →
 * «Al Dajeniin; Ctraat innttc.|. نكم», «إنكليزي» → «انكلنء»). Its FEE and CLOCK are fine — those sit
 * on the fully-drawn price row — which is exactly why the card had to be withheld rather than
 * trusted: everything about it looks healthy except the part that is a guess.
 *
 * Worth recording: the A/B pair was NOT inverted, though the PDF of that run appears to show it.
 * That was bidi text extraction reversing the segments of a line whose point A is pure Latin — the
 * same artifact turns «Baghdad Avenue» into «Avenue Baghdad» on a card that read perfectly. The
 * reader was right; the report was not. No fix was made for a bug that did not exist.
 */
describe('a card the screen sliced in half', () => {
  const tall = 1280

  it('is detected when its last line runs into the bottom edge', () => {
    const lines = [line('Abou Roummaneh', 1210), line('Al Dajeniin; Ctraat innttc.|.', 1260)]
    expect(truncatedCards(lines, [{ y0: 1174, y1: 1193 }], tall)).toEqual([true])
  })

  it('is detected when its last line is too short to be whole', () => {
    // Half a line of text is half as tall as the row's own «SYP» cap height.
    const half: OcrLine = { text: 'جامع الحمود', y0: 1100, y1: 1108, words: [{ text: 'جامع الحمود', x0: 0, x1: 80, y0: 1100, y1: 1108 }] }
    expect(truncatedCards([line('Abou Roummaneh', 1060), half], [{ y0: 1020, y1: 1040 }], tall)).toEqual([true])
  })

  it('leaves a whole card alone', () => {
    const lines = [line('مأكولات الشام شارع بغداد', 130), line('الحارة الجديدة', 160)]
    expect(truncatedCards(lines, [{ y0: 100, y1: 118 }], tall)).toEqual([false])
  })
})

describe('a dropoff the reader will not vouch for is not printed', () => {
  it('names a dropped pin instead of the debris its digits become', () => {
    // Arabic-Indic coordinates: Tesseract returns «(YLYATAAVO-AV ¥Y,cloWvo--¥)» for «(٣٦٫٢٩…)».
    expect(isCoordinateLine('(YLYATAAVO-AV ¥Y,cloWvo--¥)')).toBe(true)
  })

  it('keeps coordinates the ENGLISH build prints in readable digits', () => {
    // Same screen, Latin digits, read correctly — replacing this with «map location» would be
    // throwing away a good read.
    expect(isCoordinateLine('(33.518726, 36.276112)')).toBe(false)
  })

  it('never mistakes a real address for a pin', () => {
    expect(isCoordinateLine('المدخل جامع الرحمن')).toBe(false)
    expect(isCoordinateLine('Baghdad Avenue')).toBe(false)
    expect(isCoordinateLine('G6HF RVH')).toBe(false)
  })

  it('refuses a dropoff that is nothing but a lower-case Latin scrap', () => {
    // «إنكليزي» came back as «ssl». Alone on its line there is no Arabic beside it to mark it as
    // debris, so it would have been printed as the destination.
    const routes = routesFor([line('مطعم الربيع, الزهراء', 130), line('ssl', 160)], [anchor(100)])
    expect(routes[0]!.pointB).toBeNull()
  })
})

describe('Latin scraps invented out of Arabic strokes', () => {
  it('drops a lower-case scrap sitting inside an Arabic address', () => {
    // «عالم» came back as «alle», «جابر» as «ve» — printed, they read as corruption.
    const routes = routesFor([line('alle الدجاج, اوتستراد المزة', 130), line('جادة عارف الشهابي', 160)], [anchor(100)])
    expect(routes[0]!.pointA).not.toContain('alle')
    expect(routes[0]!.pointA).toContain('الدجاج')
  })

  it('keeps a CAPITALISED Latin name on the same line — that is a real name', () => {
    const routes = routesFor([line('Chicken World الدجاج, اوتستراد المزة', 130), line('جادة عارف', 160)], [anchor(100)])
    expect(routes[0]!.pointA).toContain('Chicken World')
  })

  it('keeps every token on a card with no Arabic at all', () => {
    const routes = routesFor([line('Abou Roummaneh', 130), line('Al Beirouni Street', 160)], [anchor(100)])
    expect(routes[0]!.pointB).toBe('Al Beirouni Street')
  })
})
