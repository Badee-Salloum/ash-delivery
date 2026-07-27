# RUNBOOK

Operational procedures for ASH Delivery. Sections marked **⚠ NOT YET REHEARSED** describe an
intended procedure that nobody has executed. They are not evidence that anything works.

---

## 1. Verifying the database guards ⚠ NOT YET EXECUTED

**Do this before anything in M2 depends on the ledger.** Three claims hold up the architecture,
and none has touched a real PostgreSQL yet — the machine the schema was written on had neither
Docker nor `psql`:

| Claim | Where |
| --- | --- |
| An unbalanced entry is rejected at COMMIT | `0006` › `journal_lines_balanced` |
| `app_user` cannot UPDATE or DELETE the ledger | `0006` › `REVOKE` |
| A write into a locked week raises `25006` | `0006` › `*_week_locked` |

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d
./scripts/db-verify.sh
```

The script recreates a scratch database, applies all six migrations in order, runs
`packages/db/verify-guards.sql` — which **attempts every illegal write and fails if the database
allows one** — then drops a trigger and confirms verification now FAILS, proving the harness has
teeth. The same three steps run in CI (`.github/workflows/pr.yml` › `database`), so pushing the
branch verifies them too.

Until this has run green, treat `0006` as unproven and say so in writing.

**If a guard fails**, do not weaken the guard. The guard is the requirement (kickoff brief §4:
immutability "in the app layer AND a DB-level guard"). Fix the schema.

---

## 2. Local development

```bash
pnpm install
pnpm check          # typecheck + domain purity + SQL static checks + tests
pnpm -r test        # 158 tests, ~800 ms, no Docker required
```

Node **24 LTS** is the target (`.nvmrc`). A newer Node will run the domain package fine but
`pnpm install` warns, and CI pins 24 — do not let a Node-25-only feature in.

---

## 3. Setting the daily FX rate (BR6) ⚠ PROCEDURE ONLY — UI NOT BUILT

One rate per business date, entered each morning by the **system admin** (nobody else — SRS §3),
applied to that entire day's transactions.

- Stored as `fx_days.syp_minor_per_usd`: minor units per USD, so `13000` = 130 new SYP/USD.
- **Posting is never blocked on a missing rate.** If the admin has not entered today's rate, the
  posting path lazily inserts a `provisional` row carried forward from yesterday and flags it.
  A cron must never be a precondition for the ledger accepting a write.
- Correcting a rate creates a new `fx_rate_versions` row; it never rewrites what was reported.

---

## 4. The Sunday close (BR7) ⚠ PROCEDURE ONLY — UI NOT BUILT

The financial week runs **Sunday 00:00 → Saturday 23:59 Asia/Damascus** and is closed by the
**system admin** on the *following* Sunday. A shift worked on the closing Sunday belongs to the
**new** week and is not frozen by that day's close.

Pre-flight, in order:

1. Every shift in the week is `approved` (none `pending_review` or `suspended`).
2. The daily cash count exists and is sealed for each day.
3. No `provisional` FX rate remains in the week.
4. The prior week is closed (locks must be contiguous — no gaps).
5. Trial balance foots: Σ debits = Σ credits for the week.
6. *(Bundle 2)* Zero reconciliation against the Yallago weekly PDF. **Not in Bundle 1** — the
   pre-flight holds a permanently-satisfied placeholder here (ASSUMPTIONS A-14).

Then `fin_seal_week(week_lock_id, closed_by)` stamps every entry of the week and sets
`closed_at`. After that the entries are immutable at both layers.

**To correct a locked week:** never edit. Post a dated reversal + repost pair; `occurrence_key`
carries the correction sequence so repeated corrections remain possible.

---

## 5. Deploy / rollback / restore ⚠ WRITTEN, NOT YET EXERCISED

The pipeline exists (`.github/workflows/release.yml`, `infra/`) but **no deploy has ever run**.
Treat this as the intended procedure, not a proven one, until the first staging deploy is green.

### First-time VPS setup

```bash
docker network create ash-edge          # the only network Caddy and the APIs share
mkdir -p /srv/ash/backups && cd /srv/ash
git clone <repo> . && sops -d .env.prod.enc > .env.prod   # never store plaintext at rest
docker run -d --name ash-caddy --network ash-edge -p 80:80 -p 443:443   -v /srv/ash/infra/caddy/Caddyfile:/etc/caddy/Caddyfile   -v caddy_data:/data -v /srv/ash/www:/srv caddy:2
```

Staging and production run as **two compose projects on one box** (`-p ash-staging`,
`-p ash-prod`). Distinct project names give distinct container names, volumes and networks, so a
staging mistake cannot reach production data. Neither publishes a port — only Caddy is reachable.

### Deploying

Push a `v*` tag. The release workflow runs the full PR gate first (a tag can never deploy
something that skipped it), builds in CI, pushes to GHCR, then over SSH:

1. takes a **pre-migration `pg_dump -Fc`** — the cheapest insurance in the pipeline;
2. pulls the image **pinned by digest**, not tag: a tag can be moved, a digest cannot, so what
   was tested is exactly what runs;
3. runs the one-shot `migrate` container — if it fails the API never starts and the **old
   container keeps serving**;
4. runs the smoke test: `/health`, HTTP→HTTPS redirect, and an unauthenticated `PUT /api/fx`
   that must return 401.

### Rolling back

Automatic on smoke failure: the workflow re-pins the previously running digest. Manually:

```bash
export API_IMAGE=ghcr.io/OWNER/ash-delivery/api@sha256:<previous>
docker compose -p ash-prod --env-file .env.prod -f infra/compose/docker-compose.prod.yml up -d --wait api
```

**Migrations are forward-only and are NOT reverted by a rollback.** Before rolling back across a
migration, confirm the new schema is still compatible with the older image — additive changes
usually are, a dropped or renamed column is not.

### Restoring

```bash
restic snapshots --tag db
restic dump <snapshot> ash-<stamp>.dump > /tmp/restore.dump
# Restore into a THROWAWAY database first and foot the trial balance before touching production.
createdb ash_restore && pg_restore -d ash_restore /tmp/restore.dump
psql -d ash_restore -c "SELECT SUM(CASE WHEN side='D' THEN amount_minor ELSE -amount_minor END) FROM journal_lines;"
# Expect exactly 0.
```

**The restore rehearsal is a deliverable, not a formality.** It must be run by hand once before
go-live and **timed**, and the measured number written here. If it exceeds the SRS's 4-hour RTO,
the client is told in writing rather than the figure being left as fiction.

> Measured RTO: **not yet measured.**

## 6. Onboarding a driver or vehicle ⚠ NOT YET BUILT — M1

Will cover: create the driver + login, upload the three documents (driving licence, national ID,
criminal record) with expiry dates, register the vehicle and its type, and create tomorrow's
assignment. Expiry alerts fire at T-30/14/7/0 and an expired licence blocks assignment.

---

## 7. Secrets

`.env` is never committed. Secrets are SOPS+age encrypted as `.env.enc`, with the private key
held only on the VPS and in GitHub Actions secrets. **The restic repository password has its own
custody**, separate from the age key — a backup you cannot decrypt is not a backup.

**`ENCRYPTION_KEY` (PII at rest).** Encrypts a driver's national ID (AES-256-GCM). Generate once:

```bash
openssl rand -hex 32
```

It is optional — without it the app still runs, but saving a national ID is refused (it never
falls back to plaintext). **Back it up separately from the database**: the ciphertext lives in the
DB, so a backup that also holds the key protects nothing, and losing the key makes stored national
IDs unrecoverable. Rotating it leaves already-encrypted values unreadable until re-entered (a
re-encrypt procedure is a follow-up). The same mechanism is intended to wrap the TOTP secret
(`mfa_secret_enc`) — deferred until it can be exercised against real Postgres, so live 2FA is not
put at risk by an untested at-rest change.

---

## 8. Known operational gaps

| Gap | Impact | Owner action |
| --- | --- | --- |
| Database guards unverified | The three load-bearing claims are unproven | §1, before M2 |
| Client samples not received | BR1 is calibrated against Yallago's arithmetic, which we do not control | Send `docs/client-request-samples.md` |
| 300 KB photo legibility untested | If a manager cannot read order numbers off a compressed screenshot, the whole C-7 review is theatre | Spike with a real screenshot |
| No staging or production yet | Everything is local | M0 completion |
| Opening balances not imported | SRS §10 م-2: section E cannot go live productively without them | Before go-live |
