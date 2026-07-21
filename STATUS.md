# STATUS — where ASH Delivery actually stands

Written for you coming back to this cold. **415 tests green, no Docker required.**
Run `pnpm check` to confirm.

---

## The one-line answer

The **backend is complete for Bundle 1a** — every SRS section A, B, C, E, F, G has working,
tested HTTP endpoints. **There is still no user interface**, so nothing can be *used* yet, only
called.

---

## What is DONE and verified

| SRS | Area | State |
| --- | --- | --- |
| **A-1** | Auth: bcrypt, 5-attempt lockout, 30-min idle sessions | ✅ |
| **A-2** | Four roles + §3 matrix as editable data, server-side `can()` | ✅ |
| **A-3** | Branches, multi-branch-ready scoping | ✅ |
| **A-4** | Settings + approval ceilings (wired into expenses and manual entries) | ✅ |
| **A-5** | Audit log with before/after + a read endpoint | ✅ |
| **B-1** | Drivers, documents, expiry status and board | ✅ |
| **B-2** | Vehicles + state machine | ✅ |
| **B-3** | Mandatory driver↔vehicle↔shift binding | ✅ |
| **C-1** | Shift state machine incl. `suspended` | ✅ |
| **C-2/3** | Both BR5 gates | ✅ |
| **C-4** | BR1 + ranked cause breakdown | ✅ |
| **C-5** | Multi-tranche float | ✅ |
| **C-6** | **Photo evidence: real upload, dedupe, RBAC-checked serving** | ✅ |
| **C-7** | Approval screen data contract (`GET /shifts/:id/review`) | ✅ |
| **E-1** | Funds tree | ✅ |
| **E-2** | Automatic postings from shift events | ✅ |
| **E-3** | Manual entries + visible dated corrections | ✅ |
| **E-4** | Daily FX + USD equivalence | ✅ |
| **E-5** | Daily cash count, frozen + sealed | ✅ |
| **E-6** | Sunday close + full pre-flight | ✅ |
| **F-1/2** | Tier table, whole + marginal, day true-up | ✅ |
| **G** | Expenses, cost centres, receipt ceiling | ✅ |

**34 HTTP endpoints.** All twelve ports have both an in-memory and a PostgreSQL implementation,
proven by one shared conformance suite.

---

## What is NOT done

| Item | Effort | Notes |
| --- | --- | --- |
| **Admin console UI** | ~4 days | Nothing exists. This is the biggest remaining piece. |
| **Driver PWA** | ~3 days | The order-entry screen alone is ~2 of those — with OCR deferred, a driver types 20 rows twice a day. |
| **i18n / RTL** | included above | No Arabic UI strings yet; the API returns machine codes for the UI to resolve. |
| **Tier admin (F-3…F-6)** | ~1 day | Engine works; effective-dated publishing, simulation and override have no routes. |
| **Ops dashboard (M5)** | ~1 day | |
| **2FA / TOTP (A-1)** | ~0.5 day | Password auth is complete; TOTP is not built. |
| **Notifications (A-6)** | ~0.5 day | Table only. |
| **Attendance (B-4)** | ~0.5 day | Table only. |

---

## Three things to do BEFORE going live

### 1. Send the client samples request — still the highest-value hour

`docs/client-request-samples.md`, bilingual, ready to send. One real shift's dashboard
screenshot + wallet screenshot + the manager's counted figures.

**Why it matters:** BR1's zero tolerance is measured against a wallet number **Yallago**
produces. If theirs carries tips, promo credits, cancellation reversals or a different rounding
direction, *every shift is unclosable on day one*. Keep `BR1_SPLIT_GATE=advisory` until this is
calibrated.

### 2. Prove the database guards on Neon

They have been run against stock PostgreSQL 17 in CI, **not against Neon**.

```bash
psql "$DIRECT_NEON_URL" -v ON_ERROR_STOP=1 -f packages/db/verify-guards.sql
```

Expected to pass. Expected is not evidence.

### 3. Choose object storage

`BLOB_DRIVER=s3` is mandatory on Vercel — the filesystem is ephemeral, so `disk` loses every
evidence photo on redeploy while the ledger still says the shift was documented. The app refuses
to boot production on a non-durable store, so this cannot happen silently, but it does mean you
must pick a bucket (R2, B2, Hetzner) before go-live. Full checklist:
`docs/DEPLOY-VERCEL-NEON.md`.

---

## Bugs found by tests during this build

Worth knowing, because each was invisible to reading:

1. **`0.80 × Σfees` makes BR1 unsatisfiable** as soon as a fee is not divisible by 5. The block
   is a residual. The SRS's own example (all fees 5,000) hides this perfectly.
2. **A driver's wallet can go negative** — 20 cash orders on a small top-up — and **BR1 still
   reads exactly zero** while it happens. Found by a property test; needs a separate check.
3. **A manual entry naming `office_cash` moved nothing.** Every fund code was being wrapped as a
   cost centre, so the entry balanced, returned 201, and the real fund never changed.
4. **The evidence gates were checking a client claim**, not a photo. The driver's app sent a list
   of slot names and the gate believed it.
5. **Nobody could create a driver.** Fleet writes were guarded by a permission held only by
   branchless org-wide roles.
6. **The API could not start.** TypeScript parameter properties are not strippable by Node, so
   the container would have crash-looped on deploy while all tests passed.

Each now has a named regression test, and four CI guards exist to stop the classes recurring:
domain purity, SQL correctness, wire-money, and TypeScript strippability. **All four are
negative-tested** — verified to fail on an injected violation.

---

## Commands

```bash
pnpm install
pnpm check          # typecheck + 4 guards + 415 tests (~30 s, no Docker)
pnpm start          # boots on :3000 against the in-memory store
./scripts/db-verify.sh   # proves the DB guards (needs Docker)
```

Key documents: [CLAUDE.md](CLAUDE.md) (rules) · [ASSUMPTIONS.md](ASSUMPTIONS.md) (29 logged, each
with a reversal cost) · [TESTS.md](TESTS.md) · [RUNBOOK.md](RUNBOOK.md) ·
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md)
