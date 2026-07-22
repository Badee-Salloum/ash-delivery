import { z } from 'zod'
import { ServiceError } from './shifts.service.ts'

/**
 * Which branch a request is about.
 *
 * Two kinds of actor exist, and the difference is the whole point of this module:
 *
 *   • **Branch-scoped** (branch_manager, driver) carry their branch on the session. They need
 *     name nothing, and naming *another* branch is refused — by the RBAC subject check, not here,
 *     so the refusal is a 403 with a reason rather than a silent substitution.
 *
 *   • **Organisation-wide** (general_manager, system_admin) have `branchId === null` by design.
 *     The §3 matrix grants them `branch_data.view` at scope **'all'** — they may see every branch,
 *     which is precisely why the session cannot pick one for them. They must say which.
 *
 * The bug this exists to kill: every branch-scoped route used to read the branch from the request
 * **body** only. A GET has no body. So `branch_data.view` at scope 'all' was a permission nobody
 * could exercise — the dashboard, the treasury, the fleet and the expense screens all returned
 * 422 `branch_required` to the general manager and the system admin, i.e. to the only two accounts
 * a fresh production install has. Authorization said yes and the handler said no.
 *
 * Reading `?branchId=` as well as `body.branchId` is what makes scope 'all' expressible on a read.
 */
const querySchema = z.object({ branchId: z.string().min(1).optional() })
const bodySchema = z.object({ branchId: z.string().min(1).optional() })

/** The branch the caller named, from either channel, or `null` if they named none. */
export function namedBranch(req: { query?: unknown; body?: unknown }): string | null {
  const fromQuery = querySchema.safeParse(req.query ?? {})
  if (fromQuery.success && fromQuery.data.branchId) return fromQuery.data.branchId
  const fromBody = bodySchema.safeParse(req.body ?? {})
  if (fromBody.success && fromBody.data.branchId) return fromBody.data.branchId
  return null
}

/**
 * The RBAC `subject` for a branch-scoped route.
 *
 * Returns what the caller *asked for*, so authorization judges the real target: a branch manager
 * reaching for another branch is refused rather than quietly served his own.
 */
export const branchSubject = (req: {
  actor?: { branchId: string | null }
  query?: unknown
  body?: unknown
}): { branchId: string | null } => ({ branchId: namedBranch(req) ?? req.actor?.branchId ?? null })

/**
 * The branch to operate on, or a 422 telling the caller to name one.
 *
 * By the time this runs, authorization has already confirmed the actor may touch this branch.
 */
export function resolveBranchId(req: {
  actor?: { branchId: string | null }
  query?: unknown
  body?: unknown
}): string {
  const branchId = branchSubject(req).branchId
  if (!branchId) {
    throw new ServiceError(422, 'branch_required', {
      hint: 'organisation-wide roles must name a branch (?branchId= on a read, branchId in the body on a write)',
    })
  }
  return branchId
}
