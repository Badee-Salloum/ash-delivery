import pg from 'pg'
import { Pool as NeonPool, neonConfig, types as neonTypes } from '@neondatabase/serverless'

/**
 * The connection pool, and the single most important line of configuration in this package.
 *
 * ── int8 MUST BE PARSED AS BIGINT ────────────────────────────────────────────────────────
 * node-postgres returns `bigint` (OID 20) columns as JavaScript STRINGS by default, and several
 * popular drivers return them as Numbers — which silently loses precision above 2^53. Every
 * money column in this schema is BIGINT minor units, so getting this wrong corrupts money on the
 * way out of the database, where no application-level test would notice.
 *
 * We register an explicit parser to `BigInt` on BOTH driver registries. `assertBigIntParser()`
 * then proves at boot that it took effect, because a silently-reverted type parser is exactly the
 * kind of failure that shows up as a rounding complaint six months later.
 *
 * ── TWO DRIVERS, ONE INTERFACE ────────────────────────────────────────────────────────────
 * On a VPS with a directly-reachable Postgres, node-postgres (`pg`) over TCP is right. On Vercel
 * talking to Neon it is NOT: the serverless environment reaches Neon over the pooler, and `pg`'s
 * behaviour there breaks trigger-firing INSERTs (the audit triggers) while leaving SELECTs fine —
 * an INSERT 500s, a login succeeds. Neon's own serverless driver speaks the same wire protocol
 * over a WebSocket (port 443) and does not have that problem, so a Neon URL uses it. Both expose
 * the same `Pool`/`PoolClient` surface the repos are written against.
 */
const parseBigInt = (value: string): bigint => BigInt(value)
// numeric/decimal (OID 1700) must never appear on a money column — check-sql.mjs enforces that
// statically — but if one ever does, fail loudly rather than hand back a lossy float.
const refuseNumeric = (value: string): never => {
  throw new Error(
    `a numeric/decimal column reached the driver (value ${value}). Money is BIGINT minor units in this schema.`,
  )
}
pg.types.setTypeParser(20, parseBigInt)
pg.types.setTypeParser(1700, refuseNumeric)
neonTypes.setTypeParser(20, parseBigInt)
neonTypes.setTypeParser(1700, refuseNumeric)

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

interface TransactionBinding {
  client: pg.PoolClient
  actorId: string | null
  requestId: string | null
}

const TRANSACTION_BINDING = Symbol('ash.transactionBinding')
type BoundPool = pg.Pool & { [TRANSACTION_BINDING]?: TransactionBinding }

const transactionBinding = (pool: pg.Pool): TransactionBinding | null =>
  (pool as BoundPool)[TRANSACTION_BINDING] ?? null

/**
 * Present an already-open transaction as a Pool to existing repositories.
 *
 * Repositories in this package consistently use either `pool.query(...)` or `withTransaction(...)`.
 * The proxy routes the former to the owning client, while `withTransaction` recognizes the marker
 * below and joins the transaction instead of opening a nested BEGIN on another connection.
 */
