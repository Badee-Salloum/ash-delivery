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

export type GrantTable = Readonly<Partial<Record<PermissionKey, Readonly<Partial<Record<RoleKey, Scope>>>>>>

/**
 * SRS §3, transcribed exactly. An absent role means ✗.
 *
 * Two rows deserve a second look, because both are counter-intuitive and both are deliberate:
 *
 *  • `tier_rule.write` is system_admin ONLY — **not** the General Manager. That is the client's
 *    literal answer to س46, reaffirmed in BR8 and flagged for confirmation as SRS open point م-5.
 *  • `journal.manual.write` / `expense.write` are branch_manager + general_manager, **not**
 *    system_admin. SRS E-3's prose says branch-manager-only while the §3 matrix grants the GM
 *    too; the conflict was escalated and the product owner ruled the matrix wins (ASSUMPTIONS D-5).
 */
export const DEFAULT_GRANTS: GrantTable = {
  'shift.operate': { driver: 'own' },
  'shift.approve': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
  'cash_count.perform': { branch_manager: 'branch', general_manager: 'all' },
  'journal.manual.write': { branch_manager: 'branch', general_manager: 'all' },
  'expense.write': { branch_manager: 'branch', general_manager: 'all' },
  'tier_rule.write': { system_admin: 'all' },
  'fx_rate.write': { system_admin: 'all' },
  'week.close': { system_admin: 'all' },
  'profit.view_total': { general_manager: 'all' },
  'branch_data.view': { branch_manager: 'branch', system_admin: 'all', general_manager: 'all' },
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
]

export const ALL_ROLES: readonly RoleKey[] = [
  'driver',
  'branch_manager',
  'system_admin',
  'general_manager',
  'accountant',
]
