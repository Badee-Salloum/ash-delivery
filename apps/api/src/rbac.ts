import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Deps, RoleGrantRecord } from '@ash/contracts'
import {
  type Actor,
  type GrantTable,
  type PermissionKey,
  type Scope,
  type Subject,
  DEFAULT_GRANTS,
  can,
} from '@ash/domain'

/**
 * Server-side authorization.
 *
 * The kickoff brief's rule: UI hiding is not security. Every protected route DECLARES the
 * permission it needs, a preHandler enforces it, and `assertEveryRouteDeclaresPermission()`
 * refuses to boot if any route forgot. That last part is the load-bearing one — a permission
 * check you remembered to write is worth much less than one you cannot forget.
 */

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor
    sessionToken?: string
    /** Whether the current session has cleared its second factor (SRS §7, admin roles). */
    mfaSatisfied?: boolean
    /**
     * The scope the authorisation actually granted — 'all', 'branch' or 'own'.
     *
     * Set once the decision is allowed, so a handler can narrow WHAT IT ANSWERS by the same rule
     * that let the caller in, instead of restating a role list. The difference between a person
     * who may audit a branch and a person who is himself the subject of the audit is exactly this
     * scope, and nothing else on the request carries it.
     */
    grantedScope?: Scope
    requestId: string
  }
  interface FastifyContextConfig {
    /** `null` marks a deliberately public route (login, health). */
    permission?: PermissionKey | null
    /** How to find the subject a `branch`/`own` grant is scoped against. */
    subject?: (req: FastifyRequest) => Promise<Subject> | Subject
  }
}

/** Build the grant table from stored rows (SRS A-2), falling back to the seeded default. */
export function grantsFromRows(rows: readonly RoleGrantRecord[]): GrantTable {
  if (rows.length === 0) return DEFAULT_GRANTS
  const table: Record<string, Record<string, Scope>> = {}
  for (const row of rows) {
    ;(table[row.permissionKey] ??= {})[row.roleKey] = row.scope
  }
  return table as GrantTable
}

/**
 * The only permissions that may name the company (HQ) row as their subject (finance redesign C1).
 *
 * The HQ row holds «صندوق الشركة» and nothing else: no drivers, no shifts, no cash counts, no
 * expenses. A branch permission pointed at it — `?branchId=<HQ>` on a treasury or dashboard read, a
 * manual entry, a cash count — would read or write branch machinery against the company ledger. So
 * everything is refused there except managing the company fund itself, sealing its week, and
 * auditing it.
 */
export const COMPANY_ADDRESSABLE_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'company_fund.manage',
  'week.close',
  'audit.view',
])

/**
 * The `branchId` a request names, from the query or the body — the same two channels
 * `branch-scope.ts` reads. Kept local: that module imports the service layer, which must not be
 * pulled into the authorization hook.
 */