export function bindPoolToTransaction(
  pool: pg.Pool,
  client: pg.PoolClient,
  ctx: { actorId?: string | null; requestId?: string | null } = {},
): pg.Pool {
  const existing = transactionBinding(pool)
  if (existing) {
    if (existing.client !== client) throw new Error('cannot rebind a transaction-bound pool to another client')
    return pool
  }

  const binding: TransactionBinding = {
    client,
    actorId: ctx.actorId ?? null,
    requestId: ctx.requestId ?? null,
  }
  return new Proxy(pool, {
    get(target, property) {
      if (property === TRANSACTION_BINDING) return binding
      if (property === 'query') return client.query.bind(client)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Neon connection strings carry `neon.tech` in the host; anything else is a plain Postgres. */
const isNeon = (connectionString: string): boolean => /[.@]neon\.tech\b/i.test(connectionString)

export function createPool(connectionString: string, max = 10, tuning: {
  connectionTimeoutMillis?: number; applicationName?: string
} = {}): pg.Pool {
  // Apply the same safeguards on Neon and TCP. An abandoned serverless invocation must not
  // retain shift/branch locks, nor let its waiters consume the entire pool for 180 seconds.
  const options = {
    connectionString,
    max,
    connectionTimeoutMillis: tuning.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: tuning.applicationName ?? 'ash-api',
  }
  const protectIdleConnections = (pool: pg.Pool): pg.Pool => {
    // pg-pool already evicts an errored idle client; consume its error event so a network
    // disconnect cannot become an uncaught exception that stops unrelated requests.
    pool.on('error', (error) => {
      console.warn('database_idle_connection_error', { code: (error as Error & { code?: string }).code ?? 'connection_error' })
    })
    return pool
  }
  if (isNeon(connectionString)) {
    // Node 22+/24 (Vercel's runtime) has a global WebSocket, which the serverless driver needs.
    neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor
    // Structurally a pg Pool for the repos' purposes; the cast keeps one Pool type across drivers.
    return protectIdleConnections(new NeonPool(options) as unknown as pg.Pool)
  }
  return protectIdleConnections(new pg.Pool(options))
}

/** Boot assertion: prove int8 really comes back as a bigint before a single row of money moves. */
export async function assertBigIntParser(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ big: unknown }>("SELECT 9007199254740993::bigint AS big")
  const value = rows[0]?.big
  if (typeof value !== 'bigint') {
    throw new Error(
      `int8 is being parsed as ${typeof value}, not bigint — money would silently lose precision. ` +
        'Check that @ash/db is imported before any other pg consumer.',
    )
  }
  if (value !== 9007199254740993n) {
    throw new Error(`int8 round-trip lost precision: got ${String(value)}`)
  }
}

/**
 * Run a function inside a transaction, with the actor published as a GUC so the audit trigger
 * can attribute the change. `SET LOCAL` scopes it to the transaction, so a pooled connection
 * never leaks one request's actor into the next.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  ctx: { actorId?: string | null; requestId?: string | null; readOnlySnapshot?: boolean },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const bound = transactionBinding(pool)
  if (bound) {
    if (ctx.actorId && bound.actorId && ctx.actorId !== bound.actorId) {
      throw new Error(`nested transaction actor ${ctx.actorId} differs from outer actor ${bound.actorId}`)
    }
    if (ctx.requestId && bound.requestId && ctx.requestId !== bound.requestId) {
      throw new Error(`nested transaction request ${ctx.requestId} differs from outer request ${bound.requestId}`)
    }
    return fn(bound.client)
  }

  const client = await pool.connect()
  let destroyConnection = false
  let connectionError: Error | null = null
  const onConnectionError = (error: Error): void => {
    connectionError ??= error
    destroyConnection = true
  }
  // A checked-out client has no pg-pool error listener. In particular a server-side idle
  // transaction timeout can arrive while the callback awaits non-query work.
  client.on('error', onConnectionError)
  try {
    await client.query(ctx.readOnlySnapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    // Neon/PgBouncer rejects timeout GUCs in startup options. SET LOCAL is supported and
    // confines the safeguards to this transaction without leaking settings across pool clients.
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '30s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'")
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', ctx.actorId ?? ''])
    await client.query('SELECT set_config($1, $2, true)', ['app.request_id', ctx.requestId ?? ''])
    const result = await fn(client)
    if (connectionError) throw connectionError
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { destroyConnection = true })
    throw err
  } finally {
    client.release(destroyConnection)
    client.removeListener('error', onConnectionError)
  }
}

/** Postgres error codes this codebase reacts to by name rather than by string matching. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  /** Raised by the week-lock guard in migration 0006. */
  READ_ONLY_TRANSACTION: '25006',
  INSUFFICIENT_PRIVILEGE: '42501',
} as const

export const isPgError = (err: unknown, code: string): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === code
