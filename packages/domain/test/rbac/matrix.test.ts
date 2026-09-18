import { describe, expect, it } from 'vitest'
import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  type Actor,
  DEFAULT_GRANTS,
  ForbiddenError,
  type PermissionKey,
  type RoleKey,
  type Scope,
  assertCan,
  can,
} from '../../src/rbac/can.ts'

const BRANCH_A = 'branch-damascus'
const BRANCH_B = 'branch-aleppo'

const actor = (roleKey: RoleKey, over: Partial<Actor> = {}): Actor => ({
  userId: `user-${roleKey}`,
  roleKey,
  branchId: roleKey === 'driver' || roleKey === 'branch_manager' ? BRANCH_A : null,
  ...over,
})

/**
 * SRS §3, transcribed a SECOND time, independently, from the Arabic table — so this test is a
 * real check on `DEFAULT_GRANTS` rather than a copy of it. A dash means ✗.
 *
 * Traceability: acceptance criterion #12, and BR8.
 */
const SRS_MATRIX: Record<PermissionKey, Partial<Record<RoleKey, Scope>>> = {
  // «فتح النوبات ورفع الحزم وتأكيدها»: driver ✓ (his own), everyone else ✗
  'shift.operate': { driver: 'own' },
  // «اعتماد النوبات (بداية ونهاية) ومطابقة الأرض»: driver ✗, BM ✓, sysadmin ✓, GM ✓
  'shift.approve': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // «الجرد اليومي الفعلي للصناديق»: BM ✓, GM ✓ — sysadmin ✗
  'cash_count.perform': { branch_manager: 'branch', general_manager: 'all' },
  // «القيود اليدوية والصرفيات»: BM ✓, GM ✓ — sysadmin ✗
  'journal.manual.write': { branch_manager: 'branch', general_manager: 'all' },
  'expense.write': { branch_manager: 'branch', general_manager: 'all' },
  // «تعديل الشرائح والقواعد والحصص»: sysadmin ✓ حصراً — NOT the GM (س46, م-5)
  'tier_rule.write': { system_admin: 'all' },
  // «إدخال سعر الصرف اليومي»: sysadmin only
  'fx_rate.write': { system_admin: 'all' },
  // «الإقفال الأسبوعي الرسمي (الأحد)»: sysadmin only
  'week.close': { system_admin: 'all' },
  // «رؤية الأرباح والحصص الإجمالية»: GM ✓ حصراً
  'profit.view_total': { general_manager: 'all' },
  // «رؤية بيانات الفرع كاملة»: BM ✓ (فرعه), sysadmin ✓, GM ✓
  'branch_data.view': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // «التتبع الحي GPS»: BM ✓ (فرعه), sysadmin ✓, GM ✓
  'gps.view': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // «إدارة المستخدمين والصلاحيات»: sysadmin ✓, GM ✓
  'user.manage': { system_admin: 'all', general_manager: 'all' },
  // BR8: the driver sees his own shifts and dues
  'driver_earnings.view': {
    driver: 'own',
    branch_manager: 'branch',
    system_admin: 'all',
    general_manager: 'all',
  },
  'audit.view': { system_admin: 'all', general_manager: 'all' },
  'settings.write': { system_admin: 'all' },
  // Not in the §3 matrix — ASSUMPTION A-27. See the rationale on the PermissionKey union.
  'fleet.manage': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // Not in the §3 matrix — owner decision 2026-09-17: «إدارة صندوق الشركة: المدير العام ومدير النظام
  // فقط». Deliberately NOT the branch manager, although he holds `journal.manual.write`.
  'company_fund.manage': { system_admin: 'all', general_manager: 'all' },
}

/**
 * OWNER DECISION 9 (2026-08-12) — «اعطي صلاحية وصول لكل شيء لمدير النظام و صلاحية لفعل كل شيء».
 *
 * The ONE sanctioned deviation from the transcription above, kept here rather than edited into it.
 * `SRS_MATRIX` earns its keep only by being an independent second reading of the Arabic §3 table;
 * folding an override into it would delete the very thing it checks and leave nothing comparing the
 * code to the document. So the SRS stays as written, the deviation is named, dated and listed, and
 * a reviewer can see in one place exactly how far the system has moved from the specification.
 *
 * It supersedes ASSUMPTIONS D-5 and amends BR8's visibility line. Legitimate under SRS §3 / A-2,
 * which make the matrix sysadmin-customisable with every change logged.
 */
const OWNER_OVERRIDE_2026_08_12: Partial<Record<PermissionKey, Partial<Record<RoleKey, Scope>>>> = {
  'shift.operate': { system_admin: 'all' },
  'cash_count.perform': { system_admin: 'all' },
  'journal.manual.write': { system_admin: 'all' },
  'expense.write': { system_admin: 'all' },
  'profit.view_total': { system_admin: 'all' },
}

