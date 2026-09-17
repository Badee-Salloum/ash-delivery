import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { type MemoryDeps, createMemoryDeps } from '@ash/adapters/memory'
import type { OcrReader } from '@ash/contracts'
import { type Minor, businessDateFor, minor } from '@ash/domain'
import { buildApp } from '../src/app.ts'
import { SESSION_COOKIE } from '../src/auth.ts'

export const BRANCH = 'branch-damascus'
export const OTHER_BRANCH = 'branch-aleppo'
export const DRIVER_ID = 'driver-1'
export const DRIVER2_ID = 'driver-2'
export const VEHICLE_ID = 'vehicle-1'
export const VEHICLE_TYPE = 'vtype-e-motorbike'
export const GOV_DAMASCUS = 'gov-damascus'
export const GOV_ALEPPO = 'gov-aleppo'

/** 2026-07-21, 08:00 Damascus (UTC+3) — a Tuesday, mid-week, so week logic is unambiguous. */
export const NOW_MS = Date.UTC(2026, 6, 21, 5, 0, 0)

export const syp = (n: number): Minor => minor(BigInt(n) * 100n)
export const sypStr = (n: number): string => `${n}.00`

/** A genuine 1x1 JPEG. Magic bytes matter — the API sniffs them and rejects anything else. */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

export interface CloseDraftFinancialFixture {
  managerToken: string
  orders?: Array<{
    clientKey: string
    providerOrderNo: string
    payMode: 'cash' | 'electronic' | 'free'
    fee: string
    occurredDate: string
    occurredMinute: string
    pointA?: string | null
    pointB?: string | null
    included?: boolean
    walletAmount?: string | null
  }>
  cashDeductions?: Array<{
    clientKey: string
    operationKey: string
    amount: string
    occurredDate: string
    occurredMinute: string
    pointA?: string | null
    pointB?: string | null
    included?: boolean
  }>
  movements?: Array<{
    clientKey: string
    amount: string
    occurredMinute?: string | null
    role?: 'unmatched' | 'corroboration'
    providerOrderNo?: string | null
    ambiguous?: boolean
    notes?: string | null
  }>
}

