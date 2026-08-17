import { describe, expect, it } from 'vitest'
import type { Pool } from '../src/pool.ts'
import { PgDirectoryRepo } from '../src/repos-shift.ts'

describe('PostgreSQL driver directory mapping', () => {
  it('returns the linked user identity required by close-draft materialization', async () => {
    const pool = {
      query: async () => ({
        rows: [{
          id: 'driver-1',
          branch_id: 'branch-1',
          code: 'DRV-1',
          full_name_ar: 'سائق',
          active: true,
          user_id: 'user-1',
          full_name_en: null,
          phone: null,
          hired_on: null,
          national_id_enc: null,
        }],
      }),
    } as unknown as Pool

    await expect(new PgDirectoryRepo(pool).driver('driver-1')).resolves.toMatchObject({
      id: 'driver-1',
      userId: 'user-1',
    })
  })
})
