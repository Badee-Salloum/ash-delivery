# PROGRESS

## 2026-07-21 — M0/M3: the API, and the §2.3 shift running over real HTTP

**Done and VERIFIED — 293 tests, ~3 s, still no Docker**

The whole shift lifecycle now runs end to end through the actual HTTP surface a driver and a
branch manager will use. `apps/api/test/lifecycle.test.ts` drives the client's own §2.3 example:
float 100,000 + top-up 50,000 → 20 orders (12 cash / 6 electronic / 2 free) → close at 160,000
cash and 70,000 wallet → «الفرق: ٠» → manager approves → the ledger shows Yallago 20,000, driver
40,000, company 40,000, `fee_earned` closed to zero, and both driver funds back at zero.

This works without a database because every dependency is a **port**:

- `packages/contracts` — the port interfaces and the Zod wire schemas.
- `packages/adapters/memory` — in-memory implementations that enforce the *same* invariants the
  database does: the `(shiftId, eventType, occurrenceKey)` idempotency key, the double-entry
  balance check, and the global uniqueness of `provider_order_no`. They are not stubs that
  always say yes, so a test passing here is testing real behaviour.
- `apps/api` — Fastify, with the PostgreSQL adapters dropping in later one file at a time.

**Security properties now enforced at the HTTP layer**

- Sessions are opaque and DB-backed, 30-minute *idle*-sliding — tested by advancing the clock
  past the window, and by polling every 29 minutes to prove a manager mid-review is not kicked out.
- Account locks after exactly 5 failed attempts, and even the correct password is then refused.
- **The lockout write is audited with `actor_kind='anonymous'`** — it happens on the
  unauthenticated path where no actor exists, and a trigger that raised there would make the
  lockout impossible to implement and turn every failed login into a 500.
- Login failures are indistinguishable between "wrong password" and "no such user", including a
  dummy hash comparison so the response time does not enumerate usernames.
- **Every route declares the permission it needs, and the app refuses to boot if one forgot.**
  A test asserts the public list is exactly `/health`, `/me`, `/auth/login`, `/auth/logout`.

**A third guard, negative-tested like the others**

`scripts/check-wire-money.mjs` — money crosses HTTP as a decimal string, never a JSON number.
`JSON.stringify` throws on a bigint and the tempting fix is `Number(amount)`, which is the single
most likely way a defect ever enters this system. The guard bans `z.number()` on money-shaped
fields, `Number(...)` on money-shaped identifiers, and `parseFloat` outright. Verified to fail on
an injected violation, then pass again.

**Notable behaviours proven over HTTP**

- Approving twice does not double-post — the state machine refuses, and the idempotency key would
  have stopped the postings even if it hadn't.
- A stale `reviewedOrdersHash` returns **409**, so approval cannot land on numbers nobody reviewed.
- A non-zero BR1 returns **422** *and* names the likely cause; no `share_split` is written.
- The pay-mode blind spot survives the round trip: difference `"0.00"`, `cashDifference`
  `"5000.00"`, `walletDifference` `"-5000.00"`, cause `pay_mode_misclassified`. Advisory lets it
  through, strict blocks it.
- A duplicate Yallago order number is caught as it is typed (409).
- A branch manager reaching another branch gets 403 `outside_branch`; a driver touching another
  driver's shift gets 403 `not_owner`.

**Next**

1. **Send `docs/client-request-samples.md`** — still the highest-value hour in the project.
2. Swap the in-memory adapters for PostgreSQL ones (`packages/db`), which also runs the guard
   harness for real. This is the step that needs Docker.
3. The two front-ends: the admin console and the driver PWA.
4. bcrypt for the production hasher (the port exists; only the test implementation is wired).

**Still true, and worth repeating:** no UI exists, and the SQL migrations have never been
executed. What is real is the arithmetic and the HTTP contract.

---

## 2026-07-21 — M0 in progress: RBAC, schema, and the guard harness

**Done and VERIFIED** (green on this machine)

- **RBAC as data** — `packages/domain/src/rbac/can.ts`. The SRS §3 matrix is stored as grants
  (A-2 requires it be sysadmin-editable), evaluated by a pure `can(actor, permission, subject)`.
  The test transcribes the Arabic table a *second* time, independently, and sweeps every role ×
  every permission: **93 tests**, so the grant table is checked against the spec rather than
  against a copy of itself. Scope handling denies rather than widens — a branch-scoped grant
  checked against a subject with no branch returns `subject_missing_branch`, not everything.
- **Static SQL checker** — `scripts/check-sql.mjs`, 8 rules, **negative-tested**: an injected
  migration with every violation produces exactly 7 findings, then passes again once removed.
  It catches the CHECK-subquery bug the design review found in unverified DDL, money declared as
  a float, `STABLE` expressions in generated columns, `date_trunc('week')`, an idempotency index
  missing `occurrence_key`, an undeferred balance trigger, and any table that is neither
  consciously audited nor consciously exempt.
