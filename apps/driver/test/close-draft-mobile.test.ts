import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
const grid = readFileSync(new URL('../src/screens/PageGrid.tsx', import.meta.url), 'utf8')
const ui = readFileSync(new URL('../src/ui.tsx', import.meta.url), 'utf8')
const appContext = readFileSync(new URL('../src/app-context.tsx', import.meta.url), 'utf8')

describe('320px RTL close screen guards', () => {
  it('uses a narrow-screen grid and clips no content into horizontal scrolling', () => {
    expect(grid).toContain('grid min-w-0 grid-cols-3 gap-2 sm:grid-cols-4')
    expect(ui).toContain('w-full min-w-0 max-w-md flex-col overflow-x-hidden')
    expect(ui).toContain('flex min-w-0 flex-1 flex-col')
    expect(ui).toContain('w-full min-w-0 max-w-md overflow-x-hidden')
    expect(appContext).toContain('document.documentElement.dir = dir(lang)')
  })

  it('keeps one compact save failure out of the missing-items list and gates submission', () => {
    expect(shift.match(/t\.shift\.draftSaveFailed/gu)).toHaveLength(1)
    expect(shift).toContain('flex min-w-0 flex-wrap items-center justify-between')
    expect(shift).not.toContain("...(!draftSaved ? [t.shift.savingDraft] : [])")
    expect(shift).toContain('missing.length === 0 && !odometerNeedsConfirmation && draftSaved')
    expect(shift).toContain('disabled={!ready || busy}')
  })
})
