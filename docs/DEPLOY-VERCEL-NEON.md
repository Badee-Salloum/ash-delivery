# Deploying to Vercel + Neon

The VPS path (Docker Compose + Caddy) is in `infra/` and still works. This is the serverless
path, and it is **live**. **Read §3 before going live — one of those points loses evidence photos
if ignored.**

---

## 0. The live deployment

Team `hadis-projects-3c86ccdb`, three projects, all public (no deployment protection):

| Surface | URL | Notes |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | React SPA, `/api/*` proxied to the API |
| Driver PWA | https://ash-driver.vercel.app | installable PWA, `/api/*` proxied to the API |
| API | https://ash-api-xi.vercel.app | Fastify serverless function |
| Database | Neon `ep-billowing-butterfly-…` (eu-central-1, **Postgres 18**) | migrated + bootstrapped |
| Evidence | Vercel Blob store `ash-evidence` (private) | linked to `ash-api` |

Verified end to end: `POST /api/auth/login` → 200 with a session cookie that survives the proxy;
an authenticated `GET /api/notifications` → 200; the same route without the cookie → 401.

**First admins** were created by the bootstrap (§1.3) with generated passwords, handed over
separately. They must **change their password and enrol 2FA on first login** — every admin role
requires TOTP (SRS §7); `login` returns `enrollmentRequired: true` until they do.

---

## 1. Neon

### 1.1 Connection strings

Two strings from the dashboard:

| Use | Which string | Why |
| --- | --- | --- |
| `DATABASE_URL` for the app | the **pooled** one (host contains `-pooler`) | Every warm Vercel instance holds its own pool. The direct endpoint exhausts Postgres under modest concurrency. |
| Migrations / bootstrap | the **direct** one (drop `-pooler`) | They take a session advisory lock and run DDL; a transaction-mode pooler can hand those to different backends. |

### 1.2 Running migrations — mind the network

Migrations run over the pg wire protocol on **port 5432**. From a network that blocks or resets
5432 — **including the Damascus dev machine**, where the geo-block the SRS warns about resets the
Postgres handshake after ~20 s while HTTPS/443 stays open — the ordinary `pg` driver cannot
connect. Two options:

