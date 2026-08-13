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

### Backing up (Vercel + Neon — the live platform)

The restic block below belongs to the docker-compose stack, which is **not deployed**. Production
is Vercel + Neon, and `pg_dump`/`psql` are not installed on the operator's machine — nor would
they work: on the Damascus network port 5432 is reset by the geo-block after about twenty seconds.
The backup therefore goes over the same `@neondatabase/serverless` HTTPS path the migrations use.

```bash
# Always the DIRECT endpoint — drop "-pooler" from the host.
DATABASE_URL='postgresql://…' node scripts/backup-db.mjs        # → backups/<ISO stamp>/
```

Writes one gzipped JSONL file per table plus a `manifest.json` recording the migration ledger,
per-table row counts, column types and the foreign-key graph. **Every value is carried as a
string**: `bigint` is the money type here and a JSON number is an IEEE double, so a single
`to_jsonb()` would silently round any amount above 2^53 minor units.

**The schema is deliberately NOT in the backup.** It lives in `packages/db/migrations` under
checksum, in version control. A restore is therefore: empty database → `pnpm migrate` → load.

⚠ **Off-site copy is still owed.** `backups/` is git-ignored and lives on one laptop; a backup on
the same machine as the only checkout is not a backup. And the **evidence photos in Vercel Blob
have no copy at all** — they are the record behind every approved shift.

### Restoring

```bash
# 1. An empty target, at the commit whose migrations match the backup.
DATABASE_URL='<target>' pnpm migrate
# 2. Load. It refuses if the target schema differs, or if it already holds rows without --yes.
DATABASE_URL='<target>' node scripts/restore-db.mjs backups/<stamp> --yes
```

Then foot the trial balance before trusting it — expect exactly `0`:

```sql
SELECT SUM(CASE WHEN side='D' THEN amount_minor ELSE -amount_minor END) FROM journal_lines;
```

**Rehearsed 2026-08-09** against a scratch database on the live Neon project. The rehearsal was
not a formality: it found four defects that would each have surfaced only during a real disaster.

| | |
| --- | --- |
| `pnpm migrate` (16 migrations, empty DB) | **26 s** |
| Load 1,196 rows across 44 tables | **154 s** |
| Verification (trial balance, fingerprints, sequences) | ~20 s |
| **Measured RTO** | **≈ 3 min 20 s** for 1,196 rows |

Verified identical to production on: trial balance, sum of debits, an entry×line fingerprint over
every posting, float-tranche total, user, shift and media fingerprints, and every sequence — then
proved the restored database accepts writes and that its audit and deferred-balance triggers came
back armed (28 user triggers, 0 disabled, matching production exactly).

**What the rehearsal found, none of which was theory:**
1. `GENERATED ALWAYS AS IDENTITY` rejects an explicit id — the load died on `journal_entries`.
   Fixed with `OVERRIDING SYSTEM VALUE`, which is required to reproduce ids the foreign keys need.
2. The audit triggers fired on the restore's own inserts and collided with the audit rows being
   restored.
3. `journal_lines_balanced` is `DEFERRABLE INITIALLY DEFERRED`, and the HTTP driver has no
   persistent session — so it checked after **each line** and rejected the first line of every
   two-line entry. The ledger was unrestorable until triggers were disabled for the load.
4. Sequences were not reset, because the reset query matched `serial` columns (`deptype='a'`) and
   every id here is an identity column (`deptype='i'`). The restore read perfectly and the **first
   write** would have collided on the primary key.

> ⚠ **RTO SCALES BADLY AND THIS IS NOT YET SOLVED.** 1,196 rows is a test fleet. The first
> rehearsal ran one INSERT per row — about three rows a second — which batching improved to
> roughly eight. A hundred bikes at twenty orders a day reaches ~1M rows within a year, and at
> this rate that is **over 30 hours** against the SRS's **4-hour RTO**. Before the fleet grows,
> the loader needs `COPY` over a real TCP session, or a Neon branch/PITR restore instead of a
> logical one. **The client is to be told this in writing rather than the figure left as fiction.**

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

