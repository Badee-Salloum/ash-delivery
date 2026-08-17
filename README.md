# ASH Delivery

Operational-financial platform for a Damascus fleet-delivery business partnered with Yallago.
Every shift is photo-documented, every shift close must satisfy a zero-tolerance cash equation,
every movement is a balanced double-entry posting, and the financial week freezes every Sunday.

**This system moves real cash daily. Production correctness beats speed.**

## Quick start

```bash
pnpm install
pnpm check     # full Node 24 gate: typecheck, repository guards, and workspace tests (no Docker)
```

The whole domain suite runs without Docker or a database, by construction — `packages/domain` has
no dependencies, no I/O, no clock and no locale.

To verify the database guards (requires Docker):

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d
./scripts/db-verify.sh
```

## Where things are

| Path | What |
| --- | --- |
| [packages/domain/](packages/domain/) | ★ The money core. Pure, zero-dependency. Every rule that decides where money goes. |
| [packages/db/migrations/](packages/db/migrations/) | 34 forward-only, hand-written SQL migrations in source; production is still live through `0033`. |
| [packages/db/verify-guards.sql](packages/db/verify-guards.sql) | Attempts every illegal write and fails if the database allows one. |
| [scripts/](scripts/) | `check-domain-pure.mjs`, `check-sql.mjs`, `db-verify.sh` — all negative-tested. |
| [CLAUDE.md](CLAUDE.md) | Business rules BR1–BR8 + conventions. Read this first. |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | Every default taken instead of blocking, with its reversal cost. |
| [TESTS.md](TESTS.md) | Acceptance criteria → named tests. |
| [PROGRESS.md](PROGRESS.md) | Done / next / risks. |
| [RUNBOOK.md](RUNBOOK.md) | Operational procedures. Unrehearsed sections are marked as such. |

Authoritative specs: [SRSv1.0.md](SRSv1.0.md) (Arabic) and [CLAUDECODEKICKOFF.md](CLAUDECODEKICKOFF.md).

## Three rules that are easy to get wrong

1. **The 80% block is a residual** — `Σfees − Σ(per-order 20% cuts)`, never `0.80 × Σfees`.
   Multiply-and-round makes a zero-tolerance equation unsatisfiable the moment a fee is not
   divisible by 5. The SRS's canonical example (all fees 5,000) hides this; the property tests
   deliberately do not.
2. **BR1 returns three differences, not one.** Flip one order cash↔electronic and the scalar
   equation stays at *exactly zero* while cash is off by −fee and wallet by +fee. Always check
   `cashDiff` and `walletDiff` too.
3. **The idempotency key is `(shift_id, event_type, occurrence_key)`.** Without the third column,
   SRS C-5's second float tranche cannot post and is silently swallowed — cash leaves the office
   with no ledger record.

## Current state, honestly

**Bundle 1a now has a Fastify API, an Arabic-first admin console, and a driver PWA.** All three have
live Vercel projects, and Neon is live at migration `0033` (33 total) after release `a150380`; the
source of truth for rollout state and remaining acceptance work is [PROGRESS.md](PROGRESS.md), not
the older milestone estimates below.

**The repository head is an unpublished `0034` release candidate.** It adds a durable server-side
shift-close draft, attachment-linked OCR and restoration, and a `428 driver_update_required`
response for an old driver attempting the new linked order-reader flow. The candidate must be
released as one maintenance operation in this order: migration `0034` → API → driver/admin, with
writes paused until all three application surfaces agree. Production has not received `0034`, and
no live Muhammad/Thaer shift has been changed by this work.

The final candidate database gate used Node `24.19.0` and PostgreSQL `17.11`: a fresh database
applied all 34 migrations, a rerun reported `0 applied / 34 present`, all database guards passed,
and the real-PostgreSQL suite passed **76/76** across 15 files. Migration `0034` recorded checksum
`5bc30a31` and SHA-256
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A` on the disposable gate.

On 2026-08-15 the full Node 24 gates passed, and the complete 69/69 database suite passed on a real,
disposable PostgreSQL 17 database after all 33 migrations. Production migration and postflight were
read-only apart from the migration itself; never run the destructive conformance suite against
production. The earlier isolated Neon restore/fingerprint rehearsal remains the recovery evidence
for that historical baseline.

The live `0033` Recent Orders OCR requires two agreeing observations from three independent time-evidence
passes. It votes on the literal printed clock before deterministic AM/PM conversion; disagreement
or insufficient evidence leaves the operation `unknown` and outside BR1 and settlement until an
audited manager action resolves it. See [RUNBOOK.md](RUNBOOK.md) for retry and stored-image reread
rules.

See [STATUS.md](STATUS.md) for the full breakdown, including the six bugs the tests caught.