- **From a network where 5432 is open** (CI, most clouds — Vercel's own functions reach Neon fine):
  ```bash
  DATABASE_URL='postgres://…@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require' \
    node apps/api/src/migrate-cli.ts
  ```
- **From a 5432-blocked network**, use Neon's serverless driver (HTTPS/WebSocket on 443). It is a
  devDependency of `@ash/db`. `migrate()` accepts its `Pool` unchanged (structurally pg-compatible):
  ```js
  import { neonConfig, Pool } from '@neondatabase/serverless'
  import { migrate } from '@ash/db'
  neonConfig.webSocketConstructor = globalThis.WebSocket   // Node 22+/25 has a global WebSocket
  await migrate(new Pool({ connectionString: DIRECT_URL }))
  ```
  This is exactly how the live database was migrated.

### 1.3 Bootstrap the production floor

The demo seed (`seed:demo`) **refuses production** — it posts a fake shift into the ledger. A live
database instead needs `bootstrap-cli`, which installs only the floor: the §3 permission matrix
(no login authorises without it), the Damascus branch, the default tier table, and two admins — and
**nothing operational** (no drivers, vehicles, or ledger rows):

```bash
# 5432 open: passwords are generated and printed once (or set ADMIN_*_PASSWORD)
node apps/api/src/bootstrap-cli.ts
```

From a 5432-blocked network, call `bootstrapProduction(pool, { admins })` from `apps/api/src/bootstrap.ts`
against a `@neondatabase/serverless` `Pool`, hashing passwords with `BcryptHasher` — same code path,
different driver. Idempotent: safe to re-run.

### 1.4 Prove the guards on Neon

The ledger guards are proven on stock Postgres 17 in CI and negative-tested. On Neon (Postgres 18)
they are **installed** (migration 0006 applied) but not yet re-verified, because `verify-guards.sql`
uses psql meta-commands (`\echo`) and `SET ROLE app_user`, and the app connects as `neondb_owner`.
Run it once from a machine with `psql` and 5432 open:

```bash
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/verify-guards.sql
```

The two role-independent triggers — an unbalanced entry rejected at COMMIT, and a locked-week write
raising `25006` — fire regardless of the connecting role, so those guarantees already hold. The
`REVOKE`-from-`app_user` layer is a second belt that is **inactive while the app connects as the
Neon owner**; for defence-in-depth, Bundle 1b should create a least-privilege Neon role. (Note the
guard file's `SET ROLE app_user` needs `GRANT app_user TO neondb_owner` first.)

---

## 2. Environment variables (project `ash-api`)

Set with `vercel env add <NAME> production --value <v>` (use `--value`; piping the value via stdin
silently stores an empty string). Current live config:

```bash
NODE_ENV=production
DATABASE_URL=postgres://…-pooler…/neondb?sslmode=require   # sensitive; the POOLED endpoint
DB_POOL_MAX=3            # small on purpose: pools multiply across warm instances
BR1_SPLIT_GATE=advisory  # keep advisory until BR1 is calibrated — see RUNBOOK §1
TZ_OFFSET_MINUTES=180    # Asia/Damascus, UTC+3 year-round since Oct 2022
LOG_LEVEL=info

BLOB_DRIVER=vercel                 # private Vercel Blob (§3)
BLOB_READ_WRITE_TOKEN=…            # injected by linking the Blob store to the project
# BCRYPT_ROUNDS defaults to 12
```

`loadConfig()` validates all of this at boot and names the offending variable. It refuses to start
in production without `DATABASE_URL`, and refuses `BLOB_DRIVER=vercel` without `BLOB_READ_WRITE_TOKEN`
— so a misconfiguration is a failed deploy, not a 500 on the first photo a driver takes.

---

## 3. Evidence photos — the one that bites

**Vercel's filesystem is ephemeral and per-invocation.** With `BLOB_DRIVER=disk`, every photo a
driver uploads is gone on the next deploy — while the ledger still records the shift as approved and
photo-documented. `assertDurableBlobStore()` refuses to boot production on a non-durable store, so
this cannot happen silently.

**Live choice: a private Vercel Blob store** (`BLOB_DRIVER=vercel`, `VercelBlobStore` behind the
`BlobStore` port). Private access means a blob URL is not world-readable — every read carries the
token as a bearer credential, and the media route streams bytes server-side after an RBAC check.
`S3BlobStore` remains available (`BLOB_DRIVER=s3`, hand-rolled SigV4) for a VPS or R2/B2 deploy.
Storage estimate from SRS §7: ~10 GB/year at 10 vehicles, ~100 GB at 100.

---

## 4. The API function build

`@vercel/node` compiles a `.ts` function with default `tsc` options — no `allowImportingTsExtensions`,
no project references — which rejects this repo's explicit `.ts` import extensions even though
`pnpm typecheck` is green. So `scripts/build-api.mjs` (run by `vercel.json`'s `buildCommand`) bundles
the function to a single self-contained `api/index.mjs` with esbuild **before** Vercel sees it:
workspace source and node_modules alike are inlined (an externalised bundle 404s at runtime — Vercel's
tracer does not follow pnpm's symlinks). `api/index.mjs` and `public/` are generated, git-ignored.

## 5. What does NOT run on Vercel

| Thing | Why | Where it goes instead |
| --- | --- | --- |
| Migrations | Concurrent cold starts would race; a failure would hide behind a 500 | Direct connection, §1.2 |
| Bootstrap | Same, and it is a one-time floor | Direct connection, §1.3 |
| Nightly backups | No cron process, and Neon holds the data | Neon PITR + a scheduled `pg_dump` |
| The demo seed | Guarded to refuse production | Local / staging only |

Neon's branching gives point-in-time recovery. **The restore must still be rehearsed and timed once**
before go-live, and the number written into `RUNBOOK.md`. RTO < 4 h is a requirement.

---

## 6. Front-ends

Both SPAs are separate Vercel projects, deployed as **prebuilt static** via the Build Output API
(`vercel deploy --prebuilt`), which sidesteps the monorepo build and the root `vercel.json`. Each
carries a `.vercel/output/config.json` that proxies `/api/*` to the API and falls back to `index.html`:

```json
{ "version": 3, "routes": [
  { "src": "/api/(.*)", "dest": "https://ash-api-xi.vercel.app/$1" },
  { "handle": "filesystem" },
  { "src": "/.*", "dest": "/index.html" }
] }
```

The `/api` proxy is same-origin from the browser's view, so the session cookie stays `SameSite=Lax`
with no CORS — and Vercel forwards `Set-Cookie` back through the external rewrite (verified). To
redeploy a front-end: `pnpm build:apps`, copy `apps/<app>/dist/*` into a staging
`.vercel/output/static/`, add the config above, `vercel link --project ash-<app>`, then
`vercel deploy --prebuilt --prod`.

---

## 7. Deploy checklist

- [x] Migrations applied against the **direct** Neon URL (via the serverless driver, §1.2)
- [x] Production floor bootstrapped: §3 matrix, branch, tier table, two admins (§1.3)
- [ ] `verify-guards.sql` run against Neon and green (§1.4 — needs psql + 5432)
- [x] `BLOB_DRIVER=vercel` with a private store linked; round-trip proven by spike
- [x] `DATABASE_URL` is the **pooled** endpoint, `DB_POOL_MAX=3`
- [x] `BR1_SPLIT_GATE=advisory` for the pilot
- [x] Real admin users created by bootstrap (not the demo seed)
- [ ] Admins change passwords + enrol 2FA on first login
- [ ] A photo uploaded through the app and read back
- [ ] Restore rehearsed and **timed**, number written into `RUNBOOK.md`
- [ ] Consider a custom domain and re-enabling deployment protection for staging
