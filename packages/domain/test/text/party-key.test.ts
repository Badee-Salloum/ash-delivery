import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normalizePartyName } from '../../src/text/party-key.ts'

/**
 * The grouping key for «السلفة»'s free-text party.
 *
 * Worth stating at the top of its own suite: NO MONEY DEPENDS ON THIS. Every advance carries its
 * own ledger fund keyed by the advance's uuid, and a repayment names the advance, never the party.
 * So the worst a wrong fold can do is group a list oddly or miss an autocomplete suggestion. These
 * tests exist so the list behaves the way the manager expects — not because a figure rests on them.
 */
describe('folding two spellings of one name', () => {
  it.each([
    ['أبو محمد', 'ابو  محمد', 'hamza dropped and the space doubled'],
    ['حَيْدَر', 'حيدر', 'harakat, which nobody types the same way twice'],
    ['شركـــة', 'شركة', 'tatweel, pure decoration'],
    ['ورشه النور', 'ورشة النور', 'the ة / ه ending'],
    ['مصطفى', 'مصطفي', 'the ى / ي ending'],
    ['  Yallago  ', 'yallago', 'Latin case and padding'],
    ['محل ٣٤', 'محل 34', 'Arabic-Indic digits'],
    ['‏أحمد‎', 'احمد', 'bidi marks that ride along in pasted Arabic'],
  ])('«%s» and «%s» are one party — %s', (a, b) => {
    expect(normalizePartyName(a)).toBe(normalizePartyName(b))
  })

  it('keeps genuinely different people apart', () => {
    // The fold must not be so eager that it merges two real counterparties. «الورشة» and «ورشة»
    // are different words to a reader, so the definite article is deliberately not stripped.
    const distinct = ['ابو محمد', 'ابو محمود', 'ورشة النور', 'الورشة', 'حيدر', 'حيدره']
    expect(new Set(distinct.map(normalizePartyName)).size).toBe(distinct.length)
  })

  it('never welds two words together when it removes a mark', () => {
    // Collapsing whitespace LAST is what makes this true: strip the marks first and «أحمد ‏ علي»
    // would come out as a single name.
    expect(normalizePartyName('أحمد ‏ علي')).toBe('احمد علي')
  })

  it('is idempotent — normalising a key again returns the same key', () => {
    // The property that lets the column be written once and compared for ever.
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizePartyName(normalizePartyName(s))).toBe(normalizePartyName(s))
      }),
    )
  })

  it('is pure: same input, same answer, every time', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizePartyName(s)).toBe(normalizePartyName(s))
      }),
    )
  })
})
