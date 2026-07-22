import type { Pool } from '@ash/db'
import { DEFAULT_BANDS } from '@ash/domain'
import { createUser, seedReferenceData } from './seed.ts'

/**
 * Production bootstrap — the honest counterpart to the demo `seed()`.
 *
 * The demo seed refuses to run against production because it posts a fake shift into the ledger.
 * But a production database still needs a floor to stand on: the §3 permission matrix (without it
 * no login can be authorised), a branch, a starting tier table, and at least one administrator to
 * create everyone else. That — and nothing operational, no drivers, no vehicles, no ledger rows —
 * is what this installs. Idempotent: every write is ON CONFLICT DO NOTHING.
 *
 * The RUNBOOK's "create the first admin by hand" step. Passwords are chosen by the operator and
 * passed in already hashed; this module never sees a plaintext password and never invents one.
 */

export interface AdminSpec {
  /** Stable uuid for the row. */
  id: string
  username: string
  /** 'system_admin' | 'general_manager' | 'branch_manager' — a role that exists in the matrix. */
  roleKey: string
  fullNameAr: string
  /** bcrypt hash; the caller hashes, so plaintext never reaches this layer. */
  passwordHash: string
}

export async function bootstrapProduction(
  pool: Pool,
  opts: { admins: AdminSpec[] },
): Promise<{ branchId: string; created: string[] }> {
  const { branchId } = await seedReferenceData(pool)

  const created: string[] = []
  for (const a of opts.admins) {
    // GM and sysadmin are global (no branch); a branch manager is scoped to the one branch.
    const branchScoped = a.roleKey === 'branch_manager'
    await createUser(pool, {
      id: a.id,
      branchId: branchScoped ? branchId : null,
      roleKey: a.roleKey,
      username: a.username,
      fullNameAr: a.fullNameAr,
      passwordHash: a.passwordHash,
    })
    created.push(a.username)
  }

  // The documented default tier table (CLAUDE.md), active from the start of the year, created by
  // the first system admin. The sysadmin can edit it later; effective-dated so history is safe.
  const sysadmin = opts.admins.find((a) => a.roleKey === 'system_admin')
  if (sysadmin) {
    await pool.query(
      `INSERT INTO tier_rules (basis, mode, vehicle_type_id, bands, effective_from, status, created_by)
       VALUES ('orders','whole',NULL,$1,'2026-01-01','active',$2)
       ON CONFLICT (vehicle_type_id, effective_from) DO NOTHING`,
      [JSON.stringify(DEFAULT_BANDS), sysadmin.id],
    )
  }

  return { branchId, created }
}
