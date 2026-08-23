import { describe, expect, it } from 'vitest'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const optedIn = { ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS: '1' }

describe('disposable PostgreSQL test guard', () => {
  it('accepts an explicitly opted-in, allowlisted loopback database', () => {
    expect(assertDisposableDatabaseUrl(
      'postgresql://postgres@127.0.0.1:55435/ash_release_gate_20260823',
      optedIn,
    )).toEqual({ database: 'ash_release_gate_20260823', host: '127.0.0.1' })
  })

  it('refuses missing opt-in, production-like names, and remote hosts by default', () => {
    expect(() => assertDisposableDatabaseUrl(
      'postgresql://postgres@127.0.0.1/ash_test',
      {},
    )).toThrow(/ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS/)
    expect(() => assertDisposableDatabaseUrl(
      'postgresql://postgres@127.0.0.1/ash_delivery',
      optedIn,
    )).toThrow(/not disposable-test allowlisted/)
    expect(() => assertDisposableDatabaseUrl(
      'postgresql://postgres@production.example/ash_test',
      optedIn,
    )).toThrow(/remote hosts require/)
  })

  it('requires a second explicit opt-in for a named remote disposable database', () => {
    expect(assertDisposableDatabaseUrl(
      'postgresql://postgres@isolated.example/ash_conformance',
      { ...optedIn, ASH_ALLOW_REMOTE_DESTRUCTIVE_DATABASE_TESTS: '1' },
    )).toEqual({ database: 'ash_conformance', host: 'isolated.example' })
  })

  it('verifies the connected database and loopback server before destructive SQL', async () => {
    const query = async () => ({
      rows: [{ database: 'ash_test', serverAddress: '127.0.0.1/32' }],
    })
    await expect(assertDisposableDatabaseConnection(
      { query },
      { database: 'ash_test', host: '127.0.0.1' },
    )).resolves.toBeUndefined()

    await expect(assertDisposableDatabaseConnection(
      { query },
      { database: 'ash_conformance', host: '127.0.0.1' },
    )).rejects.toThrow(/identity does not match/)
  })
})
