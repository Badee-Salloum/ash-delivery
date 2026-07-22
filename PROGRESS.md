# PROGRESS

## 2026-07-23 (later) — the two roles that own the business could not use the app

**207 API tests + 290 domain green, 6 guards green, redeployed.**

Reported as "the dashboard is stuck on جارِ التحميل and there is nowhere to add a deposit". One
root cause, much wider than the screen.

The GM and the system admin have `branchId === null` **by design** — the §3 matrix grants them
scope **'all'**, so the session deliberately cannot pick a branch for them. But every branch-scoped
route read the branch from the request **body**, and a GET has no body. Scope 'all' was therefore a
permission nobody could exercise: `/dashboard`, `/drivers`, `/vehicles`, `/assignments`, `/shifts`,
`/treasury/balances`, `/documents/expiring` and `/expenses` all answered 422 `branch_required` to
exactly those two roles — which, on a fresh production install, are **the only two accounts that
exist**. Authorization said yes; the handler said no.

The console hid it: a failed fetch left state `null`, the same value as "not fetched yet", so the
screen rendered "loading" forever and the real HTTP error never surfaced.

**Worse, found by the same sweep:** `week.close` is system-admin-only, and a system admin never has
a branch — so **BR7's Sunday close was unperformable by any real account**, the moment a week's
entries become immutable. `closeWeekRequest` had no `branchId` field either, so not even a body
escape hatch. The console rendered the refusal as *silence*: the catch stored the error but the JSX
knew only `weekStart` and `blockers`, so an error carrying neither fell through to `null`.

**The suite was green throughout** because every test in `week-close.test.ts` seeded a system admin
*with a branch* — a shape `bootstrap.ts` and `POST /users` both refuse to create — and said so in a
comment. That is the failure mode worth remembering: a test that constructs an impossible actor
proves nothing about the system that exists.

Fixed: one `branch-scope.ts` resolver reading `?branchId=` as well as the body (replacing five
near-identical copies); the RBAC subject is what the caller *asked for*, so a branch manager
reaching across the fence is refused rather than quietly served his own; a branch picker in the
admin side rail for organisation-wide roles; screens show the error and a retry, and refetch on
branch change; the treasury states *why* the system admin has no deposit box rather than rendering
an empty card. 17 new tests, one per endpoint in both directions, plus four pinning the real
production-shaped admin through the Sunday close.

---

## 2026-07-23 — bikes are assigned, not chosen; and a stranded bike can be released

**190 API tests + 290 domain green, 6 guards green, all three Vercel projects redeployed.**

The driver no longer picks his bike from a menu. The branch manager binds driver ↔ vehicle for a
business date (SRS B-3 / س34) on the fleet screen; from then on `/me/assignment` returns that bike
alone, and `createShift` refuses any other. A bike assigned to somebody else is off limits even to
an unassigned driver. Where no assignment exists the old free choice still stands, so a branch that
has not started assigning is not locked out of its own shifts — the rule is enforced server-side,
because a driver with the API can post any vehicle id.

The `assignments` table has existed since migration 0003, with both UNIQUE constraints, and had
**zero code references**. This wires it end to end.

**The trap it exposed.** A driver who backs out of the start screen leaves a shift in `draft`. That
shift still holds its bike, and a draft shift notifies nobody — so the bike became unusable for the
rest of the day with no route back short of a DBA. Now: `DELETE /shifts/:id` releases it, refuses
anything from `open` onward (money may already have posted), and is audited; `GET /shifts` surfaces
the stranded shift the approval queue never sees; and the fleet screen shows a **release** button on
exactly those vehicles.

Also: the treasury nav read «الجرد اليومي», which hid the branch cash box + wallet deposits behind a
label about counting. Renamed to «خزينة الفرع».

**Still open:** approval ceilings per role (A-4) and attendance (B-4) — both tables exist, neither is
wired. OCR accuracy still needs calibrating against the client's real dashboard photos.

---

## 2026-07-21 (later) — Phase A + B complete: Bundle 1a is feature-complete

**471 tests + 6 CI guards green, both front-ends build.** See [STATUS.md](STATUS.md).

**Phase B — the remaining backend**
- Tier admin (F-3…F-6): effective-dated publishing that supersedes rather than deletes, band
  validation at publish time, and a what-if simulation that reads-only (a test asserts the ledger
  is untouched after simulating).
- 2FA / TOTP (§7): RFC 6238 verified against the spec's own vectors, the deterministic parts pure
  in the domain with the HMAC injected. Password → code; an enrolled admin is blocked from every
  permissioned route until the second factor clears.
- Notification bell (A-6), branch-addressed and dedupe-keyed.
- The minimal ops dashboard (I-1), with total profit a GM-only endpoint.

**Phase A — the front-ends**
- `packages/client`: the typed API client, i18n catalogs (ar default + en, parity type-enforced),
  and the order-entry model — duplicate detection, one-tap mode cycling, and a live BR1 preview
  that reproduces the §2.3 numbers. All tested without a DOM.
- Driver PWA: RTL-first, 70 KB gzip, prompt-mode service worker. The order-entry screen with its
  live BR1 footer, and camera capture that compresses to ~300 KB and retries idempotently.
