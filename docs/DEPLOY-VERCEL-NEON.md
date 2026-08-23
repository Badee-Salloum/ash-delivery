# Deploying to Vercel + Neon

The VPS path (Docker Compose + Caddy) is in `infra/` and still works. This is the serverless
path, and it is **live**. **Read §3 before going live — one of those points loses evidence photos
if ignored.**

---

## 0. The live deployment

Team `hadis-projects-3c86ccdb`, three projects, all public (no deployment protection):

| Surface | URL | Live deployment / notes |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | `dpl_9d5Zp8QHMwuKiUB5SxJXgR5xWvpw`; React SPA, `/api/*` proxied to API |
| Driver PWA | https://ash-driver.vercel.app | `dpl_GzB3CyzkjEFBeYyP1WaHQwZYHccw`; installable PWA, `/api/*` proxied to API |
| API | https://ash-api-xi.vercel.app | `dpl_9DnbaiswA4bPP1bCEJ8H2eLi4Fub`; Fastify serverless function |
| Database | Neon `ep-billowing-butterfly-…` (eu-central-1, **Postgres 18**) | live at `0035` (35 migrations) + bootstrapped |
| Evidence | Vercel Blob store `ash-evidence` (private) | linked to `ash-api` |

**Version boundary:** production is at `0035`, deployed 2026-08-23 from commit `6389816`. The three
known cancelled-shift tranche/journal discrepancies remain explicit owner-accepted historical
exceptions: `0df7c7f1-105c-40b3-97ec-3fc81f83874c`,
`f51cd7a1-ffa5-4e72-b0e4-a1761531b11b`, and `b81ad711-835b-479a-8ee1-37105ca96c21`. The owner
accepted exactly this set at 08:21 Damascus on 2026-08-23. No Muhammad/Thaer production repair or
fabricated transaction was performed.

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
| `DATABASE_URL` for the app | `ash_runtime` on the **pooled** endpoint (host contains `-pooler`) | Every warm Vercel instance holds its own pool; the login inherits `app_user` and owns no schema objects. |
| Migrations | `neondb_owner` on the **direct** endpoint (drop `-pooler`) | DDL and the advisory migration lock require the owner; this credential is never installed in Vercel. |

`ash_runtime` is the only database identity used by the deployed API. It inherits the permission
matrix from `app_user`, cannot update/delete journal rows, and must not be able to create temporary
tables. Harden each production database after creating the role:

```sql
REVOKE TEMPORARY ON DATABASE neondb FROM PUBLIC;
GRANT TEMPORARY ON DATABASE neondb TO neondb_owner;
```

Confirm `ash_runtime` and `app_user` have no effective TEMP privilege and that only the owner retains
it. Store the pooled runtime URL as a sensitive production environment variable. The direct owner
URL is operator-held and used only for the forward migration path, never for normal API traffic.

### 1.2 Running migrations — mind the network

Migrations run over the pg wire protocol on **port 5432**. From a network that blocks or resets
5432 — **including the Damascus dev machine**, where the geo-block the SRS warns about resets the
Postgres handshake after ~20 s while HTTPS/443 stays open — the ordinary `pg` driver cannot
connect. Two options:

- **From a network where 5432 is open** (CI and most clouds):
  ```bash
  DATABASE_URL='<direct-owner-url>' pnpm migrate
  ```
- **From a 5432-blocked network**, use Neon's serverless driver (HTTPS/WebSocket on 443). It is a
  dependency of `@ash/db`; the checked-in runner is Node-24 compatible and shares the TCP runner's
  checksum ledger and advisory lock:
  ```bash
  DATABASE_URL='<direct-owner-url>' node packages/db/apply-migrations.mjs
  ```

Both paths are deliberately **forward-only**. Never edit an applied migration and never improvise a
`DOWN` script for production history. A schema rollback means switching to a verified pre-migration
branch/snapshot or restoring the pre-migration logical backup into an empty database.

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

### 1.4 Prove guards and adapters only on disposable databases