/** SRS §3 ⊕ decision 9. This — not the raw transcription — is what the code must equal. */
const EFFECTIVE_MATRIX: Record<PermissionKey, Partial<Record<RoleKey, Scope>>> = Object.fromEntries(
  (Object.keys(SRS_MATRIX) as PermissionKey[]).map((permission) => [
    permission,
    { ...SRS_MATRIX[permission], ...(OWNER_OVERRIDE_2026_08_12[permission] ?? {}) },
  ]),
) as Record<PermissionKey, Partial<Record<RoleKey, Scope>>>

describe('the grant table IS the SRS §3 matrix, plus exactly one recorded override', () => {
  /**
   * The override may not grow quietly. Without this, a future widening could be slipped into
   * `OWNER_OVERRIDE_2026_08_12` and every other test here would still pass — the deviation from the
   * SRS would be invisible again, which is the whole failure this structure exists to prevent.
   */
  it('deviates from the SRS transcription in exactly the five rows decision 9 names', () => {
    const deviations: string[] = []
    for (const permission of ALL_PERMISSIONS) {
      for (const roleKey of ALL_ROLES) {
        if (SRS_MATRIX[permission][roleKey] !== DEFAULT_GRANTS[permission]?.[roleKey]) {
          deviations.push(`${permission}:${roleKey}`)
        }
      }
    }
    expect(deviations.sort()).toEqual(
      [
        'cash_count.perform:system_admin',
        'expense.write:system_admin',
        'journal.manual.write:system_admin',
        'profit.view_total:system_admin',
        'shift.operate:system_admin',
      ].sort(),
    )
  })

  it('gives the system admin every permission at scope all (decision 9)', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(DEFAULT_GRANTS[permission]?.system_admin, `sysadmin missing ${permission}`).toBe('all')
    }
  })

  it('covers every permission the system declares', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(SRS_MATRIX[permission], `${permission} missing from the SRS transcription`).toBeDefined()
      expect(DEFAULT_GRANTS[permission], `${permission} missing from DEFAULT_GRANTS`).toBeDefined()
    }
    expect(Object.keys(SRS_MATRIX).sort()).toEqual([...ALL_PERMISSIONS].sort())
  })

  // The exhaustive sweep: every permission × 5 roles, generated, against SRS §3 ⊕ decision 9.
  for (const permission of ALL_PERMISSIONS) {
    for (const roleKey of ALL_ROLES) {
      const expected = EFFECTIVE_MATRIX[permission][roleKey]
      it(`${roleKey} ${expected ? `MAY (${expected})` : 'may NOT'} ${permission}`, () => {
        expect(DEFAULT_GRANTS[permission]?.[roleKey]).toBe(expected)
      })
    }
  }
})