- Admin console: 2FA login, the C-7 approval review (BR1 panel pinned first with ranked causes,
  start-vs-end odometer compare), the dashboard, fleet CRUD, and treasury (cash count + close).
- Two new guards, both negative-tested: physical-CSS (RTL logical properties only) and i18n parity.

**What's left** is operational, not code — the go-live checklist in STATUS.md. The one caveat
worth repeating: the UIs typecheck and build but have not been run in a browser here.

---

## 2026-07-21 (late) — Bundle 1a backend complete

**415 tests green, no Docker.** See [STATUS.md](STATUS.md) for the full picture.

Every SRS section in Bundle 1a now has working, tested endpoints — 34 of them. All twelve ports
have both an in-memory and a PostgreSQL implementation, proven by one shared conformance suite.

**Closed this session**

- **Photo evidence (C-6)** — was entirely absent. Real upload, content-addressed dedupe,
  magic-byte sniffing, RBAC-checked serving. Critically, the BR5 gates now read *uploaded media*
  rather than a list of slot names the client asserted.
- **The last three PostgreSQL adapters**, so the API can actually run against a database.
- **Fleet management (B)** — drivers, vehicles, documents, expiry board.
- **Expenses (G)** — an entire priced section that was at zero.
- **Cash count (E-5) and manual entries (E-3)**, completing section E, and the Sunday close now
  actually verifies every day was counted.
- **Vercel + Neon deployment path**, with a durability guard that refuses to boot production
  against storage that would lose evidence on redeploy.

**Six bugs the tests found**, each invisible to reading — see STATUS.md. The two worth repeating:
a manual entry naming `office_cash` moved nothing at all, and the API could not start because
TypeScript parameter properties are not strippable by Node while every test passed.

**Next, in order**

1. Send `docs/client-request-samples.md` — still the highest-value hour in the project.
2. Prove `verify-guards.sql` against Neon (run against stock Postgres 17, not Neon).
3. Choose object storage for evidence photos.
4. Build the two front-ends (~7 days). Nothing can be *used* until then.

---

## 2026-07-21 — deployable backend: Postgres adapters, Docker, release pipeline, seed

**319 tests green, ~4 s, no Docker needed on this machine.**

| Package | Covers | Tests |
| --- | --- | --- |
| `domain` | money, BR1, tier, ledger recipes, shift gates, RBAC, dates, FX, week close, fleet | 260 |
| `adapters` | port conformance, in-memory | 10 |
| `db` | port conformance, PostgreSQL | *skipped locally, runs in CI* |
| `api` | lifecycle over HTTP, auth/RBAC, config, seed guard | 49 |

**What became real since the last entry**

- **PostgreSQL adapters + migration runner.** Held to the *same* conformance suite as the
  in-memory ones — a behaviour that differs between the two is a bug in one of them, and a shared
  suite is the only place that surfaces. The load-bearing line is the int8 → `BigInt` parser:
  node-postgres returns bigint columns as strings by default and other drivers return Numbers,
  which silently loses precision above 2^53. `assertBigIntParser()` proves at boot that it took
  effect, and a `numeric` column reaching the driver throws rather than handing back a lossy float.
- **The migration runner** is forward-only, one transaction per file, advisory-locked so two
  replicas starting together cannot both migrate, and it **refuses** if an already-applied
  migration's checksum has changed — the database and the repo disagreeing about history is not
  something to paper over.
- **Production deployment**: Dockerfile (Node 24, runs as `node`, healthcheck on Fastify's own
  `/health`), two-project compose so staging cannot reach production data, Caddy with same-origin
  `/api` and a self-only CSP, and a release pipeline that runs the full PR gate first, pins by
  **digest** not tag, takes a pre-migration dump, smoke-tests, and rolls back automatically.
- **The demo seed** is the SRS §2.3 shift posted through the *same recipes the API uses*, and the
  CLI asserts the resulting BR1 difference is exactly zero — the demo data proves itself.

**A real crash-on-boot the tests could not have caught**

The server would not start: Node runs TypeScript in strip-only mode and cannot erase **parameter
properties** (`constructor(private readonly x: T)`). Nine of them across three packages, all
failing at *load* time — i.e. a crash-looping container on deploy, with 33 API tests passing the
whole time. Running the thing is not the same as testing the thing. Fixed, and
`scripts/check-strippable.mjs` now gates the repo.

**Four guards, all negative-tested** — domain purity, SQL statics, wire-money, strippability. Each
was verified to actually fail on an injected violation, because a guard nobody has watched fail is
decoration.

**What is NOT done**

1. **No UI.** Neither the admin console nor the driver PWA exists. The API is driven by HTTP calls
   today, so there is nothing a driver or branch manager can log into.
2. **Nothing has touched a real database or a real server.** The migrations, their guards, and the
   entire deploy pipeline are written and unexecuted. CI proves the first two on the first push.
3. **The client samples are still unsent** (`docs/client-request-samples.md`), and BR1's calibration
   still depends on them.

**To deploy, I need from you**

- The GitHub repo URL (to push, and to let CI prove the database guards).
- VPS host + SSH key, and the domain names for staging and production.
- Backblaze B2 (or equivalent) credentials for restic, plus a repository password held separately
  from the SOPS age key.

---

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
