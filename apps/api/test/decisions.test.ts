import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Manager decisions and the decision log (SRS C-7). Until now the manager could only APPROVE;
 * the domain modelled a re-shoot request and a reject with nowhere to fire them, and the
 * «سجل قرارات» was never written. These pin: the re-shoot/reject transitions, the driver being
 * told WHY, the log recording every decision, and that only an approver may fire them.
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
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

/** Drive a shift to `pending_review` (float 100k, no orders). BR1 need not balance to get there —
 * the end-package gate is completeness only; the manager reviews after. */
async function toPendingReview(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  const open = await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  expect(open.statusCode, open.body).toBe(200)
  await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000), zone: null })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  const end = await put(driver, `/shifts/${id}/end-package`, { odometerKm: 110, batteryPercent: 50, cashDeclared: sypStr(100_000), walletDeclared: sypStr(0) })
  expect(end.statusCode, end.body).toBe(200)
  expect(end.json().state).toBe('pending_review')
  return id
}

describe('manager decisions (C-7)', () => {
  it('a re-shoot request sends the shift back to the driver, logs it, and tells him why', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    const res = await post(manager, `/shifts/${id}/request-rephoto`, { notes: 'صورة العداد غير واضحة' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('open') // pending_review → open (re-do the end package)

    const decision = h.deps.decisions.rows.find((d) => d.shiftId === id && d.decision === 'rephoto_requested')
    expect(decision).toMatchObject({ gate: 'close', notes: 'صورة العداد غير واضحة' })

    // The driver's OWN bell rings with the reason.
    const note = h.deps.notifications.rows.find((n) => n.recipientId === 'u-d1' && n.kind === 'shift_rephoto_requested')
    expect(note?.payload).toMatchObject({ shiftId: id, notes: 'صورة العداد غير واضحة' })

    // And the driver reads the reason off his own /state.
    const state = await h.app.inject({ method: 'GET', url: `/shifts/${id}/state`, headers: { cookie: h.cookie(driver) } })
    expect(state.json().lastDecision).toMatchObject({ decision: 'rephoto_requested', notes: 'صورة العداد غير واضحة' })
  })

  it('a reject returns the close to open so the driver can correct and resubmit', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    const res = await post(manager, `/shifts/${id}/reject-close`, { notes: 'النقد لا يطابق' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('open')
    expect(h.deps.decisions.rows.some((d) => d.shiftId === id && d.decision === 'rejected')).toBe(true)
  })

  it('the decision log records every decision and the review lists it newest-first', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)
    await post(manager, `/shifts/${id}/request-rephoto`, { notes: 'first' })

    const review = await h.app.inject({ method: 'GET', url: `/shifts/${id}/review`, headers: { cookie: h.cookie(manager) } })
    const decisions = review.json().decisions as Array<{ decision: string; notes: string | null }>
    // The open approval, then the re-shoot request — newest first.
    expect(decisions[0]).toMatchObject({ decision: 'rephoto_requested', notes: 'first' })
    expect(decisions.some((d) => d.decision === 'approved')).toBe(true) // the earlier approve-open
  })

  it('a driver may not request a re-shoot or reject — that is the approver’s act', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)
    expect((await post(driver, `/shifts/${id}/request-rephoto`, { notes: 'x' })).statusCode).toBe(403)
    expect((await post(driver, `/shifts/${id}/reject-close`, { notes: 'x' })).statusCode).toBe(403)
  })
})

/**
 * The manager corrects a closing figure at the review.
 *
 * The close is read off the driver's screenshots rather than typed, so a reader that misses used to
 * leave the manager with only two blunt tools: bounce the whole shift back to the driver, or
 * force-close it — which bypasses BR1 entirely. Neither is the right answer to one wrong odometer.
 */
describe('revising the closing figures (C-7)', () => {
  it('re-runs BR1 against the corrected figure and leaves the shift UNDER REVIEW', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    // The shift has a 100,000 float and one 5,000 cash order, so the equation expects 105,000 in
    // cash; the driver declared 100,000. Correcting the figure moves the cash difference to zero.
    const fixed = await post(manager, `/shifts/${id}/close-figures`, { cashDeclared: sypStr(105_000) })
    expect(fixed.statusCode, fixed.body).toBe(200)
    expect(fixed.json().state).toBe('pending_review') // it supplies numbers; it does NOT approve
    expect(fixed.json().br1.cashDifference).toBe('0.00')

    const shift = (await h.deps.shifts.findById(id))!
    expect(shift.endCashDeclared).toBe(10_500_000n)
    expect(shift.state).toBe('pending_review')
  })

  it('corrects the odometer without touching the money', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)
    const before = (await h.deps.shifts.findById(id))!

    expect((await post(manager, `/shifts/${id}/close-figures`, { odometerKm: 1_234 })).statusCode).toBe(200)
    const after = (await h.deps.shifts.findById(id))!
    expect(after.odoEnd).toBe(1_234)
    expect(after.endCashDeclared).toBe(before.endCashDeclared) // omitted fields are left alone
  })

  it('is audited, and a driver may not do it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toPendingReview(driver, manager)

    expect((await post(driver, `/shifts/${id}/close-figures`, { odometerKm: 9_999 })).statusCode).toBe(403)
    expect((await post(manager, `/shifts/${id}/close-figures`, { odometerKm: 1_234 })).statusCode).toBe(200)

    const audited = await h.deps.audit.list({ tableName: 'shifts', recordId: id })
    expect(audited.some((a) => (a.after as { revisedByManager?: boolean })?.revisedByManager === true)).toBe(true)
  })
})
