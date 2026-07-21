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
}

describe('the grant table IS the SRS §3 matrix', () => {
  it('covers every permission the system declares', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(SRS_MATRIX[permission], `${permission} missing from the SRS transcription`).toBeDefined()
      expect(DEFAULT_GRANTS[permission], `${permission} missing from DEFAULT_GRANTS`).toBeDefined()
    }
    expect(Object.keys(SRS_MATRIX).sort()).toEqual([...ALL_PERMISSIONS].sort())
  })

  // The exhaustive sweep: 15 permissions × 5 roles = 75 assertions, generated.
  for (const permission of ALL_PERMISSIONS) {
    for (const roleKey of ALL_ROLES) {
      const expected = SRS_MATRIX[permission][roleKey]
      it(`${roleKey} ${expected ? `MAY (${expected})` : 'may NOT'} ${permission}`, () => {
        expect(DEFAULT_GRANTS[permission]?.[roleKey]).toBe(expected)
      })
    }
  }
})

describe('the two counter-intuitive rows', () => {
  it('the General Manager may NOT edit tier rules — sysadmin only (س46, BR8)', () => {
    expect(can(actor('general_manager'), 'tier_rule.write').allowed).toBe(false)
    expect(can(actor('system_admin'), 'tier_rule.write').allowed).toBe(true)
  })

  it('the system admin may NOT post manual entries or expenses — BM and GM only (D-5)', () => {
    expect(can(actor('system_admin'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(false)
    expect(can(actor('system_admin'), 'expense.write', { branchId: BRANCH_A }).allowed).toBe(false)
    expect(can(actor('branch_manager'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
    expect(can(actor('general_manager'), 'journal.manual.write', { branchId: BRANCH_A }).allowed).toBe(true)
  })

  it('only the General Manager sees total profits (AC #12, BR8)', () => {
    for (const roleKey of ALL_ROLES) {
      expect(can(actor(roleKey), 'profit.view_total').allowed).toBe(roleKey === 'general_manager')
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
