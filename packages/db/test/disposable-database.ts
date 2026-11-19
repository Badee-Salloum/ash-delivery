import type { Pool } from '../src/pool.ts'

/** Test-only schema scope; pooler backend sessions must never retain a deleted fixture path. */
export function withTestSearchPath(pool: Pool, schema: string): Pool {
  if (!/^(?:public|ash_[a-z0-9_]+)$/.test(schema)) throw new Error('invalid test schema')
  let scoped: Pool
  scoped = new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect()
      try { await client.query(`SET search_path TO "${schema}"`) }
      catch (error) { client.release(true); throw error }
      return new Proxy(client, { get(connection, property) {
        if (property === 'query') return async (sql: string, params: unknown[] = []) => {
          const result = await connection.query(sql, params)
          // A transaction pooler may assign a different backend at BEGIN. Reassert the schema
          // inside the transaction so evidence/ledger fixtures cannot depend on a session GUC.
          if (/^BEGIN(?:\s|$)/i.test(sql)) await connection.query(`SET LOCAL search_path TO "${schema}"`)
          return result
        }
        if (property === 'release') return (destroy?: boolean) => {
          if (destroy) { connection.release(true); return }
          let broken = false
          const onError = (): void => { broken = true }
          connection.on('error', onError)
          void connection.query('RESET search_path').then(
            () => connection.release(broken), () => connection.release(true),
          ).finally(() => connection.removeListener('error', onError))
        }
        const value = Reflect.get(connection, property, connection)
        return typeof value === 'function' ? value.bind(connection) : value
      } })
    }
    if (key === 'query') return async (sql: string, params: unknown[] = []) => {
      const client = await scoped.connect()
      try { return await client.query(sql, params) } finally { client.release() }
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return scoped
}

const ALLOWED_DATABASE = /^ash_(?:test|conformance|release_gate|guardcheck|integritycheck)(?:_[a-z0-9_]+)?$/i
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Fail closed before any integration test can migrate, truncate, or otherwise mutate PostgreSQL.
 * A disposable-looking name is not enough on its own: destructive tests require an explicit opt-in
 * and stay on loopback unless a second, deliberately loud remote-test opt-in is supplied.
 */
export function assertDisposableDatabaseUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { database: string; host: string } {
  if (env.ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS !== '1') {
    throw new Error('refusing database tests: set ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS=1 for a disposable database')
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('refusing database tests: DATABASE_URL is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('refusing database tests: DATABASE_URL must use postgres:// or postgresql://')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!ALLOWED_DATABASE.test(database)) {
    throw new Error(`refusing database tests: database name ${JSON.stringify(database)} is not disposable-test allowlisted`)
  }
  // DDL/migration advisory locks and per-schema fixtures require a pinned backend session.
  // Transaction-pooler endpoints can retain/reassign session search_path between statements.
  if (/-pooler\./i.test(url.hostname)) {
    throw new Error('refusing database tests: use the direct disposable endpoint, not the transaction pooler')
  }
  if (!LOCAL_HOSTS.has(url.hostname) && env.ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS !== '1') {
    throw new Error('refusing database tests: remote hosts require ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS=1')
  }
  return { database, host: url.hostname }
}

export async function assertDisposableDatabaseConnection(
  database: { query(sql: string): Promise<{ rows: unknown[] }> },
  expected: { database: string; host: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { rows } = await database.query(
    `SELECT current_database() AS database,
            inet_server_addr()::text AS "serverAddress"`,
  )
  const actual = rows[0] as { database: string; serverAddress: string | null } | undefined
  if (!actual || actual.database !== expected.database) {
    throw new Error('refusing database tests: connected database identity does not match DATABASE_URL')
  }
  if (
    LOCAL_HOSTS.has(expected.host) &&
    actual.serverAddress !== null &&
    actual.serverAddress !== '::1/128' &&
    !actual.serverAddress.startsWith('127.') &&
    env.ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS !== '1'
  ) {
    throw new Error('refusing database tests: loopback URL resolved to a non-loopback PostgreSQL server')
  }
}