Release `6389816` passed the full Node `24.19.0` gate: **1,916/1,916** tests, including **108/108**
real-PostgreSQL tests with zero database skips, after fresh migrations `0001`–`0035`. The checksum
rerun applied `0` and found all 35 migrations. `0034` is FNV `5bc30a31` / SHA-256
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`; `0035` is FNV `087c01d4` /
SHA-256 `D3958FCABB4886E390DBCD969E8BFA1241265A8CA661A843C80FA51176ECEF40`.

The PostgreSQL suite and guard harness are destructive verification tools, not production health
checks: conformance runs `TRUNCATE` in `beforeEach`, and the guard harness intentionally attempts
forbidden writes. Production receives only read-only integrity checks plus tightly scoped denial
probes whose fixtures are rolled back.

Point them only at a positively identified disposable database:

```bash
DATABASE_URL='<disposable-postgres-url>' pnpm --filter @ash/db test
psql '<disposable-postgres-url>' -v ON_ERROR_STOP=1 -f packages/db/verify-guards.sql
```

Never substitute the live URL into either command above.

`scripts/restore-db.mjs` currently uses Neon's HTTP adapter and does not target a localhost
PostgreSQL server. The `0035` local restore rehearsal therefore used a temporary, out-of-repository
copy wired to `pg`. The restored fingerprints and invariants passed, but adding a checked-in local
mode remains deferred.

---

## 2. Environment variables (project `ash-api`)

Set with `vercel env add <NAME> production --value <v>` (use `--value`; piping the value via stdin
silently stores an empty string). Current live config:

```bash
NODE_ENV=production
DATABASE_URL=postgres://ash_runtime:…@…-pooler…/neondb?sslmode=require   # sensitive; pooled
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

A manager may ask the API to reread one explicitly selected, immutable Recent Orders attachment.
That operation returns **suggestions only**: it never edits an order, cash deduction, BR1 input, or
settlement. The audit trail records the selected media id and attachment token, requester, reason,
read result, and the reviewed order/settlement hashes; applying a suggestion remains a separate,
explicit audited manager action.

---

## 4. The API function build

