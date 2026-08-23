import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repositorySource = readFileSync(new URL('../src/repos.ts', import.meta.url), 'utf8')

describe('ledger fund-prefix lookup', () => {
  it('treats percent and underscore as literal prefix characters', () => {
    expect(repositorySource).toContain('left(f.code, char_length($2)) = $2')
    expect(repositorySource).not.toMatch(/f\.code\s+LIKE\s+\$2/)
  })
})
