import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CloseDraftData, CloseDraftRepo } from '@ash/contracts'
import { createPool, type Pool } from '../src/pool.ts'
import { PgCloseDraftRepo } from '../src/repos-close-draft.ts'
import { PgShiftCloseUnitOfWork } from '../src/repos-close.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl, withTestSearchPath } from './disposable-database.ts'

// Deliberately NOT DATABASE_URL. No migrations/truncation of public tables; all fixtures live in
// one newly-created schema on an explicitly opted-in disposable database, never neondb/production.
const url = process.env.ASH_OCR_LOCKS_TEST_DATABASE_URL
const schema = `ash_ocr_lock_${randomUUID().replaceAll('-', '')}`
const SHIFT = randomUUID(), BRANCH = randomUUID(), DRIVER = randomUUID(), MEDIA = randomUUID(), TOKEN = randomUUID()
let pool: Pool, scoped: Pool
const empty = (): CloseDraftData => ({
  figures: { odometerKm: null, odometerKmOcr: null, odometerAnomalyConfirmed: false,
    batteryPercent: null, cashDeclared: null, walletDeclared: null, walletDeclaredOcr: null },
  operations: { orders: [], cashDeductions: [], movements: [] }, reads: {}, evidence: {},
})
function input(count: number): Parameters<CloseDraftRepo['saveRead']>[0] {
  return { shiftId: SHIFT, expectedRevision: 0, mediaId: MEDIA, attachmentToken: TOKEN, slot: 'dashboard',
    read: { readId: randomUUID(), status: 'complete', field: 'orders', failure: null, attempts: 1 },
    data: empty(), draftHash: 'b'.repeat(64), updatedAtMs: Date.now(), updatedBy: randomUUID(),
    observations: Array.from({ length: count }, (_, rowIndex) => ({ id: randomUUID(), rowIndex, rowCount: count,
      dateSection: '2026-10-17', yTop: rowIndex / count, yBottom: (rowIndex + 1) / count,
      row: { printed: '12.50', value: '12.50', cancelled: false, time: '08:00', dateIso: '2026-10-17',
        pointA: null, pointB: null } })),
  }
}