`@vercel/node` compiles a `.ts` function with default `tsc` options — no `allowImportingTsExtensions`,
no project references — which rejects this repo's explicit `.ts` import extensions even though
`pnpm typecheck` is green. So `scripts/build-api.mjs` (run by `vercel.json`'s `buildCommand`) bundles
the function to a single self-contained `api/index.mjs` with esbuild **before** Vercel sees it:
workspace source and node_modules alike are inlined (an externalised bundle 404s at runtime — Vercel's
tracer does not follow pnpm's symlinks). `api/index.mjs` and `public/` are generated, git-ignored.

## 5. What does NOT run automatically on Vercel

| Thing | Why | Where it goes instead |
| --- | --- | --- |
| Migrations | Concurrent cold starts would race; a failure would hide behind a 500 | Direct connection, §1.2 |
| Bootstrap | Same, and it is a one-time floor | Direct connection, §1.3 |
| Logical backups | A function deployment is not a backup scheduler | Neon PITR + scheduled HTTPS logical exports to separately controlled storage |
| The demo seed | Guarded to refuse production | Local / staging only |

Neon's branching gives point-in-time recovery, but it is not the independent logical copy.
Historical recovery evidence: the 2026-08-14 rehearsal restored **2,360 rows across 52 tables** into
an isolated scratch database and verified fingerprints, zero trial balance, sequences, enabled
triggers, and a write rollback. See `RUNBOOK.md` for the procedure and the earlier measured RTO;
keep rehearsing as data volume grows.

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

### Validated live `0035` checklist — 2026-08-23

- [x] Frozen commit `6389816`: Node 24 gate, both frontend builds, API bundle, and 108/108 real-DB tests
- [x] Read-only preflight and inventory; two open shifts identified before maintenance
- [x] Exact three historical cancelled-shift exceptions explicitly accepted; no repair or suppression
- [x] API writes paused and database activity drained without changing either open shift
- [x] Validated pre-backup: 58 tables / 3,852 rows / 34 migrations
- [x] Applied `0035` only; immediate checksum rerun found 0 pending / all 35 present
- [x] Postflight guards, runtime denial probes, and permanent integrity checker passed apart from the exact accepted exceptions
- [x] Validated post-backup: 58 tables / 3,853 rows / 35 migrations
- [x] API promoted first, then driver and admin, while writes remained paused
- [x] Health/auth/proxy/SPA/PWA/dashboard smokes passed after resume; admin `index-DGhFwpyp.js`, driver `index-Z4O4ZOFe.js`
- [x] Post-backup restored into an explicitly named disposable database; all table fingerprints, 27 sequences, triggers, journals, and rollback probe verified
- [ ] Audit the two real-staff closes: count reversal, fixed-40% settlement, immutable decision/hash coupling, balanced journals, and zero residual balances
- [ ] Rotate the deployment token disclosed during the rollout after verifying its successor

### Validated live `0033` checklist — historical production record

For every schema release: build and stage candidate API, admin, and driver artifacts first; pause
`ash-api` and drain database activity; validate the pre-migration logical backup; migrate once as
the owner; run read-only postflight and rolled-back runtime-role denial probes; then validate the
post-migration backup. Keep the API paused while promoting **API, admin, and driver together**.
If one promotion fails, keep it paused until all three aliases are coherently back on the old set or
forward on the new set. Only then unpause the API and smoke-test health/auth, both proxies, both
SPAs, the manifest, and service worker. Then restore the new backup into an isolated scratch
database. The detailed, failure-aware sequence is in `RUNBOOK.md` §5.

- [x] All 33 migrations applied against the **direct owner** Neon URL (§1.2); live head is `0033`
- [x] Production floor bootstrapped: §3 matrix, branch, tier table, two admins (§1.3)
- [x] Release `a150380`: full Node 24 gates and PostgreSQL 17 suite 69/69 green (§1.4)
- [x] Isolated Neon restore/fingerprint/invariant rehearsal passed; never run conformance on production
- [x] `BLOB_DRIVER=vercel` with a private store linked; round-trip proven by spike
- [x] `DATABASE_URL` uses least-privilege `ash_runtime` on the **pooled** endpoint, `DB_POOL_MAX=3`
- [x] Owner credential excluded from Vercel; `TEMPORARY` revoked from `PUBLIC`
- [x] `BR1_SPLIT_GATE=advisory` for the pilot
- [x] Real admin users created by bootstrap (not the demo seed)
- [x] Pre- and post-migration logical backups fully validated
- [x] Pre-release backup validated: 53 tables / 2,993 rows / 32 migrations
- [x] Post-release backup validated: 53 tables / 2,994 rows / 33 migrations; `0033` checksum `687e773f`
- [x] API, admin, and driver promoted together while paused, then unpaused and smoke-tested after `0033`
- [x] Three-pass literal-time consensus live; old `11:*` order-cache results invalidated and one explicit retry retained
- [x] Production read-only postflight completed while paused, before post-backup and promotion
- [x] Historical 2026-08-14 restore rehearsal: 52 tables / 2,360 rows plus fingerprints, trial, sequences, triggers, rollback
- [x] Neon scratch database dropped normally after confirming zero active sessions
- [x] Neon owner credential rotated; old direct and pooled credentials rejected
- [x] Runtime and owner database secrets protected outside the repository with Windows DPAPI
- [ ] Admins change passwords + enrol 2FA on first login
- [ ] A photo uploaded through the app and read back
- [ ] Move encrypted logical backups and Vercel Blob evidence to separately controlled storage
- [ ] In the personal-account Dashboard, create and verify a successor Vercel token, then revoke the
      predecessor; API creation is forbidden and the working token remains active to avoid lockout
- [ ] Consider a custom domain and re-enabling deployment protection for staging
