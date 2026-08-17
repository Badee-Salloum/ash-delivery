import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptedOcrReader } from '@ash/adapters/memory'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * SRS D-3 trail: the pre-correction OCR values follow the shift to the manager's review, so «the
 * manual edit and its difference from the OCR reading» is computable. Here: the start odometer &
 * battery baselines (readDashboard). Wallet (readWallet) and order fee (readOrders) extend this.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

async function resetWithWalletOcr(value: string): Promise<void> {
  await h.app.close()
  h = await makeHarness({
    ocr: new ScriptedOcrReader([{
      ok: true,
      rows: [{
        printed: value,
        value,
        cancelled: false,
        time: null,
        dateIso: null,
        pointA: null,
        pointB: null,
      }],
      fields: {},
      raw: null,
    }]),
  })
}

async function readAttachedWallet(driver: string, id: string): Promise<void> {
  const draftResponse = await get(driver, `/shifts/${id}/close-draft`)
  expect(draftResponse.statusCode, draftResponse.body).toBe(200)
  const draft = draftResponse.json() as {
    revision: number
    attachments: Array<{ slot: string; mediaId: string; attachmentToken: string }>
  }
  const wallet = draft.attachments.find((attachment) => attachment.slot === 'wallet')
  expect(wallet).toBeDefined()
  const read = await post(driver, `/shifts/${id}/close-draft/media/wallet/read`, {
    expectedRevision: draft.revision,
    mediaId: wallet!.mediaId,
    attachmentToken: wallet!.attachmentToken,
    field: 'wallet',
    retryFailed: false,
  })
  expect(read.statusCode, read.body).toBe(200)
}

async function newDraft(driver: string): Promise<string> {
  return (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
}

describe('OCR D-3 trail — start odometer & battery (readDashboard)', () => {
  it('carries the pre-correction OCR reads to the review, distinct from what the driver confirmed', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newDraft(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    // The driver confirmed 15,320 km / 95% but OCR had read 15,300 / 90 — a real edit.
    const res = await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 15_320,
      batteryPercent: 95,
      odometerKmOcr: 15_300,
      batteryPercentOcr: 90,
    })
    expect(res.statusCode, res.body).toBe(200)

    const start = (await get(manager, `/shifts/${id}/review`)).json().startPackage
    expect(start.odometerKm).toBe(15_320)
    expect(start.odometerKmOcr).toBe(15_300)
    expect(start.batteryPercent).toBe(95)
    expect(start.batteryPercentOcr).toBe(90)
  })

  it('echoes null when OCR never ran (the fields are optional)', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newDraft(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 15_320, batteryPercent: 95 })
    expect(res.statusCode, res.body).toBe(200)

    const start = (await get(manager, `/shifts/${id}/review`)).json().startPackage
    expect(start.odometerKm).toBe(15_320)
    expect(start.odometerKmOcr).toBeNull()
    expect(start.batteryPercentOcr).toBeNull()
  })
})

async function toOpen(driver: string, manager: string): Promise<string> {
  const id = await newDraft(driver)
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  return id
}

describe('OCR D-3 trail — close wallet balance (readWallet)', () => {
  it('carries the wallet OCR baseline to the review, distinct from the declared balance', async () => {
    await resetWithWalletOcr('76509.55')
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), zone: null })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    await readAttachedWallet(driver, id)

    // OCR read 76,509.55 off the wallet screenshot; the driver declared 70,000 — a real edit.
    const res = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 110,
      batteryPercent: 50,
      cashDeclared: sypStr(105_000),
      walletDeclared: sypStr(70_000),
    })
    expect(res.statusCode, res.body).toBe(200)

    const end = (await get(manager, `/shifts/${id}/review`)).json().endPackage
    // Money over the wire is a decimal string, never a JSON number.
    expect(end.walletDeclared).toBe('70000.00')
    expect(end.walletDeclaredOcr).toBe('76509.55')
  })

  it('echoes null when the wallet OCR never ran', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), zone: null })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)

    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 110,
      batteryPercent: 50,
      cashDeclared: sypStr(105_000),
      walletDeclared: sypStr(70_000),
    })
    const end = (await get(manager, `/shifts/${id}/review`)).json().endPackage
    expect(end.walletDeclaredOcr).toBeNull()
  })
})

describe('OCR D-3 trail — order fee (readOrders)', () => {
  it('marks an OCR-scanned order and carries the fee baseline, distinct from the confirmed fee', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)

    // OCR read 335 off «Recent orders»; the driver confirmed 300 — a real edit on a money field.
    const res = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'YAL-20260727-2346',
      payMode: 'cash',
      fee: sypStr(300),
      zone: null,
      source: 'ocr',
      feeOcr: sypStr(335),
    })
    expect(res.statusCode, res.body).toBe(201)

    const orders = (await get(manager, `/shifts/${id}/review`)).json().orders as Array<{ providerOrderNo: string; source: string; fee: string; feeOcr: string | null }>
    const o = orders.find((x) => x.providerOrderNo === 'YAL-20260727-2346')!
    expect(o.source).toBe('ocr')
    expect(o.fee).toBe('300.00')
    expect(o.feeOcr).toBe('335.00') // money over the wire is a decimal string
  })

  it('a typed order defaults to source=manual with no fee baseline', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'TYPED-1', payMode: 'cash', fee: sypStr(5_000), zone: null })

    const orders = (await get(manager, `/shifts/${id}/review`)).json().orders as Array<{ providerOrderNo: string; source: string; feeOcr: string | null }>
    const o = orders.find((x) => x.providerOrderNo === 'TYPED-1')!
    expect(o.source).toBe('manual')
    expect(o.feeOcr).toBeNull()
  })
})
