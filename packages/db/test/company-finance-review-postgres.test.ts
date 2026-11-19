import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CompanyExpenseCorrectionValues, CompanyExpenseRecord, CompanyMovementCorrection, CompanyHistoricalSourceCorrection, CompanyHistoricalSourceValues,
  CompanyRestorationProposal, CompanyRestorationReviewRevision, ExistingAssetEventRecord,
  ExistingAssetRecord, FinancialTransactionDeps,
} from '@ash/contracts'
import {
  companyBoxMovement, companyDeposit, companyExpense, companyReversal, formatMinor, fundRefFromCode,
  minor, planRestoration, postingsForRestoration, restorationMirror, type Posting,
} from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { bindPoolToTransaction, createPool, withTransaction, type Pool } from '../src/pool.ts'
import { PgCompanyLedgerRepo, PgCompanyLedgerSource } from '../src/repos-company.ts'
import { PgExistingAssetRepo } from '../src/repos-existing-assets.ts'
import { PgCompanyMovementReviewRepo } from '../src/repos-company-movement-review.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

// This suite owns a NEW allowlisted database, never the database supplied in DATABASE_URL.
// The existing opt-in/connection identity checks also refuse a production-looking URL.
const DATABASE_URL = process.env.DATABASE_URL
const HQ = '10000000-0000-4000-8000-000000000100'
const DAY = '2026-10-03'
const WEEK = '2026-09-27'
const NOW = Date.UTC(2026, 9, 3, 9)
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

