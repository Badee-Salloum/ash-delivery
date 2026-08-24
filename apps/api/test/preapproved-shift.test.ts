import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRANCH,
  DRIVER2_ID,
  DRIVER_ID,
  type Harness,
  NOW_MS,
  OTHER_BRANCH,
  VEHICLE_ID,
  makeHarness,
  syp,
  sypStr,
  today,
} from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const post = async (
  token: string,
  url: string,
  payload: Payload = {},
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

const put = async (
  token: string,
  url: string,
  payload: Payload,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const del = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'DELETE', url, headers: { cookie: h.cookie(token) } })

interface RulePayload extends Payload {
  branchId?: string
  driverId: string
  dates: string[]
  windowStart: string
  windowEnd: string
  cashFloat: string
  walletTopup: string
}

interface RuleView {
  id: string
  branchId: string
  driverId: string
  businessDate: string
  windowStart: string
  windowEnd: string
  cashFloat: string
  walletTopup: string
  active: boolean
  consumedByShiftId: string | null
  consumedAt: string | null
  authorizedBy: string
  createdAt: string
}

const defaultRule = (overrides: Partial<RulePayload> = {}): RulePayload => ({
  branchId: BRANCH,
  driverId: DRIVER_ID,
  dates: [today],
  windowStart: '07:30',
  windowEnd: '08:30',
  cashFloat: '100000.00',
  walletTopup: '50000.00',
  ...overrides,
})

async function createRules(manager: string, overrides: Partial<RulePayload> = {}): Promise<RuleView[]> {
  const response = await post(manager, '/preapproved-shift-rules', defaultRule(overrides))
  expect(response.statusCode, response.body).toBe(201)
  return (response.json() as { rules: RuleView[] }).rules
}

async function listRules(manager: string, branchId = BRANCH): Promise<RuleView[]> {
  const response = await get(manager, `/preapproved-shift-rules?branchId=${encodeURIComponent(branchId)}`)
  expect(response.statusCode, response.body).toBe(200)
  return (response.json() as { rules: RuleView[] }).rules
}

async function createShift(driver: string): Promise<string> {
  const response = await post(driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    // A cached driver bundle may still send this; the server deliberately chooses the real number.
    shiftNo: 1,
  })
  expect(response.statusCode, response.body).toBe(201)
  return (response.json() as { id: string }).id
}

async function submitStart(driver: string, shiftId: string): Promise<LightMyRequestResponse> {
  return await put(driver, `/shifts/${shiftId}/start-package`, {
    odometerKm: 100,
    batteryPercent: 90,
  })
}

const openingEntries = (eventType: 'float_out' | 'wallet_topup') =>
  h.deps.ledger.entries.filter((entry) => entry.eventType === eventType)

async function seedShiftFunding(manager: string): Promise<void> {
  const office = await post(manager, '/journal/manual', {
    reason: 'pre-approved shift carried-funding fixture',
    lines: [
      { fundCode: 'office_cash', side: 'D', amount: sypStr(100_000) },
      { fundCode: 'office_wallet', side: 'D', amount: sypStr(100_000) },
      { fundCode: 'opening_balance', side: 'C', amount: sypStr(200_000) },
    ],
  })
  expect(office.statusCode, office.body).toBe(201)

  for (const [channel, amount, key] of [
    ['cash', sypStr(10_000), '00000000-0000-4000-8000-000000000101'],
    ['wallet', sypStr(3_000), '00000000-0000-4000-8000-000000000102'],
  ] as const) {
    const funding = await post(manager, '/receivables/events', {
      driverId: DRIVER_ID,
      receivableKind: 'shift_funding',
      channel,
      direction: 'create',
      amount,
      reason: 'funding already advanced before the pre-approved shift',
      idempotencyKey: key,
    })
    expect(funding.statusCode, funding.body).toBe(201)
  }
}