- **158 tests green in ~870 ms**, no Docker. `pnpm check` runs typecheck + domain purity + SQL
  checks + tests in one command.

**Done but NOT VERIFIED** (written without a database — say so out loud)

- **Six SQL migrations** covering SRS A, B, C, E, F, G: 36 tables, 18 audited, 18 consciously
  exempt with stated reasons. **None has been executed.** This machine has no Docker and no
  `psql`; every migration file says so at the top.
- **`packages/db/verify-guards.sql`** — the proof harness. It attempts every illegal write and
  fails if the database *allows* one: unbalanced entry, `app_user` UPDATE/DELETE on the ledger,
  a Monday week start, a locked-week edit to an entry *and to a line*, a duplicate posting, a
  second float tranche (which must SUCCEED), and an actorless audit write.
- **CI** (`.github/workflows/pr.yml`) runs the migrations against a real Postgres 17 service and
  then the harness — **so the guards get proven on the first push**. It also drops a trigger and
  asserts verification then fails, because a harness that cannot fail is decoration.
- `scripts/db-verify.sh` does the same locally in one command, `RUNBOOK.md` §1 has the procedure.

**Two bugs I found reviewing my own SQL** (both would have failed on first run)

- `ROLLBACK` inside a `DO` block that has an `EXCEPTION` handler is illegal in plpgsql.
  Transaction control moved to the psql level around each block.
- The week-lock trigger used `COALESCE(OLD, NEW)`, which made sealing **order-dependent**:
  `fin_seal_week()` stamps `week_lock_id` onto entries *before* setting `closed_at`, so a
  NEW-based check would pass or fail depending on statement order. Now `OLD` only.

**Also done and VERIFIED — the ledger and the shift gates**

