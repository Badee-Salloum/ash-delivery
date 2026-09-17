/**
 * Authorization, as a pure function over data.
 *
 * SRS A-2 requires the permission matrix to be customisable by the system admin, so the grant
 * table is DATA — a row in `role_permissions` — not a hardcoded `if`. `DEFAULT_GRANTS` below is
 * the seed, transcribed from the SRS §3 matrix cell by cell.
 *
 * This module decides only "may this actor do this to this subject". Enforcing it is the API's
 * job (a Fastify preHandler), with Postgres row-level security on `branch_id` as a second layer.
 * The kickoff brief's rule stands: UI hiding is not security.
 */

export type RoleKey = 'driver' | 'branch_manager' | 'system_admin' | 'general_manager' | 'accountant'

/**
 * How far a grant reaches.
 *  • `own`    — only rows the actor personally owns (BR8: «السائق يرى نوبته ومستحقاته فقط»)
 *  • `branch` — only rows in the actor's branch  (BR8: «مدير الفرع يرى كل بيانات فرعه»)
 *  • `all`    — organisation-wide
 */
export type Scope = 'own' | 'branch' | 'all'

export type PermissionKey =
  // ── SRS §3 matrix, row by row ────────────────────────────────────────────────
  /** «فتح النوبات ورفع الحزم وتأكيدها» — open a shift, upload packages, confirm them. */
  | 'shift.operate'
  /** «اعتماد النوبات (بداية ونهاية) ومطابقة الأرض» — approve both gates. */
  | 'shift.approve'
  /** «الجرد اليومي الفعلي للصناديق» — the daily physical cash count (E-5). */
  | 'cash_count.perform'
  /** «القيود اليدوية والصرفيات» — manual journal entries and expenses (E-3, G). */
  | 'journal.manual.write'
  | 'expense.write'
  /** «تعديل الشرائح والقواعد والحصص» — system admin ONLY, per س46 and BR8. */
  | 'tier_rule.write'
  /** «إدخال سعر الصرف اليومي» — the one daily rate (BR6). */
  | 'fx_rate.write'
  /** «الإقفال الأسبوعي الرسمي (الأحد)» — the Sunday close (BR7). */
  | 'week.close'
  /** «رؤية الأرباح والحصص الإجمالية» — General Manager ONLY (BR8). */
  | 'profit.view_total'
  /** «رؤية بيانات الفرع كاملة» */
  | 'branch_data.view'
  /** «التتبع الحي GPS» — Bundle 3; the grant exists now so the matrix is complete. */
  | 'gps.view'
  /** «إدارة المستخدمين والصلاحيات» */
  | 'user.manage'
  // ── Beyond the matrix, but required by the SRS text ──────────────────────────
  /** A driver seeing his own shifts and dues (BR8, SRS §3 row 1). */
  | 'driver_earnings.view'
  /** The audit trail viewer (A-5 / س79 — the requirement is unusable without a reader). */
  | 'audit.view'
  /** Settings: approval ceilings, vehicle types, kWh price, old-lira factor (A-4). */
  | 'settings.write'
  /**
   * Onboarding drivers, vehicles and their documents (SRS §B).
   *
   * The §3 matrix has no row for this. «إدارة المستخدمين والصلاحيات» is sysadmin + GM, but that
   * is about *user accounts and permissions* — a driver record is fleet data, and the person who
   * onboards a driver is the branch manager who works with him daily. Granting fleet management
   * to user.manage instead would mean NOBODY could create a driver: both holders of that
   * permission are organisation-wide roles with no branch, and a driver must belong to one.
   *
   * ASSUMPTION A-27: fleet management is branch_manager (own branch) + sysadmin + GM. Stored as
   * data, so one row changes it if the client disagrees.
   */
  | 'fleet.manage'
  /**
   * «إدارة صندوق الشركة» — see and move صندوق الشركة (`company_box`).
   *
   * The §3 matrix has no row for it. Until 2026-09-17 the company fund was READ under
   * `profit.view_total` (GM + sysadmin) but WRITTEN under `journal.manual.write`, which the branch
   * manager holds — so he could deposit into and withdraw from a fund he was not allowed to see.
   * Owner decision (2026-09-17): «إدارة صندوق الشركة: المدير العام ومدير النظام فقط». One key now
   * gates the read and both writes, so the two can never drift apart again.
   */
  | 'company_fund.manage'

