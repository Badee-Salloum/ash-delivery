# STATUS — where ASH Delivery stands

Written for you coming back to this cold. **Last validated production baseline (commit `d7b6643`,
migration `0033`, 2026-08-15, Node 24):** the clarified branch treasury, fixed settlement, resilient
cloud OCR, three-pass printed-time consensus, evidence thumbnails, and manager same-image rereads
are live. The complete repository check and all **70** real PostgreSQL 17 DB tests passed before the
latest code-only release. Production Neon PostgreSQL 18.4 remains on `0033` with checksum
`687e773f`; the stable API and admin smokes passed after promotion, and the unchanged driver stayed
on its prior validated deployment.

**Unpublished source head:** the staged release candidate contains migration `0034`; production
still contains exactly 33 migrations and has not been promoted. `0034` adds the durable
server-side `closeDraft`, attachment-token-linked OCR/read retries and restoration, atomic final
materialisation, and the old-reader safety response `428 driver_update_required`. It does not
change BR1 or settlement arithmetic.

The candidate's final disposable gate ran on Node `24.19.0` and PostgreSQL `17.11`: fresh
`0001`–`0034` applied `34/34`, the checksum rerun applied `0` and found all `34`, every database
guard passed, and `@ash/db` passed **76/76** tests in 15 files. The disposable migration ledger
recorded `0034` checksum `5bc30a31`; the file SHA-256 was
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`. Real-PostgreSQL API
reproductions also proved that normal submit and manager force-prepare materialise a pre-draft
manager order without changing its `created_by` owner.

This is readiness evidence, not deployment evidence. The required production order is
`0034` migration → API → driver/admin inside one paused-write maintenance window. No production
migration, alias promotion, Muhammad correction, or Thaer attachment recovery has been performed.

---

## The one-line answer

**Bundle 1a, fixed settlement, verified AI order reading, and the clarified branch treasury are live
on Vercel + Neon + Vercel Blob.** The treasury separates physical-count variance from capital
variance, requires an audited reason for every non-zero count line, and displays both restoration
legs with explicit directions. The live API and database remain on migration `0033`. Order
screenshots use a compact financial pass plus three independent time reads; only literal printed
AM/PM evidence participates in the time consensus. A disagreement remains `unknown` and is excluded
until an audited manager decision.

## Live URLs (team `hadis-projects-3c86ccdb`, all public)

| Surface | URL | Live deployment |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | `dpl_8n3sLrMGjF7FQj7EVAhqbbhCM86W` |
| Driver PWA | https://ash-driver.vercel.app | `dpl_6JVSMPr1ofVwnYhvYJYncygAFpia` |
| API | https://ash-api-xi.vercel.app | `dpl_3QkzHvaJ1ijymQWE2oZU8PQzqQXE` |

Neon (PostgreSQL **18.4**, eu-central-1) has the **33-migration live baseline** and is bootstrapped
with the §3 permission matrix, the Damascus branch, the historical tier table, and two admins
(`admin`/system_admin, `gm`/general_manager)
— **no demo data in the live ledger.** Full deploy detail and redeploy steps:
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

The validated production backup moved from `53` tables / `2,993` rows / `32` migrations before
`0033` to `53` / `2,994` / `33` after it. All stable-alias smoke checks passed on the deployment IDs
above.

---

## What exists in the last validated live baseline

| Layer | State |
| --- | --- |
| **Domain** (money, BR1, settlement, ledger, shifts, RBAC, dates, FX, week, fleet, TOTP) | ✅ 424 tests, property-based |
| **Contracts** | ✅ 10 tests |
| **Shared client** (API client, i18n ar/en, order-entry model) | ✅ 248 tests |
| **Driver PWA** | ✅ 241 tests, build, service worker, live smoke passed |
| **Admin console** | ✅ 53 tests, build, live smoke passed |
| **Adapters** | ✅ 98 tests, including atomic OCR attempt/cap races |
| **API** — A, B, C, E, F, G plus fixed settlement and evidence flows | ✅ 566 tests over real HTTP |
| **Database** | ✅ static run: 31 passed + 5 environment-gated skipped; real PostgreSQL 17: 70 passed |

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
| Deploy staged source head `0034` | — | Production remains on `0033`; take the backups and use the coordinated migration → API → driver/admin sequence in the RUNBOOK. |
| Audit Muhammad/Thaer after `0034` | — | Pending and deliberately separate from deployment; use only audited API workflows, never direct SQL or automatic approval. |
| Full visual/device QA of the UIs | — | Public route and API smoke tests pass; exhaustive browser, camera, offline, and install testing is still owed. |
| First real fixed-settlement approval audit | — | The release is live, but there was no `pending_review` shift during rollout. Verify the first real immutable receipt and zeroed driver funds as described in the RUNBOOK. |
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
   The current release additionally validated production backups before `0033` (`53` tables /
   `2,993` rows / `32` migrations) and after it (`53` / `2,994` / `33`). Destructive suites stay off
   production.
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
