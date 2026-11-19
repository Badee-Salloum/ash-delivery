import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompanyHistoricalDraft, CompanyHistoricalDraftRevision, Deps, FinancialUnitOfWork } from '@ash/contracts'
import { createPool, migrate, PgCompanyHistoricalDraftRepo, PgCompanyLedgerRepo, PgFinancialUnitOfWork, PgFxRepo, PgLedgerRepo, type Pool } from '@ash/db'
import { ownerBranchFundingRead } from '../src/company-movement-read.service.ts'
import { COMPANY_BRANCH, type Harness, makeHarness } from './harness.ts'

// Opt-in only; this suite creates and removes its OWN allowlisted loopback database.
const url = process.env.DATABASE_URL
const enabled = Boolean(url) && process.env.ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS === '1'
// Keep this API suite inside its TypeScript root; unlike the broader DB suite it never permits
// remote targets, even with a remote-test opt-in. Check URL and connected identity before writes.
function localDisposableUrl(raw: string): { database: string } {
  const parsed = new URL(raw), database = decodeURIComponent(parsed.pathname.slice(1))
  if (process.env.ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS !== '1' ||
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !/^ash_(?:test|conformance|release_gate|guardcheck|integritycheck)(?:_[a-z0-9_]+)?$/i.test(database)) {
    throw new Error('Refusing transfer integration test: explicitly allowlisted loopback disposable database required')
  }
  return { database }
}
async function assertLocalDisposableConnection(target: Pool, expected: { database: string }): Promise<void> {
  const { rows } = await target.query<{ database: string; serverAddress: string | null }>(
    'SELECT current_database() AS database, inet_server_addr()::text AS "serverAddress"')
  const actual = rows[0]
  if (!actual || actual.database !== expected.database ||
    (actual.serverAddress !== null && actual.serverAddress !== '::1/128' && !actual.serverAddress.startsWith('127.'))) {
    throw new Error('Refusing transfer integration test: connected database must match its loopback disposable identity')
  }
}
const databaseName = `ash_guardcheck_branch_transfer_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
const DAY = '2026-07-21'
let admin: Pool | undefined
let pool: Pool | undefined
let created = false
let h: Harness
let gm: string
let unit: PgFinancialUnitOfWork
const ids = { branch: randomUUID(), other: randomUUID(), gm: randomUUID(), admin: randomUUID() }
const post = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/company/branch-transfers',
  headers: { cookie: h.cookie(gm) }, payload })
const body = (changes: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), branchId: ids.branch,
  direction: 'to_branch', source: 'company', channel: 'cash', currency: 'SYP_NEW', amount: '50.00',
  occurredOn: DAY, description: 'Disposable PG actual transfer', ...changes })
const count = async () => (await pool!.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_entries')).rows[0]!.n
const held = (branchId: string, code: string) => new PgLedgerRepo(pool!).fundBalance(branchId, code)

describe.skipIf(!enabled)('ordinary branch transfer API against disposable PostgreSQL', () => {
  beforeAll(async () => {
    const identified = localDisposableUrl(url!)
    admin = createPool(url!, 1)
    await assertLocalDisposableConnection(admin, identified)
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    created = true
    const childUrl = new URL(url!); childUrl.pathname = `/${databaseName}`
    const childIdentity = localDisposableUrl(childUrl.toString())
    pool = createPool(childUrl.toString(), 4)
    await assertLocalDisposableConnection(pool, childIdentity)
    await migrate(pool)
    await pool.query(`INSERT INTO roles(key,name_ar,name_en) VALUES
      ('general_manager','GM','GM'),('system_admin','Admin','Admin') ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO permissions(key,name_ar,name_en) VALUES
      ('company_fund.manage','Company','Company'),('journal.manual.write','Journal','Journal'),('settings.write','Settings','Settings')
      ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO role_permissions(role_key,permission_key,scope) VALUES
      ('general_manager','company_fund.manage','all'),('general_manager','journal.manual.write','all'),('general_manager','settings.write','all'),
      ('system_admin','company_fund.manage','all'),('system_admin','journal.manual.write','all'),('system_admin','settings.write','all')
      ON CONFLICT(role_key,permission_key) DO UPDATE SET scope=EXCLUDED.scope`)
    await pool.query(`INSERT INTO branches(id,code,name_ar,name_en,governorate_id,branch_no)
      SELECT v.id,v.code,v.code,v.code,g.id,v.no FROM
      (VALUES($1::uuid,'TRANSFER-PG-A',1),($2::uuid,'TRANSFER-PG-B',2)) v(id,code,no)
      CROSS JOIN governorates g WHERE g.no=1`, [ids.branch, ids.other])
    await pool.query(`INSERT INTO users(id,branch_id,role_key,username,full_name_ar,password_hash,active)
      VALUES($1,NULL,'general_manager','pg-transfer-gm','PG transfer reviewer','x',true)`, [ids.gm])
    await pool.query(`INSERT INTO users(id,branch_id,role_key,username,full_name_ar,password_hash,active)
      VALUES($1,NULL,'system_admin','pg-transfer-admin','PG cutover reviewer','x',true)`, [ids.admin])
    await pool.query(`INSERT INTO fx_days(business_date,syp_minor_per_usd) VALUES($1,13000)
      ON CONFLICT(business_date) DO NOTHING`, [DAY])
    h = await makeHarness({ companyRestorationReviewEnabled: true })
    const baseBranch = structuredClone([...h.deps.directory.branches.values()].find(row => row.kind === 'branch')!)
    const company = h.deps.directory.branches.get(COMPANY_BRANCH)!
    h.deps.directory.branches.clear()
    h.deps.directory.branches.set(COMPANY_BRANCH, company)
    h.deps.directory.branches.set(ids.branch, { ...baseBranch, id: ids.branch, code: 'TRANSFER-PG-A', nameAr: 'PG A' })
    h.deps.directory.branches.set(ids.other, { ...baseBranch, id: ids.other, code: 'TRANSFER-PG-B', nameAr: 'PG B' })
    h.deps.users.seed({ id: ids.gm, branchId: null, driverId: null, roleKey: 'general_manager', username: 'pg-transfer-gm',
      fullNameAr: 'PG transfer reviewer', passwordHash: 'plain:secret', failedAttempts: 0, lockedUntilMs: null, active: true })
    h.deps.users.seed({ id: ids.admin, branchId: null, driverId: null, roleKey: 'system_admin', username: 'pg-transfer-admin',
      fullNameAr: 'PG cutover reviewer', passwordHash: 'plain:secret', failedAttempts: 0, lockedUntilMs: null, active: true })
    const wired: Deps = h.deps
    wired.ledger = new PgLedgerRepo(pool)
    wired.companyLedger = new PgCompanyLedgerRepo(pool)
    wired.fx = new PgFxRepo(pool)
    wired.companyHistoricalDrafts = new PgCompanyHistoricalDraftRepo(pool)
    unit = new PgFinancialUnitOfWork(pool)
    wired.financialUnitOfWork = unit
    gm = await h.loginAs('pg-transfer-gm')
    const reviewer = await h.loginAs('pg-transfer-admin')
    const cutover = await h.app.inject({ method: 'POST', url: '/company/cutover', headers: { cookie: h.cookie(reviewer) },
      payload: { branchId: ids.branch, expectedOpening: '0.00', reason: 'Disposable reviewed branch cutover' } })
    expect(cutover.statusCode, cutover.body).toBe(201)
  }, 240_000)

  afterAll(async () => {
    if (h) await h.app.close()
    if (pool) await pool.end()
    if (created && admin) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
    if (admin) await admin.end()
  }, 60_000)

  it('commits ordinary manual shahn/kaish pairs with exact mirror invariants and no restoration', async () => {
    const result = await post(body())
    expect(result.statusCode, result.body).toBe(201)
    expect(await held(ids.branch, 'office_cash')).toBe(5000n)
    expect(await held(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(-5000n)
    expect(await held(ids.branch, 'company_box')).toBe(-5000n)
    expect(await held(COMPANY_BRANCH, `branch_clearing:${ids.branch}`)).toBe(5000n)
    const received = await post(body({ direction: 'from_branch', amount: '10.00' }))
    expect(received.statusCode, received.body).toBe(201)
    expect(await held(ids.branch, 'office_cash')).toBe(4000n)
    expect(await held(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(-4000n)
    const rows = await pool!.query<{ n: number; runs: number; proposals: number }>(`SELECT
      (SELECT count(*)::int FROM company_restoration_mirrors) AS n,
      (SELECT count(*)::int FROM restorations) AS runs,
      (SELECT count(*)::int FROM company_restoration_proposals) AS proposals`)
    expect(rows.rows[0]).toEqual({ n: 2, runs: 0, proposals: 0 })
  })

  it('commits one pair under concurrent same-UUID retries and refuses changed branch data', async () => {
    const input = body({ amount: '7.00', channel: 'wallet' }), before = await count()
    const results = await Promise.all([input, input, input].map(value => post(value)))
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 200, 201])
    expect(await count()).toBe(before + 2)
    expect(new Set(results.map(row => row.json().transfer.branchEntryId)).size).toBe(1)
    expect((await post({ ...input, branchId: ids.other })).statusCode).toBe(409)
  })

  it('records owner-to-branch funding without HQ cash, expense, mirror or restoration', async () => {
    const beforeCash = await held(COMPANY_BRANCH, 'company_cash:SYP_NEW')
    const result = await post(body({ branchId: ids.other, source: 'owner_outside', amount: '12.00', channel: 'wallet' }))
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json().transfer.companyEntryId).toBeNull()
    expect(await held(ids.other, 'office_wallet')).toBe(1200n)
    expect(await held(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(beforeCash)
    const funding = await ownerBranchFundingRead({ ledger: new PgLedgerRepo(pool!) }, await h.deps.directory.listBranches(), DAY, DAY, DAY)
    expect(funding.totals.SYP_NEW).toBe('12.00')
    expect(funding.payments).toHaveLength(1)
    const expense = await pool!.query<{ n: number }>('SELECT count(*)::int AS n FROM company_expenses')
    expect(expense.rows[0]!.n).toBe(0)
  })

  it('rolls both journals back after a late mirror-link failure', async () => {
    const before = { count: await count(), branch: await held(ids.branch, 'office_cash'),
      company: await held(COMPANY_BRANCH, 'company_cash:SYP_NEW') }
    const failing: FinancialUnitOfWork = { run: (input, work) => unit.run(input, tx => {
      tx.companyLedger.createMirror = async () => { throw new Error('injected PG mirror-link failure') }
      return work(tx)
    }) }
    ;(h.deps as Deps).financialUnitOfWork = failing
    try { expect((await post(body({ amount: '1.00' }))).statusCode).toBe(500) }
    finally { (h.deps as Deps).financialUnitOfWork = unit }
    expect({ count: await count(), branch: await held(ids.branch, 'office_cash'),
      company: await held(COMPANY_BRANCH, 'company_cash:SYP_NEW') }).toEqual(before)
  })

  it('refuses old branch movements, uncutover company transfers and overdrawing branch cash before posting', async () => {
    const before = await count()
    expect((await post(body({ branchId: 'not-a-uuid-or-verified-branch' }))).statusCode).toBe(404)
    expect((await post(body({ occurredOn: '2025-08-01' }))).json().error).toBe('historical_branch_transfer_requires_matching')
    expect((await post(body({ branchId: ids.other }))).json().error).toBe('company_transfer_cutover_required')
    expect((await post(body({ direction: 'from_branch', amount: '1000.00' }))).json().error).toBe('insufficient_funds')
    expect(await count()).toBe(before)
  })

  const draftBody = (changes: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), type: 'expense',
    currency: 'USD', amount: '135.00', occurredOn: '2025-09-06', description: 'Historical owner source evidence only',
    paidFrom: 'owner_outside', historicalRate: '13300', rateBasis: 'documented', ...changes })
  const draftRequest = (method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>) =>
    h.app.inject({ method, url: path, headers: { cookie: h.cookie(gm) }, payload })
  const financialSnapshot = async () => ({ journals: await count(),
    companyCash: await held(COMPANY_BRANCH, 'company_cash:SYP_NEW'),
    companyUsd: await held(COMPANY_BRANCH, 'company_cash:USD'),
    companyOwnerSyp: await held(COMPANY_BRANCH, 'owner_capital:SYP_NEW'),
    companyOwnerUsd: await held(COMPANY_BRANCH, 'owner_capital:USD'),
    branchCash: await held(ids.branch, 'office_cash'), branchWallet: await held(ids.branch, 'office_wallet'),
    branchOwner: await held(ids.other, 'cost_center:owner_funding'),
    records: (await pool!.query(`SELECT
      (SELECT count(*)::int FROM company_expenses) AS expenses,
      (SELECT count(*)::int FROM company_debts) AS debts,
      (SELECT count(*)::int FROM company_debt_events) AS debt_events,
      (SELECT count(*)::int FROM fixed_assets) AS assets,
      (SELECT count(*)::int FROM company_existing_assets) AS asset_cards,
      (SELECT count(*)::int FROM company_moves) AS commands,
      (SELECT count(*)::int FROM company_incomes) AS incomes,
      (SELECT count(*)::int FROM company_fx_exchanges) AS exchanges,
      (SELECT count(*)::int FROM company_restoration_mirrors) AS mirrors`)).rows[0],
  })

  it('stages and revises historical evidence with no journals, company/branch money, owner capital, expense, asset or debt changes', async () => {
    const before = await financialSnapshot(), input = draftBody()
    let failure: { code?: string | undefined; message?: string } | null = null
    ;(h.deps as Deps).financialUnitOfWork = { run: (context, work) => unit.run(context, work).catch(error => {
      failure = { code: (error as { code?: string }).code, message: (error as Error).message }; throw error
    }) }
    const saved = await draftRequest('POST', '/company/historical-drafts', input)
    ;(h.deps as Deps).financialUnitOfWork = unit
    expect(saved.statusCode, `${saved.body} ${JSON.stringify(failure)}`).toBe(201)
    const original = saved.json().draft
    expect(original).toMatchObject({ status: 'draft', version: 1, payload: { type: 'expense', paidFrom: 'owner_outside', amount: '135.00' } })
    const edited = await draftRequest('PATCH', `/company/historical-drafts/${original.id}`,
      { ...input, idempotencyKey: randomUUID(), expectedVersion: 1, amount: '140.00', description: 'Reconciled owner evidence' })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().draft).toMatchObject({ version: 2, payload: { amount: '140.00' } })
    const replay = await draftRequest('POST', '/company/historical-drafts', input)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().draft).toEqual(original)
    const list = await h.app.inject({ method: 'GET', url: '/company/historical-drafts', headers: { cookie: h.cookie(gm) } })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().drafts.find((row: { id: string }) => row.id === original.id)).toMatchObject({ version: 2 })
    expect(await financialSnapshot()).toEqual(before)
  })

  it('serializes administrative same-UUID requests once and rejects changed payload or stale draft version', async () => {
    const before = await financialSnapshot(), input = draftBody({ description: 'Concurrent administrative historical evidence' })
    const results = await Promise.all([input, input, { ...input, idempotencyKey: input.idempotencyKey.toUpperCase() }]
      .map(payload => draftRequest('POST', '/company/historical-drafts', payload)))
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 200, 201])
    const id = results[0]!.json().draft.id
    expect(new Set(results.map(result => result.json().draft.id)).size).toBe(1)
    expect((await pool!.query('SELECT version FROM company_historical_draft_revisions WHERE draft_id=$1', [id])).rows).toHaveLength(1)
    expect((await draftRequest('POST', '/company/historical-drafts', { ...input, amount: '136.00' })).statusCode).toBe(409)
    const patch = { ...input, idempotencyKey: randomUUID(), expectedVersion: 1, amount: '137.00' }
    const editResults = await Promise.all([patch, patch].map(payload => draftRequest('PATCH', `/company/historical-drafts/${id}`, payload)))
    expect(editResults.map(result => result.statusCode)).toEqual([200, 200])
    expect((await pool!.query('SELECT version FROM company_historical_draft_revisions WHERE draft_id=$1', [id])).rows).toHaveLength(2)
    expect((await draftRequest('PATCH', `/company/historical-drafts/${id}`, { ...patch, idempotencyKey: randomUUID(), amount: '138.00' })).statusCode).toBe(409)
    expect(await financialSnapshot()).toEqual(before)
  })

  it('rolls a staged identity and revision back after an injected late failure', async () => {
    const before = await financialSnapshot()
    const prior = (await pool!.query('SELECT count(*)::int AS n FROM company_historical_drafts')).rows[0]
    ;(h.deps as Deps).financialUnitOfWork = { run: (input, work) => unit.run(input, async tx => {
      const result = await work(tx)
      throw Object.assign(new Error('injected historical administrative failure after writes'), { result })
    }) }
    try { expect((await draftRequest('POST', '/company/historical-drafts', draftBody())).statusCode).toBe(500) }
    finally { (h.deps as Deps).financialUnitOfWork = unit }
    expect((await pool!.query('SELECT count(*)::int AS n FROM company_historical_drafts')).rows[0]).toEqual(prior)
    expect(await financialSnapshot()).toEqual(before)
  })

  it('rejects raw null evidence and destructive changes to existing draft history in PostgreSQL', async () => {
    const before = await financialSnapshot()
    const saved = await draftRequest('POST', '/company/historical-drafts', draftBody())
    expect(saved.statusCode, saved.body).toBe(201)
    const draft = saved.json().draft as CompanyHistoricalDraft
    for (const field of ['type', 'occurredOn', 'occurredPrecision', 'paidFrom'] as const) {
      const invalid = { ...draft.revisions[0], draftId: draft.id, requestId: randomUUID(), requestHash: '0'.repeat(64),
        expectedVersion: 1, version: 2, payload: { ...draft.payload, [field]: null } } as unknown as CompanyHistoricalDraftRevision
      await expect(unit.run({ lockKey: `raw-draft:${draft.id}`, actorId: ids.gm }, tx =>
        tx.companyHistoricalDrafts.append(invalid, 1))).rejects.toMatchObject({ code: '23514' })
    }
    await expect(pool!.query('UPDATE company_historical_draft_revisions SET payload=payload WHERE draft_id=$1', [draft.id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(pool!.query('DELETE FROM company_historical_drafts WHERE id=$1', [draft.id]))
      .rejects.toMatchObject({ code: '23514' })
    expect((await new PgCompanyHistoricalDraftRepo(pool!).get(draft.id))!.version).toBe(1)
    expect(await financialSnapshot()).toEqual(before)
  })

  it('stages branch receipts, owner-funded branch payments, asset payments and refunds without classifying or posting money again', async () => {
    const before = await financialSnapshot()
    const inputs = [
      { type: 'branch_receipt', branchId: ids.branch, currency: 'SYP_NEW', amount: '1000.00' },
      { type: 'branch_payment', branchId: ids.other, currency: 'SYP_NEW', amount: '1200.00', paidFrom: 'owner_outside' },
      { type: 'asset_payment', currency: 'USD', amount: '12000.00', paidFrom: 'owner_outside', historicalRate: '13300', rateBasis: 'estimated' },
      { type: 'refund', currency: 'SYP_NEW', amount: '880000.00' },
    ]
    for (const input of inputs) {
      const result = await draftRequest('POST', '/company/historical-drafts', { ...input, idempotencyKey: randomUUID(),
        occurredOn: '2025-08-01', description: `Original historical ${input.type} source evidence` })
      expect(result.statusCode, result.body).toBe(201)
      expect(result.json().draft).toMatchObject({ status: 'draft', version: 1, payload: { type: input.type, amount: input.amount } })
      expect(await financialSnapshot()).toEqual(before)
    }
    for (const type of ['branch_receipt', 'branch_payment']) {
      const missing = await draftRequest('POST', '/company/historical-drafts', { idempotencyKey: randomUUID(), type,
        currency: 'SYP_NEW', amount: '1000.00', occurredOn: '2025-08-01', description: 'Unspecified operating branch' })
      expect(missing.statusCode).toBe(400)
    }
    const hq = await draftRequest('POST', '/company/historical-drafts', { idempotencyKey: randomUUID(), type: 'branch_payment',
      branchId: COMPANY_BRANCH, currency: 'SYP_NEW', amount: '1000.00', occurredOn: '2025-08-01', description: 'HQ is not an operating branch' })
    expect(hq.statusCode).toBe(422)
    expect(await financialSnapshot()).toEqual(before)
  })
})
