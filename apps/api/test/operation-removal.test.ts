import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr, today } from './harness.ts'

/**
 * «احذف الصفّ» — a manager saying a row is not a delivery at all, and the system admin being told.
 *
 * Owner, 2026-09-01, after shift a3728815 counted one delivery twice because a page seam faded the
 * top off a ٣ and 330 came back as 230: «add the possibility for the manager to remove an order but
 * this should be reported to the system admin in a clear place and way». Both halves are
 * load-bearing. A removal nobody is told about is the failure this feature exists to prevent, not a
 * lesser version of it, so the report is tested as hard as the removal.
 *
 * «مستبعَد» and «محذوف» stay different things, which is what the owner chose: exclusion is an
 * accounting decision about a delivery that happened; removal says the row describes nothing that
 * did. The money treats them identically ON PURPOSE — a removed row is forced to `included: false`,
 * so it leaves the arithmetic through the one door that was already tested, and the figures after a
 * removal must equal the figures after excluding the same row to the lira. That is pinned below.
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

/** A shift at the close gate carrying two orders — one real, one the phantom to be removed. */
async function pendingReview(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: [
      {
        clientKey: 'removal-real', providerOrderNo: 'REAL-1', payMode: 'cash', fee: sypStr(5_000),
        occurredDate: today, occurredMinute: '08:00',
      },
      {
        clientKey: 'removal-phantom', providerOrderNo: 'PHANTOM-1', payMode: 'cash', fee: sypStr(3_000),
        occurredDate: today, occurredMinute: '09:00',
      },
    ],
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 110,
    batteryPercent: 50,
    cashDeclared: sypStr(105_000),
    walletDeclared: sypStr(-1_000),
  })
  return id
}

const REASON = 'قراءة مقصوصة لصفّ آخر — سجلّ المدفوعات يُظهر حسماً واحداً'

