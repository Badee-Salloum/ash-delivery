# ASH Delivery — project context for every session

Operational-financial platform for a Damascus fleet-delivery business partnered with Yallago.
10 electric motorbikes today → 100 within a year. **This system moves real cash daily.
Production correctness beats speed.**

**Authority order:** [SRSv1.0.md](SRSv1.0.md) (authoritative, Arabic) → [CLAUDECODEKICKOFF.md](CLAUDECODEKICKOFF.md)
(delivery contract) → this file. If the SRS and the brief conflict, **stop and ask the product
owner** — do not pick one silently.

**Scope now — Bundle 1:** SRS sections A, B, C, E, F, G.
**Deferred — build clean seams, not features:** D OCR (drivers type numbers manually; photos are
evidence), H Yallago PDF reconciliation, I report builder (a *minimal ops dashboard* IS in scope),
J maps, K GPS, L battery, M push/anomaly, N accounting bridge.

---

## The eight business rules

**BR1 — the zero-shift equation. The core invariant.** At shift close:

```
driver_cash_on_hand + driver_app_wallet_balance
  == cash_float_given + wallet_topup_given + 0.80 × Σ(delivery fees of the shift's orders)
```

Tolerance is **zero**. A non-zero difference blocks approval and must display a breakdown of
likely causes (missing order, wrong payment mode, odometer/cash mismatch).

Canonical worked example, encoded verbatim in `packages/domain/test/br1/canonical.test.ts`:
float 100,000 + topup 50,000 (new SYP); 20 orders × 5,000 fee (12 cash, 6 electronic, 2 free)
→ end cash 160,000, end wallet 70,000; check: 230,000 == 150,000 + 0.80×100,000. ✔

**BR2 — no weekly settlement.** Yallago's 20% is deducted **instantly** from the driver's in-app
wallet (which the company tops up). The weekly Yallago PDF is a Bundle-2 audit artifact, never a
settlement mechanism.

**BR3 — three payment modes per order**, captured per order:
- `cash`: driver collects goods value + fee in cash; wallet −20% of fee (instant Yallago cut)
- `electronic`: nothing collected in cash; order counterpart lands in wallet (net +80% of fee)
- `free` (Yallago promo): wallet +80% of fee, funded by Yallago

**BR4 — the 80% block.** In the field, driver + company share (80% of fees) stays merged in the
driver's hands/wallet. The ledger splits driver-vs-company **at approval time** using the daily
tier. Yallago's 20% is always fixed; tier changes come only out of the company's side.

**BR5 — shift gates, both ends.** Open requires: start package (odometer photo, battery %, float
amount, topup amount) + driver confirmation + branch-manager approval. Close requires: end package
(dashboard screenshot, wallet photo, odometer photo, cash handed over) + BR1 == 0 + branch-manager
approval after matching ground numbers to system numbers. A `suspended` state exists for mid-shift
incidents; data is completed later and the same equation applies.

**BR6 — currency.** Base = **new Syrian Lira** (1 new = 100 old — factor configurable). Reports
show SYP + USD equivalent using **one daily rate** entered each morning by the system admin and
applied to that entire day's transactions. Seed ≈ 130 new SYP/USD — seed only, never hardcoded logic.

**BR7 — financial week.** Closes every **Sunday** by explicit system-admin action. Locked entries
are immutable; corrections happen only via visible, dated correction entries.

