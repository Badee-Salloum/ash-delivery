# STATUS — where ASH Delivery stands

**Production is live on migration `0039` as of 2026-08-23.** The cumulative release from frozen
application commit `1407676b9802382b926b9b4f07f59636cb0ea0ee` includes the live working-driver and
working-vehicle dashboard counts, resilient battery close flow, zero opening cash/wallet, strict
tranche idempotency, range-safe settlement math, receivables, expenses, restoration, and editable
office-capital targets.

There are now two explicit receivable kinds. An ordinary cash/wallet receivable remains assigned to
its driver until collection. A shift-funding cash/wallet receivable is automatically carried into
that driver's next approved shift. Managers can create either kind directly without an existing
shift. Restoration reads the receivable-aware ledger and publishes cash/wallet targets atomically;
the current effective targets are **SYP 50,000 cash** and **SYP 10,000 wallet**.

A driver can submit the end package even when money differs or end-battery evidence is incomplete.
Submission removes an `open` shift from the live counts before manager approval. Missing readings
become explicit manager obligations; a nonzero variance receives a deterministic system audit
reason when the user leaves the reason blank. This does not bypass settlement, immutable journals,
manager evidence completion, or final approval. The stalled battery reader also has a bounded
timeout and an immediate manual escape while preserving accepted photos and the close draft.

The frozen Node `24.19.0` release gate passed `pnpm check` with **1,998 tests**, plus a fresh real
PostgreSQL run of **141/141 tests across 27 files with zero skips**. Both frontend builds, the API
bundle, and all Vercel production builds passed. The post-release restore-runner improvement adds
five focused tests; the current HEAD full gate passes **2,003 tests** with 11 expected PostgreSQL
skips in the default non-database run.

The coordinated rollout paused and drained API writes, applied `0036` through `0039` in order, and
promoted API → driver → admin before resuming writes. Final production postflight is clean:
`schema 39 / head 0039`, working counts `0/0`, no active shift rows, trial balance `0`, and zero
violations across all 17 shift-money integrity checks. Historical rows were not rewritten or
automatically repaired.

Validated backups are retained outside the repository:

- pre-release: 58 tables / 3,994 rows / 35 migrations, aggregate SHA-256
  `dd0e904a228d1022df80e1d5f75b01bec79c829a884154042f6b41ca2a3f7103`;
- post-release: 59 tables / 4,002 rows / 39 migrations, aggregate SHA-256
  `be8dc82f07b645edcc0463adc43a3ae2588791848dd9da52bde36786ad732a20`.

The post-release backup was restored end to end into isolated Neon database
`ash_restore_0039_20260823_1337`: 59/59 table fingerprints and 4,002/4,002 rows matched, all 27
serial/identity sequences were safe, all user triggers were enabled, the trial balance was zero,
and all 17 integrity checks returned zero violations. After its provider-side idle sessions reached
zero, the exact scratch database was dropped and confirmed absent; production was unaffected.

---

## The one-line answer

**The complete receivables/restoration release (`0039`) is live on Vercel + Neon + Vercel Blob.**
Production postflight is clean; the next ordinary real-staff shift is the remaining live acceptance
case and no fabricated production transaction will be used in its place.

## Live URLs (team `hadis-projects-3c86ccdb`, all public)

| Surface | URL | Live deployment |
| --- | --- | --- |
| Admin console | https://ash-admin-eta.vercel.app | `dpl_6y6NJLBuRy2x73hZ4kqfTykNv1sZ` |
| Driver PWA | https://ash-driver.vercel.app | `dpl_4YKqcBfCKkHXLr6oggduwx9P5VDE` |
| API | https://ash-api-xi.vercel.app | `dpl_826jbAVvqCetjgVtGihgCX4Kp16b` |

Neon (PostgreSQL **18.4**, eu-central-1) has the **39-migration live baseline** and is bootstrapped
with the §3 permission matrix, the Damascus branch, the historical tier table, and two admins
(`admin`/system_admin, `gm`/general_manager)
— **no demo data in the live ledger.** Full deploy detail and redeploy steps:
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

The `0039` rollout backups are
`Desktop\ash-backups\2026-08-23-pre-0036-0039\2026-08-23T10-15-59-439Z` (58 tables / 3,994 rows /
35 migrations) and `Desktop\ash-backups\2026-08-23-post-0039\2026-08-23T10-20-21-800Z` (59 /
4,002 / 39). Every gzip member, row count, and aggregate checksum was validated.

---

## Current production-release verification

| Layer | State |
| --- | --- |
| **Domain** (money, BR1, settlement, ledger, shifts, RBAC, dates, FX, week, fleet, TOTP) | ✅ 429 tests, property-based |
| **Contracts** | ✅ 19 tests |
| **Shared client** (API client, i18n ar/en, order-entry model) | ✅ 263 tests |
| **Driver PWA** | ✅ 263 tests + production build |
| **Admin console** | ✅ 136 tests + production build + responsive browser smoke |
| **Adapters** | ✅ 130 tests, including OCR abort/deadline and financial UoW regressions |
| **API** — A, B, C, E, F, G, settlement, receivables, restoration | ✅ 675 tests over real HTTP |
| **Database** | ✅ 141/141 on a positively identified disposable PostgreSQL database, 27/27 files, zero skips; current default run 88 pass / 11 expected skips |

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
| First real `0039` shift audit | — | Baseline `0/0` is recorded. During the next ordinary staff shift, verify `+1/+1` within 8 seconds, reversal on end submission, fixed 40% settlement, one decision/settlement, matching hashes, balanced journals, and zero residual shift balances. |
| Historical Muhammad/Thaer follow-up | — | Historical records were not rewritten. Any follow-up must use audited API workflows, never direct SQL repair or automatic approval. |
| Broader physical-device QA | — | The focused 390/768/1280 px Arabic/English release flow passed; physical camera, offline, install, and long-session testing remain broader follow-up work. |
| Portable localhost restore mode | small | The checked-in Neon-HTTP restore path is now fully rehearsed and sequence-safe. A separate localhost `pg` transport remains a portability improvement, not a release blocker. |
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
2. ~~**Prove the database release and restore path.**~~ **Done** on PostgreSQL and isolated Neon.
   The `0039` release validated production backups before migration (`58` tables / `3,994` rows /
   `35` migrations) and after it (`59` / `4,002` / `39`), then reproduced all 59 fingerprints and
   positioned all 27 sequences safely in a named scratch database. Destructive suites stayed off
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
8. **Rotate the deployment token shared during this rollout.** The release succeeded, but a
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
