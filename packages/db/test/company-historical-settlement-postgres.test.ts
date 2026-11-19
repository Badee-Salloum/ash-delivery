import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompanyHistoricalRestorationSettlement, FinancialTransactionDeps, JournalEntryRecord } from '@ash/contracts'
import { companyBoxMovement, formatMinor, historicalBranchTransfer, historicalRestorationReclassification,
  minor, planRestoration, postingsForRestoration, type Posting } from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { bindPoolToTransaction, createPool, withTransaction, type Pool } from '../src/pool.ts'
import { PgCompanyLedgerRepo, PgCompanyLedgerSource } from '../src/repos-company.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'
import { PgLedgerRepo } from '../src/repos.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
const HQ = '10000000-0000-4000-8000-000000000100', DAY = '2026-10-04', WEEK = '2026-10-04', NOW = Date.UTC(2026, 9, 4, 8)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

if (!DATABASE_URL) {
  describe('PostgreSQL historical noncash settlement (0097)', () => {
    it.skip('requires an explicitly opted-in independent disposable database', () => {})
  })
} else {
  const base = assertDisposableDatabaseUrl(DATABASE_URL), admin = createPool(DATABASE_URL)
  const databaseName = `ash_guardcheck_historical_settlement_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  let pool: Pool, unit: PgFinancialUnitOfWork, created = false, fx = 0, fixtureNo = 0, sourceNo = 200
  const gm = randomUUID(), manager = randomUUID(), managerBranch = randomUUID()
  beforeAll(async () => {
    await assertDisposableDatabaseConnection(admin, base)
    const url = new URL(DATABASE_URL); url.pathname = `/${databaseName}`
    const isolated = assertDisposableDatabaseUrl(url.toString())
    await admin.query(`CREATE DATABASE ${quote(databaseName)}`); created = true
    pool = createPool(url.toString(), 4)
    await assertDisposableDatabaseConnection(pool, isolated)
    await migrate(pool)
    unit = new PgFinancialUnitOfWork(pool)
    await pool.query(`INSERT INTO roles(key,name_ar,name_en) VALUES('general_manager','GM','GM'),('branch_manager','BM','BM') ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO permissions(key,name_ar,name_en) VALUES('company_fund.manage','Manage','Manage'),('journal.manual.write','Journal','Journal'),('settings.write','Settings','Settings') ON CONFLICT(key) DO NOTHING`)
    await pool.query(`INSERT INTO role_permissions(role_key,permission_key,scope) VALUES
      ('general_manager','company_fund.manage','all'),('general_manager','journal.manual.write','all'),('general_manager','settings.write','all'),
      ('branch_manager','journal.manual.write','branch') ON CONFLICT(role_key,permission_key) DO UPDATE SET scope=EXCLUDED.scope`)
    await pool.query(`INSERT INTO branches(id,code,name_ar,name_en,governorate_id,branch_no)
      SELECT $1,'RECLASS-MANAGER','Manager branch','Manager branch',id,99 FROM governorates WHERE no=1`,[managerBranch])
    await pool.query(`INSERT INTO users(id,branch_id,role_key,username,full_name_ar,password_hash,active) VALUES
      ($1,NULL,'general_manager','historical-settlement-gm','Reviewer','x',true),($2,$3,'branch_manager','historical-settlement-manager','Manager','x',true)`, [gm,manager,managerBranch])
    fx = Number((await pool.query<{ id: bigint }>(`INSERT INTO fx_days(business_date,syp_minor_per_usd) VALUES($1,13000) RETURNING id`, [DAY])).rows[0]!.id)
  }, 240_000)
  afterAll(async () => {
    if (pool!) await pool.end()
    if (created) await admin.query(`DROP DATABASE ${quote(databaseName)} WITH (FORCE)`)
    await admin.end()
  }, 60_000)
  const meta = (reason: string, actor: string = gm) => ({ shiftId: null, businessDate: DAY, postingDate: DAY, weekStartDate: WEEK,
    fxDayId: fx, sypMinorPerUsd: null, createdBy: actor, reason })
  const run = <T>(branchId: string, work: (tx: FinancialTransactionDeps) => Promise<T>, actor: string = gm) =>
    unit.run({ lockKey: `receivables:${branchId}`, actorId: actor, requestId: 'historical-settlement-pg' }, async tx => {
      await tx.locks.acquire(`receivables:${HQ}`); return work(tx)
    })

  interface Fixture { branchId: string; restorationId: number; branchEntries: JournalEntryRecord[]; refs: string[]; sourceIds: number[]; watermark: number;
    runs: Array<{ restorationId:number;entries:JournalEntryRecord[] }>;
    sourceFacts:Array<{restorationId:number;direction:'to_company'|'from_company';amount:bigint}> }
  async function fixture(totalRuns=1): Promise<Fixture> {
    const branchId = randomUUID(), no = ++fixtureNo
    await pool.query(`INSERT INTO branches(id,code,name_ar,name_en,governorate_id,branch_no)
      SELECT $1,$2,'Settlement fixture','Settlement fixture',id,$3 FROM governorates WHERE no=1`, [branchId,`RECLASS-${no}`,no])
    const old = await run(branchId, async tx => {
      await tx.capitalTargets.upsert({ branchId, fundCode: 'office_cash', target: minor(500000n), effectiveFrom: DAY, createdBy: gm, note: 'Old target' })
      await tx.capitalTargets.upsert({ branchId, fundCode: 'office_wallet', target: minor(100000n), effectiveFrom: DAY, createdBy: gm, note: 'Old target' })
      await tx.ledger.post(branchId, [{ eventType: 'manual', occurrenceKey: randomUUID(), lines: [
        { fund: { kind: 'office_cash' }, side: 'D', amount: minor(600000n) },
        { fund: { kind: 'office_wallet' }, side: 'D', amount: minor(90000n) },
        { fund: { kind: 'cost_center', costCenterId: 'owner_funding' }, side: 'C', amount: minor(690000n) },
      ] }], meta('Original branch cash'))
      const plan = planRestoration([
        { fundCode: 'office_cash', officeBalance: minor(600000n), receivables: minor(0n), advances: minor(0n), capitalTarget: minor(500000n) },
        { fundCode: 'office_wallet', officeBalance: minor(90000n), receivables: minor(0n), advances: minor(0n), capitalTarget: minor(100000n) },
      ])
      const reason = 'Executed historical mixed-direction run'
      const openingBalances = [{ fundCode: 'office_cash', balance: '6000.00' }, { fundCode: 'office_wallet', balance: '900.00' }]
      const legs = plan.legs.map(leg => ({ ...leg, officeBalance: formatMinor(leg.officeBalance), receivables: formatMinor(leg.receivables),
        advances: formatMinor(leg.advances), position: formatMinor(leg.position), capitalTarget: formatMinor(leg.capitalTarget), delta: formatMinor(leg.delta), amount: formatMinor(leg.amount) }))
      const runs:Array<{restorationId:number;entries:JournalEntryRecord[]}> = []
      for(let runNo=1;runNo<=totalRuns;runNo++) {
        if(runNo>1) await tx.ledger.post(branchId,[{eventType:'manual',occurrenceKey:randomUUID(),lines:[
          {fund:{kind:'office_cash'},side:'D',amount:minor(100000n)},
          {fund:{kind:'office_wallet'},side:'C',amount:minor(10000n)},
          {fund:{kind:'cost_center',costCenterId:'owner_funding'},side:'C',amount:minor(90000n)},
        ]}],meta('Next old run original balances'))
        const entries = await tx.ledger.post(branchId, postingsForRestoration(plan, `${DAY}#${runNo}`), meta(reason))
        const restorationId = await tx.restorations.create({ branchId, businessDate: DAY, cashCountId: null,
          plan: { schemaVersion: 4, source: 'live_ledger', openingBalances, restorationJournalEntryIds: entries.map(entry => entry.id), legs },
          netToCompany: plan.netToCompany, reason, performedBy: gm, runNo })
        runs.push({restorationId,entries})
      }
      return {restorationId:runs[0]!.restorationId,entries:runs.flatMap(run=>run.entries),runs}
    })
    const sourceIds: number[] = [], refs: string[] = []
    const sourceFacts=old.runs.flatMap((run,index)=>index===old.runs.length-1?
      [{restorationId:run.restorationId,direction:'to_company' as const,amount:60000n},
        {restorationId:run.restorationId,direction:'to_company' as const,amount:39000n},
        {restorationId:run.restorationId,direction:'from_company' as const,amount:10000n}]:
      [{restorationId:run.restorationId,direction:'to_company' as const,amount:89000n}])
    await withTransaction(pool, { actorId: gm, requestId: 'original-import' }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ash:financial:receivables:${branchId}`])
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ash:financial:receivables:${HQ}`])
      const ledger = new PgLedgerRepo(bindPoolToTransaction(pool, client, { actorId: gm }))
      for (const source of sourceFacts) {
        const id = randomUUID(), ref = `HQ-SRC-${++sourceNo}`, reason = 'Original imported cash source'
        const [entry] = await ledger.post(HQ,[historicalBranchTransfer(source.direction,minor(source.amount),branchId,id)], { ...meta(reason), externalReference: ref })
        sourceIds.push(entry!.id); refs.push(ref)
        await client.query(`INSERT INTO company_historical_transfers
          (id,branch_id,source_branch_id,direction,amount_minor,occurred_on,business_date,source_reference,reason,restoration_id,journal_entry_id,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)`, [id,HQ,branchId,source.direction,source.amount.toString(),DAY,ref,reason,source.restorationId,entry!.id,gm])
      }
      const batchId = randomUUID()
      await client.query(`INSERT INTO company_historical_import_batches
        (id,branch_id,source_sha256,source_name,cutoff_date,expected_rows,expected_posted_rows,expected_syp_minor,expected_usd_minor,created_by)
        VALUES($1,$2,$3,'Original sources',$4,$5,$5,$6,$7,$8)`, [batchId,HQ,hash(batchId),DAY,sourceFacts.length,
        (await ledger.fundBalance(HQ,'company_cash:SYP_NEW')).toString(),(await ledger.fundBalance(HQ,'company_cash:USD')).toString(),gm])
      for (let index=0; index<refs.length; index++) {
        const source=sourceFacts[index]!,type = source.direction==='from_company' ? 'branch_payment' : 'branch_receipt', amount = source.amount
        const evidence = { sourceId: refs[index]!.replace('HQ-SRC-',''),originalDeltas:[0,0,0,0],payload:{type,currency:'SYP_NEW',amount:formatMinor(minor(amount)),occurredOn:DAY,description:'Original source'} }
        await client.query(`INSERT INTO company_historical_import_receipts
          (source_reference,batch_id,source_position,occurred_on,movement_type,paid_from,source_branch_id,journal_entry_id,restoration_id,original_evidence,created_by)
          VALUES($1,$2,$3,$4,$5,'pocket',$6,$7,$8,$9::jsonb,$10)`, [refs[index],batchId,index+1,DAY,type,branchId,sourceIds[index],source.restorationId,JSON.stringify(evidence),gm])
      }
    })
    const watermark = await run(branchId,async tx => {
      const watermarkEntryId = await tx.companyLedger.latestEntryId()
      await tx.companyLedger.createCutover({ branchId,companyBranchId:HQ,mode:'link_only',openingAmount:minor(90000n*BigInt(totalRuns)),openingEntryId:null,
        baselineDifference:minor(90000n*BigInt(totalRuns)),watermarkEntryId,businessDate:DAY,reason:'Freeze original baseline without cash',performedBy:gm,performedAtMs:NOW })
      return watermarkEntryId
    })
    return {branchId,restorationId:old.restorationId,branchEntries:old.entries,sourceIds,refs,watermark,runs:old.runs,sourceFacts}
  }
  const approved = (f: Fixture, id: string=randomUUID()): CompanyHistoricalRestorationSettlement => ({
    id,companyBranchId:HQ,sourceBranchId:f.branchId,version:1,cutoverWatermarkEntryId:f.watermark,evidenceHash:hash('verified'),requestHash:hash(id),
    businessDate:DAY,reason:'Human approved whole original group without moving cash',createdBy:gm,createdAtMs:NOW,
    groups:f.runs.map(run=>({restorationId:run.restorationId,businessDate:DAY,sourceReferences:f.refs.filter((_ref,index)=>f.sourceFacts[index]!.restorationId===run.restorationId),
      branchSourceEntries:run.entries.map(entry => ({sourceEntryId:entry.id,...companyBoxMovement(entry.lines)!})),
      branchNet:minor(90000n),companyNet:minor(89000n),variance:minor(1000n)})),
    legs:f.sourceIds.map((sourceId,index) => ({restorationId:f.sourceFacts[index]!.restorationId,sourceReference:f.refs[index]!,historicalJournalEntryId:sourceId,
      direction:f.sourceFacts[index]!.direction,amount:minor(f.sourceFacts[index]!.amount),journalEntryId:0})),
  })
  const settle = (f: Fixture, row=approved(f), changePosting?: (posting: Posting, index:number)=>Posting) => run(f.branchId,async tx => {
    for (let index=0; index<row.legs.length; index++) {
      const leg = row.legs[index]!, posting = historicalRestorationReclassification(leg.direction,leg.amount,f.branchId,leg.historicalJournalEntryId,row.id)
      const [entry] = await tx.ledger.post(HQ,[changePosting ? changePosting(posting,index) : posting],meta(row.reason,row.createdBy))
      leg.journalEntryId = entry!.id
    }
    await tx.companyLedger.createHistoricalSettlement(row,row.version-1)
    return row
  },row.createdBy)
  const snapshot = async (f: Fixture) => ({
    branchEntries:(await pool.query('SELECT * FROM journal_entries WHERE branch_id=$1 ORDER BY id',[f.branchId])).rows,
    originalEntries:(await pool.query('SELECT * FROM journal_entries WHERE id=ANY($1::bigint[]) ORDER BY id',[f.sourceIds])).rows,
    cutover:await new PgCompanyLedgerRepo(pool).cutoverFor(f.branchId),
    cash:await new PgLedgerRepo(pool).fundBalance(HQ,'company_cash:SYP_NEW'),
    branchCash:await new PgLedgerRepo(pool).fundBalance(f.branchId,'office_cash'),
    branchWallet:await new PgLedgerRepo(pool).fundBalance(f.branchId,'office_wallet'),
    profit:(await new PgCompanyLedgerSource(pool).readOverview(HQ,{from:DAY,to:DAY})).period.SYP_NEW,
  })

  describe('PostgreSQL historical noncash settlement (0097)', () => {
    it('applies exact mixed-direction multi-source groups, preserving cash, profit, historical journals and baseline',async () => {
      const f=await fixture(), before=await snapshot(f), batch=await settle(f)
      expect(await snapshot(f)).toEqual(before)
      const repo=new PgCompanyLedgerRepo(pool)
      expect(await repo.findHistoricalSettlement(batch.id)).toEqual(batch)
      expect(await repo.findHistoricalSettlementBySource(f.sourceIds[1]!)).toEqual(batch)
      expect(await repo.listHistoricalSettlements(HQ,f.branchId)).toEqual([batch])
      expect(await new PgLedgerRepo(pool).fundBalance(HQ,`historical_branch_transit:${f.branchId}`)).toBe(0n)
      expect(await new PgLedgerRepo(pool).fundBalance(HQ,`branch_clearing:${f.branchId}`)).toBe(-89000n)
      expect((await pool.query<{offset:string}>('SELECT ash_historical_restoration_settlement_offset($1)::text AS offset',[f.branchId])).rows[0]!.offset).toBe('89000')
      expect((await pool.query<{n:number}>('SELECT count(*)::int AS n FROM audit_log WHERE table_name=$1',['company_historical_restoration_settlements'])).rows[0]!.n).toBeGreaterThan(0)
      await expect(pool.query('UPDATE company_historical_restoration_settlements SET reason=$1 WHERE id=$2',['silent rewrite',batch.id])).rejects.toMatchObject({code:'23514'})
      await expect(pool.query('DELETE FROM company_historical_restoration_settlement_legs WHERE settlement_id=$1',[batch.id])).rejects.toMatchObject({code:'23514'})
      // A later branch source reversal must not detach the sealed documentary evidence.
      await expect(run(f.branchId,tx=>tx.ledger.post(f.branchId,[{
        eventType:'correction',occurrenceKey:`reversal-of-${f.branchEntries[0]!.id}`,
        lines:f.branchEntries[0]!.lines.map(line=>({fund:line.fundCode==='company_box'?{kind:'company_box'}:{kind:'office_cash'},
          side:line.side==='D'?'C':'D',amount:line.amount})),
      }],meta('Attempt to silently reverse sealed source')))).rejects.toMatchObject({code:'23514',constraint:'company_historical_settled_source_reversal_guard'})
      const entries=await new PgLedgerRepo(pool).findEntriesByIds([...f.sourceIds,f.sourceIds[0]!,999999])
      expect(entries.map(entry=>entry.id)).toEqual([...f.sourceIds].sort((a,b)=>a-b))
      expect(await new PgLedgerRepo(pool).findEntriesByIds([])).toEqual([])
      expect((await new PgCompanyLedgerSource(pool).listHistoricalImportReceipts(HQ,{from:DAY,to:DAY})).filter(source=>source.sourceBranchId===f.branchId).map(source=>source.linkStatus)).toEqual([null,null,null])
    },120_000)
    it('rejects missing HQ source, partial branch evidence, altered amount and stale watermark atomically',async () => {
      const f=await fixture(),before=await snapshot(f)
      for (const mutate of [
        (row:CompanyHistoricalRestorationSettlement)=>{row.legs.splice(1,1);row.groups[0]!.sourceReferences=[f.refs[0]!,f.refs[2]!];row.groups[0]!.companyNet=minor(50000n);row.groups[0]!.variance=minor(40000n)},
        (row:CompanyHistoricalRestorationSettlement)=>{row.groups[0]!.branchSourceEntries.splice(1,1);row.groups[0]!.branchNet=minor(100000n);row.groups[0]!.variance=minor(11000n)},
        (row:CompanyHistoricalRestorationSettlement)=>{row.legs[0]!.amount=minor(60001n);row.groups[0]!.companyNet=minor(89001n);row.groups[0]!.variance=minor(999n)},
        (row:CompanyHistoricalRestorationSettlement)=>{row.cutoverWatermarkEntryId--},
      ]) {
        const row=approved(f);mutate(row)
        await expect(settle(f,row)).rejects.toMatchObject({code:'23514'})
        expect(await snapshot(f)).toEqual(before)
        expect(await new PgCompanyLedgerRepo(pool).findHistoricalSettlement(row.id)).toBeNull()
      }
    },120_000)
    it('rejects cash, branch and profit lines, wrong direction, orphan new-event entries and unauthorized attribution',async () => {
      const f=await fixture(),before=await snapshot(f)
      for (const kind of ['company_cash','company_expense','office_cash'] as const) {
        await expect(settle(f,approved(f),(posting,index)=>index===0?{...posting,lines:posting.lines.map((line,n)=>n===0?{...line,
          fund:kind==='office_cash'?{kind}:kind==='company_expense'?{kind,currency:'SYP_NEW',centre:'general'}:{kind,currency:'SYP_NEW'}}:line)}:posting)).rejects.toMatchObject({code:'23514'})
        expect(await snapshot(f)).toEqual(before)
      }
      await expect(settle(f,approved(f),(posting,index)=>index===0?{...posting,lines:posting.lines.map(line=>({...line,side:line.side==='D'?'C':'D'}))}:posting)).rejects.toMatchObject({code:'23514'})
      await expect(run(f.branchId,tx=>tx.ledger.post(HQ,[historicalRestorationReclassification('to_company',minor(60000n),f.branchId,f.sourceIds[0]!,randomUUID())],meta('Orphan reclassification')))).rejects.toMatchObject({code:'23514'})
      const unauthorized=approved(f);unauthorized.createdBy=manager
      await expect(settle(f,unauthorized)).rejects.toMatchObject({code:'23514'})
      expect(await snapshot(f)).toEqual(before)
    },120_000)
    it('serializes duplicate source adoption and supports stable UUID replay without a second journal',async () => {
      const f=await fixture(),before=await snapshot(f), a=approved(f),b=approved(f)
      const results=await Promise.allSettled([settle(f,a),settle(f,b)])
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
      expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
      const stored=(await new PgCompanyLedgerRepo(pool).listHistoricalSettlements(HQ,f.branchId))[0]!
      expect(await snapshot(f)).toEqual(before)
      expect((await pool.query<{n:number}>(`SELECT count(*)::int AS n FROM journal_entries WHERE event_type::text='company_historical_restoration_reclass' AND occurrence_key LIKE $1`,[`historical-reclass:${stored.id}:%`])).rows[0]!.n).toBe(3)
      // Request replay is a read of the immutable request hash, never re-posting its cash.
      expect((await new PgCompanyLedgerRepo(pool).findHistoricalSettlement(stored.id))?.requestHash).toBe(stored.requestHash)
      await expect(settle(f,approved(f))).rejects.toMatchObject({code:'HISTORICAL_SETTLEMENT_VERSION_CONFLICT'})
    },120_000)
    it('completes a realistic 20-group / 22-HQ / 40-branch batch within the 60-second server budget',async () => {
      const f=await fixture(20),before=await snapshot(f),started=performance.now(),batch=await settle(f),elapsed=performance.now()-started
      expect(batch.groups).toHaveLength(20);expect(batch.legs).toHaveLength(22)
      expect(batch.groups.flatMap(group=>group.branchSourceEntries)).toHaveLength(40)
      expect(await snapshot(f)).toEqual(before)
      expect(elapsed).toBeLessThan(60000)
      console.info(JSON.stringify({historicalSettlementBenchmark:{groups:20,hqSources:22,branchSources:40,elapsedMs:Math.round(elapsed),cashAndProfitUnchanged:true}}))
    },240_000)
    it('rejects extra evidence after early SET CONSTRAINTS validation in the same transaction',async () => {
      const f=await fixture(),before=await snapshot(f),row=approved(f)
      await expect(withTransaction(pool,{actorId:gm,requestId:'early-validation-append-proof'},async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ash:financial:receivables:${f.branchId}`])
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ash:financial:receivables:${HQ}`])
        const bound=bindPoolToTransaction(pool,client,{actorId:gm}),ledger=new PgLedgerRepo(bound)
        for(const leg of row.legs) {
          const [entry]=await ledger.post(HQ,[historicalRestorationReclassification(leg.direction,leg.amount,f.branchId,leg.historicalJournalEntryId,row.id)],meta(row.reason))
          leg.journalEntryId=entry!.id
        }
        await new PgCompanyLedgerRepo(bound).createHistoricalSettlement(row,0)
        await client.query('SET CONSTRAINTS ALL IMMEDIATE')
        await client.query(`INSERT INTO company_historical_restoration_settlement_sources
          (settlement_id,restoration_id,source_entry_id,direction,amount_minor) VALUES($1,$2,$3,'to_company',1)`,[row.id,f.restorationId,f.sourceIds[0]])
      })).rejects.toMatchObject({code:'23514',constraint:'company_historical_settlement_cardinality_guard'})
      expect(await snapshot(f)).toEqual(before)
      expect(await new PgCompanyLedgerRepo(pool).findHistoricalSettlement(row.id)).toBeNull()
    },120_000)
  })
}
