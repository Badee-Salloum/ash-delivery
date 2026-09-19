import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('admin theme boot', () => {
  it('uses the OS dark preference even when localStorage cannot be read', () => {
    const source = readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8')
    const attributes: Array<[string, string]> = []
    runInNewContext(source, {
      localStorage: { getItem: () => { throw new Error('storage disabled') } },
      window: { matchMedia: () => ({ matches: true }) },
      document: {
        documentElement: { setAttribute: (key: string, value: string) => attributes.push([key, value]) },
      },
    })
    expect(attributes).toEqual([['data-theme', 'dark']])
  })
})
