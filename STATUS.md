# STATUS — where ASH Delivery stands

Written for you coming back to this cold. **Last validated production baseline (migrations
`0028`–`0030`, 2026-08-14, Node 24):** `pnpm check`, both front-end builds, the standalone API
build, PostgreSQL 17's tests, and all database guards were green. The newer fixed-settlement
candidate is also locally release-gated: current `pnpm check`, both front-end builds and the API
bundle passed on Node 24; fresh PostgreSQL 17.11 applied 31/31 migrations, reran with 0 pending,
passed 59/59 DB tests and every guard. This is verification evidence, not a production-deploy claim.

---

## The one-line answer

**Bundle 1a and the shift-window/cash-deduction release are live on Vercel + Neon + Vercel Blob;
the fixed 40% cash-settlement release is the current, newer change set.** The live API, both
front-ends, database, and evidence storage remain on the verified `0028`–`0030` baseline until the
new migration/API/admin/PWA rollout is recorded. Do not infer a deployment from source changes.

## Live URLs (team `hadis-projects-3c86ccdb`, all public)

| Surface | URL |
| --- | --- |
| Admin console | https://ash-admin-eta.vercel.app |
| Driver PWA | https://ash-driver.vercel.app |
| API | https://ash-api-xi.vercel.app |

Neon (Postgres 18, eu-central-1) has the **30-migration live baseline** and is bootstrapped with the §3
permission matrix, the Damascus branch, the historical tier table, and two admins
(`admin`/system_admin, `gm`/general_manager)
— **no demo data in the live ledger.** Full deploy detail and redeploy steps:
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

---

## What exists in the last validated live baseline

| Layer | State |
| --- | --- |
| **Domain** (money, BR1, tiers, ledger, shifts, RBAC, dates, FX, week, fleet, TOTP) | ✅ 404 tests, property-based |
| **API** — A, B, C, E, F, G plus operation-window and evidence flows | ✅ 513 tests over real HTTP |
| **PostgreSQL adapters** | ✅ 40/40 on PostgreSQL 17; isolated Neon restore/fingerprint rehearsal passed |
| **In-memory adapters** | ✅ 46 tests against the shared contracts |
| **Shared client** (API client, i18n ar/en, order-entry model) | ✅ 199 tests |
| **Driver PWA** | ✅ 188 tests, builds, service worker, live smoke passed |
| **Admin console** | ✅ 6 tests, builds, live smoke passed |

### By SRS section — all in scope for Bundle 1a, all done

- **A** auth (incl. **2FA/TOTP**), RBAC-as-data, audit, settings, branches, **notification bell**
- **B** drivers, vehicles, documents + expiry, assignment
- **C** shift lifecycle, canonical operation window, cash deductions, both gates, end-odo OCR,
  evidence provenance, BR1 + ranked causes, **C-7 review UI**
- **E** funds tree, double-entry, FX, **cash count**, **manual entries + corrections**, Sunday close
- **F (historical baseline)** tier engine, whole + marginal, day true-up, effective-dated admin +
  what-if simulation. The new policy retires these write paths and uses fixed 40% per unapproved shift.
- **G** expenses, cost centres, receipt ceiling
- **I-1** the minimal ops dashboard (in scope per the brief)

### Seven repository guards, plus the PostgreSQL guard harness

domain-purity · SQL-correctness · wire-money · TypeScript-strippability · **physical-CSS (RTL)** ·
**i18n-parity** · **glyph-corpus parity**. The database harness separately attempts forbidden
ledger and locked-week writes on a disposable database; it passed on PostgreSQL 17. Never point
conformance at production because it truncates application tables.

---

## What is NOT done

| Item | Effort | Note |
| --- | --- | --- |
| Full visual/device QA of the UIs | — | Public route and API smoke tests pass; exhaustive browser, camera, offline, and install testing is still owed. |
| Fixed-settlement production rollout | — | Local Node-24 checks/builds and fresh PostgreSQL 17 tests are green. Migration 0031 plus API/admin/PWA still require the coordinated RUNBOOK maintenance deployment and postflight. |
| Historical tier admin | retired | Tier tables remain readable for approved history; editing and publication are intentionally disabled by the fixed 40% policy. |
| QR code on 2FA enrolment | ~1 h | The secret is shown for manual entry; a QR renderer is a nicety. |
| Attendance (B-4) | ~0.5 day | Table only. |
| Evidence thumbnails in C-7 | ~0.5 day | The review lists which slots are present; the id-addressed image endpoint exists, the `<img>` wiring does not. |

---

## Outstanding operational checklist

1. **Send `docs/client-request-samples.md`.** Still the highest-value hour. The signed wallet/cash
   settlement is measured against a wallet number Yallago produces; compare one complete real shift
   before treating the variance explanation as calibrated. Variance no longer blocks submission.
2. ~~**Prove the database release and restore path.**~~ **Done** on PostgreSQL 17 and isolated Neon;
   the latest restore reproduced 2,360 rows across 52 tables. Destructive suites stay off production.
3. ~~**Pick object storage.**~~ **Done — Vercel Blob (private).** `BLOB_DRIVER=vercel`, a
   `VercelBlobStore` adapter behind the `BlobStore` port, store linked to the `ash-api` project so
   `BLOB_READ_WRITE_TOKEN` is injected. The durable-storage boot guard accepts it; evidence photos
   cannot silently vanish. (`s3` remains available for a VPS deploy.)
4. **Have a fluent speaker review the Arabic** — ~150 keys, including the BR1 cause explanations a
   manager reads under time pressure. CI checks key parity, not that the financial Arabic is right.
5. **Complete admin password changes and 2FA enrolment.** The production floor already contains the
   real admins; the demo seed remains forbidden in production.
6. **Move backups off the operator laptop and copy Vercel Blob evidence.** A local logical backup
   and a provider snapshot do not cover the same failures.
7. ~~**Rotate the Neon owner credential and secure database credentials.**~~ **Done:** the old
   direct and pooled credentials are rejected, and runtime/owner secrets are DPAPI-protected outside
   the repository.
8. **Rotate the Vercel token once in the personal-account Dashboard.** Its token-creation API
   returned forbidden, so the working token was intentionally not revoked. Create and test the
   successor first, then revoke the predecessor; this is the only remaining credential follow-up.

Full deploy steps: `docs/DEPLOY-VERCEL-NEON.md`.

---

## Bugs the tests caught during the build

Each was invisible to reading:

1. `0.80 × Σfees` makes BR1 unsatisfiable once a fee is not divisible by 5 — the block is a residual.
2. A driver's wallet can go negative while BR1 still reads exactly zero — found by a property test.
3. A manual entry naming `office_cash` moved *nothing* (every code was wrapped as a cost centre).
4. The evidence gates were checking a client *claim*, not a photo.
5. Nobody could create a driver (fleet writes were guarded by a branchless permission).
6. The API could not start — TypeScript parameter properties are not strippable by Node.

---

## Commands

```bash
pnpm install
pnpm check          # Node 24: typecheck + 7 repository guards + unit/API/UI tests
pnpm build:apps     # build the driver PWA and admin console
node scripts/build-api.mjs
pnpm start          # API on :3000 (in-memory store)
./scripts/db-verify.sh   # disposable PostgreSQL only; prove the DB guards (needs Docker)
DATABASE_URL='<disposable-db>' pnpm --filter @ash/db test   # NEVER production: truncates tables
```

Key docs: [CLAUDE.md](CLAUDE.md) · [ASSUMPTIONS.md](ASSUMPTIONS.md) · [TESTS.md](TESTS.md) ·
[RUNBOOK.md](RUNBOOK.md) · [docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md)
