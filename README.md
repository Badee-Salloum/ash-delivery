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
| [packages/db/migrations/](packages/db/migrations/) | 40 forward-only, hand-written SQL migrations; production is live through `0040`. |
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

**Bundle 1a has a live Fastify API, Arabic-first admin console, and driver PWA on Vercel.** Neon is
live through migration `0040`, deployed on 2026-08-24 from frozen commit
`8222b6aad437e1de6df0d51999f4026808e395ab`. This release adds single-use pre-approved shift
openings, completed-shift history, and the explicit rule that the driver's share comes from returned
shift money rather than company capital.

[GitHub Actions run 32737035699](https://github.com/Badee-Salloum/ash-delivery/actions/runs/32737035699)
passed all three Node 24 jobs, including fresh PostgreSQL 17 migrations `0001`–`0040`, the guard
harness, its negative test, and PostgreSQL adapter conformance. Migration `0040` is recorded in
production with checksum `e1d2b547`; the validated post-release backup was restored into an isolated
database with all 60 table fingerprints and 4,885 rows matching.

The source of truth for rollout evidence and remaining acceptance work is
[PROGRESS.md](PROGRESS.md). Operational procedures, stable URLs, deployment ids, backup locations,
and rollback rules are in [RUNBOOK.md](RUNBOOK.md) and
[docs/DEPLOY-VERCEL-NEON.md](docs/DEPLOY-VERCEL-NEON.md).

See [STATUS.md](STATUS.md) for the full breakdown, including the six bugs the tests caught.
