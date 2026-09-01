import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

/** Prose describes what the code must NOT do; a naive search finds the forbidden words in it. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const code = stripComments(source)

/**
 * The body of one top-level `function Name(...)`, by brace matching.
 *
 * From the RETURN TYPE, not from the first brace after the name — that one opens the destructured
 * parameter list, and matching it hands back the props instead of the code. Every `not.toContain`
 * below then passes against a slice that could never have contained what it forbids.
 */
const bodyOf = (name: string): string => {
  const start = code.indexOf(`function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const signature = code.indexOf('): ReactNode {', start)
  expect(signature, `${name} has no ReactNode signature`).toBeGreaterThan(-1)
  const open = code.indexOf('{', signature + '): ReactNode'.length)
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

describe('the side-by-side duplicate choice', () => {
  it('is offered on both kinds of row', () => {
    // A pair can cross kinds — decision 12 makes a negative row a cash deduction, and two reads of
    // one screen can disagree about the sign. Offering the choice on orders only would leave the
    // deduction side of such a pair with the old position-only note.
    expect(code.split('<DuplicateChoicePanel').length - 1).toBe(2)
    expect(code).toContain("duplicateChoiceFor(\n    { kind: 'order', providerOrderNo: order.providerOrderNo },")
    expect(code).toContain("duplicateChoiceFor(\n    { kind: 'cash_deduction', id: deduction.id },")
  })

  it('replaces the position-only note rather than stacking on top of it', () => {
    // Two amber boxes saying the same thing in different words is how a manager stops reading them.
    expect(code.split('{duplicateChoice ? null : <DuplicateHintNote').length - 1).toBe(2)
  })

  it('never decides for the manager', () => {
    const panel = bodyOf('DuplicateChoicePanel')
    // No pre-selected answer. `useState('')` and nothing else: a radio checked on arrival, beside a
    // save button, means one click excludes a real delivery the system merely suspected.
    expect(panel).toContain("useState('')")
    expect(panel).not.toMatch(/useState\(\s*view\.timedKey/)
    expect(panel).not.toMatch(/defaultChecked/)
    // The printed clock is surfaced as a note on the column, never as the selection itself.
    expect(bodyOf('DuplicateChoiceColumn')).toContain('copy.duplicateChoiceTimedNote')
    expect(panel).toContain('timed={view.timedKey === view.self.key}')
  })

  it('cannot post without an answer and an audited reason', () => {
    const panel = bodyOf('DuplicateChoicePanel')
    expect(panel).toContain("disabled={disabled || revision === null || reason.trim() === ''}")
  })

  it('states both outcomes on the button and that nothing is deleted', () => {
    // The owner rejected «استبعد هذا» / «استبعد المقابل»: «المقابل» has to be resolved by counting
    // columns, and both buttons name EXCLUSION while the manager is deciding which row is real.
    expect(code).toContain('duplicateChoiceSave')
    expect(code).toContain('duplicateChoiceReversible')
    expect(code).toContain('احفظ — يبقى المحدَّد ويُستبعد الآخر')
    expect(code).toContain('أيّ الصفّين هو التوصيلة الحقيقية؟')
  })

  it('keeps every string bilingual, as the rest of this screen is', () => {
    for (const key of [
      'duplicateChoiceTitle',
      'duplicateChoiceQuestion',
      'duplicateChoiceThisRow',
      'duplicateChoiceOtherRow',
      'duplicateChoiceSave',
      'duplicateChoiceReversible',
      'duplicateChoiceTimedNote',
      'duplicateChoiceNoClock',
      'duplicateChoiceIncludedNow',
      'duplicateChoiceExcludedNow',
      'duplicateChoiceAgree',
      'duplicateChoiceDiffer',
      'duplicateChoiceSettled',
      'duplicateChoicePage',
      'duplicateFactAmount',
      'duplicateFactMinute',
      'duplicateFactRoute',
      'duplicateFactDate',
      'duplicateFactInclusion',
    ]) {
      // Declared once in the copy interface, then defined once in English and once in Arabic.
      expect(code.split(`${key}:`).length - 1, key).toBe(3)
    }
  })

  it('builds both columns with the same component', () => {
    // «هذا الصفّ» and «المقابل» differ only in the words above them. Two implementations would
    // eventually diverge, and the manager would be comparing two things that are not comparable.
    expect(code.split('<DuplicateChoiceColumn').length - 1).toBe(2)
    expect(code).toContain('heading={copy.duplicateChoiceThisRow}')
    expect(code).toContain('heading={copy.duplicateChoiceOtherRow}')
  })
})
