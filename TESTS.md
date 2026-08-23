# TESTS.md — acceptance-criteria traceability

Maps SRS §8 acceptance criteria to named automated tests. **#8, #10 and #11 belong to Bundles 2–3**
(Yallago PDF reconciliation, OCR, live GPS map) and are out of Bundle-1 scope.

A CI check fails the build when a test named here is renamed or deleted, so this table cannot rot.

**Legend:** ✅ implemented and green · ⚠ written but never executed · 🔜 planned, milestone named.

## 2026-08-23 release gate — dashboard working counts and shift-close integrity

All release-gate commands ran under Node `24.19.0` / pnpm `11.3.0`. The frozen-install full
`pnpm check` plus the required real-PostgreSQL rerun passed **1,916/1,916 tests**:

| Package/gate | Tests | Result |
| --- | ---: | --- |
| Domain | 425 | ✅ |
| Contracts | 12 | ✅ |
| Shared client | 256 | ✅ |
| Admin | 93 | ✅ |
| Driver | 256 | ✅ |
| Adapters | 119 | ✅ |
| Database on disposable PostgreSQL 17.11 | 108 | ✅, zero skips |
| API | 647 | ✅ |

Both frontend production builds and the API bundle passed. Fresh migrations `0001`–`0035` applied
35/35, then the checksum rerun applied 0 and found all 35. The disposable SQL guard harness passed.
Checksums: `0034` FNV `5bc30a31`, SHA-256
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`; `0035` FNV `087c01d4`,
SHA-256 `D3958FCABB4886E390DBCD969E8BFA1241265A8CA661A843C80FA51176ECEF40`.

Automated coverage includes exact-open/suspended/terminal state counts, distinct actors, branch and
cross-midnight isolation, polling/branch-switch/failure preservation; zero/blank/positive/mixed
opening tranches; exact/concurrent/conflicting mid-shift retries and successful close after retry;
balanced/surplus/shortage/negative-wallet/manual-order/cash-deduction/rephoto/stale-hash/
lost-response/two-phase-force-close flows; inclusive cross-week profit and variance exclusion; and
direct PostgreSQL variance-reason plus near-bigint rejection. A twice-seeded release database passed
all 14 permanent read-only money-integrity checks.

The isolated browser flow passed English/Arabic at 390/768/1280 px: `0/0 → 1/1` in 7,516 ms,
stale failure preserved `1/1`, recovery in 7,693 ms, and end submission returned `1/1 → 0/0` in
7,786 ms before approval. Grid columns were 2/3/6, no overflow or page errors occurred, and seven
lightweight polls did not periodically reload financial dashboard endpoints.

The production pre/postflight checker continues to detect three cancelled 2026-08-11 shifts with tranches
`300,000`/`30,000` but journals `30,000,000`/`3,000,000` minor units. A separate backup query
confirmed the exact 100× history. On 2026-08-23 the owner explicitly accepted exactly these three
cancelled shifts as grandfathered historical exceptions for the `0035` rollout. They are not
repaired or hidden: pre/postflight must continue reporting the same three, with all other checks
clean. Their IDs are `0df7c7f1-105c-40b3-97ec-3fc81f83874c`,
`f51cd7a1-ffa5-4e72-b0e4-a1761531b11b`, and `b81ad711-835b-479a-8ee1-37105ca96c21`. The rollout
then completed with the exception set unchanged. Validated backups contained
58 tables / 3,852 pre-migration rows and 58 / 3,853 post-migration rows. Production smokes passed,
and the post-backup restore reproduced all 3,853 rows and every table fingerprint with 27 safe
sequences, no disabled triggers, zero unbalanced entries, and a clean rollback probe. The two shifts
open during deployment remain the real-staff close acceptance cases. The checked-in restore utility
is Neon-HTTP-only, so the localhost rehearsal used a temporary out-of-repository `pg` adapter; a
portable checked-in local restore mode remains deferred.

### Driver end handoff follow-up

Regression coverage now proves that a driver can submit a non-zero money result and can explicitly
defer incomplete end-battery evidence to the manager in the same request. The API test uses two
packs: one valid attachment/reading is preserved, while the unlinked pack becomes a null,
`unavailable: true` manager obligation. It verifies working counts `1/1 → 0/0`, a
`pending_review` state, failed ordinary approval, manager reading completion, and successful final
approval. A no-flag request retains the historical strict battery gate, and domain tests retain the
strict start and manager gates. Driver tests prove that mismatch/battery conditions create visible
review warnings and never enter the end screen's blocking list; active reads, unsaved drafts, other
required evidence/values, invalid operations, and odometer confirmation still block.

| # | Criterion (SRS §8) | Test | Status |
| --- | --- | --- | --- |
| **1** | A shift cannot open before the start package is complete, the driver confirms, and the branch manager approves | `shift/state.test.ts` › "the OPEN gate (BR5, AC #1)" (5 cases) | ✅ |
| | | `api/lifecycle.test.ts` › "will not open without the odometer photo" / "will not open before the branch manager approves" | ✅ |
| **2** | A driver may submit a nonzero result for review; final approval requires BR1 zero or an application-validated settlement, plus branch-manager approval | `br1/canonical.test.ts` › "closes the zero equation exactly" · `br1/property.test.ts` › "closes at exactly zero for any mix" | ✅ |
| | | `shift/state.test.ts` › "the CLOSE gate (BR5, AC #2)" (9 executed cases) | ✅ |
| | | `api/lifecycle.test.ts` › "submits and settles when the equation is not zero, while still explaining the difference" | ✅ |
| | | `api/lifecycle.test.ts` › "the SRS §2.3 shift, end to end over HTTP" | ✅ |
| | | `shift/lifecycle.e2e.ts` — the same, through the real **UI** | 🔜 M3 |
| **3** | A cash order deducts 20% of its fee instantly from the driver's wallet to the Yallago fund | `br1/canonical.test.ts` › "reproduces the SRS table row for row" · "splits at approval" | ✅ |
| | | `ledger/recipes.test.ts` › "yalago_share accumulates the 20,000" | ✅ |
| **4** | An electronic or free order adds 80% of its fee to the driver's wallet | `br1/canonical.test.ts` › "reproduces the SRS table row for row" | ✅ |
| | | `ledger/recipes.test.ts` › "SRS §2.3 walked through the ledger" | ✅ |
| **5** | Σ debits == Σ credits across every entry of any day | `money/allocate.test.ts` › "driver + company + yalago === feeTotal, exactly" | ✅ |
| | | `ledger/recipes.test.ts` › "every posting balances under random event streams" (400 runs) | ✅ |
| | | `db/verify-guards.sql` › guard 1 — rejected at COMMIT by Postgres | ✅ PostgreSQL 17.11 |
| **6** | The day's rate applies to all that day's transactions **and the USD equivalent appears in reports** | `fx/rate.test.ts` › "USD equivalence (BR6, AC #6)" (6 cases) + "resolving the day's rate" (5 cases) | ✅ |
| | | `fx/usd-display.itest.ts` — the *second half* of the criterion, easy to miss | 🔜 M5 |
| | | `api/auth-rbac.test.ts` › "only the system admin may set the daily rate" | ✅ |
| **7** | The daily band is computed automatically from the order count, changes only the company's share, and only the sysadmin may edit it | `tier/bands.test.ts` › "band boundaries — 14/15, 24/25, 34/35" (9 cases) | ✅ |
| | | `tier/bands.test.ts` › "the company absorbs the rounding remainder, never the driver and never Yallago" | ✅ |
| | | `rbac/matrix.test.ts` › "the General Manager may NOT edit tier rules" | ✅ |
| **9** | The Sunday close blocks any edit to that week's entries except via a visible correction entry | `shift/state.test.ts` › "immutability after the week lock" | ✅ |
| | | `db/verify-guards.sql` › guards 3, 5a, 5b, 5c — `REVOKE` *and* trigger, entries **and** lines | ✅ PostgreSQL 17.11 |
| | | `ledger/recipes.test.ts` › "corrections (BR7)" | ✅ |
| **12** | Total profits are visible to the General Manager only; a branch manager sees only his branch | `rbac/matrix.test.ts` — every role × every permission, 93 generated cases | ✅ |
| | | `shift/state.test.ts` › "RBAC on transitions" | ✅ |
| | | `api/auth-rbac.test.ts` › "RBAC over HTTP" (7 cases, every role × protected route) | ✅ |
| | | `rbac/visibility.e2e.ts` — through the real UI | 🔜 M5 |

---

## Business rules → tests

Acceptance criteria do not cover every rule. BR2 in particular is encoded *by absence* — nothing
accrues weekly — which is exactly the kind of thing that silently regresses.

| Rule | Test | Status |
| --- | --- | --- |
| BR1 zero equation | `br1/canonical.test.ts`, `br1/property.test.ts` | ✅ |
| BR1 pay-mode blind spot | `br1/canonical.test.ts` › "the pay-mode blind spot" · `br1/property.test.ts` › "flipping any order cash↔electronic" | ✅ |
| BR1 cause breakdown | `br1/canonical.test.ts` › "difference breakdown — the arithmetic signatures are distinguishable" | ✅ |
| BR2 no weekly settlement | `api/lifecycle.test.ts` — yalago_share lands per order at approval; there is no weekly accrual recipe to call | ✅ |
| BR3 three payment modes | `br1/property.test.ts` (all three generated) | ✅ |
| BR4 80% block + company absorbs remainder | `money/allocate.test.ts` › "the company absorbs the rounding remainder" | ✅ |
| BR5 both gates | `shift/state.test.ts` (30 cases) | ✅ |
| BR6 daily FX, one rate per day | `fx/rate.test.ts` (11 cases) | ✅ |
| BR7 close pre-flight blockers | `week/close.test.ts` (15 cases) | ✅ |
| B-1 document expiry / B-3 assignment binding | `fleet/documents.test.ts` (24 cases) | ✅ |
| BR7 Sunday week, Sunday→Saturday | `time/civil.test.ts` › "financial week — Sunday → Saturday" (7 cases) | ✅ |
| BR7 non-Sunday week start refused by the DB | `db/verify-guards.sql` › guard 4 | ✅ PostgreSQL 17.11 |
| BR8 visibility limits | `rbac/matrix.test.ts` (93 cases) + `api/auth-rbac.test.ts` | ✅ |
| A-1 auth: 5-attempt lockout, 30-min idle sessions | `api/auth-rbac.test.ts` › "authentication" (9 cases) | ✅ |
| Every route declares a permission (boot assertion) | `api/auth-rbac.test.ts` › "the boot assertion" (3 cases) | ✅ |

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
domain       425 tests
contracts     12 tests
client       256 tests
admin         93 tests
driver       256 tests
adapters     119 tests
database     108 tests   (real disposable PostgreSQL 17.11; zero skips)
api          647 tests
             ─────────
           1,916 tests
```

`packages/db/verify-guards.sql` was executed against a positively identified disposable PostgreSQL
17.11 database. It attempted the forbidden writes and passed every guard; destructive conformance
was never pointed at production. The production integrity checker is read-only and separately
continues to report only the exact owner-accepted historical exceptions documented above.

Run the full gate with `pnpm check`.