describe('pre-approved shift rule management', () => {
  it('expands custom dates, returns canonical rule views, and revokes an unused rule', async () => {
    const manager = await h.loginAs('manager')
    const dates = [today, '2026-07-23']

    const created = await createRules(manager, {
      dates,
      windowStart: '06:15',
      windowEnd: '10:45',
      cashFloat: '125.50',
      walletTopup: '0',
    })

    expect(created).toHaveLength(2)
    expect(created.map((rule) => rule.businessDate).sort()).toEqual(dates)
    for (const rule of created) {
      expect(rule).toMatchObject({
        branchId: BRANCH,
        driverId: DRIVER_ID,
        windowStart: '06:15',
        windowEnd: '10:45',
        cashFloat: '125.50',
        walletTopup: '0.00',
        active: true,
        consumedByShiftId: null,
        consumedAt: null,
        authorizedBy: 'u-bm',
      })
      expect(Number.isNaN(Date.parse(rule.createdAt))).toBe(false)
    }

    const listed = await listRules(manager)
    expect(listed).toHaveLength(2)
    expect(listed.map((rule) => rule.id).sort()).toEqual(created.map((rule) => rule.id).sort())

    const signed = await h.deps.preapprovedShiftRules.findById(created[0]!.id)
    expect(signed).toMatchObject({
      authorizedBy: 'u-bm',
      authorizedByRole: 'branch_manager',
      authorizedByBranchId: BRANCH,
    })
    expect(h.deps.audit.rows.filter((row) =>
      row.tableName === 'preapproved_shift_rules' && row.action === 'INSERT'
    )).toEqual(expect.arrayContaining(created.map((rule) => expect.objectContaining({
      recordId: rule.id,
      actorId: 'u-bm',
      actorKind: 'user',
      branchId: BRANCH,
    }))))

    const removed = await del(
      manager,
      `/preapproved-shift-rules/${created[0]!.id}?branchId=${encodeURIComponent(BRANCH)}`,
    )
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json()).toEqual({ ok: true })
    expect((await listRules(manager)).find((rule) => rule.id === created[0]!.id)?.active).toBe(false)
    expect(h.deps.audit.rows).toContainEqual(expect.objectContaining({
      tableName: 'preapproved_shift_rules',
      recordId: created[0]!.id,
      action: 'UPDATE',
      actorId: 'u-bm',
      branchId: BRANCH,
    }))

    const malformed = await del(
      manager,
      `/preapproved-shift-rules/does-not-exist?branchId=${encodeURIComponent(BRANCH)}`,
    )
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('invalid_request')

    const missing = await del(
      manager,
      `/preapproved-shift-rules/ffffffff-ffff-4fff-8fff-ffffffffffff?branchId=${encodeURIComponent(BRANCH)}`,
    )
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('preapproved_shift_rule_not_found')
  })

  it('rejects inclusive overlap, but a revoked rule no longer blocks the same window', async () => {
    const manager = await h.loginAs('manager')
    const [first] = await createRules(manager, {
      dates: ['2026-07-22'],
      windowStart: '08:00',
      windowEnd: '09:00',
    })

    // Both ends match. Therefore 09:00 belongs to the first rule and this is an overlap.
    const overlap = await post(manager, '/preapproved-shift-rules', defaultRule({
      dates: ['2026-07-22'],
      windowStart: '09:00',
      windowEnd: '10:00',
    }))
    expect(overlap.statusCode).toBe(409)
    expect(overlap.json().error).toBe('preapproved_shift_rule_overlap')

    expect((await del(
      manager,
      `/preapproved-shift-rules/${first!.id}?branchId=${encodeURIComponent(BRANCH)}`,
    )).statusCode).toBe(200)

    const replacement = await post(manager, '/preapproved-shift-rules', defaultRule({
      dates: ['2026-07-22'],
      windowStart: '09:00',
      windowEnd: '10:00',
    }))
    expect(replacement.statusCode, replacement.body).toBe(201)
  })

  it.each([
    ['a negative float', { cashFloat: '-0.01' }],
    ['numeric rather than decimal-string money', { walletTopup: 1 }],
    ['duplicate custom dates', { dates: [today, today] }],
    ['a calendar-shaped date that is not real', { dates: ['2026-02-30'] }],
    ['an empty or wrapping window', { windowStart: '23:00', windowEnd: '01:00' }],
    ['a zero-width window', { windowStart: '08:00', windowEnd: '08:00' }],
  ])('rejects %s at the request boundary', async (_case, patch) => {
    const manager = await h.loginAs('manager')
    const response = await post(manager, '/preapproved-shift-rules', {
      ...defaultRule(),
      ...patch,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('invalid_request')
    expect(await listRules(manager)).toEqual([])
  })

  it('rejects a past custom date and hides a driver outside the selected branch', async () => {
    const manager = await h.loginAs('manager')
    const past = await post(manager, '/preapproved-shift-rules', defaultRule({ dates: ['2026-07-20'] }))
    expect(past.statusCode).toBe(422)
    expect(past.json().error).toBe('preapproved_shift_rule_past_date')

    const otherManager = await h.loginAs('manager2')
    const wrongBranch = await post(otherManager, '/preapproved-shift-rules', defaultRule({
      branchId: OTHER_BRANCH,
    }))
    expect(wrongBranch.statusCode).toBe(404)
    expect(wrongBranch.json().error).toBe('driver_not_found')
  })
})

describe('automatic opening from a pre-approved rule', () => {
  it('does not treat a rule signed after the driver confirmation timestamp as advance approval', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')

    // Publish the rule one second after the confirmation instant used below. This models a manager
    // creating a rule during the best-effort work between the committed signature and rule lookup.
    h.deps.clock.advance(1_000)
    const [rule] = await createRules(manager)
    h.deps.clock.set(NOW_MS)

    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const submitted = await submitStart(driver, shiftId)

    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('awaiting_open_approval')
    expect(await h.deps.preapprovedShiftRules.findById(rule!.id)).toMatchObject({
      active: true,
      consumedByShiftId: null,
    })
    expect(openingEntries('float_out')).toHaveLength(0)
    expect(openingEntries('wallet_topup')).toHaveLength(0)
  })

  it.each([
    ['another driver', { driverId: DRIVER2_ID }],
    ['another custom date', { dates: ['2026-07-22'] }],
    ['outside the local time window', { windowStart: '09:00', windowEnd: '10:00' }],
  ])('does not match %s and follows the normal approval flow', async (_case, rulePatch) => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager, rulePatch)
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')

    const submitted = await submitStart(driver, shiftId)

    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('awaiting_open_approval')
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      state: 'awaiting_open_approval',
      openApprovedBy: null,
    })
    expect(openingEntries('float_out')).toHaveLength(0)
    expect(openingEntries('wallet_topup')).toHaveLength(0)
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)).toMatchObject({
      active: true,
      consumedByShiftId: null,
      consumedAt: null,
    })
  })

  it.each([
    ['start', '08:00', '08:30'],
    ['end', '07:30', '08:00'],
  ])('matches the exact inclusive %s boundary', async (_boundary, windowStart, windowEnd) => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager, {
      windowStart,
      windowEnd,
      cashFloat: '0',
      walletTopup: '0.00',
    })
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')

    const submitted = await submitStart(driver, shiftId)

    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('open')
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      state: 'open',
      openApprovedBy: 'u-bm',
    })
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)?.consumedByShiftId)
      .toBe(shiftId)
  })

  it('waits for complete evidence, then consumes once and posts the manager-authorized funds once', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager)
    const shiftId = await createShift(driver)

    const incomplete = await submitStart(driver, shiftId)
    expect(incomplete.statusCode).toBe(422)
    expect(incomplete.json().error).toBe('start_package_incomplete')
    expect(incomplete.json().detail).toContainEqual({ kind: 'missing_photo', slot: 'odometer' })
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)?.consumedByShiftId)
      .toBeNull()

    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    // Two phone retries race for the same authorization. Exactly one may open and consume it.
    const attempts = await Promise.all([
      submitStart(driver, shiftId),
      submitStart(driver, shiftId),
    ])
    expect(attempts.filter((response) => response.statusCode === 200)).toHaveLength(1)
    expect(attempts.find((response) => response.statusCode === 200)?.json().state).toBe('open')
    expect(attempts.every((response) => response.statusCode === 200 || response.statusCode === 422)).toBe(true)

    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      state: 'open',
      openApprovedBy: 'u-bm',
      floatTranches: [syp(100_000)],
      topupTranches: [syp(50_000)],
    })
    expect(openingEntries('float_out')).toHaveLength(1)
    expect(openingEntries('wallet_topup')).toHaveLength(1)

    const consumed = (await listRules(manager)).find((candidate) => candidate.id === rule!.id)
    expect(consumed).toMatchObject({
      active: true,
      consumedByShiftId: shiftId,
      authorizedBy: 'u-bm',
    })
    expect(consumed?.consumedAt).not.toBeNull()
    expect(Number.isNaN(Date.parse(consumed!.consumedAt!))).toBe(false)

    const cannotDelete = await del(
      manager,
      `/preapproved-shift-rules/${rule!.id}?branchId=${encodeURIComponent(BRANCH)}`,
    )
    expect(cannotDelete.statusCode).toBe(409)
    expect(cannotDelete.json().error).toBe('preapproved_shift_rule_consumed')

    // A consumed rule is immutable evidence, not an active overlap blocker.
    const nextRule = await post(manager, '/preapproved-shift-rules', defaultRule())
    expect(nextRule.statusCode, nextRule.body).toBe(201)
  })

  it('adds current carried cash and wallet funding, and never reuses the consumed rule', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    await seedShiftFunding(manager)
    const [rule] = await createRules(manager)
    const firstShiftId = await createShift(driver)
    await h.uploadPhoto(driver, firstShiftId, 'start', 'odometer')

    const first = await submitStart(driver, firstShiftId)

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({
      state: 'open',
      businessDate: today,
      startPackage: {
        // The driver can enter the order screen from this response without waiting for a poll.
        odometerKm: 100,
        floatTotal: sypStr(110_000),
        topupTotal: sypStr(53_000),
      },
    })
    expect(await h.deps.shifts.findById(firstShiftId)).toMatchObject({
      floatTranches: [syp(100_000)],
      carriedTranches: [syp(10_000)],
      topupTranches: [syp(50_000)],
      carriedWalletTranches: [syp(3_000)],
    })
    expect(openingEntries('float_out').map((entry) => entry.occurrenceKey).sort())
      .toEqual(['1', 'carry-1'])
    expect(openingEntries('wallet_topup').map((entry) => entry.occurrenceKey).sort())
      .toEqual(['1', 'carry-1'])
    expect(await h.deps.ledger.fundBalance(
      BRANCH,
      `driver_shift_funding_cash:${DRIVER_ID}`,
    )).toBe(0n)
    expect(await h.deps.ledger.fundBalance(
      BRANCH,
      `driver_shift_funding_wallet:${DRIVER_ID}`,
    )).toBe(0n)

    const voided = await post(manager, `/shifts/${firstShiftId}/void`, {
      reason: 'first shift cancelled before any work',
    })
    expect(voided.statusCode, voided.body).toBe(200)

    const secondShiftId = await createShift(driver)
    await h.uploadPhoto(driver, secondShiftId, 'start', 'odometer')
    const second = await submitStart(driver, secondShiftId)

    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().state).toBe('awaiting_open_approval')
    expect(await h.deps.shifts.findById(secondShiftId)).toMatchObject({
      state: 'awaiting_open_approval',
      openApprovedBy: null,
    })
    expect(openingEntries('float_out')).toHaveLength(2)
    expect(openingEntries('wallet_topup')).toHaveLength(2)
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)?.consumedByShiftId)
      .toBe(firstShiftId)
  })

  it('rolls back a claimed rule when opening-fund posting fails', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager)
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const failedPost = vi.spyOn(h.deps.ledger, 'post').mockRejectedValueOnce(
      new Error('simulated opening journal failure'),
    )

    const failed = await submitStart(driver, shiftId)
    failedPost.mockRestore()

    expect(failed.statusCode, failed.body).toBe(200)
    expect(failed.json().state).toBe('awaiting_open_approval')
    expect((await h.deps.shifts.findById(shiftId))?.state).toBe('awaiting_open_approval')
    expect(openingEntries('float_out')).toHaveLength(0)
    expect(openingEntries('wallet_topup')).toHaveLength(0)
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)).toMatchObject({
      active: true,
      consumedByShiftId: null,
      consumedAt: null,
    })
  })

  it('does not exercise an old rule after its author loses shift approval permission', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager)
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')

    // Once stored grants exist they replace the seeded fallback. Keep only the permission needed
    // by this driver request; the author no longer has authority to approve a shift automatically.
    h.deps.directory.setGrants([
      { roleKey: 'driver', permissionKey: 'shift.operate', scope: 'own' },
    ])

    const submitted = await submitStart(driver, shiftId)

    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('awaiting_open_approval')
    expect(await h.deps.preapprovedShiftRules.findById(rule!.id)).toMatchObject({
      active: true,
      consumedByShiftId: null,
    })
    expect(openingEntries('float_out')).toHaveLength(0)
    expect(openingEntries('wallet_topup')).toHaveLength(0)
  })

  it('lets exactly one of simultaneous automatic and manual approval win without double-posting', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager)
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')

    const attempts = await Promise.all([
      submitStart(driver, shiftId),
      post(manager, `/shifts/${shiftId}/approve-open`, {
        floatTranches: [sypStr(100_000)],
        topupTranches: [sypStr(50_000)],
      }),
    ])

    expect(attempts.filter((response) => response.statusCode === 200)).toHaveLength(1)
    expect(attempts.every((response) => response.statusCode === 200 || response.statusCode === 422)).toBe(true)
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      state: 'open',
      openApprovedBy: 'u-bm',
      floatTranches: [syp(100_000)],
      topupTranches: [syp(50_000)],
    })
    expect(openingEntries('float_out')).toHaveLength(1)
    expect(openingEntries('wallet_topup')).toHaveLength(1)
    const consumedBy = (await listRules(manager)).find((candidate) => candidate.id === rule!.id)
      ?.consumedByShiftId
    expect(consumedBy === null || consumedBy === shiftId).toBe(true)
  })

  it('leaves a manager-reading BMS handoff awaiting approval and does not consume the rule', async () => {
    const manager = await h.loginAs('manager')
    const driver = await h.loginAs('driver1')
    const [rule] = await createRules(manager)
    const battery = await post(manager, '/batteries', {
      capacityAh: 50,
      vehicleId: VEHICLE_ID,
      slotNo: 1,
    })
    expect(battery.statusCode, battery.body).toBe(201)
    const batteryId = (battery.json() as { id: string }).id
    const shiftId = await createShift(driver)
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const handoff = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    expect(handoff.statusCode, handoff.body).toBe(200)

    const submitted = await put(driver, `/shifts/${shiftId}/start-package`, {
      odometerKm: 100,
      batteryPercent: null,
    })

    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('awaiting_open_approval')
    expect(await h.deps.shifts.findById(shiftId)).toMatchObject({
      state: 'awaiting_open_approval',
      openApprovedBy: null,
    })
    expect(openingEntries('float_out')).toHaveLength(0)
    expect(openingEntries('wallet_topup')).toHaveLength(0)
    expect((await listRules(manager)).find((candidate) => candidate.id === rule!.id)).toMatchObject({
      active: true,
      consumedByShiftId: null,
      consumedAt: null,
    })
  })
})
