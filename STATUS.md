# STATUS — where ASH Delivery stands

Written for you coming back to this cold. **471 tests + 6 CI guards green, both front-ends build.**
Run `pnpm check` to confirm, `pnpm build:apps` to build the UIs.

---

## The one-line answer

**Bundle 1a is feature-complete end to end** — backend *and* both front-ends. What remains before
a real go-live is operational, not code: send the client samples, prove the DB guards on Neon,
pick object storage, and have someone fluent review the Arabic.

---

## What exists

| Layer | State |
| --- | --- |
| **Domain** (money, BR1, tiers, ledger, shifts, RBAC, dates, FX, week, fleet, TOTP) | ✅ 290 tests, property-based |
| **API** — 46 endpoints across A, B, C, E, F, G | ✅ 149 tests over real HTTP |
| **PostgreSQL adapters** (all 14 ports) | ✅ shared conformance suite, runs in CI |
| **Shared client** (API client, i18n ar/en, order-entry model) | ✅ 15 tests |
| **Driver PWA** | ✅ builds, 70 KB gzip, service worker |
| **Admin console** | ✅ builds, 70 KB gzip |

### By SRS section — all in scope for Bundle 1a, all done

- **A** auth (incl. **2FA/TOTP**), RBAC-as-data, audit, settings, branches, **notification bell**
- **B** drivers, vehicles, documents + expiry, assignment
- **C** shift lifecycle, both gates, **real photo evidence**, BR1 + ranked causes, **C-7 review UI**
- **E** funds tree, double-entry, FX, **cash count**, **manual entries + corrections**, Sunday close
- **F** tier engine, whole + marginal, day true-up, **effective-dated admin + what-if simulation**
- **G** expenses, cost centres, receipt ceiling
- **I-1** the minimal ops dashboard (in scope per the brief)

### Six CI guards, every one negative-tested

domain-purity · SQL-correctness · wire-money · TypeScript-strippability · **physical-CSS (RTL)** ·
**i18n-parity**. Each is verified to *fail* on an injected violation — a guard nobody has watched
fail is decoration.

---

## What is NOT done

| Item | Effort | Note |
| --- | --- | --- |
| Visual QA of the UIs | — | The apps typecheck and build but have **not been run in a browser** here (needs the API + a browser). |
| Tier-admin & audit-viewer **screens** | ~1 day | The APIs exist and are tested; the admin console does not yet surface them. |
| QR code on 2FA enrolment | ~1 h | The secret is shown for manual entry; a QR renderer is a nicety. |
| Attendance (B-4) | ~0.5 day | Table only. |
| Evidence thumbnails in C-7 | ~0.5 day | The review lists which slots are present; the id-addressed image endpoint exists, the `<img>` wiring does not. |

---

## Before go-live — the operational checklist

1. **Send `docs/client-request-samples.md`.** Still the highest-value hour. BR1's zero tolerance
   is measured against a wallet number Yallago produces; keep `BR1_SPLIT_GATE=advisory` until it
   is calibrated against one real shift.
2. **Run `verify-guards.sql` against Neon.** Proven on stock Postgres 17, not Neon. Expected to
   pass; expected is not evidence.
3. ~~**Pick object storage**~~ **Done — Vercel Blob (private).** `BLOB_DRIVER=vercel`, a
   `VercelBlobStore` adapter behind the `BlobStore` port, store linked to the `ash-api` project so
   `BLOB_READ_WRITE_TOKEN` is injected. The durable-storage boot guard accepts it; evidence photos
   cannot silently vanish. (`s3` remains available for a VPS deploy.)
4. **Have a fluent speaker review the Arabic** — ~150 keys, including the BR1 cause explanations a
   manager reads under time pressure. CI checks key parity, not that the financial Arabic is right.
5. **Create the first admin by hand** — the seed refuses to run against production.

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
pnpm check          # typecheck + 6 guards + 471 tests (~40 s, no Docker)
pnpm build:apps     # build the driver PWA and admin console
pnpm start          # API on :3000 (in-memory store)
./scripts/db-verify.sh   # prove the DB guards (needs Docker)
```

Key docs: [CLAUDE.md](CLAUDE.md) · [ASSUMPTIONS.md](ASSUMPTIONS.md) · [TESTS.md](TESTS.md) ·
[RUNBOOK.md](RUNBOOK.md) · [docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md)