if (!DATABASE_URL) {
  describe('PostgreSQL finance review (0086–0088)', () => {
    it.skip('requires an explicitly opted-in disposable loopback PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const admin = createPool(DATABASE_URL)
  const databaseName = `ash_guardcheck_finance_review_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))
  let baselineDir: string | null = null
  let created = false
  let pool: Pool
  let unit: PgFinancialUnitOfWork
  let applied: string[] = []
  const ids = { branch: randomUUID(), gm: randomUUID(), manager: randomUUID(), category: randomUUID(), fx: 0 }

  beforeAll(async () => {
    await assertDisposableDatabaseConnection(admin, disposable)
    const url = new URL(DATABASE_URL)
    url.pathname = `/${databaseName}`
    const isolated = assertDisposableDatabaseUrl(url.toString())
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    created = true
    pool = createPool(url.toString(), 4)
    await assertDisposableDatabaseConnection(pool, isolated)

    // Prove the upgrade from the old schema, rather than testing fresh-table creation alone.
    baselineDir = mkdtempSync(join(tmpdir(), 'ash-finance-review-migrations-'))
    for (const name of readdirSync(migrationsDir).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= '0085')) {
      copyFileSync(join(migrationsDir, name), join(baselineDir, name))
    }
    await migrate(pool, baselineDir)
    expect((await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0]?.filename)
      .toBe('0085_dashboard_charge_vehicle_types.sql')
    applied = (await migrate(pool)).applied
    unit = new PgFinancialUnitOfWork(pool)

    await pool.query(`INSERT INTO roles(key,name_ar,name_en) VALUES
      ('general_manager','GM','GM'),('branch_manager','Manager','Manager') ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO permissions(key,name_ar,name_en) VALUES
      ('company_fund.manage','Company','Company'),('journal.manual.write','Journal','Journal'),('settings.write','Settings','Settings') ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO role_permissions(role_key,permission_key,scope) VALUES
      ('general_manager','company_fund.manage','all'),('general_manager','journal.manual.write','all'),('general_manager','settings.write','all'),
      ('branch_manager','journal.manual.write','branch')
      ON CONFLICT(role_key,permission_key) DO UPDATE SET scope=EXCLUDED.scope`)
    await pool.query(`INSERT INTO branches(id,code,name_ar,name_en,governorate_id,branch_no)
      SELECT $1,'FINANCE-REVIEW','Finance review','Finance review',id,1 FROM governorates WHERE no=1`, [ids.branch])
    await pool.query(`INSERT INTO users(id,branch_id,role_key,username,full_name_ar,password_hash,active) VALUES
      ($1,NULL,'general_manager','finance-review-gm','Reviewer','x',true),
      ($2,$3,'branch_manager','finance-review-manager','Manager','x',true)`, [ids.gm, ids.manager, ids.branch])
    await pool.query(`INSERT INTO expense_categories(id,code,name_ar,active) VALUES($1,'FINANCE-REVIEW','Reviewed expense',true)`, [ids.category])
    const fx = await pool.query<{ id: bigint }>(`INSERT INTO fx_days(business_date,syp_minor_per_usd) VALUES($1,13000) RETURNING id`, [DAY])
    ids.fx = Number(fx.rows[0]!.id)
  }, 240_000)

  afterAll(async () => {
    if (pool!) await pool.end()
    if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
    await admin.end()
    if (baselineDir !== null) {
      const exact = resolve(baselineDir)
      if (dirname(exact) !== resolve(tmpdir()) || !basename(exact).startsWith('ash-finance-review-migrations-')) {
        throw new Error('refusing cleanup outside the explicitly created migration fixture')
      }
      rmSync(exact, { recursive: true, force: true })
    }
  }, 60_000)

  const run = <T>(work: (tx: FinancialTransactionDeps) => Promise<T>, actor = ids.gm) =>
    unit.run({ lockKey: `receivables:${HQ}`, actorId: actor, requestId: 'finance-review-postgres' }, work)
  const meta = (reason: string, actor = ids.gm) => ({ shiftId: null, businessDate: DAY, postingDate: DAY,
    weekStartDate: WEEK, fxDayId: ids.fx, sypMinorPerUsd: null, createdBy: actor, reason })
  const balance = (branch: string, code: string) => new PgLedgerRepo(pool).fundBalance(branch, code)
  const count = async (table: 'journal_entries' | 'journal_lines' | 'company_expenses' | 'company_movement_correction_versions' | 'company_restoration_proposals' | 'restorations') =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n
  const financialCounts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM journal_entries) AS journals,
    (SELECT count(*)::int FROM journal_lines) AS lines,
    (SELECT count(*)::int FROM company_expenses) AS expenses,
    (SELECT count(*)::int FROM company_debts) AS debts,
    (SELECT count(*)::int FROM fixed_assets) AS purchases,
    (SELECT count(*)::int FROM asset_depreciation_schedule) AS depreciation`)).rows[0]

  async function vehicle(label: string): Promise<string> {
    const id = randomUUID()
    await pool.query(`INSERT INTO vehicles(id,branch_id,vehicle_type_id,code,machine_no)
      SELECT $1,$2,id,$3,(SELECT COALESCE(max(machine_no),0)+1 FROM vehicles WHERE branch_id=$2)
      FROM vehicle_types WHERE code='e_motorbike'`, [id, ids.branch, label])
    return id
  }
  function registration(vehicleId: string, key = randomUUID()): ExistingAssetEventRecord {
    const card: ExistingAssetRecord = { id: key, branchId: HQ, vehicleId, name: 'Existing motor', currency: 'USD',
      price: minor(125000n), purchasedOn: '2025-07-01', useStartedOn: '2025-07-01', fundingSource: 'owner_outside',
      description: 'Card only, not payment evidence', status: 'registered', accountingStatus: 'pending_review', version: 1,
      depreciation: null, recognition: null, sale: null, pendingEdit: null,
      createdBy: ids.gm, createdAtMs: NOW, updatedBy: ids.gm, updatedAtMs: NOW }
    return { id: key, assetId: key, branchId: HQ, kind: 'register', expectedVersion: 0, version: 1,
      requestFingerprint: JSON.stringify([key, vehicleId, card.price!.toString()]), reason: 'Register an old motor card',
      snapshot: card, createdBy: ids.gm, createdAtMs: NOW }
  }
  async function register(event: ExistingAssetEventRecord): Promise<{ asset: ExistingAssetRecord; replayed: boolean }> {
    return run(async tx => {
      const prior = await tx.existingAssets.getEvent(event.id)
      if (prior) {
        if (prior.requestFingerprint !== event.requestFingerprint) throw new Error('idempotency_key_conflict')
        return { asset: prior.snapshot, replayed: true }
      }
      await tx.existingAssets.apply(event)
      return { asset: event.snapshot, replayed: false }
    })
  }

  async function historicalExpense(amount = 2000n, paidFrom: 'pocket' | 'owner_outside' = 'pocket'): Promise<CompanyExpenseRecord> {
    return run(async tx => {
      const id = randomUUID(), description = 'Historical paper expense'
      const [entry] = await tx.ledger.post(HQ, [companyExpense('SYP_NEW', minor(amount), 'general', paidFrom, id)],
        { ...meta(description), externalReference: `HQ-HIST-${id}` })
      const record: CompanyExpenseRecord = { id, branchId: HQ, kind: 'expense', currency: 'SYP_NEW', amount: minor(amount),
        sypMinorPerUsd: null, categoryId: ids.category, costCenterKind: 'general', vehicleId: null, assetId: null,
        receiptMediaId: null, paidFrom, description, occurredOn: '2025-08-01', businessDate: DAY,
        journalEntryId: entry!.id, createdBy: ids.gm, createdAtMs: NOW }
      await tx.companyLedger.createCommand(record)
      await tx.companyMovementReview.createMetadata({ commandId: id, branchId: HQ, occurredPrecision: 'day', occurredMonth: null,
        rateBasis: null, sourceUnit: 'SYP_NEW', receiptReference: null, intakeSessionId: null })
      return record
    })
  }
  function values(command: CompanyExpenseRecord, amount: string, paidFrom = command.paidFrom): CompanyExpenseCorrectionValues {
    return { currency: command.currency, amount, paidFrom, categoryId: command.categoryId, costCenterKind: 'general',
      vehicleId: null, assetId: null, receiptMediaId: null, occurredOn: command.occurredOn, description: 'Reviewed corrected expense',
      sypMinorPerUsd: null, occurredPrecision: 'day', occurredMonth: null, rateBasis: null, sourceUnit: 'SYP_NEW', receiptReference: null }
  }
  function draft(targetId: string, current: CompanyExpenseRecord, proposed: CompanyExpenseCorrectionValues, targetVersion = 1): CompanyMovementCorrection {
    const id = randomUUID()
    return { id, branchId: HQ, targetId, targetVersion, effectiveCommandId: current.id, version: 1, status: 'draft',
      reason: 'Reviewed correction with explicit cash effect', values: proposed, financial: true, blockingReasons: [],
      reversalId: randomUUID(), replacementId: randomUUID(), reversalEntryId: null, replacementEntryId: null,
      actionId: id, actionFingerprint: `draft:${id}`, createdBy: ids.gm, createdAtMs: NOW,
      actedBy: ids.gm, actedAtMs: NOW, confirmedBy: null, confirmedAtMs: null }
  }
  async function confirm(correction: CompanyMovementCorrection, failAfterJournals = false): Promise<CompanyExpenseRecord> {
    return run(async tx => {
      const current = await tx.companyLedger.findCommand(correction.effectiveCommandId)
      if (!current || current.kind !== 'expense') throw new Error('current expense missing')
      const entry = await tx.ledger.findEntryById(current.journalEntryId)
      const posting: Posting = { eventType: entry!.eventType, occurrenceKey: entry!.occurrenceKey,
        lines: entry!.lines.map(line => ({ fund: fundRefFromCode(line.fundCode), side: line.side, amount: line.amount,
          ...(line.role === undefined ? {} : { role: line.role }) })) }
      const [reversal] = await tx.ledger.post(HQ, [companyReversal(posting, correction.reversalId)], meta(correction.reason))
      await tx.companyLedger.createCommand({ id: correction.reversalId, branchId: HQ, kind: 'reversal', targetKind: 'expense',
        targetId: current.id, targetEntryId: current.journalEntryId, sypMinorPerUsd: null, reason: correction.reason,
        occurredOn: DAY, businessDate: DAY, journalEntryId: reversal!.id, createdBy: ids.gm, createdAtMs: NOW })
      const v = correction.values
      const [replacement] = await tx.ledger.post(HQ,
        [companyExpense(v.currency, minor(BigInt(v.amount.replace('.', ''))), 'general', v.paidFrom, correction.replacementId)], meta(v.description))
      const command: CompanyExpenseRecord = { ...current, id: correction.replacementId, currency: v.currency,
        amount: minor(BigInt(v.amount.replace('.', ''))), paidFrom: v.paidFrom, description: v.description,
        occurredOn: v.occurredOn, businessDate: DAY, journalEntryId: replacement!.id, createdAtMs: NOW }
      await tx.companyLedger.createCommand(command)
      await tx.companyMovementReview.createMetadata({ commandId: command.id, branchId: HQ, occurredPrecision: 'day', occurredMonth: null,
        rateBasis: null, sourceUnit: 'SYP_NEW', receiptReference: null, intakeSessionId: null })
      if (failAfterJournals) throw new Error('injected failure after correction journals')
      await tx.companyMovementReview.saveCorrection({ ...correction, status: 'confirmed', version: correction.version + 1,
        reversalEntryId: reversal!.id, replacementEntryId: replacement!.id, actionId: randomUUID(), actionFingerprint: `confirm:${correction.id}`,
        actedAtMs: NOW + 1, confirmedBy: ids.gm, confirmedAtMs: NOW + 1 }, correction.version)
      return command
    })
  }

  async function seedHistoricalSourceCorrections(): Promise<void> {
    await withTransaction(pool, { actorId: ids.gm, requestId: 'source-correction-fixture' }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ash:financial:receivables:${HQ}`])
      const bound = bindPoolToTransaction(pool, client, { actorId: ids.gm }), ledger = new PgLedgerRepo(bound)
      const cashCommandId = randomUUID()
      const [cashEntry] = await ledger.post(HQ, [companyExpense('SYP_NEW', minor(100n), 'general', 'pocket', cashCommandId)],
        { ...meta('Cash-backed historical source'), externalReference: 'HQ-SRC-101' })
      await new PgCompanyLedgerRepo(bound).createCommand({ id: cashCommandId, branchId: HQ, kind: 'expense', currency: 'SYP_NEW',
        amount: minor(100n), sypMinorPerUsd: null, categoryId: ids.category, costCenterKind: 'general', vehicleId: null, assetId: null,
        receiptMediaId: null, paidFrom: 'pocket', description: 'Cash-backed historical source', occurredOn: DAY, businessDate: DAY,
        journalEntryId: cashEntry!.id, createdBy: ids.gm, createdAtMs: NOW })
      await new PgCompanyMovementReviewRepo(bound).createMetadata({ commandId: cashCommandId, branchId: HQ, occurredPrecision: 'day',
        occurredMonth: null, rateBasis: null, sourceUnit: 'SYP_NEW', receiptReference: null, intakeSessionId: null })
      const batchId = randomUUID(), hash = createHash('sha256').update(batchId).digest('hex')
      await client.query(`INSERT INTO company_historical_import_batches
        (id,branch_id,source_sha256,source_name,cutoff_date,expected_rows,expected_posted_rows,expected_syp_minor,expected_usd_minor,created_by)
        VALUES($1,$2,$3,'Guard-test historical source',$4,3,1,$5,$6,$7)`,
      [batchId,HQ,hash,DAY,(await ledger.fundBalance(HQ,'company_cash:SYP_NEW')).toString(),
        (await ledger.fundBalance(HQ,'company_cash:USD')).toString(),ids.gm])
      for (const source of [
        { number: 10, type: 'expense', currency: 'SYP_NEW', amount: '51500.00', occurredOn: '2026-07-08',
          description: 'Bags, original worksheet denomination', paidFrom: 'owner_outside', branchId: null, entryId: null },
        { number: 25, type: 'branch_payment', currency: 'SYP_NEW', amount: '12000.00', occurredOn: '2026-07-29',
          description: 'Owner independent branch funding', paidFrom: 'owner_outside', branchId: ids.branch, entryId: null },
        { number: 101, type: 'expense', currency: 'SYP_NEW', amount: '1.00', occurredOn: DAY,
          description: 'Cash-backed historical source', paidFrom: 'pocket', branchId: null, entryId: cashEntry!.id },
      ]) {
        const evidence = { sourceId: String(source.number), payload: { type: source.type, currency: source.currency,
          amount: source.amount, occurredOn: source.occurredOn, description: source.description } }
        await client.query(`INSERT INTO company_historical_import_receipts
          (source_reference,batch_id,source_position,occurred_on,movement_type,paid_from,source_branch_id,journal_entry_id,original_evidence,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [`HQ-SRC-${source.number}`,batchId,source.number,source.occurredOn,source.type,source.paidFrom,source.branchId,
          source.entryId,JSON.stringify(evidence),ids.gm])
      }
    })
  }
  const sourceValues = (sourceReference: string): CompanyHistoricalSourceValues => ({
    currency: 'SYP_NEW', amount: sourceReference === 'HQ-SRC-10' ? '51500.00' : sourceReference === 'HQ-SRC-25' ? '12000.00' : '1.00',
    occurredOn: sourceReference === 'HQ-SRC-10' ? '2026-07-08' : sourceReference === 'HQ-SRC-25' ? '2026-07-29' : DAY,
    description: sourceReference === 'HQ-SRC-10' ? 'Bags, original worksheet denomination' : sourceReference === 'HQ-SRC-25'
      ? 'Owner independent branch funding' : 'Cash-backed historical source', excluded: false, sypMinorPerUsd: null, rateBasis: null,
  })
  const sourceCorrection = (sourceReference: string, change: Partial<CompanyHistoricalSourceValues>, version = 2,
    before = sourceValues(sourceReference)): CompanyHistoricalSourceCorrection => ({
    id: randomUUID(), branchId: HQ, sourceReference, version, before, values: { ...before, ...change },
    reason: 'User-authorized administrative worksheet correction', fingerprint: createHash('sha256').update(randomUUID()).digest('hex'), createdBy: ids.gm, createdAtMs: NOW,
  })
  const applySourceCorrection = (row: CompanyHistoricalSourceCorrection) => run(async tx => {
    const prior = await tx.companyMovementReview.findHistoricalSourceCorrection(row.id)
    if (prior) {
      if (prior.fingerprint !== row.fingerprint) throw new Error('idempotency_key_conflict')
      return true
    }
    await tx.companyMovementReview.saveHistoricalSourceCorrection(row, row.version - 1)
    return false
  })

  async function saleReceipt(amount = 90000n) {
    return run(async tx => {
      const id = randomUUID(), reason = 'Existing full-price receipt used as documentary evidence'
      const [entry] = await tx.ledger.post(HQ,[companyDeposit('USD',minor(amount),'owner_funding',id)],
        { ...meta(reason),sypMinorPerUsd: 13000n })
      await tx.companyLedger.createCommand({ id,branchId: HQ,kind: 'deposit',equityAccount: 'owner_funding',currency: 'USD',
        amount: minor(amount),sypMinorPerUsd: 13000n,reason,occurredOn: DAY,businessDate: DAY,journalEntryId: entry!.id,
        createdBy: ids.gm,createdAtMs: NOW })
      return { id,entry: entry! }
    })
  }
  function documentarySale(card: ExistingAssetRecord, receiptEntryId: number, amount = 90000n): ExistingAssetEventRecord {
    const id = randomUUID(), reason = 'Document the disposal of an unrecognized motor card, with existing full receipt'
    return { id,assetId: card.id,branchId: HQ,kind: 'sale_documentary',expectedVersion: card.version,version: card.version+1,
      requestFingerprint: createHash('sha256').update(id).digest('hex'),reason,createdBy: ids.gm,createdAtMs: NOW+1,
      snapshot: { ...card,version: card.version+1,status: 'sold',updatedBy: ids.gm,updatedAtMs: NOW+1,
        sale: { id,kind: 'documentary',buyer: 'QA buyer',currency: 'USD',price: minor(amount),occurredOn: DAY,
          receivedAmount: minor(amount),receiptDestination: 'company',receiptEntryId,debtId: null,status: 'confirmed',
          disposalEntryId: null,bookValue: null,confirmedBy: ids.gm,confirmedAtMs: NOW+1,reason } } }
  }
  const applyDocumentary = (event: ExistingAssetEventRecord) => run(async tx => {
    const prior = await tx.existingAssets.getEvent(event.id)
    if (prior) {
      if (prior.requestFingerprint !== event.requestFingerprint) throw new Error('idempotency_key_conflict')
      return true
    }
    await tx.existingAssets.apply(event)
    return false
  })
  async function reverseSaleReceipt(receipt: Awaited<ReturnType<typeof saleReceipt>>) {
    return run(async tx => {
      const id = randomUUID(), reason = 'Reverse an existing receipt', source = receipt.entry
      const posting: Posting = { eventType: source.eventType,occurrenceKey: source.occurrenceKey,
        lines: source.lines.map(line => ({ fund: fundRefFromCode(line.fundCode),side: line.side,amount: line.amount,
          ...(line.role === undefined ? {} : { role: line.role }) })) }
      const [entry] = await tx.ledger.post(HQ,[companyReversal(posting,id)],{ ...meta(reason),sypMinorPerUsd: 13000n })
      await tx.companyLedger.createCommand({ id,branchId: HQ,kind: 'reversal',targetKind: 'move',targetId: receipt.id,
        targetEntryId: source.id,sypMinorPerUsd: 13000n,reason,occurredOn: DAY,businessDate: DAY,journalEntryId: entry!.id,
        createdBy: ids.gm,createdAtMs: NOW+2 })
    })
  }

  describe('0085 → 0086–0088 repository upgrade and atomicity', () => {
    it('applies only the additive migrations and skips an identical rerun', async () => {
      expect(applied).toEqual(readdirSync(migrationsDir).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0085').sort())
      expect((await migrate(pool)).applied).toEqual([])
    })

    it('registers an existing motor with no journal, payment, debt or depreciation, and retains exact retry evidence', async () => {
      const before = await financialCounts(), event = registration(await vehicle('NEUTRAL-1'))
      expect((await register(event)).replayed).toBe(false)
      expect(await financialCounts()).toEqual(before)
      expect((await register(event)).replayed).toBe(true)
      expect(await new PgExistingAssetRepo(pool).listEvents(event.assetId)).toHaveLength(1)
      await expect(register({ ...event, requestFingerprint: 'changed-price' })).rejects.toThrow('idempotency_key_conflict')
      expect((await new PgExistingAssetRepo(pool).get(event.assetId))?.price).toBe(125000n)
      const failure = registration(await vehicle('NEUTRAL-ROLLBACK'))
      await expect(run(async tx => { await tx.existingAssets.apply(failure); throw new Error('injected after card projection') }))
        .rejects.toThrow('injected after card projection')
      expect(await new PgExistingAssetRepo(pool).get(failure.assetId)).toBeNull()
      expect(await new PgExistingAssetRepo(pool).getEvent(failure.id)).toBeNull()
      expect(await financialCounts()).toEqual(before)
    })

    it('serializes competing cards for one vehicle and refuses unattributed card revisions', async () => {
      const vehicleId = await vehicle('NEUTRAL-RACE'), a = registration(vehicleId), b = registration(vehicleId)
      const outcomes = await Promise.allSettled([register(a), register(b)])
      expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
      expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM company_existing_assets WHERE vehicle_id=$1', [vehicleId])).rows[0]!.n).toBe(1)
      const event = registration(await vehicle('NEUTRAL-ACTOR'))
      const wrongActor = { ...event, createdBy: ids.manager,
        snapshot: { ...event.snapshot, createdBy: ids.manager, updatedBy: ids.manager } }
      await expect(run(tx => tx.existingAssets.apply(wrongActor), ids.manager)).rejects.toMatchObject({ code: '23514' })
      expect(await new PgExistingAssetRepo(pool).get(wrongActor.assetId)).toBeNull()
    })

    it('executes branch restoration atomically with a proposal, then confirms/corrects only the HQ half', async () => {
      await run(async tx => {
        await tx.companyLedger.createCutover({ branchId: ids.branch, companyBranchId: HQ, openingAmount: minor(0n), openingEntryId: null,
          watermarkEntryId: await tx.companyLedger.latestEntryId(), businessDate: DAY, reason: 'Disposable reviewed workflow', performedBy: ids.gm, performedAtMs: NOW })
        await tx.capitalTargets.upsert({ branchId: ids.branch, fundCode: 'office_cash', target: minor(500000n), effectiveFrom: DAY, createdBy: ids.gm, note: 'Test target' })
        await tx.capitalTargets.upsert({ branchId: ids.branch, fundCode: 'office_wallet', target: minor(100000n), effectiveFrom: DAY, createdBy: ids.gm, note: 'Test target' })
        await tx.ledger.post(ids.branch, [{ eventType: 'manual', occurrenceKey: randomUUID(), lines: [
          { fund: { kind: 'office_cash' }, side: 'D', amount: minor(600000n) },
          { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(100000n) },
          { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: minor(700000n) },
        ] }], meta('Seed actual office boxes'))
      })
      const cashBefore = await balance(HQ, 'company_cash:SYP_NEW')
      const restore = async (proposalId: string, fail = false): Promise<CompanyRestorationProposal> => run(async tx => {
        const cash = await tx.ledger.fundBalance(ids.branch, 'office_cash'), wallet = await tx.ledger.fundBalance(ids.branch, 'office_wallet')
        const plan = planRestoration([
          { fundCode: 'office_cash', officeBalance: cash, receivables: minor(0n), advances: minor(0n), capitalTarget: minor(500000n) },
          { fundCode: 'office_wallet', officeBalance: wallet, receivables: minor(0n), advances: minor(0n), capitalTarget: minor(100000n) },
        ])
        const runNo = await tx.restorations.runsOnDay(ids.branch, DAY) + 1
        const reason = 'Actual branch restoration awaiting HQ review'
        const entries = await tx.ledger.post(ids.branch, postingsForRestoration(plan, `${DAY}#${runNo}`), meta(reason, ids.manager))
        const openingBalances = [{ fundCode: 'office_cash', balance: formatMinor(cash) }, { fundCode: 'office_wallet', balance: formatMinor(wallet) }]
        const legs = plan.legs.map(leg => ({ ...leg, officeBalance: formatMinor(leg.officeBalance), receivables: formatMinor(leg.receivables),
          advances: formatMinor(leg.advances), position: formatMinor(leg.position), capitalTarget: formatMinor(leg.capitalTarget), delta: formatMinor(leg.delta), amount: formatMinor(leg.amount) }))
        const restorationId = await tx.restorations.create({ branchId: ids.branch, businessDate: DAY, cashCountId: null,
          plan: { schemaVersion: 4, source: 'live_ledger', openingBalances, restorationJournalEntryIds: entries.map(entry => entry.id), legs },
          netToCompany: plan.netToCompany, reason, performedBy: ids.manager, runNo })
        const proposal: CompanyRestorationProposal = { id: proposalId, restorationId, branchId: ids.branch, companyBranchId: HQ,
          businessDate: DAY, reason, requestHash: proposalId, runNo, snapshot: { openingBalances, legs }, response: {},
          legs: entries.map(entry => ({ sourceEntryId: entry.id, fundCode: 'office_cash', ...companyBoxMovement(entry.lines)!, sourceEntry: entry })),
          createdBy: ids.manager, createdAtMs: NOW }
        await tx.companyRestorationReviews.create(proposal)
        if (fail) throw new Error('injected after actual restoration and proposal')
        return proposal
      }, ids.manager)
      const beforeFailure = { journals: await count('journal_entries'), runs: await count('restorations'), proposals: await count('company_restoration_proposals') }
      await expect(restore(randomUUID(), true)).rejects.toThrow('injected after actual restoration and proposal')
      expect(await balance(ids.branch, 'office_cash')).toBe(600000n)
      expect({ journals: await count('journal_entries'), runs: await count('restorations'), proposals: await count('company_restoration_proposals') }).toEqual(beforeFailure)
      const proposal = await restore(randomUUID())
      expect(await balance(ids.branch, 'office_cash')).toBe(500000n)
      expect(await balance(ids.branch, 'company_box')).toBe(100000n)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(cashBefore)
      const branchFacts = (await pool.query('SELECT * FROM journal_entries WHERE branch_id=$1 ORDER BY id', [ids.branch])).rows
      const review = async (amount: bigint, kind: 'confirm' | 'correct', version: number, previousAmount = 0n) => run(async tx => {
        const id = randomUUID(), source = proposal.legs[0]!, reason = 'HQ amount reviewed without changing branch'
        const write = async (posting: Posting) => (await tx.ledger.post(HQ, [posting], meta(reason)))[0]!.id
        const reverseEntry = kind === 'correct' && previousAmount > 0n ? await write({ ...restorationMirror(source.direction, minor(previousAmount), ids.branch, source.sourceEntryId),
          occurrenceKey: `review-reverse:${id}:${source.sourceEntryId}`, lines: restorationMirror(source.direction, minor(previousAmount), ids.branch, source.sourceEntryId).lines
            .map(line => ({ ...line, side: line.side === 'D' ? 'C' as const : 'D' as const })) }) : null
        const journalEntryId = await write({ ...restorationMirror(source.direction, minor(amount), ids.branch, source.sourceEntryId), occurrenceKey: `review:${id}:${source.sourceEntryId}` })
        const revision: CompanyRestorationReviewRevision = { id, proposalId: proposal.id, version, kind, requestHash: id, reason,
          occurredOn: DAY, businessDate: DAY, createdBy: ids.gm, createdAtMs: NOW,
          legs: [{ sourceEntryId: source.sourceEntryId, amount: minor(amount), journalEntryId, reversalEntryId: reverseEntry }] }
        await tx.companyRestorationReviews.appendRevision(revision)
      })
      await review(80000n, 'confirm', 1)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(cashBefore + 80000n)
      await review(90000n, 'correct', 2, 80000n)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(cashBefore + 90000n)
      expect(await balance(HQ, `branch_clearing:${ids.branch}`)).toBe(-90000n)
      expect((await pool.query('SELECT * FROM journal_entries WHERE branch_id=$1 ORDER BY id', [ids.branch])).rows).toEqual(branchFacts)
      expect(await balance(ids.branch, 'office_cash')).toBe(500000n)
      expect(await balance(ids.branch, 'company_box')).toBe(100000n)
      const pending = await pool.query<{ difference: string }>('SELECT ash_restoration_pending_difference($1)::text AS difference', [ids.branch])
      expect(pending.rows[0]!.difference).toBe('10000')
    })

    it('links a positive historical branch baseline without HQ cash and adopts an old executed run without double counting', async () => {
      const branchId = randomUUID()
      await pool.query(`INSERT INTO branches(id,code,name_ar,name_en,governorate_id,branch_no)
        SELECT $1,'MATCH-ONLY','Matching','Matching',id,2 FROM governorates WHERE no=1`, [branchId])
      const branchRun = <T>(work: (tx: FinancialTransactionDeps) => Promise<T>) => unit.run({
        lockKey: `receivables:${branchId}`, actorId: ids.gm, requestId: 'link-only-pg-proof',
      }, async tx => { await tx.locks.acquire(`receivables:${HQ}`); return work(tx) })
      const old = await branchRun(async tx => {
        await tx.capitalTargets.upsert({ branchId, fundCode: 'office_cash', target: minor(500000n), effectiveFrom: DAY, createdBy: ids.gm, note: 'Old target' })
        await tx.capitalTargets.upsert({ branchId, fundCode: 'office_wallet', target: minor(100000n), effectiveFrom: DAY, createdBy: ids.gm, note: 'Old target' })
        await tx.ledger.post(branchId, [{ eventType: 'manual', occurrenceKey: randomUUID(), lines: [
          { fund: { kind: 'office_cash' }, side: 'D', amount: minor(600000n) },
          { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(100000n) },
          { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: minor(700000n) },
        ] }], meta('Old balances before activation'))
        const plan = planRestoration([
          { fundCode: 'office_cash', officeBalance: minor(600000n), receivables: minor(0n), advances: minor(0n), capitalTarget: minor(500000n) },
          { fundCode: 'office_wallet', officeBalance: minor(100000n), receivables: minor(0n), advances: minor(0n), capitalTarget: minor(100000n) },
        ])
        const reason = 'Executed old run before matching activation'
        const entries = await tx.ledger.post(branchId, postingsForRestoration(plan, `${DAY}#1`), meta(reason))
        const openingBalances = [{ fundCode: 'office_cash', balance: '6000.00' }, { fundCode: 'office_wallet', balance: '1000.00' }]
        const legs = plan.legs.map(leg => ({ ...leg, officeBalance: formatMinor(leg.officeBalance), receivables: formatMinor(leg.receivables),
          advances: formatMinor(leg.advances), position: formatMinor(leg.position), capitalTarget: formatMinor(leg.capitalTarget), delta: formatMinor(leg.delta), amount: formatMinor(leg.amount) }))
        const restorationId = await tx.restorations.create({ branchId, businessDate: DAY, cashCountId: null,
          plan: { schemaVersion: 4, source: 'live_ledger', openingBalances, restorationJournalEntryIds: entries.map(entry => entry.id), legs },
          netToCompany: plan.netToCompany, reason, performedBy: ids.gm, runNo: 1 })
        return { restorationId, entries, snapshot: { openingBalances, legs } }
      })
      const before = await financialCounts(), cashBefore = await balance(HQ, 'company_cash:SYP_NEW')
      const branchFacts = (await pool.query('SELECT * FROM journal_entries WHERE branch_id=$1 ORDER BY id', [branchId])).rows
      const transition = async (baseline: bigint) => branchRun(async tx => tx.companyLedger.createCutover({
        branchId, companyBranchId: HQ, mode: 'link_only', openingAmount: minor(100000n), openingEntryId: null,
        baselineDifference: minor(baseline), watermarkEntryId: await tx.companyLedger.latestEntryId(), businessDate: DAY,
        reason: 'Link actual old books without another cash receipt', performedBy: ids.gm, performedAtMs: NOW,
      }))
      await expect(transition(99999n)).rejects.toMatchObject({ code: '23514', constraint: 'company_cutovers_link_only_guard' })
      await transition(100000n)
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(cashBefore)
      const key = randomUUID()
      const proposal: CompanyRestorationProposal = { id: key, origin: 'historical', restorationId: old.restorationId,
        branchId, companyBranchId: HQ, businessDate: DAY, reason: 'Verified original source identity', requestHash: key, runNo: 1,
        snapshot: old.snapshot, response: {}, createdBy: ids.gm, createdAtMs: NOW,
        legs: old.entries.map(entry => ({ sourceEntryId: entry.id, fundCode: 'office_cash', ...companyBoxMovement(entry.lines)!, sourceEntry: entry })) }
      await branchRun(tx => tx.companyRestorationReviews.create(proposal))
      expect(await financialCounts()).toEqual(before)
      const revisionId = randomUUID(), source = proposal.legs[0]!, reason = 'HQ receipt amount reviewed'
      await branchRun(async tx => {
        const [entry] = await tx.ledger.post(HQ, [{ ...restorationMirror(source.direction, minor(80000n), branchId, source.sourceEntryId),
          occurrenceKey: `review:${revisionId}:${source.sourceEntryId}` }], meta(reason))
        await tx.companyRestorationReviews.appendRevision({ id: revisionId, proposalId: proposal.id, version: 1, kind: 'confirm', requestHash: revisionId,
          reason, occurredOn: DAY, businessDate: DAY, createdBy: ids.gm, createdAtMs: NOW,
          legs: [{ sourceEntryId: source.sourceEntryId, amount: minor(80000n), journalEntryId: entry!.id, reversalEntryId: null }] })
      })
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBe(cashBefore+80000n)
      expect(await balance(branchId, 'company_box')).toBe(100000n)
      expect((await pool.query('SELECT * FROM journal_entries WHERE branch_id=$1 ORDER BY id', [branchId])).rows).toEqual(branchFacts)
      expect((await pool.query<{ offset: string }>('SELECT ash_restoration_historical_offset($1)::text AS offset', [branchId])).rows[0]!.offset).toBe('100000')
    })

    it('keeps one canonical effective expense chain and rolls back all journals when correction approval fails', async () => {
      const original = await historicalExpense(), originalEntry = await new PgLedgerRepo(pool).findEntryById(original.journalEntryId)
      const branchBefore = await balance(ids.branch, 'office_cash')
      const first = draft(original.id, original, values(original, '35.00', 'owner_outside'))
      await run(tx => tx.companyMovementReview.saveCorrection(first, 0))
      const before = { entries: await count('journal_entries'), expenses: await count('company_expenses'), cash: await balance(HQ, 'company_cash:SYP_NEW') }
      await expect(confirm(first, true)).rejects.toThrow('injected failure after correction journals')
      expect({ entries: await count('journal_entries'), expenses: await count('company_expenses'), cash: await balance(HQ, 'company_cash:SYP_NEW') }).toEqual(before)
      expect((await new PgCompanyMovementReviewRepo(pool).getCorrection(first.id))?.status).toBe('draft')
      const replacement = await confirm(first)
      const second = draft(original.id, replacement, values(replacement, '40.00', 'pocket'), 2)
      await run(tx => tx.companyMovementReview.saveCorrection(second, 0))
      const active = await confirm(second)
      expect(active.amount).toBe(4000n)
      const confirmed = (await new PgCompanyMovementReviewRepo(pool).listCorrections(HQ, original.id)).filter(row => row.status === 'confirmed')
      expect(confirmed.map(row => row.targetVersion).sort()).toEqual([1, 2])
      expect((await new PgCompanyMovementReviewRepo(pool).listCorrectionHistory(first.id)).map(row => row.status)).toEqual(['draft', 'confirmed'])
      expect(await new PgLedgerRepo(pool).findEntryById(original.journalEntryId)).toEqual(originalEntry)
      expect(await balance(ids.branch, 'office_cash')).toBe(branchBefore)
      const nested = draft(replacement.id, replacement, values(replacement, '45.00'))
      await expect(run(tx => tx.companyMovementReview.saveCorrection(nested, 0))).rejects.toMatchObject({ code: '23514', constraint: 'company_correction_canonical_target_guard' })
      expect(await new PgCompanyMovementReviewRepo(pool).getCorrection(nested.id)).toBeNull()
      const overview = await new PgCompanyLedgerSource(pool).readOverview(HQ, { from: DAY, to: DAY })
      expect(overview.period.SYP_NEW.expense).toBe(4000n)
    })

    it('allows only one concurrent confirmation against the same effective target version', async () => {
      const original = await historicalExpense(1000n, 'owner_outside')
      const a = draft(original.id, original, values(original, '12.00', 'owner_outside'))
      const b = draft(original.id, original, values(original, '13.00', 'owner_outside'))
      await run(async tx => { await tx.companyMovementReview.saveCorrection(a, 0); await tx.companyMovementReview.saveCorrection(b, 0) })
      const before = await count('journal_entries')
      const outcomes = await Promise.allSettled([confirm(a), confirm(b)])
      expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
      expect(await count('journal_entries')).toBe(before + 2)
      expect((await new PgCompanyMovementReviewRepo(pool).listCorrections(HQ, original.id)).filter(row => row.status === 'confirmed')).toHaveLength(1)
    })

    it('refuses forged negative ordinary cash while allowing attributed positive historical movement values', async () => {
      const before = await balance(HQ, 'company_cash:SYP_NEW')
      const ordinaryId = randomUUID(), amount = minor((before > 0n ? before : 0n) + 100n)
      await expect(run(async tx => {
        const [entry] = await tx.ledger.post(HQ, [companyExpense('SYP_NEW', amount, 'general', 'pocket', ordinaryId)], meta('Ordinary overdraft must fail'))
        await tx.companyLedger.createCommand({ id: ordinaryId, branchId: HQ, kind: 'expense', currency: 'SYP_NEW', amount,
          sypMinorPerUsd: null, categoryId: ids.category, costCenterKind: 'general', vehicleId: null, assetId: null, receiptMediaId: null,
          paidFrom: 'pocket', description: 'Ordinary overdraft must fail', occurredOn: DAY, businessDate: DAY,
          journalEntryId: entry!.id, createdBy: ids.gm, createdAtMs: NOW })
      })).rejects.toMatchObject({ code: '23514', constraint: 'company_pocket_negative_guard' })
      expect(await new PgCompanyLedgerRepo(pool).findCommand(ordinaryId)).toBeNull()
      const historical = await historicalExpense(amount + 100n)
      expect(historical.amount).toBeGreaterThan(0n)
      expect(await balance(HQ, 'company_cash:SYP_NEW')).toBeLessThan(0n)
    })

    it('retains immutable historical source evidence and serializes exact source-correction retries without GL changes', async () => {
      await seedHistoricalSourceCorrections()
      const before = await financialCounts(), cash = await balance(HQ,'company_cash:SYP_NEW')
      const original = (await pool.query('SELECT * FROM company_historical_import_receipts ORDER BY source_reference')).rows
      const bags = sourceCorrection('HQ-SRC-10', { currency: 'USD', amount: '390.00', sypMinorPerUsd: '13300', rateBasis: 'estimated' })
      expect((await Promise.all([applySourceCorrection(bags),applySourceCorrection(bags)])).sort()).toEqual([false,true])
      await expect(applySourceCorrection({ ...bags, fingerprint: 'changed' })).rejects.toThrow('idempotency_key_conflict')
      const exclude = sourceCorrection('HQ-SRC-25', { excluded: true })
      expect(await applySourceCorrection(exclude)).toBe(false)
      const description = sourceCorrection('HQ-SRC-101', { description: 'Reviewed receipt explanation' })
      expect(await applySourceCorrection(description)).toBe(false)
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:SYP_NEW')).toBe(cash)
      expect((await pool.query('SELECT * FROM company_historical_import_receipts ORDER BY source_reference')).rows).toEqual(original)
      expect(await new PgCompanyMovementReviewRepo(pool).listHistoricalSourceCorrections(HQ,'HQ-SRC-10')).toHaveLength(1)
      await expect(pool.query('UPDATE company_historical_source_corrections SET version=3 WHERE id=$1',[bags.id]))
        .rejects.toMatchObject({ code: '23514' })
      await expect(pool.query('DELETE FROM company_historical_source_corrections WHERE id=$1',[exclude.id]))
        .rejects.toMatchObject({ code: '23514' })
    })

    it('rolls back forged before evidence, invalid values, stale source versions and cash-backed financial edits', async () => {
      const repo = new PgCompanyMovementReviewRepo(pool)
      const bags = (await repo.listHistoricalSourceCorrections(HQ,'HQ-SRC-10'))[0]!
      const cashSource = (await repo.listHistoricalSourceCorrections(HQ,'HQ-SRC-101'))[0]!
      const before = await financialCounts(), cash = await balance(HQ,'company_cash:SYP_NEW')
      const reject = (row: CompanyHistoricalSourceCorrection) => expect(run(tx => tx.companyMovementReview.saveHistoricalSourceCorrection(row,row.version-1)))
        .rejects.toMatchObject({ code: '23514' })
      await reject(sourceCorrection('HQ-SRC-10',{ amount: '400.00' },3,{ ...bags.values,amount: '389.00' }))
      await reject(sourceCorrection('HQ-SRC-10',{ amount: '400.00' },2,bags.values))
      for (const values of [{ amount: '-1.00' },{ amount: '0.00' },{ amount: '1e5' },{ amount: '92233720368547758.08' },
        { occurredOn: '2099-01-01' },{ description: '\u200b' },{ sypMinorPerUsd: '0' },{ rateBasis: null }] as const) {
        await reject(sourceCorrection('HQ-SRC-10',values,3,bags.values))
      }
      await reject({ ...sourceCorrection('HQ-SRC-10',{ amount: '400.00' },3,bags.values),createdBy: ids.manager })
      await reject(sourceCorrection('HQ-SRC-101',{ amount: '2.00' },3,cashSource.values))
      await reject(sourceCorrection('HQ-SRC-101',{ excluded: true },3,cashSource.values))
      const rollback = sourceCorrection('HQ-SRC-10',{ description: 'Not committed' },3,bags.values)
      await expect(run(async tx => { await tx.companyMovementReview.saveHistoricalSourceCorrection(rollback,2); throw new Error('injected source correction rollback') }))
        .rejects.toThrow('injected source correction rollback')
      expect(await repo.findHistoricalSourceCorrection(rollback.id)).toBeNull()
      expect(await repo.listHistoricalSourceCorrections(HQ)).toHaveLength(3)
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:SYP_NEW')).toBe(cash)
    })

    it('refuses incomplete or forged historical source correction identity and attribution metadata', async () => {
      const repo = new PgCompanyMovementReviewRepo(pool)
      const prior = (await repo.listHistoricalSourceCorrections(HQ,'HQ-SRC-10'))[0]!
      const before = await financialCounts(), cash = await balance(HQ,'company_cash:SYP_NEW')
      for (const field of ['id','branchId','sourceReference','version','createdBy','reason','fingerprint']) {
        const row = sourceCorrection('HQ-SRC-10',{ description: 'Metadata must be complete' },3,prior.values)
        const payload: Record<string,unknown> = { ...row }
        delete payload[field]
        await expect(withTransaction(pool,{ actorId: ids.gm },async client => client.query(`
          INSERT INTO company_historical_source_corrections(id,branch_id,source_reference,version,created_by,payload)
          VALUES($1,$2,$3,$4,$5,$6)`,[row.id,HQ,row.sourceReference,row.version,ids.gm,JSON.stringify(payload)])))
          .rejects.toMatchObject({ code: '23514' })
      }
      for (const malformed of [{ fingerprint: 'not-a-request-hash' },{ reason: '\u200b' },{ createdBy: ids.manager }]) {
        const row = { ...sourceCorrection('HQ-SRC-10',{ description: 'Forged metadata' },3,prior.values), ...malformed }
        await expect(run(tx => tx.companyMovementReview.saveHistoricalSourceCorrection(row,2))).rejects.toMatchObject({ code: '23514' })
      }
      expect(await repo.listHistoricalSourceCorrections(HQ)).toHaveLength(3)
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:SYP_NEW')).toBe(cash)
    })

    it('links documentary sale to one existing exact receipt with no journal, cash, profit or debt change, and preserves retries/CAS', async () => {
      const motor = registration(await vehicle('DOC-SALE')), receipt = await saleReceipt()
      await register(motor)
      const before = await financialCounts(), cash = await balance(HQ,'company_cash:USD')
      const period = (await new PgCompanyLedgerSource(pool).readOverview(HQ,{ from: DAY,to: DAY })).period
      const event = documentarySale(motor.snapshot,receipt.entry.id)
      expect((await Promise.all([applyDocumentary(event),applyDocumentary(event)])).sort()).toEqual([false,true])
      await expect(applyDocumentary({ ...event,requestFingerprint: 'changed' })).rejects.toThrow('idempotency_key_conflict')
      expect((await new PgExistingAssetRepo(pool).get(motor.assetId))?.sale).toMatchObject({ kind: 'documentary',status: 'confirmed',
        receiptEntryId: receipt.entry.id,disposalEntryId: null,bookValue: null,debtId: null })
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:USD')).toBe(cash)
      expect((await new PgCompanyLedgerSource(pool).readOverview(HQ,{ from: DAY,to: DAY })).period).toEqual(period)
      expect(await new PgExistingAssetRepo(pool).listEvents(motor.assetId)).toHaveLength(2)
      await expect(reverseSaleReceipt(receipt)).rejects.toMatchObject({ code: '23514',constraint: 'existing_asset_sale_receipt_correction_guard' })
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:USD')).toBe(cash)
      const competing = registration(await vehicle('DOC-SALE-CAS')), a = await saleReceipt(), b = await saleReceipt()
      await register(competing)
      const competingBefore = await financialCounts()
      const outcomes = await Promise.allSettled([applyDocumentary(documentarySale(competing.snapshot,a.entry.id)),
        applyDocumentary(documentarySale(competing.snapshot,b.entry.id))])
      expect(outcomes.filter(result => result.status==='fulfilled')).toHaveLength(1)
      expect(outcomes.filter(result => result.status==='rejected')).toHaveLength(1)
      expect(await financialCounts()).toEqual(competingBefore)
      expect(await new PgExistingAssetRepo(pool).listEvents(competing.assetId)).toHaveLength(2)
      const another = registration(await vehicle('DOC-RECEIPT-REUSE'))
      await register(another)
      await expect(applyDocumentary(documentarySale(another.snapshot,receipt.entry.id))).rejects.toMatchObject({ code: '23505' })
      expect((await new PgExistingAssetRepo(pool).get(another.assetId))?.status).toBe('registered')
    })

    it('refuses partial, wrong-currency, other-branch, reversed or future documentary sale evidence and an unauthorized actor', async () => {
      const motor = registration(await vehicle('DOC-SALE-GUARDS')), receipt = await saleReceipt(), reversed = await saleReceipt()
      await register(motor); await reverseSaleReceipt(reversed)
      const branchEntry = await run(tx => tx.ledger.post(ids.branch,[{ eventType: 'manual',occurrenceKey: randomUUID(),lines: [
        { fund: { kind: 'office_cash' },side: 'D',amount: minor(90000n) },
        { fund: { kind: 'cost_center',costCenterId: 'owner_funding' },side: 'C',amount: minor(90000n) },
      ] }],meta('Different branch receipt')))
      const before = await financialCounts(), cash = await balance(HQ,'company_cash:USD')
      const reject = (event: ExistingAssetEventRecord) => expect(run(tx => tx.existingAssets.apply(event)))
        .rejects.toMatchObject({ code: '23514' })
      await reject(documentarySale(motor.snapshot,receipt.entry.id,80000n))
      await reject(documentarySale(motor.snapshot,branchEntry[0]!.id))
      await reject(documentarySale(motor.snapshot,reversed.entry.id))
      for (const change of [{ currency: 'SYP_NEW' },{ occurredOn: '2099-01-01' },{ receivedAmount: minor(80000n) },
        { buyer: '\u200b' },{ receiptDestination: 'owner_outside' } ] as const) {
        const event = documentarySale(motor.snapshot,receipt.entry.id)
        await reject({ ...event,snapshot: { ...event.snapshot,sale: { ...event.snapshot.sale!,...change } } })
      }
      const wrongActor = documentarySale(motor.snapshot,receipt.entry.id)
      await expect(run(tx => tx.existingAssets.apply({ ...wrongActor,createdBy: ids.manager,
        snapshot: { ...wrongActor.snapshot,updatedBy: ids.manager,sale: { ...wrongActor.snapshot.sale!,confirmedBy: ids.manager } } }),ids.manager))
        .rejects.toMatchObject({ code: '23514',constraint: 'existing_asset_actor_guard' })
      expect((await new PgExistingAssetRepo(pool).get(motor.assetId))?.status).toBe('registered')
      expect(await financialCounts()).toEqual(before)
      expect(await balance(HQ,'company_cash:USD')).toBe(cash)
    })
  })
}
