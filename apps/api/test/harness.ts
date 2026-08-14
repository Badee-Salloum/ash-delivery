import type { FastifyInstance } from 'fastify'
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
  if (opts.ocr) deps.ocr = opts.ocr

  // Two governorates so a cross-governorate branch number can be exercised: Damascus branch 1 and
  // Aleppo branch 1 are both legal, because branch numbers are unique WITHIN a governorate.
  deps.directory.governorates.set(GOV_DAMASCUS, { id: GOV_DAMASCUS, no: 1, nameAr: 'دمشق', nameEn: 'Damascus', active: true })
  deps.directory.governorates.set(GOV_ALEPPO, { id: GOV_ALEPPO, no: 11, nameAr: 'حلب', nameEn: 'Aleppo', active: true })
  deps.directory.vehicleTypes.set(VEHICLE_TYPE, {
    id: VEHICLE_TYPE, code: 'e_motorbike', nameAr: 'دراجة كهربائية', nameEn: 'Electric Motorbike',
    typeNo: 1, batterySlots: 3, active: true,
  })
  deps.directory.branches.set(BRANCH, { id: BRANCH, code: 'DAM', nameAr: 'دمشق', nameEn: 'Damascus', governorateId: GOV_DAMASCUS, branchNo: 1, timezone: 'Asia/Damascus' })
  deps.directory.branches.set(OTHER_BRANCH, { id: OTHER_BRANCH, code: 'ALP', nameAr: 'حلب', nameEn: 'Aleppo', governorateId: GOV_ALEPPO, branchNo: 1, timezone: 'Asia/Damascus' })
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
    async uploadPhoto(token, shiftId, pkg, slot, bytes = TINY_JPEG) {
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
        },
        payload: bytes,
      })
      if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`)
      return res.json()
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
