import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { minor, type Posting } from '@ash/domain'
import { createPool, type Pool } from '../src/pool.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl, withTestSearchPath } from './disposable-database.ts'

const url = process.env.ASH_LEDGER_BATCH_TEST_DATABASE_URL
const schema = `ash_ledger_batch_${randomUUID().replaceAll('-', '')}`
const branch = randomUUID(), actor = randomUUID(), shift = randomUUID()
const meta = { shiftId: shift, businessDate: '2026-10-27', postingDate: '2026-10-27',
  weekStartDate: '2026-10-25', fxDayId: 1, createdBy: actor, reason: 'isolated regression', sypMinorPerUsd: null } as const
const posting = (key: string, amount = 12550n): Posting => ({
  eventType: 'manual', occurrenceKey: key, lines: [
    { fund: { kind: 'office_cash' }, side: 'D', amount: minor(amount) },
    { fund: { kind: 'office_wallet' }, side: 'C', amount: minor(amount) },
  ],
})
let pool: Pool, scoped: Pool, repo: PgLedgerRepo

describe.skipIf(!url)('batched ledger on isolated PostgreSQL', () => {
  beforeAll(async () => {
    const identity = assertDisposableDatabaseUrl(url!)
    pool = withTestSearchPath(createPool(url!, 4), 'public')
    await assertDisposableDatabaseConnection(pool, identity)
    if (!/^ash_ledger_batch_[a-f0-9]{32}$/.test(schema)) throw new Error('invalid fixture schema')
    await pool.query(`CREATE SCHEMA "${schema}"`)
    scoped = withTestSearchPath(pool, schema)
    // Real PostgreSQL constraints/transactions, fixture-only tables. No public schema migrations.
    await scoped.query(`
      CREATE TYPE fund_type AS ENUM ('office_cash','office_wallet');
      CREATE TYPE ledger_event AS ENUM ('manual');
      CREATE TABLE funds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),branch_id uuid NOT NULL,
        type fund_type NOT NULL, owner_kind text NOT NULL, owner_id uuid, code text NOT NULL,
        name_ar text NOT NULL,currency text NOT NULL,UNIQUE(branch_id,code),
        CHECK((owner_kind='none')=(owner_id IS NULL)));
      CREATE TABLE journal_entries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        branch_id uuid NOT NULL,event_type ledger_event NOT NULL,shift_id uuid,occurrence_key text NOT NULL,
        business_date date,posting_date date,week_start_date date,fx_day_id bigint,reason text,
        created_by uuid,syp_minor_per_usd bigint,external_reference text,prior_period_reason text,
        created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX fixture_idempotency ON journal_entries(shift_id,event_type,occurrence_key) WHERE shift_id IS NOT NULL;
      CREATE TABLE journal_lines(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id bigint REFERENCES journal_entries(id),fund_id uuid REFERENCES funds(id),
        side char(1) CHECK(side IN ('D','C')), amount_minor bigint CHECK(amount_minor>0),line_role text);
      CREATE FUNCTION fixture_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.id
        GROUP BY entry_id HAVING sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END)<>0)
        OR NOT EXISTS(SELECT 1 FROM journal_lines WHERE entry_id=NEW.id)
        THEN RAISE EXCEPTION 'unbalanced fixture journal'; END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER fixture_balance AFTER INSERT ON journal_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_balanced();
    `)
    repo = new PgLedgerRepo(scoped)
  }, 120_000)

  beforeEach(async () => {
    await scoped.query('TRUNCATE journal_lines,journal_entries,funds RESTART IDENTITY')
  }, 60_000)
  afterAll(async () => {
    if (pool) {
      if (/^ash_ledger_batch_[a-f0-9]{32}$/.test(schema)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await pool.end()
    }
  }, 60_000)

  it('commits 65 exact balanced postings and skips a replay/mixed duplicate batch', async () => {
    const input = Array.from({ length: 65 }, (_, i) => posting(`item:${i}`, 9007199254740993n))
    expect(await repo.post(branch, input, meta)).toHaveLength(65)
    expect(await repo.post(branch, [...input, posting('new'), posting('new')], meta)).toHaveLength(1)
    const summary = (await scoped.query(`SELECT count(DISTINCT j.id)::text AS entries,count(l.id)::text AS lines,
      sum(CASE l.side WHEN 'D' THEN l.amount_minor ELSE -l.amount_minor END)::text AS balance
      FROM journal_entries j JOIN journal_lines l ON l.entry_id=j.id`)).rows[0]
    expect(summary).toEqual({ entries: '66', lines: '132', balance: '0' })
    expect((await scoped.query('SELECT amount_minor::text AS amount FROM journal_lines ORDER BY id LIMIT 1')).rows[0]?.amount)
      .toBe('9007199254740993')
  }, 120_000)

  it('keeps two NULL-shift postings with the same key and different exact amounts', async () => {
    const result = await repo.post(branch, [posting('same', 100n), posting('same', 250n)], { ...meta, shiftId: null })
    expect(result.map(row => row.lines[0]!.amount)).toEqual([100n, 250n])
    expect((await scoped.query('SELECT amount_minor::text AS amount FROM journal_lines WHERE side=\'D\' ORDER BY id')).rows)
      .toEqual([{ amount: '100' }, { amount: '250' }])
  }, 60_000)

  it('rolls back headers, newly created funds and all lines on a failed line constraint', async () => {
    await expect(repo.post(branch, [posting('good'), posting('zero', 0n)], meta)).rejects.toMatchObject({ code: '23514' })
    expect((await scoped.query(`SELECT (SELECT count(*)::text FROM journal_entries) AS entries,
      (SELECT count(*)::text FROM journal_lines) AS lines,(SELECT count(*)::text FROM funds) AS funds`)).rows[0])
      .toEqual({ entries: '0', lines: '0', funds: '0' })
    expect(await repo.post(branch, [posting('recovered')], meta)).toHaveLength(1)
  }, 60_000)

  it('serializes simultaneous approval replays to one receipt per identity', async () => {
    const input = Array.from({ length: 10 }, (_, i) => posting(`concurrent:${i}`))
    const results = await Promise.all([repo.post(branch, input, meta), repo.post(branch, input, meta)])
    expect(results.map(rows => rows.length).sort((a, b) => a - b)).toEqual([0, 10])
    expect((await scoped.query('SELECT count(*)::text AS n FROM journal_entries')).rows[0]?.n).toBe('10')
  }, 120_000)
})
