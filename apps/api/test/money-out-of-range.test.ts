import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScriptedOcrReader } from '@ash/adapters/memory'
import type { OcrReader } from '@ash/contracts'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr, today } from './harness.ts'

/**
 * The production incident, pinned.
 *
 * A driver finished a shift whose equation read «الفرق 0.00» and could not hand it over: the close
 * answered «تعذّر تنفيذ العملية». The server was throwing 500 on
 *
 *   value "82296150060611100000226021100101000" is out of range for type bigint
 *
 * — the wallet OCR baseline. `readWallet` keeps every digit in the text and concatenates them, so a
 * crop with the whole wallet card produced a thirty-five digit number; `moneySchema`'s regex bounds
 * the shape but not the magnitude, so it passed validation and died at the database.
 *
 * Two rules come out of it, and they pull in opposite directions on purpose:
 *   * the OCR baseline is EVIDENCE — an unusable reading is no reading, and it must never stop a
 *     correct shift from closing;
 *   * every figure the EQUATION is made of is money — an unstorable one is refused, loudly, because
 *     quietly substituting null there would be inventing a number.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (t: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(t, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })

/** The unstorable figure exactly as production sent it. */
const OUT_OF_RANGE = '82296150060611100000226021100101000'

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

async function readAttachedWallet(driver: string, id: string, retryFailed = false): Promise<void> {
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
    retryFailed,
  })
  expect(read.statusCode, read.body).toBe(200)
}

async function shiftReadyToClose(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
    .id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: [{
      clientKey: 'money-range-a1', providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000),
      occurredDate: today, occurredMinute: '08:00',
    }],
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  return id
}

/** float 100,000 + one 5,000 cash fee → cash 105,000, wallet −1,000. Difference 0.00. */
const BALANCED = { odometerKm: 110, batteryPercent: 50, cashDeclared: sypStr(105_000), walletDeclared: sypStr(-1_000) }

describe('money the system cannot store', () => {
  it('closes the shift anyway when it is only the OCR baseline that is unreadable', async () => {
    await resetWithWalletOcr(OUT_OF_RANGE)
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await shiftReadyToClose(driver, manager)
    await readAttachedWallet(driver, id)

    const res = await put(driver, `/shifts/${id}/end-package`, BALANCED)

    expect(res.statusCode).toBe(200)
    // The equation is untouched by the misread — this is the shift the driver was blocked on.
    expect(res.json().br1.difference).toBe('0.00')
    expect(res.json().br1.balanced).toBe(true)

    // And the unusable reading is stored as what it is: no reading. Not a truncated number, and not
    // the garbage either — a baseline nobody can trust must not be shown to the manager as a fact.
    const review = (await get(manager, `/shifts/${id}/review`)).json()
    expect(review.endPackage.walletDeclaredOcr).toBeNull()
    expect(review.endPackage.walletDeclared).toBe(sypStr(-1_000))
  })

  it('refuses it as a declared figure — those are what the equation is made of', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await shiftReadyToClose(driver, manager)

    const cash = await put(driver, `/shifts/${id}/end-package`, { ...BALANCED, cashDeclared: OUT_OF_RANGE })
    expect(cash.statusCode).toBe(400)
    expect(cash.json().error).toBe('invalid_request')

    const wallet = await put(driver, `/shifts/${id}/end-package`, { ...BALANCED, walletDeclared: OUT_OF_RANGE })
    expect(wallet.statusCode).toBe(400)

    // A rejected close writes nothing: the shift is still the driver's to finish.
    expect((await get(manager, `/shifts/${id}/review`)).json().state).toBe('open')
  })

  it('keeps the last storable wallet baseline when a same-photo reread is out of range', async () => {
    await h.app.close()
    let walletCalls = 0
    const reader: OcrReader = {
      available: true,
      model: 'wallet-range-regression',
      cacheSignature: (field) => `wallet-range-regression-v1:${field}`,
      read: async ({ field }) => {
        if (field !== 'wallet') {
          return {
            result: { ok: true, rows: [], fields: field === 'odometer' ? { odometer: '110' } : {}, raw: null },
            usage: { tokensIn: 1, tokensOut: 1, latencyMs: 1 },
          }
        }
        walletCalls += 1
        const value = walletCalls === 1 ? '76509.55' : OUT_OF_RANGE
        return {
          result: {
            ok: true,
            ...(walletCalls === 1 ? { retryable: true } : {}),
            rows: [{
              printed: value, value, cancelled: false,
              time: null, dateIso: null, pointA: null, pointB: null,
            }],
            fields: {},
            raw: null,
          },
          usage: { tokensIn: 1, tokensOut: 1, latencyMs: 1 },
        }
      },
    }
    h = await makeHarness({
      ocr: reader,
    })
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await shiftReadyToClose(driver, manager)

    await readAttachedWallet(driver, id)
    await readAttachedWallet(driver, id, true)
    expect(walletCalls).toBe(2)
    const res = await put(driver, `/shifts/${id}/end-package`, BALANCED)

    expect(res.statusCode, res.body).toBe(200)
    expect((await get(manager, `/shifts/${id}/review`)).json().endPackage.walletDeclaredOcr)
      .toBe('76509.55')
  })

  it('refuses it as a fee — 400 at the edge, never a 500 from the database', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await shiftReadyToClose(driver, manager)

    const res = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: 'A-2',
      payMode: 'cash',
      fee: OUT_OF_RANGE,
    })
    expect(res.statusCode).toBe(400)
    expect(await h.deps.orders.findByProviderNo('A-2')).toBeNull()
  })

  it('still accepts the largest figure that genuinely fits', async () => {
    await resetWithWalletOcr('92233720368547758.07')
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await shiftReadyToClose(driver, manager)
    await readAttachedWallet(driver, id)

    // 9,223,372,036,854,775,807 minor units — the top of a Postgres bigint, to the cent.
    const res = await put(driver, `/shifts/${id}/end-package`, {
      ...BALANCED,
    })
    expect(res.statusCode).toBe(200)
    expect((await get(manager, `/shifts/${id}/review`)).json().endPackage.walletDeclaredOcr).toBe('92233720368547758.07')
  })
})