export type GrantTable = Readonly<Partial<Record<PermissionKey, Readonly<Partial<Record<RoleKey, Scope>>>>>>

/**
 * SRS §3, transcribed exactly — **plus owner decision 9**. An absent role means ✗.
 *
 * ── DECISION 9 (2026-08-12): the system admin holds every permission at scope `all` ─────────
 *
 * «اعطي صلاحية وصول لكل شيء لمدير النظام و صلاحية لفعل كل شيء». Given twice, in writing, after
 * the narrower rule was put to the owner. It supersedes ASSUMPTIONS D-5 and AMENDS BR8, whose
 * «رؤية الأرباح والحصص الإجمالية: المدير العام فقط» made `profit.view_total` GM-only.
 *
 * This is a legitimate change rather than a violation of the SRS: §3 / A-2 make the matrix
 * explicitly customisable BY THE SYSTEM ADMIN with every change logged, and `Permissions.tsx`
 * already edits it as data. Five rows moved: `shift.operate`, `cash_count.perform`,
 * `journal.manual.write`, `expense.write`, `profit.view_total`.
 *
 * THIS CONSTANT ONLY SEEDS A FRESH DATABASE. Live grants are rows in `role_permissions`, which is
 * why decision 9 also needed migration 0024 — production was measured holding 11 of 16 for the
 * sysadmin, and editing this table alone would have changed the tests and nothing else.
 *
 * One row STILL deserves a second look, and it is unchanged:
 *
 *  • `tier_rule.write` is system_admin ONLY — **not** the General Manager. That is the client's
 *    literal answer to س46, reaffirmed in BR8 and flagged for confirmation as SRS open point م-5.
 *
 * (The old note here — that `journal.manual.write` / `expense.write` exclude the sysadmin — is now
 * history. It recorded ASSUMPTIONS D-5, which decision 9 reverses.)
 */
export const DEFAULT_GRANTS: GrantTable = {
  'shift.operate': { driver: 'own', system_admin: 'all' },
  'shift.approve': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'cash_count.perform': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'journal.manual.write': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'expense.write': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'tier_rule.write': { system_admin: 'all' },
  'fx_rate.write': { system_admin: 'all' },
  'week.close': { system_admin: 'all' },
  'profit.view_total': { system_admin: 'all', general_manager: 'all' },
  'branch_data.view': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // The branch manager is the one who actually dispatches, so he sees his own branch (owner,
  // 2026-09-08). This RESTORES SRS §3, which granted him «التتبع الحي GPS ✓ (فرعه)» all along; the
  // earlier «upper-level only» reading had been carried into the SRS transcription in
  // `matrix.test.ts` as well, which is what quietly defeated that file's independent cross-check.
  'gps.view': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'user.manage': { system_admin: 'all', general_manager: 'all' },
  'driver_earnings.view': {
    driver: 'own',
    branch_manager: 'branch',
    system_admin: 'all',
    general_manager: 'all',
  },
  'audit.view': { system_admin: 'all', general_manager: 'all' },
  'settings.write': { system_admin: 'all' },
  'fleet.manage': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  // Deliberately NOT the branch manager — see the rationale on the PermissionKey union. Seeded into a
  // live `role_permissions` by migration 0064, because this constant only seeds a fresh database.
  'company_fund.manage': { system_admin: 'all', general_manager: 'all' },
  // `accountant` (س77) is seeded with no grants at all — enabling the role is a data change,
  // not a migration. See ASSUMPTIONS A-17.
}

export interface Actor {
  readonly userId: string
  readonly roleKey: RoleKey
  /** The branch this user belongs to. `null` only for org-wide roles. */
  readonly branchId: string | null
  /** Present when the user IS a driver, for `own`-scoped checks. */
  readonly driverId?: string | null
}

