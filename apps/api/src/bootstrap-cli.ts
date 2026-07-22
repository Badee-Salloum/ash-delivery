import { randomBytes, randomUUID } from 'node:crypto'
import { assertBigIntParser, createPool, migrate } from '@ash/db'
import { bootstrapProduction } from './bootstrap.ts'
import { loadConfig } from './config.ts'
import { BcryptHasher } from './runtime.ts'

/**
 * `node src/bootstrap-cli.ts` — the production floor: migrations, the §3 permission matrix, a
 * branch, the default tier table, and two administrators (a system admin and a general manager).
 *
 * Unlike the demo seed, this posts NOTHING to the ledger, so it is safe against a live database.
 * Passwords are read from ADMIN_SYSADMIN_PASSWORD / ADMIN_GM_PASSWORD when set, otherwise a strong
 * one is generated and printed ONCE. Either way the operator must change them on first login.
 *
 * Note: this uses the node-postgres driver over the pooled endpoint, which needs a network that
 * can reach Postgres on 5432. From a network that blocks 5432, run the equivalent over Neon's
 * serverless (HTTPS) driver instead — see docs/DEPLOY-VERCEL-NEON.md.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to bootstrap')

  const genPassword = () => randomBytes(12).toString('base64url')
  const sysadminPassword = process.env.ADMIN_SYSADMIN_PASSWORD ?? genPassword()
  const gmPassword = process.env.ADMIN_GM_PASSWORD ?? genPassword()

  const hasher = new BcryptHasher(config.BCRYPT_ROUNDS)
  const sysadmin = {
    id: randomUUID(),
    username: process.env.ADMIN_SYSADMIN_USERNAME ?? 'admin',
    roleKey: 'system_admin',
    fullNameAr: 'مدير النظام',
    passwordHash: await hasher.hash(sysadminPassword),
  }
  const gm = {
    id: randomUUID(),
    username: process.env.ADMIN_GM_USERNAME ?? 'gm',
    roleKey: 'general_manager',
    fullNameAr: 'المدير العام',
    passwordHash: await hasher.hash(gmPassword),
  }

  const pool = createPool(config.DATABASE_URL, 2)
  try {
    await assertBigIntParser(pool)
    await migrate(pool)
    const { created } = await bootstrapProduction(pool, { admins: [sysadmin, gm] })
    console.log(`bootstrap complete: reference data + tier table installed; users created: ${created.join(', ')}`)
    console.log('─'.repeat(60))
    console.log(`  ${sysadmin.username} (system_admin)     password: ${sysadminPassword}`)
    console.log(`  ${gm.username} (general_manager)  password: ${gmPassword}`)
    console.log('─'.repeat(60))
    console.log('CHANGE THESE ON FIRST LOGIN. They are shown once and never stored in plaintext.')
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('[ash] bootstrap failed:', err)
  process.exit(1)
})
