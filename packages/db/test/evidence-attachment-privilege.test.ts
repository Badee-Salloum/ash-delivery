import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { bindPoolToTransaction, createPool, withTransaction } from '../src/pool.ts'
import { PgMediaRepo } from '../src/repos-shift.ts'

/**
 * The evidence attachment path, exercised at the privilege level the API actually runs with.
 *
 * On 2026-08-17 a `{ lock: true }` option put `FOR UPDATE` on the read of
 * `shift_media_attachment_history`. That table is append-only on purpose — `0028` REVOKEs UPDATE
 * from `app_user` — and Postgres requires UPDATE for `SELECT ... FOR UPDATE`. Production logs in as
 * `ash_runtime`, which inherits `app_user`, so the statement was `42501 permission denied`. It sits
 * between the media write and the attach, so every upload stored a blob and a `media` row and then
 * 500ed before creating `shift_media`. Every driver in the fleet was blocked for three days, and
 * the only thing anyone could see was «فشل الرفع».
 *
 * The suite could not catch it because DB tests connect as the OWNER, who holds every privilege.
 * That is the actual lesson here, and it is why this file sets the role explicitly: a privilege bug
 * is invisible to a test running as a superuser.
 */
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('evidence attachment privileges', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('evidence attachment privileges', () => {
    it('lets app_user read the attachment history but never lock it', async () => {
      await migrate(pool)
      const { rows } = await pool.query<{ s: boolean; u: boolean }>(
        `SELECT has_table_privilege('app_user', 'shift_media_attachment_history', 'SELECT') AS s,
                has_table_privilege('app_user', 'shift_media_attachment_history', 'UPDATE') AS u`,
      )
      expect(rows[0]?.s).toBe(true)
      // If this ever reads true, someone answered a lock error by GRANTing UPDATE and threw away
      // 0028's append-only audit guarantee. Drop the lock instead — the media row is the serializer.
      expect(rows[0]?.u).toBe(false)
    })

    it('reads the prior attachment as app_user without demanding a lock it cannot hold', async () => {
      await migrate(pool)
      const rollback = new Error('rollback: this test writes nothing')
      await expect(
        withTransaction(pool, { actorId: null }, async (client) => {
          await client.query('SET LOCAL ROLE app_user')
          const media = new PgMediaRepo(bindPoolToTransaction(pool, client))
          // The row need not exist: the privilege is checked on the statement, not on the result.
          await media.latestAttachmentForMedia(randomUUID(), { lock: true })
          throw rollback
        }),
      ).rejects.toBe(rollback)
    })
  })
}