describe.skipIf(!url)('OCR persistence and lock scope on disposable PostgreSQL', () => {
  beforeAll(async () => {
    const identity = assertDisposableDatabaseUrl(url!)
    pool = withTestSearchPath(createPool(url!, 4), 'public')
    await assertDisposableDatabaseConnection(pool, identity)
    if (!/^ash_ocr_lock_[a-f0-9]{32}$/.test(schema)) throw Error('Invalid fixture schema')
    await pool.query(`CREATE SCHEMA "${schema}"`)
    scoped = withTestSearchPath(pool, schema)
    // Representative repository schema, including atomicity/identity checks. No financial tables.
    await scoped.query(`
      CREATE TABLE shifts(id uuid PRIMARY KEY,branch_id uuid,driver_id uuid,business_date date);
      CREATE TABLE shift_orders(id uuid,shift_id uuid);
      CREATE TABLE cash_deductions(id uuid,shift_id uuid);
      CREATE TABLE shift_wallet_movements(id uuid,shift_id uuid);
      CREATE TABLE shift_media(shift_id uuid REFERENCES shifts(id),package text,slot text,
        media_id uuid,attachment_token uuid,UNIQUE(shift_id,package,slot));
      CREATE TABLE shift_close_drafts(shift_id uuid PRIMARY KEY REFERENCES shifts(id),revision bigint,
        draft_hash text,payload jsonb,updated_at timestamptz,updated_by uuid,submitted_at timestamptz);
      CREATE TABLE shift_close_draft_reads(id uuid PRIMARY KEY,shift_id uuid REFERENCES shifts(id),
        media_id uuid,attachment_token uuid,package text,slot text,field text,status text,failure text,
        attempts integer,result jsonb,created_at timestamptz,updated_at timestamptz,created_by uuid);
      CREATE TABLE shift_close_draft_observations(id uuid PRIMARY KEY,read_id uuid REFERENCES shift_close_draft_reads(id),
        shift_id uuid,media_id uuid,attachment_token uuid,slot text,row_index integer,row_count integer,
        date_section text,y_top double precision CHECK(y_top BETWEEN 0 AND 1),
        y_bottom double precision CHECK(y_bottom BETWEEN 0 AND 1),row_data jsonb,created_at timestamptz,
        UNIQUE(read_id,row_index),CHECK(row_index>=0 AND row_index<row_count));
      CREATE TABLE observation_insert_statements(n integer NOT NULL);
      CREATE FUNCTION note_observations_statement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE observation_insert_statements SET n=n+1; RETURN NULL; END $$;
      CREATE TRIGGER count_observation_statements AFTER INSERT ON shift_close_draft_observations
        FOR EACH STATEMENT EXECUTE FUNCTION note_observations_statement();
    `)
  }, 30_000)
  beforeEach(async () => {
    await scoped.query('TRUNCATE shifts,shift_media,shift_close_drafts,shift_close_draft_reads,shift_close_draft_observations CASCADE')
    await scoped.query('INSERT INTO shifts VALUES($1,$2,$3,$4)', [SHIFT, BRANCH, DRIVER, '2026-10-17'])
    await scoped.query('TRUNCATE observation_insert_statements')
    await scoped.query('INSERT INTO observation_insert_statements VALUES(0)')
    await scoped.query("INSERT INTO shift_media VALUES($1,'end','dashboard',$2,$3)", [SHIFT, MEDIA, TOKEN])
    await scoped.query('INSERT INTO shift_close_drafts VALUES($1,0,$2,$3,now(),$4,NULL)',
      [SHIFT, 'a'.repeat(64), JSON.stringify(empty()), DRIVER])
  }, 30_000)
  afterAll(async () => {
    if (pool) {
      // Exact generated fixture schema only, on the identity-checked disposable database.
      if (scoped) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    }
  }, 30_000)

  it('writes 200 observations atomically in one SQL statement and safely replays the same page', async () => {
    const repo = new PgCloseDraftRepo(scoped), request = input(200)
    const result = await repo.saveRead(request)
    expect(result?.revision).toBe(1)
    const stored = await scoped.query('SELECT row_index,row_data FROM shift_close_draft_observations ORDER BY row_index')
    expect(stored.rows).toHaveLength(200)
    expect((await scoped.query('SELECT n FROM observation_insert_statements')).rows[0]?.n).toBe(1)
    expect(stored.rows[199]).toMatchObject({ row_index: 199, row_data: { printed: '12.50', value: '12.50' } })
    expect(await repo.saveRead({ ...request, expectedRevision: 1 })).toMatchObject({ revision: 1 })
    expect((await scoped.query('SELECT count(*)::int AS n FROM shift_close_draft_observations')).rows[0]?.n).toBe(200)
    expect(await repo.saveRead({ ...request, expectedRevision: 0 })).toBeNull()
  }, 45_000)

  it('rolls back the revision AND read record when one observation violates a constraint', async () => {
    const request = input(40)
    request.observations[21]!.yTop = 2
    await expect(new PgCloseDraftRepo(scoped).saveRead(request)).rejects.toMatchObject({ code: '23514' })
    expect((await scoped.query('SELECT revision::text FROM shift_close_drafts')).rows[0]?.revision).toBe('0')
    expect((await scoped.query('SELECT count(*)::int AS n FROM shift_close_draft_reads')).rows[0]?.n).toBe(0)
    expect((await scoped.query('SELECT count(*)::int AS n FROM shift_close_draft_observations')).rows[0]?.n).toBe(0)
  }, 45_000)

  it('does not wait for an unrelated branch financial lock when attaching evidence', async () => {
    const holder = await scoped.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ash:financial:receivables:${BRANCH}`])
      const evidence = new PgShiftCloseUnitOfWork(scoped).run(
        { shiftId: SHIFT, actorId: null, scope: 'evidence' }, async () => 'evidence-committed',
      )
      // Resolves while holder STILL owns the financial lock; the previous implementation raised55P03.
      await expect(evidence).resolves.toBe('evidence-committed')
    } finally { await holder.query('ROLLBACK'); holder.release() }
  }, 45_000)

  it('still refuses to bypass the shift row lock and retains default financial locking', async () => {
    const holder = await scoped.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM shifts WHERE id=$1 FOR UPDATE', [SHIFT])
      await expect(new PgShiftCloseUnitOfWork(scoped).run(
        { shiftId: SHIFT, actorId: null, scope: 'evidence' }, async () => 'must-wait',
      )).rejects.toMatchObject({ code: '55P03' })
      await holder.query('ROLLBACK')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ash:financial:receivables:${BRANCH}`])
      await expect(new PgShiftCloseUnitOfWork(scoped).run(
        { shiftId: SHIFT, actorId: null }, async () => 'must-wait',
      )).rejects.toMatchObject({ code: '55P03' })
    } finally { await holder.query('ROLLBACK'); holder.release() }
  }, 45_000)

  it('retains partial payment observations once and permits one explicit new attempt', async () => {
    const repo = new PgCloseDraftRepo(scoped)
    const partial = input(2)
    partial.read = { ...partial.read, field: 'payments_log', status: 'failed', failure: 'no_fields', rowCount: 2 }
    partial.data.reads[`${TOKEN}|payments_log`] = partial.read
    const first = await repo.saveRead(partial)
    expect(first?.revision).toBe(1)
    const replay = { ...partial, expectedRevision: 1, read: { ...partial.read, readId: randomUUID() } }
    expect((await repo.saveRead(replay))?.revision).toBe(1)
    expect((await scoped.query('SELECT count(*)::text AS n FROM shift_close_draft_observations')).rows[0]?.n).toBe('2')
    const retry = { ...replay, replacesCompletedRead: true, data: structuredClone(partial.data),
      observations: partial.observations.map(observation => ({ ...observation, id: randomUUID() })),
      read: { ...replay.read, readId: randomUUID(), attempts: 2 } }
    retry.data.reads[`${TOKEN}|payments_log`] = retry.read
    expect((await repo.saveRead(retry))?.revision).toBe(2)
    expect((await repo.saveRead({ ...retry, expectedRevision: 2, read: { ...retry.read, readId: randomUUID() } }))?.revision).toBe(2)
    expect((await scoped.query('SELECT count(*)::text AS n FROM shift_close_draft_observations')).rows[0]?.n).toBe('4')
  }, 60_000)
})