**BR8 — visibility.** Total profits/shares: General Manager **only**. Branch manager: everything in
his branch. Driver: his own shifts and earnings only. Tier/rule editing: **system admin only**
(not even the GM — client's explicit answer; keep it configurable).

**Default tier table** (system-admin editable, effective-dated, whole-amount mode, basis = approved
orders per day): 0–14 → driver 35% · 15–24 → 40% · 25–34 → 43% · 35+ → 46%. Marginal mode must
exist as a config switch.

---

## Decisions already taken (do not re-litigate)

| # | Decision |
| --- | --- |
| 1 | **Financial week = Sunday 00:00 → Saturday 23:59** Asia/Damascus, closed the *following* Sunday. A shift worked on the closing Sunday belongs to the **new** week. |
| 2 | Infrastructure exists (GitHub, VPS, domain). **Staging goes live in M0**, not M6. |
| 3 | Old lira is **schema-ready only**: `settings.old_lira_factor = 100`, currency tag on every row, but all Bundle-1 UI is new SYP + USD. |
| 4 | **The wallet is zeroed each day**, like the float. `wallet_return` recipe + a zeroed-wallet photo at close. BR1 therefore stays in **absolute** form — no ledger-derived opening balance. |
| 5 | Manual entries & expenses: **branch manager ✓ + general manager ✓, sysadmin ✗** (SRS §3 matrix wins over the narrower E-3 prose). Stored as data. |
| 6 | Tier band is computed over the **whole day**, with a visible «تسوية شريحة اليوم» true-up restating earlier shifts when a later one crosses a band. |
| 7 | Commercial scope re-cut: **Bundle 1a** = SRS A–G as priced; **Bundle 1b** = production readiness, separately priced. |

---

## Money rules — non-negotiable

1. **Money is `bigint` minor units. Never a float, never a `number`.**
   1 minor unit = 1/100 new SYP = exactly 1 old lira.
2. **The 80% block is a RESIDUAL**: `Σfees − Σ(per-order 20% cuts)`. **Never** `0.80 × Σfees`.
   Multiply-and-round makes a zero-tolerance BR1 unsatisfiable as soon as a fee is not divisible
   by 5. The SRS example (all fees 5,000) hides this — the property tests deliberately do not.
3. **The company absorbs every rounding remainder**, never the driver and never Yallago. That is
   BR4's rule expressed as arithmetic: `companyShare = blockTotal − driverShare`.
4. **BR1 returns three differences, not one.** The scalar equation is blind to a pay-mode error:
   flip one order cash↔electronic and `scalarDiff` stays exactly 0 while cash is off by −fee and
   wallet by +fee. Always evaluate `cashDiff` and `walletDiff` too. The `br1_split_gate` setting
   (`advisory` → `strict`) decides whether a split failure blocks approval.
5. **`allocate()` refuses negative totals.** Signed deltas are always produced by *subtracting two
   allocations*, never by allocating a negative — that keeps the rounding direction unambiguous.

## Time rules

- **`business_date` is a WRITTEN column**, fed by `businessDateFor()`. It is deliberately not a
  Postgres generated column: `(occurred_at AT TIME ZONE 'Asia/Damascus')::date` is `STABLE`, not
  `IMMUTABLE`, and Postgres refuses it there.
- **`week_start_date` is stored explicitly.** Never `date_trunc('week', …)` — that is ISO,
  i.e. **Monday**-based, and BR7 closes on **Sunday**. An off-by-one-day in exactly the place
  entries become immutable is the worst available failure.
- Asia/Damascus is UTC+3 year-round since Syria abolished DST in October 2022. The offset is
  **injected as a value** so the domain stays deterministic and backfilled pre-2022 data stays right.

## Database rules

- **Idempotency key is `(shift_id, event_type, occurrence_key)`** — *not* `(shift_id, event_type)`.
  SRS C-5 allows multiple float/top-up tranches per day; without `occurrence_key` the second
  tranche cannot post and an "idempotent replay" silently swallows it, so cash leaves the office
  with no ledger record.
- Double-entry balance is enforced by a **deferred** constraint trigger at COMMIT.
- Week-lock immutability is enforced **twice**: `REVOKE UPDATE, DELETE` from `app_user` *and* a
  trigger — on **both** `journal_entries` and `journal_lines` (a guard on entries alone leaves the
  amounts mutable).
- Tier resolution filters `status IN ('active','superseded')`, never `'active'` alone — otherwise
  publishing a successor silently restates every historical day.

---

## Architecture

```
packages/domain     ★ PURE. No dependencies, no I/O, no clock, no Intl, no framework.
                      All money math lives here and nowhere else.
packages/contracts    Zod schemas + ports (DashboardSource, BlobStore, Clock, …)
packages/adapters     fake/ (fixtures) + real/. OCR & PDF land here in Bundle 2.
packages/db           Drizzle schema, hand-written SQL migrations, repos, seed
packages/testkit      DB harnesses, fast-check arbitraries, builders
apps/api              Fastify 5
apps/admin            React 19 SPA, RTL-first
apps/driver           PWA, separate bundle, tight size budget
```

**Domain purity is enforced four ways**, not by convention: `"dependencies": {}` (asserted by
`scripts/check-domain-pure.mjs`), `"types": []`, TypeScript project references, and ESLint
`no-restricted-imports`/`no-restricted-globals`. The purity script is negative-tested — it
genuinely fails on a violation.

**Stack:** TypeScript 5.9 on Node 24 LTS · Fastify 5 · Zod 4 · PostgreSQL 17 · Drizzle · React 19 +
Vite · Tailwind 4 (logical properties only) · i18next (`ar` default) · Vitest + fast-check +
Testcontainers + Playwright · Caddy 2 · Docker Compose · GitHub Actions → GHCR.

## Conventions

- **Conventional commits**, small and focused. Code, identifiers, commit messages and engineering
  docs are **English**; the UI is Arabic-first.
- UI is **bilingual ar/en, RTL-first**. CSS uses **logical properties only** — CI fails the build
  on any `ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`.
- No human-facing strings in `packages/domain`. It emits cause **codes**; the UI resolves
  `br1.cause.<code>`.
- RBAC is **server-side**, per the SRS §3 matrix. UI hiding is not security.
- Audit log on every mutation (who, when, before/after).
- Config via `.env`; secrets never committed.
- **Never mark work done with failing tests. Never fabricate test output.**
- Every milestone ends with `PROGRESS.md` updated (done / next / risks) and a "see it in 2 minutes"
  demo note.

## Repo documents

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | this file — business rules + conventions, loaded every session |
| `ASSUMPTIONS.md` | every default taken instead of blocking on a question |
| `PROGRESS.md` | done / next / risks, updated at every milestone |
| `TESTS.md` | acceptance criteria #1–7, 9, 12 → named automated tests |
| `RUNBOOK.md` | deploy, rollback, restore, daily FX rate, Sunday close, onboarding |

## Commands

```bash
pnpm install
pnpm -r test                      # unit + property. No Docker required — the domain is pure.
pnpm typecheck
node scripts/check-domain-pure.mjs
```
