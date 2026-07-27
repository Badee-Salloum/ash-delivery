import type { Catalog } from '@ash/client/i18n'

/**
 * Turn an API error code into something a manager can act on.
 *
 * `branch_required` (an organisation-wide role has not named a branch) and `forbidden` (the §3
 * matrix says no) are the framing cases; the rest of the map in `t.errors` names the concrete
 * write failures a manager triggers — duplicate codes, an expired-document shift block, a receipt
 * ceiling, and so on. An unmapped code falls back to a neutral "that didn't go through" rather than
 * a raw string, so a toast is always readable; the raw code still shows under `Pending` for load
 * errors, where diagnosis matters.
 */
export function explainError(code: string | null, t: Catalog): string {
  if (!code) return t.common.actionFailed
  if (code === 'branch_required') return t.common.branchRequired
  if (code === 'forbidden' || code === 'outside_branch') return t.common.forbidden
  const mapped = (t.errors as Record<string, string>)[code]
  return mapped ?? t.common.actionFailed
}
