import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const guards = readFileSync(new URL('../verify-guards.sql', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../../../scripts/db-verify.sh', import.meta.url), 'utf8')

describe('database guard verification harness', () => {
  it('rolls back the append-only fixture so verification is safe to run twice', () => {
    const guardThree = guards.slice(
      guards.indexOf('GUARD 3:'),
      guards.indexOf('GUARD 4:'),
    )

    expect(guardThree).toContain('SET LOCAL ROLE app_user;')
    expect(guardThree).toContain('ROLLBACK;')
    expect(guardThree).not.toContain('COMMIT;')
  })

  it('accepts the negative run only when the deliberately removed guard is reached', () => {
    expect(runner).toContain("grep -Fq 'GUARD FAILED: a locked-week LINE amount was updated'")
    expect(runner).toContain('verification failed before it exercised the deliberately removed guard')
  })

  it('requires an explicit disposable database and quotes its identifier', () => {
    expect(runner).toContain('ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS')
    expect(runner).toContain('VERIFY_DB is not disposable-test allowlisted')
    expect(runner).toContain(`-v db_name="$VERIFY_DB"`)
    expect(runner).not.toContain('DROP DATABASE IF EXISTS ${VERIFY_DB}')
  })
})
