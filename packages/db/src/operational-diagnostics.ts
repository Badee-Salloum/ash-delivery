import { randomUUID } from 'node:crypto'
import { createPool } from './pool.ts'

interface Bucket {
  minute: string; route: string; method: string; status: number; cause: string;
  count: number; durationMs: number; maxDurationMs: number; slowCount: number
}

/** A separate, one-connection, short-budget diagnostic lane; never joins a financial transaction. */
export function createOperationalDiagnosticsStore(connectionString: string): {
  write(buckets: readonly Bucket[]): Promise<void>
  dispose(): Promise<void>
} {
  const pool = createPool(connectionString, 1, { connectionTimeoutMillis: 1_000, applicationName: 'ash-diagnostics' })
  let nextPrune = 0
  return {
    async write(buckets) {
      if (buckets.length === 0) return
      const client = await pool.connect()
      let broken = false
      const onError = (): void => { broken = true }
      client.on('error', onError)
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout = '100ms'")
        await client.query("SET LOCAL statement_timeout = '1s'")
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '2s'")
        // Immutable batches avoid hot-row increments. The caller never replays an uncertain
        // commit; a diagnostic gap is reported rather than silently counting requests twice.
        await client.query(
          `INSERT INTO operational_request_batches (id, recorded_at, buckets)
           VALUES ($1, now(), $2::jsonb) ON CONFLICT (id) DO NOTHING`,
          [randomUUID(), JSON.stringify(buckets)],
        )
        if (Date.now() >= nextPrune) {
          await client.query(`DELETE FROM operational_request_batches WHERE id IN (
            SELECT id FROM operational_request_batches WHERE recorded_at < now() - interval '30 days'
            ORDER BY recorded_at LIMIT 500)`)
          nextPrune = Date.now() + 3_600_000
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => { broken = true })
        throw error
      } finally {
        client.release(broken)
        client.removeListener('error', onError)
      }
    },
    dispose: () => pool.end(),
  }
}