describe('the rows worth a second look', () => {
  /** UNCHANGED by decision 9, and deliberately so — the GM still may not edit the tier table. */
  it('the General Manager may NOT edit tier rules — sysadmin only (س46, BR8)', () => {
    expect(can(actor('general_manager'), 'tier_rule.write').allowed).toBe(false)
    expect(can(actor('system_admin'), 'tier_rule.write').allowed).toBe(true)
  })

  /**
   * REVERSED by decision 9. This test used to assert the opposite, citing ASSUMPTIONS D-5. Kept as
   * a test rather than deleted, because the sysadmin's ability to move money is exactly the kind of
   * thing that should fail loudly if someone narrows it again without a decision to point at.
   */
  it('the system admin MAY post manual entries and expenses (decision 9, was D-5)', () => {
    expect(can(actor('system_admin'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
    expect(can(actor('system_admin'), 'expense.write', { branchId: BRANCH_A }).allowed).toBe(true)
    expect(can(actor('branch_manager'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
    expect(can(actor('general_manager'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
  })

  /** AMENDED by decision 9: BR8's «المدير العام فقط» now reads GM + sysadmin. Nobody else. */
  it('only the General Manager and the system admin see total profits (AC #12, BR8 as amended)', () => {
    for (const roleKey of ALL_ROLES) {
      expect(can(actor(roleKey), 'profit.view_total').allowed).toBe(
        roleKey === 'general_manager' || roleKey === 'system_admin',
      )
    }
  })

  /**
   * صندوق الشركة (2026-09-17). The branch manager used to reach it through `journal.manual.write`
   * while `profit.view_total` kept him from seeing it. The new key must never quietly follow the
   * manual-entry grant back to him.
   */
  it('only the General Manager and the system admin manage the company fund', () => {
    for (const roleKey of ALL_ROLES) {
      expect(can(actor(roleKey), 'company_fund.manage', { branchId: BRANCH_A }).allowed, roleKey).toBe(
        roleKey === 'general_manager' || roleKey === 'system_admin',
      )
    }
    // The gap it closes: the branch manager keeps manual entries, and that is no longer enough.
    expect(can(actor('branch_manager'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
    expect(DEFAULT_GRANTS['company_fund.manage']?.branch_manager).toBeUndefined()
  })

  /** The floor decision 9 does NOT touch: a driver is still confined to his own. */
  it('leaves every non-sysadmin role exactly where the SRS put it', () => {
    for (const permission of ALL_PERMISSIONS) {
      for (const roleKey of ALL_ROLES) {
        if (roleKey === 'system_admin') continue
        expect(DEFAULT_GRANTS[permission]?.[roleKey], `${permission}:${roleKey} moved`).toBe(
          SRS_MATRIX[permission][roleKey],
        )
      }
    }
  })
})

describe('branch scoping — "his branch" is enforced, not assumed', () => {
  const bm = actor('branch_manager')

  it('allows inside the branch', () => {
    expect(can(bm, 'shift.approve', { branchId: BRANCH_A })).toEqual({ allowed: true, scope: 'branch' })
  })

  it('denies another branch', () => {
    expect(can(bm, 'shift.approve', { branchId: BRANCH_B })).toEqual({
      allowed: false,
      reason: 'outside_branch',
    })
  })

  it('DENIES rather than widening when the subject carries no branch', () => {
    // The dangerous default: a branch-scoped grant checked against a subject with no branch
    // must not silently become organisation-wide.
    expect(can(bm, 'shift.approve', {})).toEqual({ allowed: false, reason: 'subject_missing_branch' })
  })

  it('denies a branch-scoped actor with no branch of their own', () => {
    expect(can(actor('branch_manager', { branchId: null }), 'shift.approve', { branchId: BRANCH_A })).toEqual({
      allowed: false,
      reason: 'actor_missing_branch',
    })
  })

  it('an org-wide role is unaffected by branch', () => {
    expect(can(actor('general_manager'), 'shift.approve', { branchId: BRANCH_B }).allowed).toBe(true)
    expect(can(actor('general_manager'), 'shift.approve', {}).allowed).toBe(true)
  })
})

describe('own scoping — a driver sees his own shifts and nothing else (BR8)', () => {
  const driver = actor('driver', { driverId: 'driver-1' })

  it('allows his own shift', () => {
    expect(can(driver, 'shift.operate', { driverId: 'driver-1' })).toEqual({ allowed: true, scope: 'own' })
  })

  it('denies another driver’s shift — even in the same branch', () => {
    expect(can(driver, 'shift.operate', { driverId: 'driver-2', branchId: BRANCH_A })).toEqual({
      allowed: false,
      reason: 'not_owner',
    })
  })

  it('matches on the owning user id as well as the driver id', () => {
    expect(can(driver, 'driver_earnings.view', { ownerUserId: 'user-driver' }).allowed).toBe(true)
  })

  it('DENIES rather than widening when the subject carries no owner', () => {
    expect(can(driver, 'shift.operate', {})).toEqual({ allowed: false, reason: 'subject_missing_owner' })
  })

  it('a driver may not approve his own shift — BR5 needs a second pair of eyes', () => {
    expect(can(driver, 'shift.approve', { driverId: 'driver-1', branchId: BRANCH_A })).toEqual({
      allowed: false,
      reason: 'no_grant_for_role',
    })
  })
})

describe('the accountant role is seeded but powerless (س77, A-17)', () => {
  it('has no grant anywhere, so enabling it later is a data change', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(can(actor('accountant'), permission, { branchId: BRANCH_A }).allowed).toBe(false)
    }
  })
})

describe('customisable matrix (SRS A-2)', () => {
  it('honours an overridden grant table without any code change', () => {
    const custom = { ...DEFAULT_GRANTS, 'tier_rule.write': { general_manager: 'all' as const } }
    expect(can(actor('general_manager'), 'tier_rule.write', {}, custom).allowed).toBe(true)
    expect(can(actor('system_admin'), 'tier_rule.write', {}, custom).allowed).toBe(false)
  })
})

describe('assertCan', () => {
  it('throws a ForbiddenError carrying the permission and the machine-readable reason', () => {
    try {
      assertCan(actor('driver', { driverId: 'd1' }), 'week.close')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError)
      expect((err as ForbiddenError).permission).toBe('week.close')
      expect((err as ForbiddenError).reason).toBe('no_grant_for_role')
    }
  })

  it('is silent when allowed', () => {
    expect(() => assertCan(actor('system_admin'), 'week.close')).not.toThrow()
  })
})