function requestedBranchId(req: FastifyRequest): string | null {
  for (const source of [req.query, req.body]) {
    if (typeof source !== 'object' || source === null) continue
    const value = (source as { branchId?: unknown }).branchId
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

export function makeAuthorize(deps: Deps) {
  // The HQ id never changes (0066 fixes it), so it is read once. Only a FOUND id is cached: an
  // environment that has no company row yet keeps asking, and starts refusing the moment one exists.
  let companyBranchId: string | null = null
  const isCompanyBranch = async (branchId: string): Promise<boolean> => {
    companyBranchId ??= (await deps.directory.companyBranch())?.id ?? null
    return companyBranchId !== null && companyBranchId === branchId
  }

  return async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const config = req.routeOptions.config as { permission?: PermissionKey | null; subject?: (r: FastifyRequest) => Promise<Subject> | Subject }
    const permission = config.permission

    if (permission === null) return // explicitly public

    if (permission === undefined) {
      /*
       * No route matched at all.
       *
       * This hook is global, and Fastify runs preHandler hooks on its NOT-FOUND route too — which
       * declares no permission, because it is not a route anyone wrote. So every typo, every stale
       * client URL and every scanner probe was answering `500 route_misconfigured`: the server
       * reporting its own fault for a thing that simply does not exist. Real 500s are how you find
       * real breakage, and burying them under 404s costs exactly that.
       *
       * `routeOptions.url` is the discriminator: Fastify leaves it undefined when nothing matched.
       */
      if (req.routeOptions.url === undefined) {
        await reply.code(404).send({ error: 'not_found' })
        return
      }
      // A REGISTERED route that declares no permission is the real misconfiguration, and the boot
      // assertion refuses to start in that state. Fail closed if one ever slips through.
      req.log.error({ url: req.url }, 'route declares no permission')
      await reply.code(500).send({ error: 'route_misconfigured' })
      return
    }

    if (!req.actor) {
      await reply.code(401).send({ error: 'unauthenticated' })
      return
    }

    // A session that has not cleared its second factor may authenticate (/me works) but may not
    // reach any permissioned route. 403 with a specific code so the UI shows the 2FA step.
    if (req.mfaSatisfied === false) {
      await reply.code(403).send({ error: 'second_factor_required' })
      return
    }

    const subject: Subject = config.subject ? await config.subject(req) : {}

    // Before the grant, so the refusal says what is actually wrong — for the general manager too,
    // whose `all` scope would otherwise wave the company row through as one more branch. Both the
    // resolved subject AND the branch the request names are judged: a few organisation-wide reads
    // (`/dashboard/profit`, `/dashboard/treasury`) declare an empty subject and still read
    // `?branchId=` in the handler.
    if (!COMPANY_ADDRESSABLE_PERMISSIONS.has(permission)) {
      for (const branchId of new Set([subject.branchId, requestedBranchId(req)])) {
        if (typeof branchId !== 'string' || !(await isCompanyBranch(branchId))) continue
        req.log.warn(
          { actor: req.actor.userId, role: req.actor.roleKey, permission, branchId },
          'authorization denied: the company branch is not addressable by this permission',
        )
        await reply.code(403).send({ error: 'company_branch_not_addressable', permission })
        return
      }
    }

    const grants = grantsFromRows(await deps.directory.grants())
    const decision = can(req.actor, permission, subject, grants)

    if (!decision.allowed) {
      // Log the machine-readable reason: a 403 that does not say WHY is unauditable later.
      req.log.warn(
        { actor: req.actor.userId, role: req.actor.roleKey, permission, reason: decision.reason },
        'authorization denied',
      )
      await reply.code(403).send({ error: 'forbidden', permission, reason: decision.reason })
      return
    }

    req.grantedScope = decision.scope
  }
}

export class RouteMisconfiguration extends Error {}

/**
 * Boot-time completeness assertion.
 *
 * Every registered route must state its permission — or state `null` to be public on purpose.
 * A route that says nothing is a route somebody forgot, and forgetting is exactly how an
 * authorization hole gets shipped. This throws rather than warning, so the mistake cannot reach
 * production behind a log line nobody read.
 */
export function assertEveryRouteDeclaresPermission(app: FastifyInstance): void {
  const offenders: string[] = []
  for (const route of app.printRoutes({ commonPrefix: false }).split('\n')) void route

  // printRoutes is for humans; the reliable source is the onRoute hook's collected registry.
  for (const entry of collected) {
    if (entry.permission === undefined) offenders.push(`${entry.method} ${entry.url}`)
  }
  if (offenders.length > 0) {
    throw new RouteMisconfiguration(
      `these routes declare no permission (use \`config: { permission: null }\` to make one public on purpose):\n  ` +
        offenders.join('\n  '),
    )
  }
}

interface CollectedRoute {
  method: string
  url: string
  permission: PermissionKey | null | undefined
}

const collected: CollectedRoute[] = []

/** Register on the app so every route lands in the registry the assertion reads. */
export function collectRoutes(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/__')) return
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      collected.push({
        method,
        url: route.url,
        permission: (route.config as { permission?: PermissionKey | null } | undefined)?.permission,
      })
    }
  })
}

/** Test helper: the registry is module-level, so suites must not leak into each other. */
export function resetRouteRegistry(): void {
  collected.length = 0
}

export function routeRegistry(): readonly CollectedRoute[] {
  return collected
}
