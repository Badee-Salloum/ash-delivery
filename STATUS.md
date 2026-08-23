# STATUS — where ASH Delivery stands

Written for you coming back to this cold. **Production is on migration `0034` (deployed
2026-08-17); the `0035` release candidate is not live.** The candidate adds live working-driver and
working-vehicle dashboard counts, closes the zero-opening-funds and tranche-retry defects, adds
money-range and settlement database guards, corrects dashboard profit semantics, and installs a
permanent read-only shift-money integrity checker. A driver may now hand an end package to manager
review even when its money differs or end-battery evidence is incomplete. Incomplete packs become
explicit manager-reading obligations; this does not bypass manager approval or settlement.

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

The production checker was rerun read-only at 2026-08-23 08:07 Damascus. Thirteen checks were clean;
the same three cancelled 2026-08-11 shifts still report their known exact 100× tranche/journal
history. At 08:21 the owner explicitly accepted exactly those three cancelled shifts as grandfathered
historical exceptions and directed the `0035` deployment. They remain visible in every pre/postflight
report and receive no repair, deletion, or checker suppression. Promotion may proceed only while the
exception set is unchanged and every other integrity check remains clean. Vercel deployment access
was restored for this rollout; the real-staff shift audit remains a post-deployment requirement.

---

## The one-line answer

**Bundle 1a, fixed settlement, durable close drafts (`0034`), verified AI order reading, and the
clarified branch treasury are live on Vercel + Neon + Vercel Blob.** The working-count and
shift-money-integrity release (`0035`) is fully verified and authorized for coordinated production
rollout with the three known cancelled shifts retained as explicit historical exceptions.

## Live URLs (team `hadis-projects-3c86ccdb`, all public)

| Surface | URL | Live deployment |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | `dpl_8n3sLrMGjF7FQj7EVAhqbbhCM86W` |
| Driver PWA | https://ash-driver.vercel.app | `dpl_6JVSMPr1ofVwnYhvYJYncygAFpia` |
| API | https://ash-api-xi.vercel.app | `dpl_6Rknpd6` |

Neon (PostgreSQL **18.4**, eu-central-1) has the **34-migration live baseline** and is bootstrapped
with the §3 permission matrix, the Damascus branch, the historical tier table, and two admins
(`admin`/system_admin, `gm`/general_manager)
— **no demo data in the live ledger.** Full deploy detail and redeploy steps:
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

The earlier validated backup moved from `53` tables / `2,993` rows / `32` migrations before `0033`
to `53` / `2,994` / `33` after it. The 2026-08-23 preflight positively identified production at
`0034`; a new rollout backup was intentionally not started after the integrity gate blocked
promotion.

---

## Current release-candidate verification

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
| Resolve the production integrity blocker and deploy `0035` | — | Three cancelled shifts have exact 100× tranche/journal mismatches. No automatic ledger repair is allowed; obtain a supervised accounting decision, rerun preflight, then use the coordinated RUNBOOK. |
| Audit Muhammad/Thaer after `0034` | — | Pending and deliberately separate from deployment; use only audited API workflows, never direct SQL or automatic approval. |
| Broader physical-device QA | — | The focused 390/768/1280 px Arabic/English release flow passed; physical camera, offline, install, and long-session testing remain broader follow-up work. |
| First real `0035` shift-close audit | — | Candidate browser acceptance used isolated data only. After the blocker is resolved and deployment succeeds, audit the next ordinary Damascus staff shift exactly as described in the RUNBOOK. |
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
8. **Restore Vercel CLI authentication before rollout.** The local OIDC material is expired and is
   not a deploy token. Create/test a successor credential before revoking anything, then record the
   new deployment IDs during the coordinated promotion.

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