export interface Harness {
  app: FastifyInstance
  deps: MemoryDeps
  loginAs(username: string): Promise<string>
  cookie(token: string): string
  /** Upload one evidence photo. Returns the parsed response body. */
  uploadPhoto(
    token: string,
    shiftId: string,
    pkg: 'start' | 'end',
    slot: string,
    bytes?: Buffer,
  ): Promise<Record<string, unknown>>
  /** Persist the driver's closing figures into the durable draft, then submit its exact identity. */
  submitEndPackage(
    token: string,
    shiftId: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse>
  /** Explicitly stage non-OCR financial rows as manual draft rows and have the manager decide them. */
  stageCloseDraftFinancialFixture(shiftId: string, fixture: CloseDraftFinancialFixture): void
  updateStagedCloseDraftFinancialOrder(
    shiftId: string,
    providerOrderNo: string,
    patch: { included?: boolean; walletAmount?: string | null },
  ): void
}

export async function makeHarness(
  opts: {
    splitGate?: 'advisory' | 'strict'
    /** Swap in a reader that answers. The default one reports `available: false` and never calls out. */
    ocr?: OcrReader
    maxOcrReadsPerShift?: number
  } = {},
): Promise<Harness> {
  const deps = createMemoryDeps(NOW_MS)
  const fixturePhotoBytes = new Map<string, Buffer>()
  const financialFixtures = new Map<string, CloseDraftFinancialFixture>()
  let fixturePhotoSequence = 0
  if (opts.ocr) deps.ocr = opts.ocr

  // Two governorates so a cross-governorate branch number can be exercised: Damascus branch 1 and
  // Aleppo branch 1 are both legal, because branch numbers are unique WITHIN a governorate.
  deps.directory.governorates.set(GOV_DAMASCUS, { id: GOV_DAMASCUS, no: 1, nameAr: 'دمشق', nameEn: 'Damascus', active: true })
  deps.directory.governorates.set(GOV_ALEPPO, { id: GOV_ALEPPO, no: 11, nameAr: 'حلب', nameEn: 'Aleppo', active: true })
  deps.directory.vehicleTypes.set(VEHICLE_TYPE, {
    id: VEHICLE_TYPE, code: 'e_motorbike', nameAr: 'دراجة كهربائية', nameEn: 'Electric Motorbike',
    typeNo: 1, batterySlots: 3, active: true,
  })
  deps.directory.branches.set(BRANCH, { id: BRANCH, code: 'DAM', nameAr: 'دمشق', nameEn: 'Damascus', governorateId: GOV_DAMASCUS, branchNo: 1, timezone: 'Asia/Damascus', lat: 33.5138, lng: 36.2765, checkinRadiusM: 150, kind: 'branch' })
  deps.directory.branches.set(OTHER_BRANCH, { id: OTHER_BRANCH, code: 'ALP', nameAr: 'حلب', nameEn: 'Aleppo', governorateId: GOV_ALEPPO, branchNo: 1, timezone: 'Asia/Damascus', lat: null, lng: null, checkinRadiusM: 150, kind: 'branch' })
  // «رأس مال المكتب» — the owner's own figures, seeded exactly as migration 0026 seeds production.
  // A test that had to configure capital before it could exercise الترميم would be testing its setup.
  deps.capitalTargets.seed(BRANCH)
  deps.capitalTargets.seed(OTHER_BRANCH)
  deps.directory.drivers.set(DRIVER_ID, { id: DRIVER_ID, branchId: BRANCH, code: 'DRV-1', fullNameAr: 'سائق ١', active: true, userId: 'u-d1' })
  deps.directory.drivers.set(DRIVER2_ID, { id: DRIVER2_ID, branchId: BRANCH, code: 'DRV-2', fullNameAr: 'سائق ٢', active: true, userId: 'u-d2' })
  deps.directory.vehicles.set(VEHICLE_ID, {
    id: VEHICLE_ID,
    branchId: BRANCH,
    vehicleTypeId: VEHICLE_TYPE,
    code: '1-1-1-1',
    machineNo: 1,
    plateNo: null,
    groundNo: null,
    state: 'ready',
    active: true,
  })
  deps.directory.vehicles.set('vehicle-2', {
    id: 'vehicle-2',
    branchId: BRANCH,
    vehicleTypeId: VEHICLE_TYPE,
    code: '1-1-1-2',
    machineNo: 2,
    plateNo: null,
    groundNo: null,
    state: 'ready',
    active: true,
  })

  // The brief's seed cast: GM, sysadmin, branch manager, two drivers.
  const users = [
    { id: 'u-gm', roleKey: 'general_manager' as const, username: 'gm', branchId: null, driverId: null },
    { id: 'u-sa', roleKey: 'system_admin' as const, username: 'sysadmin', branchId: null, driverId: null },
    { id: 'u-bm', roleKey: 'branch_manager' as const, username: 'manager', branchId: BRANCH, driverId: null },
    { id: 'u-bm2', roleKey: 'branch_manager' as const, username: 'manager2', branchId: OTHER_BRANCH, driverId: null },
    { id: 'u-d1', roleKey: 'driver' as const, username: 'driver1', branchId: BRANCH, driverId: DRIVER_ID },
    { id: 'u-d2', roleKey: 'driver' as const, username: 'driver2', branchId: BRANCH, driverId: DRIVER2_ID },
  ]
  for (const u of users) {
    deps.users.seed({
      ...u,
      fullNameAr: u.username,
      passwordHash: 'plain:secret',
      failedAttempts: 0,
      lockedUntilMs: null,
      active: true,
    })
  }

  const app = await buildApp({
    deps,
    ...(opts.splitGate ? { splitGate: opts.splitGate } : {}),
    ...(opts.maxOcrReadsPerShift !== undefined ? { maxOcrReadsPerShift: opts.maxOcrReadsPerShift } : {}),
  })

  const cookieFor = (token: string) => `${SESSION_COOKIE}=${token}`

  return {
    app,
    deps,
    cookie: cookieFor,
    stageCloseDraftFinancialFixture(shiftId, fixture) {
      financialFixtures.set(shiftId, structuredClone(fixture))
    },
    updateStagedCloseDraftFinancialOrder(shiftId, providerOrderNo, patch) {
      const fixture = financialFixtures.get(shiftId)
      const order = fixture?.orders?.find((candidate) => candidate.providerOrderNo === providerOrderNo)
      if (!order) throw new Error(`staged canonical fixture order not found: ${providerOrderNo}`)
      Object.assign(order, patch)
    },
    async uploadPhoto(token, shiftId, pkg, slot, bytes) {
      // A normal fixture represents a different real photograph in every slot. Reusing the same
      // 1x1 bytes everywhere used to be harmless, but the evidence layer now correctly refuses one
      // photograph being active in two slots. Tests that intentionally exercise reuse still pass
      // explicit bytes and therefore keep the old content identity.
      const fixtureKey = `${shiftId}:${pkg}:${slot}`
      let generated = fixturePhotoBytes.get(fixtureKey)
      if (bytes === undefined && generated === undefined) {
        fixturePhotoSequence += 1
        // Preserve the historical first fixture byte-for-byte for tests that serve it back, then
        // distinguish every additional slot while retaining valid JPEG magic bytes.
        generated = fixturePhotoSequence === 1
          ? TINY_JPEG
          : Buffer.concat([TINY_JPEG, Buffer.from(`ash-test-photo:${fixturePhotoSequence}:${fixtureKey}`, 'utf8')])
        fixturePhotoBytes.set(fixtureKey, generated)
      }
      const uploadBytes = bytes ?? generated!
      let closeDraftRevision: number | null = null
      let expectedAttachmentToken: string | null = null
      if (pkg === 'end') {
        const current = await app.inject({
          method: 'GET',
          url: `/shifts/${shiftId}/close-draft`,
          headers: { cookie: cookieFor(token) },
        })
        if (current.statusCode !== 200) {
          throw new Error(`close draft read failed: ${current.statusCode} ${current.body}`)
        }
        const draft = current.json() as {
          revision: number
          attachments: Array<{ slot: string; attachmentToken: string }>
        }
        closeDraftRevision = draft.revision
        expectedAttachmentToken =
          draft.attachments.find((attachment) => attachment.slot === slot)?.attachmentToken ?? null
      } else {
        expectedAttachmentToken = (await deps.media.listSlots(shiftId)).find(
          (attachment) => attachment.package === pkg && attachment.slot === slot,
        )?.attachmentToken ?? null
      }
      const res = await app.inject({
        method: 'PUT',
        url: `/shifts/${shiftId}/media/${pkg}/${slot}`,
        // Test fixtures intentionally reuse one 1x1 JPEG across slots. A real driver sees and
        // acknowledges that warning; do the same here so unrelated lifecycle tests exercise their
        // own gate. Evidence-specific tests inject without this header when they test refusal.
        headers: {
          cookie: cookieFor(token),
          'content-type': 'image/jpeg',
          'x-stale-evidence-acknowledged': 'true',
          'x-replace-confirmed': 'true',
          ...(expectedAttachmentToken === null
            ? {}
            : { 'x-expected-attachment-token': expectedAttachmentToken }),
          ...(closeDraftRevision === null
            ? {}
            : {
                'x-close-draft-revision': String(closeDraftRevision),
              }),
        },
        payload: uploadBytes,
      })
      if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`)
      return res.json()
    },
    async submitEndPackage(token, shiftId, payload) {
      const currentResponse = await app.inject({
        method: 'GET',
        url: `/shifts/${shiftId}/close-draft`,
        headers: { cookie: cookieFor(token) },
      })
      if (currentResponse.statusCode !== 200) return currentResponse
      let current = currentResponse.json() as {
        revision: number
        draftHash: string
        submittedAt: string | null
        attachments: Array<{
          slot: string
          mediaId: string
          attachmentToken: string
          read: { status: 'idle' | 'running' | 'complete' | 'failed'; failure: string | null } | null
        }>
      }
      if (current.submittedAt === null) {
        const figureKeys = [
          'odometerKm',
          'odometerAnomalyConfirmed',
          'cashDeclared',
          'walletDeclared',
        ] as const
        const figures = Object.fromEntries(
          figureKeys.flatMap((key) => key in payload ? [[key, payload[key]]] : []),
        )
        const fixture = financialFixtures.get(shiftId)
        let saved = await app.inject({
          method: 'PATCH',
          url: `/shifts/${shiftId}/close-draft`,
          headers: { cookie: cookieFor(token) },
          payload: {
            expectedRevision: current.revision,
            figures,
            ...(fixture === undefined
              ? {}
              : {
                  operations: {
                    manualOrders: (fixture.orders ?? []).map((row) => ({
                      clientKey: row.clientKey,
                      providerOrderNo: row.providerOrderNo,
                      payMode: row.payMode,
                      fee: row.fee,
                      occurredDate: row.occurredDate,
                      occurredMinute: row.occurredMinute,
                      pointA: row.pointA ?? null,
                      pointB: row.pointB ?? null,
                      source: 'manual',
                    })),
                    manualCashDeductions: (fixture.cashDeductions ?? []).map((row) => ({
                      clientKey: row.clientKey,
                      operationKey: row.operationKey,
                      amount: row.amount,
                      occurredDate: row.occurredDate,
                      occurredMinute: row.occurredMinute,
                      pointA: row.pointA ?? null,
                      pointB: row.pointB ?? null,
                      source: 'manual',
                    })),
                    manualMovements: (fixture.movements ?? []).map((row) => ({
                      clientKey: row.clientKey,
                      amount: row.amount,
                      occurredMinute: row.occurredMinute ?? null,
                      role: row.role ?? 'unmatched',
                      providerOrderNo: row.providerOrderNo ?? null,
                      ambiguous: row.ambiguous ?? false,
                      notes: row.notes ?? null,
                      source: 'manual',
                    })),
                  },
                }),
          },
        })
        if (saved.statusCode !== 200 && 'walletDeclaredOcr' in figures) {
          const { walletDeclaredOcr: _ignoredUnreadableBaseline, ...storableFigures } = figures
          saved = await app.inject({
            method: 'PATCH',
            url: `/shifts/${shiftId}/close-draft`,
            headers: { cookie: cookieFor(token) },
            payload: {
              expectedRevision: current.revision,
              figures: storableFigures,
              ...(fixture === undefined
                ? {}
                : {
                    operations: {
                      manualOrders: (fixture.orders ?? []).map((row) => ({
                        clientKey: row.clientKey,
                        providerOrderNo: row.providerOrderNo,
                        payMode: row.payMode,
                        fee: row.fee,
                        occurredDate: row.occurredDate,
                        occurredMinute: row.occurredMinute,
                        pointA: row.pointA ?? null,
                        pointB: row.pointB ?? null,
                        source: 'manual',
                      })),
                      manualCashDeductions: (fixture.cashDeductions ?? []).map((row) => ({
                        clientKey: row.clientKey,
                        operationKey: row.operationKey,
                        amount: row.amount,
                        occurredDate: row.occurredDate,
                        occurredMinute: row.occurredMinute,
                        pointA: row.pointA ?? null,
                        pointB: row.pointB ?? null,
                        source: 'manual',
                      })),
                      manualMovements: (fixture.movements ?? []).map((row) => ({
                        clientKey: row.clientKey,
                        amount: row.amount,
                        occurredMinute: row.occurredMinute ?? null,
                        role: row.role ?? 'unmatched',
                        providerOrderNo: row.providerOrderNo ?? null,
                        ambiguous: row.ambiguous ?? false,
                        notes: row.notes ?? null,
                        source: 'manual',
                      })),
                    },
                  }),
            },
          })
        }
        if (saved.statusCode !== 200 && fixture !== undefined) {
          const failure = saved.json() as {
            error?: string
            detail?: Array<{ path?: unknown[] }>
          }
          const rejectedClientFigure = failure.error === 'invalid_request'
            && Array.isArray(failure.detail)
            && failure.detail.length > 0
            && failure.detail.every((issue) => issue.path?.[0] === 'figures')
          if (!rejectedClientFigure) {
            throw new Error(`canonical fixture patch failed: ${saved.statusCode} ${saved.body}`)
          }
        }
        // Invalid wire values still belong to the end-package schema test. Preserve its response
        // surface by sending them to that route with the current identity instead of throwing here.
        if (saved.statusCode === 200) {
          current = saved.json() as typeof current
        }
      }
      // Model the current driver build: every accounting evidence upload starts its own linked
      // read, and terminal reader failures still permit manual entry. Individual evidence tests
      // use direct injection when they intentionally need to skip this step.
      for (const attachment of current.attachments) {
        const field = attachment.slot === 'dashboard' || /^dashboard_[1-9][0-9]*$/.test(attachment.slot)
          ? 'orders'
          : attachment.slot === 'wallet'
            ? 'wallet'
            : attachment.slot === 'odometer'
              ? 'odometer'
              : /^bms_[1-9][0-9]*$/.test(attachment.slot)
                ? 'bms'
                : null
        if (field === null || attachment.read?.status === 'complete' || attachment.read?.status === 'failed') continue
        const read = await app.inject({
          method: 'POST',
          url: `/shifts/${shiftId}/close-draft/media/${attachment.slot}/read`,
          headers: {
            cookie: cookieFor(token),
            ...(field === 'orders' ? { 'x-ash-orders-time-consensus': 'close-draft-v1' } : {}),
          },
          payload: {
            expectedRevision: current.revision,
            mediaId: attachment.mediaId,
            attachmentToken: attachment.attachmentToken,
            field,
            retryFailed: false,
          },
        })
        if (read.statusCode !== 200) return read
        current = read.json().draft as typeof current
      }
      const submitted = await app.inject({
        method: 'PUT',
        url: `/shifts/${shiftId}/end-package`,
        headers: { cookie: cookieFor(token) },
        payload: {
          ...payload,
          draftRevision: current.revision,
          draftHash: current.draftHash,
        },
      })
      const fixture = financialFixtures.get(shiftId)
      if (submitted.statusCode !== 200 || fixture === undefined) return submitted
      financialFixtures.delete(shiftId)
      const deductions = await deps.cashDeductions.listByShift(shiftId)
      const decisions = await app.inject({
        method: 'POST',
        url: `/shifts/${shiftId}/operations/revise`,
        headers: { cookie: cookieFor(fixture.managerToken) },
        payload: {
          orders: (fixture.orders ?? []).map((row) => ({
            providerOrderNo: row.providerOrderNo,
            included: row.included ?? true,
            ...(row.walletAmount === undefined ? {} : { walletAmount: row.walletAmount }),
            occurredDate: row.occurredDate,
            occurredMinute: row.occurredMinute,
            reason: 'manager verified the explicit close-draft financial fixture',
          })),
          cashDeductions: (fixture.cashDeductions ?? []).map((row) => {
            const deduction = deductions.find((candidate) => candidate.operationKey === row.operationKey)
            if (!deduction) throw new Error(`canonical fixture deduction not materialized: ${row.operationKey}`)
            return {
              id: deduction.id,
              included: row.included ?? true,
              occurredDate: row.occurredDate,
              occurredMinute: row.occurredMinute,
              reason: 'manager verified the explicit close-draft deduction fixture',
            }
          }),
        },
      })
      if (decisions.statusCode !== 200) {
        throw new Error(`canonical fixture decision failed: ${decisions.statusCode} ${decisions.body}`)
      }
      return app.inject({
        method: 'GET',
        url: `/shifts/${shiftId}/review`,
        headers: { cookie: cookieFor(fixture.managerToken) },
      })
    },
    async loginAs(username: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username, password: 'secret' },
      })
      if (res.statusCode !== 200) throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`)
      const setCookie = res.headers['set-cookie']
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
      const token = /ash_session=([^;]+)/.exec(String(raw))?.[1]
      if (!token) throw new Error('no session cookie returned')
      return token
    },
  }
}

