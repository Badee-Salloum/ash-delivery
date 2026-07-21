# TESTS.md — acceptance-criteria traceability

Maps SRS §8 acceptance criteria to named automated tests. **#8, #10 and #11 belong to Bundles 2–3**
(Yallago PDF reconciliation, OCR, live GPS map) and are out of Bundle-1 scope.

A CI check fails the build when a test named here is renamed or deleted, so this table cannot rot.

**Legend:** ✅ implemented and green · ⚠ written but never executed · 🔜 planned, milestone named.

| # | Criterion (SRS §8) | Test | Status |
| --- | --- | --- | --- |
| **1** | A shift cannot open before the start package is complete, the driver confirms, and the branch manager approves | `shift/state.test.ts` › "the OPEN gate (BR5, AC #1)" (5 cases) | ✅ |
| | | `shift/gates.open.itest.ts` (through the API) | 🔜 M3 |
| **2** | A shift cannot close before the zero equation holds and the branch manager approves | `br1/canonical.test.ts` › "closes the zero equation exactly" · `br1/property.test.ts` › "closes at exactly zero for any mix" | ✅ |
| | | `shift/state.test.ts` › "the CLOSE gate (BR5, AC #2)" (7 cases) | ✅ |
| | | `shift/gates.close.itest.ts` (through the API) | 🔜 M3 |
| | | `shift/lifecycle.e2e.ts` — the §2.3 example through the real UI | 🔜 M3 |
| **3** | A cash order deducts 20% of its fee instantly from the driver's wallet to the Yallago fund | `br1/canonical.test.ts` › "reproduces the SRS table row for row" · "splits at approval" | ✅ |
| | | `ledger/recipes.test.ts` › "yalago_share accumulates the 20,000" | ✅ |
| **4** | An electronic or free order adds 80% of its fee to the driver's wallet | `br1/canonical.test.ts` › "reproduces the SRS table row for row" | ✅ |
| | | `ledger/recipes.test.ts` › "SRS §2.3 walked through the ledger" | ✅ |
| **5** | Σ debits == Σ credits across every entry of any day | `money/allocate.test.ts` › "driver + company + yalago === feeTotal, exactly" | ✅ |
| | | `ledger/recipes.test.ts` › "every posting balances under random event streams" (400 runs) | ✅ |
| | | `db/verify-guards.sql` › guard 1 — rejected at COMMIT by Postgres | ⚠ written, unrun |
| **6** | The day's rate applies to all that day's transactions **and the USD equivalent appears in reports** | `fx/rate-application.itest.ts` | 🔜 M2 |
| | | `fx/usd-display.itest.ts` — the *second half* of the criterion, easy to miss | 🔜 M5 |
| **7** | The daily band is computed automatically from the order count, changes only the company's share, and only the sysadmin may edit it | `tier/bands.test.ts` › "band boundaries — 14/15, 24/25, 34/35" (9 cases) | ✅ |
| | | `tier/bands.test.ts` › "the company absorbs the rounding remainder, never the driver and never Yallago" | ✅ |
| | | `rbac/matrix.test.ts` › "the General Manager may NOT edit tier rules" | ✅ |
| **9** | The Sunday close blocks any edit to that week's entries except via a visible correction entry | `shift/state.test.ts` › "immutability after the week lock" | ✅ |
| | | `db/verify-guards.sql` › guards 3, 5a, 5b, 5c — `REVOKE` *and* trigger, entries **and** lines | ⚠ written, unrun |
| | | `ledger/recipes.test.ts` › "corrections (BR7)" | ✅ |
| **12** | Total profits are visible to the General Manager only; a branch manager sees only his branch | `rbac/matrix.test.ts` — every role × every permission, 93 generated cases | ✅ |
| | | `shift/state.test.ts` › "RBAC on transitions" | ✅ |
| | | `rbac/visibility.e2e.ts` | 🔜 M5 |

---

## Business rules → tests

Acceptance criteria do not cover every rule. BR2 in particular is encoded *by absence* — nothing
accrues weekly — which is exactly the kind of thing that silently regresses.

| Rule | Test | Status |
| --- | --- | --- |
| BR1 zero equation | `br1/canonical.test.ts`, `br1/property.test.ts` | ✅ |
| BR1 pay-mode blind spot | `br1/canonical.test.ts` › "the pay-mode blind spot" · `br1/property.test.ts` › "flipping any order cash↔electronic" | ✅ |
| BR1 cause breakdown | `br1/canonical.test.ts` › "difference breakdown — the arithmetic signatures are distinguishable" | ✅ |
| BR2 no weekly settlement | `ledger/br2.no-settlement.itest.ts` — asserts the cut posts per order at approval and no weekly accrual recipe exists | 🔜 M2 |
| BR3 three payment modes | `br1/property.test.ts` (all three generated) | ✅ |
| BR4 80% block + company absorbs remainder | `money/allocate.test.ts` › "the company absorbs the rounding remainder" | ✅ |
| BR5 both gates | `shift/state.test.ts` (30 cases) | ✅ |
| BR6 daily FX, one rate per day | `fx/*.itest.ts` | 🔜 M2 |
| BR7 Sunday week, Sunday→Saturday | `time/civil.test.ts` › "financial week — Sunday → Saturday" (7 cases) | ✅ |
| BR7 non-Sunday week start refused by the DB | `db/verify-guards.sql` › guard 4 | ⚠ written, unrun |
| BR8 visibility limits | `rbac/matrix.test.ts` (93 cases) | ✅ |

## Invariants proven by property test

| Property | Test | Runs |
| --- | --- | --- |
| P-A — the 80% block is a residual; `block + yalago === feeTotal` for any basket | `money/allocate.test.ts` | default |
| P-B — `driver + company + yalago === feeTotal` for any fees **and any band rate** | `money/allocate.test.ts` | default |
| P-C — BR1 closes at zero for any mode mix, any fees, any tranche count | `br1/property.test.ts` | 500 |
| P-D — a pay-mode flip leaves `scalarDiff` at 0 and moves the split by ±fee | `br1/property.test.ts` | 500 |
| P-E — dropping an order moves `scalarDiff` by exactly that order's block | `br1/property.test.ts` | 500 |
| P-F — tier split exhaustive in **both** whole and marginal modes | `tier/bands.test.ts` | 300 |
| P-G — every date falls in a 7-day window starting on a Sunday | `time/civil.test.ts` | default |
| P-H — every posting balances under random event streams | `ledger/recipes.test.ts` | 400 |
| P-I — the ledger's driver balances always equal what BR1 expects | `ledger/recipes.test.ts` | 400 |

**Seed policy:** fixed seed on PRs for reproducibility; a nightly job re-runs with a randomised seed
and files an issue on failure. Every shrunk counterexample is frozen as a named regression test —
`money/allocate.test.ts` › "REGRESSION: the naive 0.80 × Σfees formula really does diverge" is the
first of these, and it is the reason the residual rule exists.

## Not a coverage number

Line coverage on a pure arithmetic module lies: it is trivially 100% while the assertions are weak.
The domain package is gated on **mutation score** instead (Stryker, `packages/domain` only) — cut
from the CI gate to a manual M6 run under the agreed cut list, but the property suites above are the
real protection either way.

## Current state

```
8 test files · 210 tests · ~1.0 s · no Docker required
```

**⚠ Rows marked "written, unrun"** live in `packages/db/verify-guards.sql`. That file attempts
every illegal write and fails if the database allows one, but it has never been executed — this
machine has no Docker and no `psql`. CI runs it against real Postgres 17, so the first push
proves them. Until then they are claims, not evidence.

Run with `pnpm -r test`.