describe('a manager removes a row that is not a delivery', () => {
  it('takes it out of the money exactly as excluding it would', async () => {
    // The whole safety argument for this feature. Removal adds MEANING and a report; it must add no
    // second way for money to move. If these two ever disagree, some path learned about removal
    // that should only ever have looked at `included`.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const excluded = await pendingReview(driver, manager)
    expect((await post(manager, `/shifts/${excluded}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', included: false, reason: REASON }],
    })).statusCode).toBe(200)
    const afterExclude = (await get(manager, `/shifts/${excluded}/review`)).json()

    await h.app.close()
    h = await makeHarness()
    const driver2 = await h.loginAs('driver1')
    const manager2 = await h.loginAs('manager')
    const removed = await pendingReview(driver2, manager2)
    expect((await post(manager2, `/shifts/${removed}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })).statusCode).toBe(200)
    const afterRemove = (await get(manager2, `/shifts/${removed}/review`)).json()

    expect(afterRemove.br1.difference).toBe(afterExclude.br1.difference)
    expect(afterRemove.br1.cashDifference).toBe(afterExclude.br1.cashDifference)
    expect(afterRemove.br1.walletDifference).toBe(afterExclude.br1.walletDifference)
  })

  it('marks the row rather than deleting it, and takes it out of the count', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)

    expect((await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })).statusCode).toBe(200)

    const review = (await get(manager, `/shifts/${id}/review`)).json()
    const phantom = review.orders.find((order: any) => order.providerOrderNo === 'PHANTOM-1')
    // Still there — a row that is gone cannot be reported, reviewed, or restored.
    expect(phantom, 'the row must survive its own removal').toBeDefined()
    expect(phantom.removedAt).not.toBeNull()
    expect(phantom.removalReason).toBe(REASON)
    // And out of the money, which the database refuses to let it be otherwise.
    expect(phantom.included).toBe(false)
    // The real one is untouched.
    expect(review.orders.find((order: any) => order.providerOrderNo === 'REAL-1').removedAt).toBeNull()
  })

  it('carries the attributed decision the database demands of any inclusion change', async () => {
    /*
     * `guard_shift_order_window_decision_reason` (migration 0054) refuses ANY change to `included`
     * unless the row also gains a visibly non-blank reason, a `decided_by` equal to the transaction
     * actor, and a `decided_at` DIFFERENT from the one before. A removal changes `included`, so it
     * must satisfy all three.
     *
     * This is here because no in-memory test can fail on the trigger — the memory adapter has none.
     * The first draft of this feature passed 902 tests and was refused by production Postgres on
     * the first rehearsal. What is pinned here is the shape that survived it.
     */
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)
    const before = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'PHANTOM-1')!

    expect((await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })).statusCode).toBe(200)

    const after = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'PHANTOM-1')!
    expect(after.decisionReason, 'the guard reads decision_reason, not removal_reason').toBe(REASON)
    expect(after.decidedBy).not.toBeNull()
    expect(after.decidedAt).not.toBe(before.decidedAt)
  })

  it('refuses a removal with no readable reason', async () => {
    // `nonblankReasonSchema`, not a trim: an Arabic-first UI carries invisible bidi marks through
    // copy-paste, and `'‏'.trim()` is truthy — so a reason nobody can read used to be an audit trail.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)

    for (const reason of ['', '   ', '‏']) {
      const response = await post(manager, `/shifts/${id}/operations/revise`, {
        orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason }],
      })
      expect([400, 422], `reason ${JSON.stringify(reason)} was accepted`).toContain(response.statusCode)
    }
  })

  it('writes the register the system admin reads', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const admin = await h.loginAs('sysadmin')
    const id = await pendingReview(driver, manager)

    expect((await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })).statusCode).toBe(200)

    const register = await get(admin, '/operation-removals')
    expect(register.statusCode, register.body).toBe(200)
    const rows = register.json().rows
    expect(rows).toHaveLength(1)
    // Everything a person needs to judge it without opening the shift.
    expect(rows[0]).toMatchObject({
      kind: 'removed',
      operationKind: 'order',
      operationRef: 'PHANTOM-1',
      shiftId: id,
      businessDate: today,
      amount: sypStr(3_000),
      reason: REASON,
    })
    expect(rows[0].actedByName, 'the register must name who did it').toBeTruthy()
  })

  it('rings the system admin, who is a recipient of nothing else in this system', async () => {
    // A system admin has `branch_id = NULL`, and every other producer addresses `branch:<id>` — so
    // before this he could not receive a notification at all. That is why «tell the system admin»
    // needed more than one line of code.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const admin = await h.loginAs('sysadmin')
    const id = await pendingReview(driver, manager)

    expect((await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })).statusCode).toBe(200)

    const bell = await get(admin, '/notifications')
    expect(bell.statusCode, bell.body).toBe(200)
    const removal = (bell.json().rows ?? bell.json().notifications ?? []).find(
      (row: any) => row.kind === 'operation_removed',
    )
    expect(removal, 'the system admin must be told').toBeDefined()
    expect(removal.payload.operationRef).toBe('PHANTOM-1')
    expect(removal.payload.reason).toBe(REASON)
  })

  it('records a restore as its own entry rather than editing the first', async () => {
    // «removed, then put back» is two acts by two people for two reasons. One row could only tell
    // half of it, and the register is append-only in the database precisely so it cannot try.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const admin = await h.loginAs('sysadmin')
    const id = await pendingReview(driver, manager)

    await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: true, reason: REASON }],
    })
    const restored = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'PHANTOM-1', removed: false, reason: 'الصورة أثبتت أنها توصيلة حقيقية' }],
    })
    expect(restored.statusCode, restored.body).toBe(200)

    const rows = (await get(admin, '/operation-removals')).json().rows
    expect(rows.map((row: any) => row.kind)).toEqual(['restored', 'removed'])

    const review = (await get(manager, `/shifts/${id}/review`)).json()
    const phantom = review.orders.find((order: any) => order.providerOrderNo === 'PHANTOM-1')
    expect(phantom.removedAt).toBeNull()
    // Restoring clears the flag; it does NOT put the money back. Re-including is its own decision,
    // and inferring it here would let one click both clear a flag and change a total.
    expect(phantom.included).toBe(false)
  })

  it('keeps the register away from a branch manager', async () => {
    // `audit.view` is granted to system_admin and general_manager only. A branch manager may remove
    // a row; the register exists so somebody ELSE reads what he did.
    const manager = await h.loginAs('manager')
    const response = await get(manager, '/operation-removals')
    expect(response.statusCode).toBe(403)
  })
})