- **Posting recipes** (`ledger/recipes.ts`) — pure and balanced. All three payment modes share
  one shape: `order_fee` debits whichever asset received the fee, `yalago_cut` always debits
  `yalago_share` and credits the wallet (BR2's instant deduction), and `share_split` closes the
  whole of `fee_earned` into driver + company + Yallago. It balances *by construction*, because
  `splitBlock()` already guarantees the three shares exhaust the fee total exactly — acceptance
  criterion #5 falls out of the arithmetic instead of being checked afterwards.
  The §2.3 example now walks the ledger end to end and lands on 20,000 / 40,000 / 40,000 with
  `fee_earned` closing to zero and both driver funds at zero after the daily returns.
- **Shift state machine** (`shift/state.ts`) — BR5's two gates as pure transitions, 30 tests.
  Every refusal carries a machine-readable reason and package gaps come back as a *checklist*,
  not a boolean. Covers: the driver's confirmation as the first signature and the manager's as
  the second, re-shoot requests, `suspended` closing under the same equation, the
  `br1_split_gate` advisory→strict switch, the orders-hash check that stops an approval landing
  on numbers nobody reviewed, and RBAC on every transition.
- **210 tests green in ~1.0 s**, still no Docker.

**A real bug the property tests found**

The random-event-stream property failed with `driver_wallet` at −1. Every cash order takes 20%
*out* of the wallet while putting nothing in, so a thin top-up plus many cash orders drives it
negative — twenty 5,000 fees against a 1,000 top-up leaves −19,000. My first `walletReturn`
skipped the posting when the balance was negative, silently leaving money unaccounted for.

This is the negative-wallet scenario the design review flagged as a blocker, reproduced
independently by a generator. Two consequences: the return posting now runs the other way (the
office covers the shortfall, the fund still lands on zero), and `minWalletBalance()` is a
**separate** check — because **BR1 evaluates to exactly zero throughout**, so the zero equation
genuinely cannot detect it. Logged as A-26, and it raised a new question for the client.

**Also done and VERIFIED — FX, week close, fleet rules**

- **Daily FX** (BR6, AC #6) — rates stored as SYP *minor units per USD*, because USD-per-SYP is a
  fraction and there is no honest way to hold a fraction in an integer. Conversion is half-up
  because it is a display figure only; the ledger is SYP minor units end to end. A missing rate
  carries forward flagged `provisional` rather than failing — a broken cron must never freeze the
  business — and the Sunday close then refuses to seal a week that still contains one.
- **Sunday-close pre-flight** (BR7, AC #9) — reports *every* blocker at once rather than one
  refusal at a time. Closing on Sunday the 26th seals the 19th–25th; a shift worked on the 26th
  belongs to the new week. The Yallago reconciliation gate reports `deferred_to_bundle_2` instead
  of silently reading as satisfied.
- **Fleet rules** (B-1/B-2/B-3) — expiry alerts fire once per threshold (T-30/14/7/0), not daily
  for a month; an *expired* document blocks assignment, one merely expiring does not.

**Where the domain stands**

| Module | Covers | Tests |
| --- | --- | --- |
| `money/` | minor units, residual 80% block, exhaustive split | 10 |
| `br1/` | the zero equation, split components, cause breakdown | 14 |
| `tier/` | bands, whole + marginal, day true-up, effective dating | 27 |
| `ledger/` | posting recipes, balance invariant, corrections | 22 |
| `shift/` | BR5 gates, state machine, RBAC on transitions | 30 |
| `rbac/` | the SRS §3 matrix as data | 93 |
| `time/` | Damascus business dates, Sunday weeks | 14 |
| `fx/` | daily rate, carry-forward, USD equivalence | 11 |
| `week/` | close pre-flight, lock coverage | 15 |
| `fleet/` | document expiry, vehicle state, assignment | 24 |
| | **total** | **260 in ~1.3 s** |

**Next**

1. **Send `docs/client-request-samples.md`.** Still the highest-value hour in the project. It now
   carries a second question: what does Yallago do when its 20% cut exceeds the wallet balance?
2. `./scripts/db-verify.sh` — install Docker, or just push and let CI prove the guards. Until that
   runs green, every claim in `packages/db/migrations/0006` is unproven.
3. `packages/contracts` (Zod + ports), then `apps/api` with the route-permission registry and
   its boot-time completeness assertion, then the admin/driver shells.
4. The photo-legibility spike, once a real dashboard screenshot exists.

**Honest status against the plan:** the *arithmetic* of Bundle 1 is done and green — M2's and
M3's hardest logic both exist as pure, tested code. What does not exist yet is anything a human
can log into: no API, no UI, no running database. M0's "log in as four roles" demo is not
reachable yet.

---

## 2026-07-21 — Day 1 (pre-M0): the money core

**Done**

- Read SRS v1.0 and the kickoff brief in full. No blocking brief-vs-SRS conflict; ~16 binding SRS
  details the brief omits are captured in the plan.
- Stack chosen and approved: TypeScript / Fastify 5 / PostgreSQL 17 / Drizzle / React 19 + a
  separate driver PWA / Vitest + fast-check. Four independent proposals, three judges.
- Seven product decisions confirmed and recorded in `CLAUDE.md` and `ASSUMPTIONS.md`.
- **`packages/domain` is written, pure, and green — 65 tests, 732 ms, no Docker.**
  - `money/minor.ts` — branded `bigint` minor units (1 minor = 1/100 new SYP = 1 old lira)
  - `money/allocate.ts` — the residual 80% block, `yalagoCut`, exhaustive `splitBlock`
  - `br1/equation.ts` — BR1 with `cashDiff` / `walletDiff`, not just the scalar
  - `br1/diagnose.ts` — ranked cause breakdown with distinguishable arithmetic signatures
  - `tier/rules.ts` + `tier/split.ts` — band validation, whole + marginal, day-level true-up
  - `time/civil.ts` — Asia/Damascus business dates, Sunday→Saturday weeks, no `Date`/`Intl`
- `scripts/check-domain-pure.mjs` enforces domain purity — and is **negative-tested**: it genuinely
  fails on an injected violation.
- `CLAUDE.md`, `ASSUMPTIONS.md`, `TESTS.md` written and current.

**See it in 2 minutes**

```bash
pnpm install
pnpm -r test                                  # 65 green
npx vitest run test/br1/canonical.test.ts     # the client's own §2.3 example, verbatim
node scripts/check-domain-pure.mjs
```

The canonical test reproduces the SRS §2.3 table row for row — end cash 160,000, end wallet 70,000,
230,000 == 150,000 + 0.80×100,000, difference zero — then splits it at approval into Yallago 20,000
/ driver 40,000 / company 40,000.

**Next**

1. **Send `docs/client-request-samples.md`** — one real shift's dashboard + wallet screenshots and
   the manager's counted ground truth. Blocking for M2; see Risks.
2. The two remaining Day-1 spikes: photo legibility at ~300 KB, and the three Postgres guards
   (deferred balance trigger, `REVOKE` on the ledger, locked-week rejection).
3. M0 — auth, RBAC-as-data, audit, i18n/RTL shell, CI, staging live.

**Risks**

- 🔴 **BR1 is measured against a number Yallago produces and we do not control.** If their wallet
  figure carries tips, promo credits, cancellation reversals, a pending/settled split, or a
  different rounding direction, every shift is unclosable on day one. Mitigation: get one real
  shift before M2; pilot with `br1_split_gate = advisory`; only then make the gate strict.
- 🟠 **The 19-day contract.** Realistic estimate is 40 days (merged plan) to 56 (independent
  review). Re-cut into Bundle 1a + 1b agreed with the PO — **still needs saying to the client in
  writing, this week.**
- 🟠 **The two screens nobody itemised** — driver order entry (20 rows typed on a cheap Android,
  twice a day, with OCR deferred) and the C-7 approval screen. ~2 days each, now budgeted in M3.
- 🟡 Local Node is 25.8; the project targets Node 24 LTS. `.nvmrc` pins 24 and `engines` warns.
  Harmless for the pure domain, but CI and the Dockerfile must pin 24.
- 🟡 Docker is not on PATH in this shell — needed for the M2 Testcontainers work and the DB spike.
