import type {
  DriverAccountProvisionInput,
  DriverAccountProvisioningRepo,
  RegistrationAttemptClaim,
} from '@ash/contracts'
import { bindPoolToTransaction, type Pool, withTransaction } from './pool.ts'
import { PgAuditRepo, PgSessionRepo, PgUserRepo } from './repos.ts'
import { PgDirectoryRepo } from './repos-shift.ts'

/** PostgreSQL owns both the cross-instance throttle and the all-or-nothing identity write. */
export class PgDriverAccountProvisioningRepo implements DriverAccountProvisioningRepo {
  private readonly pool: Pool
  constructor(pool: Pool) {
    this.pool = pool
  }

  async claimRegistrationAttempt(input: {
    addressHash: string
    attemptedAtMs: number
    limit: number
    windowMs: number
  }): Promise<RegistrationAttemptClaim> {
    return withTransaction(this.pool, {}, async (client) => {
      // One address is serialized across every API instance. A denied claim never inserts a row,
      // so repeatedly hitting 429 cannot push the rolling window farther into the future.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `driver-registration:${input.addressHash}`,
      ])
      await client.query(
        `DELETE FROM driver_registration_attempts
          WHERE attempted_at < to_timestamp($1::double precision / 1000) - interval '24 hours'`,
        [input.attemptedAtMs],
      )
      const { rows } = await client.query<{ attempts: string; oldest_ms: string | null }>(
        `SELECT count(*)::text AS attempts,
                (extract(epoch FROM min(attempted_at)) * 1000)::bigint::text AS oldest_ms
           FROM driver_registration_attempts
          WHERE address_sha256 = $1
            AND attempted_at > to_timestamp($2::double precision / 1000)
                                - ($3::bigint * interval '1 millisecond')`,
        [input.addressHash, input.attemptedAtMs, input.windowMs],
      )
      const row = rows[0]!
      if (Number(row.attempts) >= input.limit) {
        const oldestMs = Number(row.oldest_ms)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestMs + input.windowMs - input.attemptedAtMs) / 1000)),
        }
      }
      await client.query(
        `INSERT INTO driver_registration_attempts (address_sha256, attempted_at)
         VALUES ($1, to_timestamp($2::double precision / 1000))`,
        [input.addressHash, input.attemptedAtMs],
      )
      return { allowed: true }
    })
  }

  async provision(input: DriverAccountProvisionInput): Promise<void> {
    await withTransaction(
      this.pool,
      { actorId: input.audit.actorId, requestId: input.audit.requestId },
      async (client) => {
        const txPool = bindPoolToTransaction(this.pool, client, {
          actorId: input.audit.actorId,
          requestId: input.audit.requestId,
        })
        await new PgUserRepo(txPool).create(input.user)
        await new PgDirectoryRepo(txPool).createDriver(input.driver)
        if (input.session) await new PgSessionRepo(txPool).create(input.session)
        await new PgAuditRepo(txPool).append({
          tableName: 'driver_registrations',
          recordId: input.driver.id,
          action: 'INSERT',
          actorId: input.audit.actorId,
          actorKind: input.audit.actorKind,
          branchId: input.driver.branchId,
          requestId: input.audit.requestId,
          before: null,
          after: {
            userId: input.user.id,
            driverId: input.driver.id,
            branchId: input.driver.branchId,
            roleKey: 'driver',
            sessionCreated: input.session !== null,
          },
          occurredAtMs: input.audit.occurredAtMs,
        })
      },
    )
  }
}
