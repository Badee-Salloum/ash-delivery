import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, readTheme, resolveTheme } from '../src/theme.ts'

afterEach(() => vi.unstubAllGlobals())

function installAppearanceEnvironment(saved: string | null, dark: boolean) {
  const writes: Array<[string, string]> = []
  const documentAttributes: Array<[string, string]> = []
  const metaAttributes: Array<[string, string]> = []
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'ash.theme' ? saved : null),
    setItem: (key: string, value: string) => writes.push([key, value]),
  })
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: dark, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  vi.stubGlobal('document', {
    documentElement: { setAttribute: (key: string, value: string) => documentAttributes.push([key, value]) },
    querySelector: () => ({ setAttribute: (key: string, value: string) => metaAttributes.push([key, value]) }),
  })
  return { writes, documentAttributes, metaAttributes }
}

describe('driver experience consistency', () => {
  it('uses the same persisted appearance preference as admin and resolves automatic mode safely', () => {
    installAppearanceEnvironment('dark', false)
    expect(readTheme()).toBe('dark')
    expect(resolveTheme('system')).toBe('light')

    const environment = installAppearanceEnvironment('system', true)
    applyTheme('system')
    expect(environment.documentAttributes).toEqual([['data-theme', 'dark']])
    expect(environment.metaAttributes).toEqual([['content', '#0b1220']])
    expect(environment.writes).toEqual([['ash.theme', 'system']])
  })

  it('honours a dark operating system at first paint even when browser storage is unavailable', () => {
    const boot = readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8')
    const documentAttributes: Array<[string, string]> = []
    const metaAttributes: Array<[string, string]> = []
    runInNewContext(boot, {
      localStorage: { getItem: () => { throw new Error('storage disabled') } },
      window: { matchMedia: () => ({ matches: true }) },
      document: {
        documentElement: { setAttribute: (key: string, value: string) => documentAttributes.push([key, value]) },
        querySelector: () => ({ setAttribute: (key: string, value: string) => metaAttributes.push([key, value]) }),
      },
    })
    expect(documentAttributes).toEqual([['data-theme', 'dark']])
    expect(metaAttributes).toEqual([['content', '#0b1220']])
  })

  it('uses the central feedback provider instead of browser confirmation prompts', () => {
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../src/DriverApp.tsx', import.meta.url), 'utf8')
    const photos = readFileSync(new URL('../src/screens/PhotoSlot.tsx', import.meta.url), 'utf8')
    const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

    expect(main).toContain('<FeedbackProvider>')
    expect(app).not.toContain('window.confirm')
    expect(photos).not.toContain('window.confirm')
    expect(shell).toContain('/theme-boot.js')
    expect(shell).toContain("content: 'ASH Delivery'")
  })
})
