# ASH Delivery

Operational-financial platform for a Damascus fleet-delivery business partnered with Yallago.
Every shift is photo-documented, every shift close must satisfy a zero-tolerance cash equation,
every movement is a balanced double-entry posting, and the financial week freezes every Sunday.

**This system moves real cash daily. Production correctness beats speed.**

## Quick start

```bash
pnpm install
pnpm check     # typecheck + domain purity + SQL static checks + 260 tests (~15 s, no Docker)
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
| [packages/db/migrations/](packages/db/migrations/) | Hand-written SQL. ⚠ Not yet executed — see below. |
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

The **arithmetic** of Bundle 1 is written and green: money, BR1, the tier engine, ledger posting
recipes, the shift state machine, RBAC, Damascus dates, FX, week close, fleet rules — 260 tests.

**Not yet built:** the API, both front-ends, and any running database. Nothing here can be logged
into yet. The SQL migrations and their guards have **never been executed** — this was written on a
machine with no Docker and no `psql` — so treat `0006` as unproven until CI or `db-verify.sh`
turns green.
