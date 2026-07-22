import type { Catalog } from '@ash/client/i18n'

/**
 * Turn an API error code into something a manager can act on.
 *
 * The two that actually happen in the console are `branch_required` (an organisation-wide role has
 * not named a branch) and `forbidden` (the §3 matrix says no — e.g. the system admin on the cash
 * count, which is branch manager + GM by design). Anything else falls back to a generic line with
 * the raw code beneath it, so an unexpected failure is still diagnosable rather than invisible.
 */
export function explainError(code: string | null, t: Catalog): string {
  if (!code) return t.common.loadFailed
  if (code === 'branch_required') return t.common.branchRequired
  if (code === 'forbidden') return t.common.forbidden
  return t.common.loadFailed
}