/**
 * What is being acted upon. Every field is optional because some permissions are not about a
 * specific row (`week.close`), but a `branch`- or `own`-scoped grant CANNOT be satisfied without
 * the corresponding field — see `can()`. That is deliberate: a missing subject denies rather than
 * silently widening to organisation-wide.
 */
export interface Subject {
  readonly branchId?: string | null
  readonly driverId?: string | null
  readonly ownerUserId?: string | null
}

export type DenyReason =
  | 'no_grant_for_role'
  | 'outside_branch'
  | 'not_owner'
  | 'subject_missing_branch'
  | 'subject_missing_owner'
  | 'actor_missing_branch'

export type Decision =
  | { readonly allowed: true; readonly scope: Scope }
  | { readonly allowed: false; readonly reason: DenyReason }

const ALLOW = (scope: Scope): Decision => ({ allowed: true, scope })
const DENY = (reason: DenyReason): Decision => ({ allowed: false, reason })

/**
 * The single authorization decision point.
 *
 * Denials carry a machine-readable reason so the audit log records *why* access was refused,
 * not merely that it was — which is what makes an RBAC regression visible after the fact.
 */
export function can(
  actor: Actor,
  permission: PermissionKey,
  subject: Subject = {},
  grants: GrantTable = DEFAULT_GRANTS,
): Decision {
  const scope = grants[permission]?.[actor.roleKey]
  if (scope === undefined) return DENY('no_grant_for_role')

  switch (scope) {
    case 'all':
      return ALLOW('all')

    case 'branch': {
      if (actor.branchId === null || actor.branchId === undefined) return DENY('actor_missing_branch')
      // A branch-scoped grant with no branch on the subject must NOT widen to everything.
      if (subject.branchId === null || subject.branchId === undefined) return DENY('subject_missing_branch')
      return subject.branchId === actor.branchId ? ALLOW('branch') : DENY('outside_branch')
    }

    case 'own': {
      const byDriver =
        actor.driverId !== null &&
        actor.driverId !== undefined &&
        subject.driverId !== null &&
        subject.driverId !== undefined &&
        subject.driverId === actor.driverId
      const byUser =
        subject.ownerUserId !== null &&
        subject.ownerUserId !== undefined &&
        subject.ownerUserId === actor.userId
      if (byDriver || byUser) return ALLOW('own')
      if (
        (subject.driverId === null || subject.driverId === undefined) &&
        (subject.ownerUserId === null || subject.ownerUserId === undefined)
      ) {
        return DENY('subject_missing_owner')
      }
      return DENY('not_owner')
    }
  }
}

/** Throwing form, for use at a route boundary. */
export class ForbiddenError extends Error {
  readonly permission: PermissionKey
  readonly reason: DenyReason
  constructor(permission: PermissionKey, reason: DenyReason) {
    super(`forbidden: ${permission} (${reason})`)
    this.name = 'ForbiddenError'
    this.permission = permission
    this.reason = reason
  }
}

export function assertCan(
  actor: Actor,
  permission: PermissionKey,
  subject: Subject = {},
  grants: GrantTable = DEFAULT_GRANTS,
): void {
  const decision = can(actor, permission, subject, grants)
  if (!decision.allowed) throw new ForbiddenError(permission, decision.reason)
}

/** Every permission the system knows about — used by the API's boot-time completeness assertion. */
export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  'shift.operate',
  'shift.approve',
  'cash_count.perform',
  'journal.manual.write',
  'expense.write',
  'tier_rule.write',
  'fx_rate.write',
  'week.close',
  'profit.view_total',
  'branch_data.view',
  'gps.view',
  'user.manage',
  'driver_earnings.view',
  'audit.view',
  'settings.write',
  'fleet.manage',
  'company_fund.manage',
]

export const ALL_ROLES: readonly RoleKey[] = [
  'driver',
  'branch_manager',
  'system_admin',
  'general_manager',
  'accountant',
]
