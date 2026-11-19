import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, OTHER_BRANCH, VEHICLE_ID, type Harness, makeHarness } from './harness.ts'
import { minor, weekStartFor } from '@ash/domain'

let h: Harness
let gm: string
let vehicleId: string
const post = async (url: string, payload: Record<string, unknown>, token = gm) => h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (url: string, token = gm) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const registration = () => ({ idempotencyKey: crypto.randomUUID(), vehicleId, name: 'Motor one', currency: 'USD', price: '1234.56', purchasedOn: null, useStartedOn: '2026-07-01', fundingSource: 'unknown', description: '' })

beforeEach(async () => {
  h = await makeHarness()
  gm = await h.loginAs('gm')
  vehicleId = crypto.randomUUID()
  const original = (await h.deps.directory.vehicle(VEHICLE_ID))!
  h.deps.directory.vehicles.set(vehicleId, { ...original, id: vehicleId, code: '1-1-1-9', machineNo: 9 })
})
afterEach(async () => h.app.close())

describe('existing motor registration is neutral and audit-versioned', () => {
  it('previews and approves a depreciating card edit prospectively, preserving old rows and all cash', async()=>{
    const body={...registration(),price:'1200.00'}
    await post('/company/existing-assets',body)
    await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`,{idempotencyKey:crypto.randomUUID(),expectedVersion:1,startsOn:'2026-07-21',usefulMonths:12,residualValue:'0.00',reason:'Enable from today'})
    const edit={...body,idempotencyKey:crypto.randomUUID(),expectedVersion:2,price:'1420.00',reason:'Correct individual motor price'}
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/edit`,edit)).json().requiresReview).toBe(true)
    const before=structuredClone(h.deps.ledger.entries)
    const preview=await get(`/company/existing-assets/${body.idempotencyKey}/edit-preview?effectiveOn=2026-08-01`)
    expect(preview.statusCode,preview.body).toBe(200)
    expect(preview.json()).toMatchObject({frozenPeriods:1,remainingPeriods:11,futureMonthly:'120.00',cashEffect:'none',requiresJournal:false})
    expect((await get(`/company/existing-assets/${body.idempotencyKey}/edit-preview?effectiveOn=2026-07-25`)).statusCode).toBe(422)
    const confirmation={idempotencyKey:crypto.randomUUID(),expectedVersion:3,requestId:edit.idempotencyKey,effectiveOn:'2026-08-01',reason:'Reviewed no-cash price correction',acknowledged:true}
    const result=await post(`/company/existing-assets/${body.idempotencyKey}/edit-confirm`,confirmation)
    expect(result.statusCode,result.body).toBe(201)
    expect(result.json().asset).toMatchObject({price:'1420.00',pendingEdit:null,version:4})
    expect(result.json().asset.calculatedSchedule.map((row:{amount:string})=>row.amount)).toEqual(['100.00',...Array(11).fill('120.00')])
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/edit-confirm`,confirmation)).statusCode).toBe(200)
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/edit-confirm`,{...confirmation,reason:'different'})).statusCode).toBe(409)
    expect(h.deps.ledger.entries).toEqual(before)
    expect((await get(`/company/existing-assets/${body.idempotencyKey}`)).json().events).toHaveLength(4)
  })
  it('rejects an asset edit with a reason and preserves the effective card and schedule',async()=>{
    const body={...registration(),price:'1200.00'}
    await post('/company/existing-assets',body)
    await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`,{idempotencyKey:crypto.randomUUID(),expectedVersion:1,startsOn:'2026-07-21',usefulMonths:12,residualValue:'0.00',reason:'Enable from today'})
    const edit={...body,idempotencyKey:crypto.randomUUID(),expectedVersion:2,price:'50.00',reason:'Unverified edit'}
    await post(`/company/existing-assets/${body.idempotencyKey}/edit`,edit)
    expect((await get(`/company/existing-assets/${body.idempotencyKey}/edit-preview?effectiveOn=2026-08-01`)).statusCode).toBe(422)
    const result=await post(`/company/existing-assets/${body.idempotencyKey}/edit-reject`,{idempotencyKey:crypto.randomUUID(),expectedVersion:3,requestId:edit.idempotencyKey,reason:'Keep verified original price'})
    expect(result.statusCode,result.body).toBe(201)
    expect(result.json().asset).toMatchObject({price:'1200.00',pendingEdit:null,version:4})
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('documents an unrecognized motor sale by linking its exact existing full receipt, with no financial rewrite', async () => {
    const body = registration()
    await post('/company/existing-assets', body)
    const deposit = await post('/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '800.00', reason: 'Previously received motor sale price' })
    expect(deposit.statusCode, deposit.body).toBe(201)
    const receiptEntryId = deposit.json().command.journalEntryId as number
    const vehicle = await h.deps.directory.vehicle(vehicleId)
    const before = structuredClone(h.deps.ledger.entries)
    const sale = { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, buyer: 'Motor buyer', currency: 'USD', price: '800.00', occurredOn: '2026-07-21', receiptEntryId, reason: 'Confirmed card-only sale, receipt was recorded previously' }
    const eligible = await get('/company/existing-assets/sale-receipts?currency=USD')
    expect(eligible.statusCode, eligible.body).toBe(200)
    expect(eligible.json().receipts).toEqual(expect.arrayContaining([expect.objectContaining({ id: receiptEntryId, amount: '800.00' })]))
    const result = await post(`/company/existing-assets/${body.idempotencyKey}/documentary-sale`, sale)
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json()).toMatchObject({ administrativeOnly: true, cashEffect: 'none', bookGain: null, asset: { status: 'sold', accountingStatus: 'pending_review', bookValue: null, recognition: null, sale: { kind: 'documentary', status: 'confirmed', price: '800.00', receivedAmount: '800.00', receiptEntryId, disposalEntryId: null, debtId: null, bookValue: null } } })
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/documentary-sale`, sale)).statusCode).toBe(200)
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/documentary-sale`, { ...sale, price: '801.00' })).statusCode).toBe(409)
    expect((await get('/company/existing-assets/sale-receipts?currency=USD')).json().receipts).toEqual([])
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyFinance.listDebts(COMPANY_BRANCH)).toEqual([])
    expect(await h.deps.directory.vehicle(vehicleId)).toEqual(vehicle)
    expect((await get(`/company/existing-assets/${body.idempotencyKey}`)).json().events).toHaveLength(2)
    const reversal = await post('/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: deposit.json().command.id, reason: 'Receipt cannot be reversed behind a confirmed sale' })
    expect(reversal.statusCode, reversal.body).toBe(409)
    expect(reversal.json().error).toBe('asset_sale_receipt_correction_required')
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('rejects mismatched, reversed and foreign receipts or administrative sale of an incomplete card', async () => {
    const body = registration()
    await post('/company/existing-assets', body)
    const deposit = await post('/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '800.00', reason: 'Cash source' })
    const receiptEntryId = deposit.json().command.journalEntryId as number
    const sale = { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, buyer: 'Buyer', currency: 'USD', price: '800.00', occurredOn: '2026-07-21', receiptEntryId, reason: 'Sale evidence' }
    for (const change of [{ price: '799.00' }, { currency: 'SYP_NEW' }, { receiptEntryId: 99999 }, { occurredOn: '2026-06-30' }]) {
      expect((await post(`/company/existing-assets/${body.idempotencyKey}/documentary-sale`, { ...sale, ...change })).statusCode).toBe(422)
    }
    expect((await post('/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: deposit.json().command.id, reason: 'Undo unrelated receipt' })).statusCode).toBe(201)
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/documentary-sale`, sale)).statusCode).toBe(422)
    expect((await h.deps.existingAssets.get(body.idempotencyKey))?.status).toBe('registered')
  })
  it('uses one receipt for at most one card under concurrent documentary sale requests', async () => {
    const first = registration(), secondVehicleId = crypto.randomUUID()
    h.deps.directory.vehicles.set(secondVehicleId, { ...(await h.deps.directory.vehicle(VEHICLE_ID))!, id: secondVehicleId, code: '1-1-1-21', machineNo: 21 })
    const second = { ...registration(), vehicleId: secondVehicleId }
    await post('/company/existing-assets', first); await post('/company/existing-assets', second)
    const deposit = await post('/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '800.00', reason: 'One actual sale receipt' })
    const before = structuredClone(h.deps.ledger.entries)
    const sale = () => ({ idempotencyKey: crypto.randomUUID(), expectedVersion: 1, buyer: 'Buyer', currency: 'USD', price: '800.00', occurredOn: '2026-07-21', receiptEntryId: deposit.json().command.journalEntryId, reason: 'Only one card may own the receipt' })
    const results = await Promise.all([post(`/company/existing-assets/${first.idempotencyKey}/documentary-sale`, sale()), post(`/company/existing-assets/${second.idempotencyKey}/documentary-sale`, sale())])
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409])
    expect((await h.deps.existingAssets.list(COMPANY_BRANCH)).filter(card => card.status === 'sold')).toHaveLength(1)
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('canonicalizes uppercase UUIDs before registration, lookup and an exact lowercase retry', async () => {
    const body = registration()
    const uppercase = { ...body, idempotencyKey: body.idempotencyKey.toUpperCase(), vehicleId: body.vehicleId.toUpperCase() }
    const created = await post('/company/existing-assets', uppercase)
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ replayed: false, asset: { id: body.idempotencyKey, vehicleId: body.vehicleId, version: 1 } })
    const retried = await post('/company/existing-assets', body)
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json()).toMatchObject({ replayed: true, asset: { id: body.idempotencyKey, vehicleId: body.vehicleId, version: 1 } })
    const detail = await get(`/company/existing-assets/${body.idempotencyKey.toUpperCase()}`)
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json().events).toHaveLength(1)
    expect(await h.deps.existingAssets.list(COMPANY_BRANCH)).toHaveLength(1)
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('saves manual price with unknown source/date, no journal, debt, funding, FX or forced schedule', async () => {
    const before = structuredClone(h.deps.ledger.entries)
    const body = registration()
    const response = await post('/company/existing-assets', body)
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().asset).toMatchObject({ id: body.idempotencyKey, vehicleId, price: '1234.56', purchasedOn: null, fundingSource: 'unknown', status: 'registered', accountingStatus: 'pending_review', version: 1, depreciation: null, recognition: null, sale: null, calculatedSchedule: [], bookValue: null, cashEffect: { company: '0.00', branch: '0.00', ownerFunding: '0.00' } })
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyFinance.listDebts(COMPANY_BRANCH)).toEqual([])
    expect(await h.deps.companyFinance.listAssets(COMPANY_BRANCH)).toEqual([])
    expect(await h.deps.companyFinance.listAssetSchedule()).toEqual([])
    const detail = await get(`/company/existing-assets/${body.idempotencyKey}`)
    expect(detail.json().events).toHaveLength(1)
    const replay = await post('/company/existing-assets', body)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, asset: { version: 1 } })
    expect((await post('/company/existing-assets', { ...body, price: '1234.57' })).statusCode).toBe(409)
  })
  it('supports a genuine incomplete draft and rejects bad values or invented future dates', async () => {
    const draft = await post('/company/existing-assets', { ...registration(), price: null, useStartedOn: null })
    expect(draft.statusCode, draft.body).toBe(201)
    expect(draft.json().asset).toMatchObject({ status: 'draft', price: null, useStartedOn: null })
    for (const patch of [{ price: '-1.00' }, { price: '0.00' }, { useStartedOn: '2026-02-30' }]) {
      expect((await post('/company/existing-assets', { ...registration(), ...patch })).statusCode).toBe(400)
    }
    for (const patch of [{ useStartedOn: '2026-07-22' }, { purchasedOn: '2026-07-02' }]) {
      expect((await post('/company/existing-assets', { ...registration(), ...patch })).statusCode).toBe(422)
    }
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('limits all actions to general manager/system admin, including a broadened branch grant', async () => {
    const manager = await h.loginAs('manager')
    expect((await post('/company/existing-assets', registration(), manager)).statusCode).toBe(403)
    expect((await get('/company/existing-assets', manager)).statusCode).toBe(403)
    expect((await get('/company/existing-assets/vehicles', manager)).statusCode).toBe(403)
  })
  it('shows all branches and prevents duplicate cards and old cash purchases under races', async () => {
    const otherVehicleId = crypto.randomUUID()
    h.deps.directory.vehicles.set(otherVehicleId, { ...(await h.deps.directory.vehicle(VEHICLE_ID))!, id: otherVehicleId, branchId: OTHER_BRANCH, code: '11-1-1-1' })
    const vehicles = await get('/company/existing-assets/vehicles')
    expect(vehicles.statusCode, vehicles.body).toBe(200)
    expect(vehicles.json().vehicles.some((vehicle: { id: string }) => vehicle.id === otherVehicleId)).toBe(true)
    const results = await Promise.all([post('/company/existing-assets', registration()), post('/company/existing-assets', registration())])
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409])
    const purchase = await post('/company/assets', { idempotencyKey: crypto.randomUUID(), kind: 'vehicle', vehicleId, name: 'Motor one', currency: 'USD', price: '1234.56', purchasedOn: '2026-07-01', paidNow: '1234.56', paidFrom: 'owner_outside', description: 'Do not buy twice' })
    expect(purchase.statusCode, purchase.body).toBe(409)
    expect(h.deps.ledger.entries).toEqual([])
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(0n)
  })
  it('does not register a second card for an existing journal-backed purchase', async () => {
    const purchase = await post('/company/assets', { idempotencyKey: crypto.randomUUID(), kind: 'vehicle', vehicleId, name: 'Motor one', currency: 'USD', price: '1234.56', purchasedOn: '2026-07-01', paidNow: '1234.56', paidFrom: 'owner_outside', description: 'Existing purchase' })
    expect(purchase.statusCode, purchase.body).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    expect((await post('/company/existing-assets', registration())).statusCode).toBe(409)
    expect(h.deps.ledger.entries).toEqual(before)
    expect((await get('/company/existing-assets')).json().legacyAssets).toHaveLength(1)
  })
  it('edits with an immutable reasoned version, stale conflict and exact original retry receipt', async () => {
    const body = registration()
    await post('/company/existing-assets', body)
    const edit = { ...body, idempotencyKey: crypto.randomUUID(), expectedVersion: 1, reason: 'Correct motor price', price: '1400.00', fundingSource: 'owner_outside' }
    const changed = await post(`/company/existing-assets/${body.idempotencyKey}/edit`, edit)
    expect(changed.statusCode, changed.body).toBe(201)
    expect(changed.json().asset).toMatchObject({ price: '1400.00', fundingSource: 'owner_outside', version: 2 })
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/edit`, edit)).statusCode).toBe(200)
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/edit`, { ...edit, idempotencyKey: crypto.randomUUID() })).statusCode).toBe(409)
    expect((await post('/company/existing-assets', body)).json().asset.price).toBe('1234.56')
    const detail = (await get(`/company/existing-assets/${body.idempotencyKey}`)).json()
    expect(detail.events).toHaveLength(2)
    expect(detail.events[0].snapshot.price).toBe('1234.56')
    expect(detail.events[1]).toMatchObject({ expectedVersion: 1, version: 2, reason: 'Correct motor price' })
    expect(h.deps.ledger.entries).toEqual([])
  })
  it('activates configurable depreciation only explicitly, and cannot silently restate prior months', async () => {
    const body = { ...registration(), price: '100.01' }
    await post('/company/existing-assets', body)
    const activate = { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, startsOn: '2026-07-21', usefulMonths: 5, residualValue: '10.00', reason: 'Reviewed use date and useful life' }
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`, { ...activate, startsOn: '2026-07-20' })).statusCode).toBe(422)
    const result = await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`, activate)
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json().asset.calculatedSchedule.map((row: { amount: string }) => row.amount)).toEqual(['18.00', '18.00', '18.00', '18.00', '18.01'])
    expect(result.json().asset).toMatchObject({ depreciationExpensePosted: false, bookValue: null, paymentStatus: 'not_documented' })
    expect(result.json().asset.depreciation).toMatchObject({ startsOn: '2026-07-21', activatedOn: '2026-07-21' })
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`, activate)).statusCode).toBe(200)
    const proposal = await post(`/company/existing-assets/${body.idempotencyKey}/edit`, { ...body, idempotencyKey: crypto.randomUUID(), expectedVersion: 2, price: '101.00', reason: 'Request reviewed cost correction' })
    expect(proposal.statusCode, proposal.body).toBe(201)
    expect(proposal.json()).toMatchObject({ requiresReview: true, asset: { price: '100.01', version: 3, pendingEdit: { price: '101.00', sourceVersion: 2 } } })
    expect(h.deps.ledger.entries).toEqual([])
    const secondVehicle = crypto.randomUUID()
    h.deps.directory.vehicles.set(secondVehicle, { ...(await h.deps.directory.vehicle(VEHICLE_ID))!, id: secondVehicle, code: '1-1-1-20' })
    const other = { ...registration(), vehicleId: secondVehicle, useStartedOn: '2026-05-01' }
    await post('/company/existing-assets', other)
    expect((await post(`/company/existing-assets/${other.idempotencyKey}/depreciation/activate`, { ...activate, idempotencyKey: crypto.randomUUID(), startsOn: '2026-05-01' })).statusCode).toBe(422)
  })
  it('links evidence without allocating any cash and rolls back the full revision on failure', async () => {
    const deposit = await post('/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'USD', amount: '1500.00', reason: 'Existing source evidence' })
    const operation = deposit.json().command
    const body = registration()
    await post('/company/existing-assets', body)
    const before = structuredClone(h.deps.ledger.entries)
    const evidence = { idempotencyKey: crypto.randomUUID().toUpperCase(), expectedVersion: 1, operationId: String(operation.id).toUpperCase(), journalEntryId: operation.journalEntryId, description: 'Documentation only', reason: 'Link source receipt' }
    const added = await post(`/company/existing-assets/${body.idempotencyKey}/evidence`, evidence)
    expect(added.statusCode, added.body).toBe(201)
    expect(h.deps.ledger.entries).toEqual(before)
    const detail = (await get(`/company/existing-assets/${body.idempotencyKey}`)).json()
    expect(detail.evidence).toHaveLength(1)
    expect(detail.evidence[0]).toMatchObject({ id: evidence.idempotencyKey.toLowerCase(), operationId: operation.id })
    expect(detail.evidence[0]).not.toHaveProperty('allocatedAmount')
    expect(await h.deps.existingAssets.linkedToOperation(operation.id, operation.journalEntryId)).toHaveLength(1)
    h.deps.existingAssets.addEvidence = async () => { throw new Error('Simulated evidence insert failure') }
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/evidence`, { ...evidence, idempotencyKey: crypto.randomUUID(), expectedVersion: 2 })).statusCode).toBe(500)
    expect((await h.deps.existingAssets.get(body.idempotencyKey))?.version).toBe(2)
    expect(await h.deps.existingAssets.listEvents(body.idempotencyKey)).toHaveLength(2)
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('saves sale for review without cash, debt, disposal or vehicle mutation and blocks unreviewed final sale', async () => {
    const body = registration()
    await post('/company/existing-assets', body)
    const vehicle = await h.deps.directory.vehicle(vehicleId)
    const saleBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, buyer: 'Buyer one', currency: 'USD', price: '1500.00', occurredOn: '2026-07-20', receivedAmount: '500.00', receiptDestination: 'owner_outside', reason: 'Pending ownership and receipt review' }
    const sale = await post(`/company/existing-assets/${body.idempotencyKey}/sales`, saleBody)
    expect(sale.statusCode, sale.body).toBe(201)
    expect(sale.json().asset).toMatchObject({ status: 'registered', sale: { status: 'draft', receivedAmount: '500.00', bookValue: null } })
    const confirm = await post(`/company/existing-assets/${body.idempotencyKey}/sales/${saleBody.idempotencyKey}/confirm`, { idempotencyKey: crypto.randomUUID(), expectedVersion: 2, disposalEntryId: 99, reason: 'Cannot assume approved cost' })
    expect(confirm.statusCode, confirm.body).toBe(422)
    expect(confirm.json().error).toBe('asset_sale_recognition_required')
    expect(h.deps.ledger.entries).toEqual([])
    expect(await h.deps.companyFinance.listDebts(COMPANY_BRANCH)).toEqual([])
    expect(await h.deps.directory.vehicle(vehicleId)).toEqual(vehicle)
  })
  it('links only exact reviewed recognition and disposal facts, confirms once, stops future schedule, and preserves the fleet', async () => {
    const body = { ...registration(), price: '1000.00' }
    await post('/company/existing-assets', body)
    // Imported immutable accounting fixtures. The registration API must never create these.
    const actor = (await h.deps.existingAssets.get(body.idempotencyKey))!.createdBy
    const assetCode = `fixed_asset:USD:${body.idempotencyKey}`
    h.deps.ledger.entries.push({ id: 90, branchId: COMPANY_BRANCH, eventType: 'asset_purchase', shiftId: null, occurrenceKey: body.idempotencyKey, externalReference: null, businessDate: '2026-07-01', postingDate: '2026-07-01', weekStartDate: weekStartFor('2026-07-01'), fxDayId: 1, sypMinorPerUsd: 13000n, weekLockId: null, reason: 'Imported reviewed cost', createdBy: actor, createdAtMs: h.deps.clock.nowMs(), lines: [
      { fundCode: assetCode, side: 'D', amount: minor(100000n), currency: 'USD' },
      { fundCode: 'company_equity:USD:owner_funding', side: 'C', amount: minor(100000n), currency: 'USD' },
    ] })
    const recognitionBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: 1, journalEntryId: 90, cost: '1000.00', accumulatedDepreciation: '0.00', asOf: '2026-07-01', reason: 'Link imported reviewed ownership and cost' }
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/recognition`, { ...recognitionBody, cost: '999.00' })).statusCode).toBe(422)
    const recognized = await post(`/company/existing-assets/${body.idempotencyKey}/recognition`, recognitionBody)
    expect(recognized.statusCode, recognized.body).toBe(201)
    expect(recognized.json().asset).toMatchObject({ accountingStatus: 'approved', bookValue: '1000.00', bookValueStatus: 'approved_baseline_only' })
    const activation = await post(`/company/existing-assets/${body.idempotencyKey}/depreciation/activate`, { idempotencyKey: crypto.randomUUID(), expectedVersion: 2, startsOn: '2026-07-21', usefulMonths: 10, residualValue: '0.00', reason: 'Approve a calculation, not reserve cash' })
    expect(activation.statusCode, activation.body).toBe(201)
    h.deps.ledger.entries.push({ id: 91, branchId: COMPANY_BRANCH, eventType: 'company_income', shiftId: null, occurrenceKey: crypto.randomUUID(), externalReference: null, businessDate: '2026-07-20', postingDate: '2026-07-20', weekStartDate: weekStartFor('2026-07-20'), fxDayId: 1, sypMinorPerUsd: 13000n, weekLockId: null, reason: 'Imported reviewed disposal with gain only', createdBy: actor, createdAtMs: h.deps.clock.nowMs(), lines: [
      { fundCode: 'company_cash:USD', side: 'D', amount: minor(150000n), currency: 'USD' },
      { fundCode: assetCode, side: 'C', amount: minor(100000n), currency: 'USD' },
      { fundCode: 'company_income:USD:general', side: 'C', amount: minor(50000n), currency: 'USD' },
    ] })
    const saleBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: 3, buyer: 'Buyer one', currency: 'USD', price: '1500.00', occurredOn: '2026-07-20', receivedAmount: '1500.00', receiptDestination: 'company', receiptEntryId: 91, reason: 'Link existing disposal cash, not a second receipt' }
    const draft = await post(`/company/existing-assets/${body.idempotencyKey}/sales`, saleBody)
    expect(draft.statusCode, draft.body).toBe(201)
    const vehicle = await h.deps.directory.vehicle(vehicleId)
    const before = structuredClone(h.deps.ledger.entries)
    const confirmBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: 4, disposalEntryId: 91, reason: 'Confirm the existing reviewed journal' }
    const confirmed = await post(`/company/existing-assets/${body.idempotencyKey}/sales/${saleBody.idempotencyKey}/confirm`, confirmBody)
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(confirmed.json().asset).toMatchObject({ status: 'sold', depreciationStoppedOn: '2026-07-20', calculatedSchedule: [], bookValue: '0.00', bookValueStatus: 'disposed', sale: { status: 'confirmed', bookValue: '1000.00' } })
    expect((await post(`/company/existing-assets/${body.idempotencyKey}/sales/${saleBody.idempotencyKey}/confirm`, confirmBody)).statusCode).toBe(200)
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.directory.vehicle(vehicleId)).toEqual(vehicle)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:USD')).toBe(150000n)
  })
})