export const today = businessDateFor(NOW_MS, 180)

export interface FixedSettlementPreviewForApproval {
  settlementHash: string
  variance: string
}

/**
 * Build the exact fixed-policy approval payload from a fresh read-only preview.
 *
 * Most lifecycle tests are about some other gate, so centralising the two physical confirmations
 * prevents them from accidentally exercising the old deferred-share policy. Tests for missing or
 * stale settlement confirmation deliberately send their own payload instead.
 */
export async function fixedApprovalPayload(
  harness: Harness,
  managerToken: string,
  shiftId: string,
  reviewedOrdersHash: string,
  options: { varianceReason?: string | null } = {},
): Promise<Record<string, unknown>> {
  const settlementResponse = await harness.app.inject({
    method: 'GET',
    url: `/shifts/${shiftId}/settlement`,
    headers: { cookie: harness.cookie(managerToken) },
  })
  if (settlementResponse.statusCode !== 200) {
    throw new Error(`settlement preview failed: ${settlementResponse.statusCode} ${settlementResponse.body}`)
  }
  const settlement = settlementResponse.json() as FixedSettlementPreviewForApproval
  return {
    reviewedOrdersHash,
    reviewedSettlementHash: settlement.settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    varianceReason:
      options.varianceReason === undefined
        ? settlement.variance === '0.00'
          ? null
          : 'verified discrepancy in API test'
        : options.varianceReason,
  }
}

export async function approveFixedClose(
  harness: Harness,
  managerToken: string,
  shiftId: string,
  reviewedOrdersHash: string,
  options: { varianceReason?: string | null } = {},
): Promise<LightMyRequestResponse> {
  return await harness.app.inject({
    method: 'POST',
    url: `/shifts/${shiftId}/approve-close`,
    headers: { cookie: harness.cookie(managerToken) },
    payload: await fixedApprovalPayload(harness, managerToken, shiftId, reviewedOrdersHash, options),
  })
}
