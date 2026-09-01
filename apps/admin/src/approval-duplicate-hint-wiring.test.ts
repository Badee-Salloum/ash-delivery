import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./screens/Approval.tsx', import.meta.url), 'utf8')

/**
 * Comments describe what the code must NOT do, so a naive search finds the forbidden words in the
 * prose and proves the opposite of what it claims. Strip them before asserting on behaviour.
 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const code = stripComments(source)

/** The body of one top-level `function Name(` declaration, by brace matching. */
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

describe('the duplicate hint is wired into review, and only as a hint', () => {
  it('renders the badge and the explanation on both attention cards', () => {
    expect(code).toContain('copy.duplicateHintBadge')
    expect(code).toContain('copy.duplicateHintMatches')
    expect(code).toContain('copy.duplicateHintAdvisory')
    // One badge in the order card's badge row and one in the deduction card's.
    expect(code.split('copy.duplicateHintBadge').length - 1).toBe(2)
    expect(code.split('<DuplicateHintNote').length - 1).toBe(2)
  })

  it('feeds both cards from the server payload, never from a local guess', () => {
    expect(code).toContain('duplicateHints={duplicateHintsForOrder(review.duplicateHints, order.providerOrderNo)}')
    expect(code).toContain('duplicateHints={duplicateHintsForDeduction(review.duplicateHints, deduction.id)}')
  })

  it('never lets the hint itself change an operation', () => {
    // This is the whole safety property. Decision 11 requires an attributed manager decision, so
    // the hint may inform «تثبيت كتكرار» but must never post one. If this fails, an advisory signal
    // has quietly become an actor on a shift's money.
    const note = bodyOf('DuplicateHintNote')
    expect(note).not.toContain('onRevise')
    expect(note).not.toContain('revise(')
    expect(note).not.toContain('fetch(')
    expect(note).not.toContain('included')
    expect(note).not.toMatch(/<(Button|button)\b/)
  })

  it('keeps the copy bilingual, as every other string on this screen is', () => {
    for (const key of [
      'duplicateHintBadge',
      'duplicateHintMatches',
      'duplicateHintAmountOnly',
      'duplicateHintAdvisory',
    ]) {
      // Declared once in the copy interface, then defined once in English and once in Arabic.
      expect(code.split(`${key}:`).length - 1, key).toBe(3)
    }
    expect(code).toContain('يُحتمل أنه مكرّر')
    expect(code).toContain('Possible duplicate')
  })
})
