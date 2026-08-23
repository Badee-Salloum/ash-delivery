# STATUS — where ASH Delivery stands

Written for you coming back to this cold. **Production is on migration `0035`, deployed
2026-08-23.** Live working-driver and working-vehicle dashboard counts, zero-opening-funds handling,
safe tranche retries, money-range and settlement database guards, corrected dashboard profit
semantics, and the permanent read-only shift-money integrity checker are live. A driver may hand an
end package to manager review even when its money differs or end-battery evidence is incomplete.
Incomplete packs become explicit manager-reading obligations; this does not bypass manager approval
or settlement.

The final isolated gate ran on Node `24.19.0`, pnpm `11.3.0`, and PostgreSQL `17.11`. A frozen
install, full `pnpm check`, and required real-PostgreSQL rerun passed **1,916/1,916 tests**: domain
425, contracts 12, shared client 256, admin 93, driver 256, adapters 119, real PostgreSQL database
108, and API 647. Both frontend
production builds and the API bundle passed. Fresh migrations `0001`–`0035` applied `35/35`; the
checksum rerun applied `0` and found all 35. The disposable database guard harness passed, and a
twice-seeded release database passed all 14 read-only integrity checks. Migration checksums are:

- `0034`: FNV `5bc30a31`; SHA-256
  `228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`
- `0035`: FNV `087c01d4`; SHA-256
  `D3958FCABB4886E390DBCD969E8BFA1241265A8CA661A843C80FA51176ECEF40`

Focused browser acceptance passed in Arabic and English at 390, 768, and 1280 px. Opening one
shift changed the distinct counts from `0/0` to `1/1` in 7,516 ms; a failed refresh preserved
`1/1` and visibly marked it stale; recovery took 7,693 ms; end submission removed the shift in
7,786 ms, before manager approval. The layout used 2/3/6 columns, had no horizontal overflow or
page errors, and polling the lightweight endpoint did not reload financial dashboard data.

The coordinated rollout completed from frozen commit `6389816`. API writes were paused and drained;
validated backups captured 58 tables / 3,852 rows before migration and 58 / 3,853 after it. Only
`0035` applied, then its checksum rerun found 0 pending / all 35 present. Postflight retained exactly
the three owner-accepted cancelled-shift exceptions and found no other violation. The API was
promoted first, followed by driver and admin, before writes resumed. Health/auth, both proxies and
SPA fallbacks, the dashboard route, manifest, service worker, admin asset `index-DGhFwpyp.js`, and
driver asset `index-Z4O4ZOFe.js` passed. A local disposable restore reproduced all 58 tables / 3,853
rows, every table fingerprint, 27 sequences, enabled triggers, zero unbalanced journals, and a clean
rolled-back write probe. The real-staff close audit remains a post-deployment requirement.

The accepted exception set is immutable deployment evidence: shifts
`0df7c7f1-105c-40b3-97ec-3fc81f83874c`, `f51cd7a1-ffa5-4e72-b0e4-a1761531b11b`, and
`b81ad711-835b-479a-8ee1-37105ca96c21`, accepted by the owner at 08:21 Damascus on 2026-08-23.
Any new or changed exception still blocks a future promotion.

---

## The one-line answer

**The working-count and shift-money-integrity release (`0035`) is live on Vercel + Neon + Vercel
Blob.** The three known cancelled shifts remain explicit historical exceptions; they were neither
rewritten nor hidden.

## Live URLs (team `hadis-projects-3c86ccdb`, all public)

| Surface | URL | Live deployment |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | `dpl_9d5Zp8QHMwuKiUB5SxJXgR5xWvpw` |
| Driver PWA | https://ash-driver.vercel.app | `dpl_GzB3CyzkjEFBeYyP1WaHQwZYHccw` |
| API | https://ash-api-xi.vercel.app | `dpl_9DnbaiswA4bPP1bCEJ8H2eLi4Fub` |

Neon (PostgreSQL **18.4**, eu-central-1) has the **35-migration live baseline** and is bootstrapped
with the §3 permission matrix, the Damascus branch, the historical tier table, and two admins
(`admin`/system_admin, `gm`/general_manager)
— **no demo data in the live ledger.** Full deploy detail and redeploy steps:
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

The `0035` rollout backups are
`Desktop\ash-backups\2026-08-23-pre-0035\2026-08-23T05-42-10-547Z` (58 tables / 3,852 rows / 34
migrations) and `Desktop\ash-backups\2026-08-23-post-0035\2026-08-23T05-44-48-740Z` (58 / 3,853 /
35). Both were fully validated before promotion.

---

## Current production-release verification

| Layer | State |
| --- | --- |
| **Domain** (money, BR1, settlement, ledger, shifts, RBAC, dates, FX, week, fleet, TOTP) | ✅ 425 tests, property-based |
| **Contracts** | ✅ 12 tests |
| **Shared client** (API client, i18n ar/en, order-entry model) | ✅ 256 tests |
| **Driver PWA** | ✅ 256 tests + production build |
| **Admin console** | ✅ 93 tests + production build + focused responsive browser acceptance |
| **Adapters** | ✅ 119 tests, including atomic OCR and idempotency races |
| **API** — A, B, C, E, F, G plus fixed settlement and evidence flows | ✅ 647 tests over real HTTP |
| **Database** | ✅ 108/108 on real PostgreSQL 17, zero skips; guards and migrations through `0035` |

### By SRS section — all in scope for Bundle 1a, all done

- **A** auth (incl. **2FA/TOTP**), RBAC-as-data, audit, settings, branches, **notification bell**
- **B** drivers, vehicles, documents + expiry, assignment
- **C** shift lifecycle, canonical operation window, cash deductions, both gates, end-odo OCR,
  three-pass printed-time consensus, unknown-operation exclusion, evidence provenance, BR1 + ranked
  causes, and the **C-7 review UI with thumbnails and same-image manager reread**
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
| First real `0035` close audit | — | Two ordinary shifts were open when deployment completed. Audit their working-count reversal and first completed settlement without fabricating production data. |
| Audit Muhammad/Thaer after `0034` | — | Pending and deliberately separate from deployment; use only audited API workflows, never direct SQL or automatic approval. |
| Broader physical-device QA | — | The focused 390/768/1280 px Arabic/English release flow passed; physical camera, offline, install, and long-session testing remain broader follow-up work. |
| Historical tier admin | retired | Tier tables remain readable for approved history; editing and publication are intentionally disabled by the fixed 40% policy. |
| QR code on 2FA enrolment | ~1 h | The secret is shown for manual entry; a QR renderer is a nicety. |
| Attendance (B-4) | ~0.5 day | Table only. |

Evidence thumbnails and same-image manager rereads are implemented. Unknown-time rows being excluded
until an audited manager decision is a deliberate accounting guard, not an unfinished fallback.

---

## Outstanding operational checklist

1. **Send `docs/client-request-samples.md`.** Still the highest-value hour. The signed wallet/cash
   settlement is measured against a wallet number Yallago produces; compare one complete real shift
   before treating the variance explanation as calibrated. Variance no longer blocks submission.
2. ~~**Prove the database release and restore path.**~~ **Done** on PostgreSQL 17 and isolated Neon.
   The `0035` release validated production backups before migration (`58` tables / `3,852` rows /
   `34` migrations) and after it (`58` / `3,853` / `35`), then reproduced every table fingerprint
   in an explicitly named disposable restore database. Destructive suites stay off production.
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
8. **Rotate the deployment token shared during the `0035` rollout.** The release succeeded, but a
   credential placed in chat must be replaced and the successor verified before revocation.

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