**`OPENAI_API_KEY` (cloud OCR).** Read by the API only when `OCR_DRIVER=openai`; the boot refuses
that combination without it, naming the variable. Set it in the Vercel project, never in the repo.

---

## 7a. The cloud OCR reader — turning it on, watching it, turning it off

**Turning it on** (three env vars on the `ash-api` Vercel project, then redeploy):

```
OCR_DRIVER=openai
OPENAI_API_KEY=sk-…
OCR_MAX_READS_PER_SHIFT=15        # optional; this is the default
```

`OPENAI_OCR_MODEL` / `_EFFORT` / `_VERBOSITY` default to **gpt-5.5 / medium / medium**. Those three
were measured together over 48 real screens and 311 hand-transcribed rows. **Do not change one
without re-running the benchmark** — dropping effort to `low` cut reasoning tokens 16× and cost
seven more wrong numbers and three more hundredfold errors:

```bash
node scripts/vision-bench.mjs --provider=openai --model=gpt-5.5 --effort=medium --verbosity=medium
node scripts/ocr-compare.mjs                 # the scoreboard; MISREAD is the only column that decides
node scripts/ocr-failures.mjs --run=<folder>  # every wrong row, with the glyphs it claims to have seen
```

**TURNING IT OFF — the one thing to know at 3 a.m.** Set `OCR_DRIVER=none` in the Vercel project
and redeploy. No code change. Every read then answers `unavailable`, the driver's phone falls back
to its own reader, and nothing else in the app notices. Reach for this if the bill runs away, the
provider degrades, or a model update starts misreading. **It cannot break a shift**: an OCR failure
is a 200 with a reason by construction, and no gate consults the reader.

**Watching the bill.** `ocr_reads` is the only cost meter that exists.

```sql
-- What it cost, by day. gpt-5.5 is $5/1M in, $30/1M out.
SELECT created_at::date AS day,
       count(*) AS reads,
       sum(tokens_in) AS tin, sum(tokens_out) AS tout,
       round((sum(tokens_in)*5.0 + sum(tokens_out)*30.0) / 1e6, 2) AS usd
  FROM ocr_reads GROUP BY 1 ORDER BY 1 DESC;

-- How often it fails, and how.
SELECT field, result->>'reason' AS reason, count(*)
  FROM ocr_reads WHERE (result->>'ok')::boolean IS NOT TRUE GROUP BY 1,2 ORDER BY 3 DESC;

-- Shifts pressed against the cap: candidates for a higher ceiling, or a driver retaking photos.
SELECT shift_id, count(*) FROM ocr_reads WHERE shift_id IS NOT NULL
 GROUP BY 1 HAVING count(*) >= 15;
```

Budget at 3.7¢/image and ~12 photos a shift: **≈$130/month at ten bikes, ≈$1,300 at a hundred.**

**`maxDuration` is 60s** in `vercel.json` (raised from 30 — a measured read took 24.9s). The fetch
aborts at `OCR_TIMEOUT_MS`, default 45s, deliberately *inside* that window: set the two equal and
the socket dies at the same instant the platform gives up, turning a clean 504 into an opaque
error. If the ceiling ever changes, move the timeout with it and keep the gap.

**Privacy.** These screenshots carry real customer addresses, named businesses and metre-level GPS,
and they now leave the country. Recorded as `ASSUMPTIONS.md` A-30. The **paid** OpenAI API does not
train on submitted content by default (30-day retention for abuse review); a free tier is a
different bargain and this must not be pointed at one.

---

## 8. Known operational gaps

| Gap | Impact | Owner action |
| --- | --- | --- |
| Database guards unverified | The three load-bearing claims are unproven | §1, before M2 |
| Client samples not received | BR1 is calibrated against Yallago's arithmetic, which we do not control | Send `docs/client-request-samples.md` |
| 300 KB photo legibility untested | If a manager cannot read order numbers off a compressed screenshot, the whole C-7 review is theatre | Spike with a real screenshot |
| No staging or production yet | Everything is local | M0 completion |
| Opening balances not imported | SRS §10 م-2: section E cannot go live productively without them | Before go-live |
