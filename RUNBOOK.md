# RUNBOOK

Operational procedures for ASH Delivery. Sections marked **⚠ NOT YET REHEARSED** describe an
intended procedure that nobody has executed. They are not evidence that anything works.

---

## 1. Verifying the database guards — verified 2026-08-16

Three claims hold up the architecture:

| Claim | Where |
| --- | --- |
| An unbalanced entry is rejected at COMMIT | `0006` › `journal_lines_balanced` |
| `app_user` cannot UPDATE or DELETE the ledger | `0006` › `REVOKE` |
| A write into a locked week raises `25006` | `0006` › `*_week_locked` |

```bash
docker compose -f infra/compose/docker-compose.dev.yml up -d
./scripts/db-verify.sh
```

The script recreates a scratch database, applies every migration in order, runs
`packages/db/verify-guards.sql` — which **attempts every illegal write and fails if the database
allows one** — then drops a trigger and confirms verification now FAILS, proving the harness has
teeth. The same three steps run in CI (`.github/workflows/pr.yml` › `database`), so pushing the
branch verifies them too.

For the live 2026-08-24 release at commit
`8222b6aad437e1de6df0d51999f4026808e395ab`, [CI run
32737035699](https://github.com/Badee-Salloum/ash-delivery/actions/runs/32737035699) passed all three
Node 24 jobs. Its PostgreSQL 17 job applied fresh migrations `0001`–`0040`, passed every guard,
negative-tested the guard harness, and passed PostgreSQL adapter conformance. Production now ends at
`0040_preapproved_shift_rules.sql`, checksum `e1d2b547`.

The validated post-release backup was restored into isolated database
`ash_release_gate_0040_restore_20260824_1748`: 60 tables, 4,885 rows, 40 migrations, and all 60
canonical fingerprints matched production. All 27 sequences and an audited rollback probe passed;
the scratch database was then dropped and confirmed absent. None of the destructive CI targets was
production; the conformance suite truncates its database and must never be pointed at the live Neon
URL.

**If a guard fails**, do not weaken the guard. The guard is the requirement (kickoff brief §4:
immutability "in the app layer AND a DB-level guard"). Fix the schema.

---

## 2. Local development

```bash
pnpm install
pnpm check          # typecheck + domain purity + SQL static checks + tests
pnpm -r test        # workspace suites; DB integration skips unless DATABASE_URL is set
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

## 5. Deploy / rollback / restore — Vercel + Neon exercised through 2026-08-26

The live Vercel + Neon procedure below has been exercised, including a production migration,
three deployments, smoke tests, and an isolated restore rehearsal. The separate VPS pipeline
(`.github/workflows/release.yml`, `infra/`) still exists but has not been exercised in production.

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

> **Do not roll the API back past the «السلفة» release (0055–0057) while any advance is
> outstanding.** The older image emits a schema-v3 restoration plan, which has no `advances` term
> and would read money out on a سلفة as a capital shortfall — «شحن»ing real money out of صندوق
> الشركة to refill a box that is not short, and sweeping it back out when the advance is repaid.
> 0057's dispatcher refuses such a plan by name (`restorations_plan_version_guard`, *"schema-v3
> restoration cannot ignore an outstanding advance"*), so الترميم **stops** rather than lies. That
> is the recoverable direction, but it does stop: roll forward, or settle the advances first.
> Outstanding advances: `SELECT id, party_name, amount_minor FROM advances a WHERE EXISTS (…)` —
> or read them from Treasury → «السلف».

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

For a schema release, take and fully validate **both** logical backups: one after writes are paused
and before migration, then another after migration and invariant checks. Validation means every
manifest entry exists, every gzip stream decompresses, every JSONL row parses, and the row totals
match the manifest. A successful command without those checks is not a verified backup.

**The schema is deliberately NOT in the backup.** It lives in `packages/db/migrations` under
checksum, in version control. A restore is therefore: empty database → `pnpm migrate` → load.

### Coordinated schema releases on Vercel + Neon

The shift-window/cash-deduction rollout established this procedure. A schema release can install
financial guards and take heavyweight PostgreSQL locks, so treat it as one coordinated maintenance
operation, not as an ordinary hot deploy:

1. On Node 24, run `pnpm check`, `pnpm build:apps`, and `node scripts/build-api.mjs`. Stage the API,
   admin, and driver artifacts without promoting them; record every current and candidate deployment
   id. Run the production read-only preflight. Record counts for `shifts`, `shift_orders`,
   `shift_media`, and `audit_log`; invariant probes must find no cross-shift wallet/order links,
   cross-branch evidence, invalid minutes/odometers, or unrecoverable open/submit boundaries.
2. Enter the maintenance block: pause **only `ash-api`** through Vercel, verify `/health` returns
   503, and wait for two consecutive zero-activity database samples. The admin and driver bundles
   may remain served, but their writes must fail while the API is paused.
3. Take and fully validate the **pre-migration** HTTPS logical backup. Never run DB conformance
   against production: its `beforeEach` deliberately truncates every application table.
4. Run exactly one HTTPS migration runner with the direct Neon **owner** connection. Migration is
   the owner's only routine application task; that credential must never be installed in Vercel.
   The runner is forward-only, advisory-locked, and checksum-enforced.
5. Run read-only postflight invariants and inspect every current shift. The API's pooled connection
   must authenticate as the least-privilege `ash_runtime` login inheriting `app_user`, never as the
   owner. Remove public scratch-space privilege and return it only to the owner:

   ```sql
   REVOKE TEMPORARY ON DATABASE neondb FROM PUBLIC;
   GRANT TEMPORARY ON DATABASE neondb TO neondb_owner;
   ```

   Verify `ash_runtime` can perform its required application work but cannot update/delete journal
   rows or create temporary tables. Permission probes must roll back their fixtures.
6. Take and fully validate the **post-migration** logical backup while `ash-api` remains paused.
7. Still inside maintenance, promote the already-built **API, admin, and driver together**. Keep
   all three old deployment ids available for code rollback; do not let either UI write through an
   old or mismatched API. If any promotion fails, keep the API paused until all three aliases are
   coherently restored to the old set or advanced to the new set.
8. Only after all three stable aliases point at one coordinated release, resume `ash-api` and
   smoke-test stable `/health` = 200, an unauthenticated protected route = 401, both front-end
   proxies and SPA fallbacks, the driver manifest, and its service worker. The API pause spans
   migration, postflight, post-backup, and all three promotions. Inspect the target live shift
   before approval; do not patch the ledger manually to manufacture a balance.
9. Restore the post-migration backup into an empty, explicitly named scratch database. Verify
   migration checksums, all row/fingerprint counts, zero trial balance, sequences, enabled triggers,
   and a write-with-rollback probe. Never use the production database as the restore target.

The migration framework is intentionally forward-only. “Rollback” here means restoring the
pre-migration Neon branch/snapshot or rebuilding an empty branch and loading the verified logical
backup, then pointing the API at it. There is no honest lossless `DOWN`: enum values, audit history,
and reconstructed attachment provenance cannot be removed and later recreated exactly. Keep the
old API deployment available for a code rollback, but restore the database when crossing this
schema boundary.

### Evidence-attachment and next-shift-funding release (`0044` — deployed 2026-08-26)

Frozen commit `5d76a539af517a914c59a455cdc8c2d3bafb4ce6` is current on API
`dpl_8s5w8kubRfYx4SLSjwuvL53JahMP`, driver `dpl_H8mXPQAUd5fjqNwSZzas6g9fACpj`, and admin
`dpl_AoziBU6U4ubjxugPRafwAVu8iUc6`. Migration 0041 routes retained cash and wallet collections to
the same `driver_shift_funding_*` funds consumed by the next open. Migration 0042 closes the
driver-entered unavailable-plus-percent battery bypass. Migration 0043 uses one visible-text rule
for attributed operation decisions. Migration 0044 makes `read_budget_exhausted` a durable terminal
OCR result.

The validated backups are:

- pre: `Desktop\ash-backups\release-0044-20260826\pre\2026-08-25T23-29-11-398Z`
  (60 tables, 6,233 rows, 40 migrations);
- post: `Desktop\ash-backups\release-0044-20260826\post\2026-08-25T23-32-12-584Z`
  (60 tables, 6,237 rows, 44 migrations);
- restore check: `Desktop\ash-backups\release-0044-20260826\restore-check\2026-08-26T08-20-20-245Z`
  (all 60 fingerprints and 6,237 rows equal to the post-backup).

The isolated restore passed all 27 sequence checks and the audited rollback probe, then the exact
scratch database was dropped. Production's only current money-integrity warning is five excluded
`unknown` orders on Thaer's submitted shift. Do not resolve those by editing timestamps or amounts:
the manager must inspect the immutable images and record an attributed include/exclude decision.

**Two of those five rows are the same deliveries twice.** The `dashboard` and `dashboard_2` photos
are two scans of one list taken while scrolling, and they overlap: `130` and `125` on the undated
page are the `22:47` and `22:21` rows already counted on the dated page. Only `130`, `280` and `270`
are new. After release `0045` the review screen says so itself, on the affected rows.

Resolving it: include `130`, `280`, `270`; exclude `130` and `125` as duplicates, each with a reason
naming the row it repeats. Expect the variance to fall from **+58,120** to **+3,720** and the
employee's settlement from **779.20** to **507.20**. Including all five instead would take it to
**405.20** — over-collecting 102.00 from the driver. Use the audited `markDuplicate` action; never
SQL.

### Pre-approved openings release (`0040` — deployed 2026-08-24)

Frozen commit `8222b6aad437e1de6df0d51999f4026808e395ab` was promoted in the coordinated order API,
driver, then admin. The stable deployments are API `dpl_HEfzBBSRd78SpB14PJuKfatPhyci`, driver
`dpl_5B2gE3LH6gDvKADzMf6ZehX5yJ65`, and admin `dpl_EyNqnL7gSKWpqcwnCZ5Zva58iqis` at
`https://ash-api-xi.vercel.app`, `https://ash-driver.vercel.app`, and
`https://ash-admin-eta.vercel.app` respectively.

The fully validated backups are:

- pre-migration: `Desktop\ash-backups\release-0040-20260824\pre\2026-08-24T14-32-31-942Z`
  (59 tables, 4,884 rows, 39 migrations);
- post-migration: `Desktop\ash-backups\release-0040-20260824\post\2026-08-24T14-37-29-598Z`
  (60 tables, 4,885 rows, 40 migrations);
- restore comparison: `Desktop\ash-backups\release-0040-20260824\restore-check\2026-08-24T14-49-09-297Z`,
  restored into `ash_release_gate_0040_restore_20260824_1748` with all 60 table fingerprints equal;
  all 27 sequences and the audited rollback probe passed before the scratch database was dropped.

### Historical durable close-draft rollout (`0034` — deployed 2026-08-17)

Migration `0034` added durable
`closeDraft` state, attachment-token-linked OCR and restoration, atomic draft materialisation, and
an explicit old-driver refusal. A linked order-read request that omits
`X-ASH-ORDERS-TIME-CONSENSUS: close-draft-v1` must receive
`428 driver_update_required`; do not work around that response by reopening the legacy reader.
The cache/reader signature also changes, so a pre-release cached OCR answer must not populate the
new draft.

Use the coordinated schema-release procedure above, with this exact application order while API
writes remain paused:

1. Build and stage API, driver, and admin artifacts; record old and candidate deployment ids. Test
   the new driver service worker, linked-read header, reload restoration, and the `428` old-client
   path on the candidate deployment.
2. Complete the read-only production preflight and validated pre-migration backup. Record every
   open and `pending_review` shift plus its current evidence slots; do not alter either named shift.
3. Apply **only** migration `0034` with the direct owner connection. Confirm the migration ledger
   checksum, new close-draft/attachment-history objects, guards, ownership, and runtime grants.
4. Run read-only postflight and take the validated post-migration backup while writes remain paused.
5. Promote the **API first**, still paused; then promote the **driver and admin** candidates. If any
   promotion fails, keep writes paused and return all aliases to one coherent set or complete the
   forward promotion. Never expose the new UI to the old API or resume an old driver against the
   new linked-reader workflow.
6. Resume writes only after all aliases are coherent. Smoke-test health/auth and both proxies; then
   verify the driver manifest/service worker, a linked OCR request, draft restore after reload, and
   that an intentionally headerless linked order read returns `428 driver_update_required` without
   creating operations.
7. Restore the post-migration backup into a named scratch database and rerun checksum, fingerprint,
   invariant, trigger, sequence, and rolled-back write probes.

Rollback before any new close draft is written may use the verified pre-migration restore path.
After a draft, attachment restoration, or final materialisation is written, do not expose the old
API as a casual code rollback: pause writes and choose a forward fix or an explicitly accepted
point-in-time database restore. Migration `0034` is forward-only.

The following are **pending post-deploy audited operations, not release smoke tests and not completed
work**:

- **Muhammad:** retrieve the restored draft and exact evidence; verify the `2026-08-16 01:18` order
  through the manager decision flow, record the reason/provenance, then obtain fresh order and
  settlement hashes. Do not approve automatically.
- **Thaer:** mark the Payments Log images in order slots as wrong-screen evidence, restore the last
  valid order attachments from attachment history (which rotates the attachment token), and rerun
  linked OCR. Confirm the 23 suspect local operations did not materialise. Do not approve
  automatically.

Use API/service actions and the audit trail only. Never repair either shift with direct SQL.

### Rolling out fixed 40% wallet/cash settlement (`0031`)

> **Historical release procedure for `0031`.** Keep it as evidence of that rollout; for every new
> schema release use the coordinated sequence above, including post-backup before promotion and
> promotion of all three surfaces before unpausing.

This is a coordinated money-policy release. It changes every shift that is not already approved,
retires tier publication, and adds immutable settlement snapshots. Deploy database, API, admin, and
driver PWA in one short write pause; do not expose an old API or old manager UI after approvals can
use the new policy.

1. On Node 24 run `pnpm check`, `pnpm build:apps`, and `node scripts/build-api.mjs`. Run the database
   suite only against a disposable PostgreSQL 17 database. Record the exact results; an earlier
   release's green output is not evidence for this one.
2. Read-only preflight production. Record all shifts by state and capture the settlement preview for
   each `pending_review` shift. Confirm no week containing a target shift is locked. Specifically
   inspect deductions for duplicate timestamps/routes and confirm Payments Log evidence is absent
   from every expected/share calculation.
3. Pause API writes and wait for two consecutive zero-activity samples. Take and fully validate the
   pre-migration logical backup. Never point adapter/conformance tests at production.
4. Apply the current migrations once with the direct owner connection. Verify migration `0031` is
   present, the settlement table/immutability guards exist, and the runtime login has only its
   intended privileges.
5. Deploy the already-tested API, admin, and driver artifacts while writes remain paused. The API
   must be live before either UI is allowed to write. Do not enable tier publication as a fallback.
6. Run read-only postflight checks, then take and validate the post-migration backup. For one
   unapproved example, independently verify the preview equations below and the direction labels;
   do **not** approve it merely as a smoke test and do not patch the ledger manually.
7. Resume writes and smoke-test health/auth plus a settlement preview. Confirm an old driver payload
   can still submit a complete end package, a non-zero variance reaches manager review, absence of a
   Payments Log image does not block it, and stale `settlementHash` is rejected safely.

```text
gross share = floor(40% × included Yallago fees) + manual-order driver shares
base share = gross share - cash deductions
variance = actual cash + actual wallet - expected total
employee settlement = base share + variance
wallet to office = full actual wallet
cash to office = actual cash - employee settlement
```

All amounts sent on the wire are decimal strings in minor units. Positive `wallet to office` means
collect the full wallet; negative means fund it. Positive `cash to office` means collect cash from
the employee; negative means pay cash to the employee. Zero means no physical movement, but the
manager must still confirm that the wallet and cash actions were checked.

After the first real approval, verify atomically that one immutable settlement snapshot exists, one
approval decision exists, the reviewed order and settlement hashes match, and the shift's driver
cash, driver wallet, share payable, and current-shift receivable balances are all zero. Variance must
not appear in `cost_center:shift_variance:*`; no new receivable may exist.

Rollback after a new-policy approval is a financial incident, not an ordinary code rollback. Pause
writes and reconcile the immutable snapshot and journal before changing versions. Restoring the
pre-migration database discards approvals made after that backup; rolling back only the UI/API risks
reintroducing daily tiers for pending shifts. Escalate and choose a ledger-preserving forward fix or
an explicitly accepted point-in-time restore.

### Order-time verification and unknown-operation exclusion (`0033`)

Release `a150380` is live with migration `0033`, the 33rd migration. For each Recent Orders image,
three independently started AI passes can supply time evidence at the same card position. A clock
is accepted only when at least two passes agree on the **literal printed time**, including the
printed AM/PM marker; only after that vote does deterministic code convert it to 24-hour time.
Disagreement, a missing marker on an ambiguous 1–12 clock, or otherwise insufficient evidence yields
`windowStatus: unknown`. Migration `0033` forces every unresolved unknown order or cash deduction
to `included = false`, so it is excluded from BR1 and fixed settlement until a manager records an
audited correction or inclusion/exclusion decision.

The order-reader cache signature changed with this logic. Answers created under old `11:*`
signatures are not eligible cache hits. A failed or partial result under the current signature gets
at most **one explicit retry**; repeated clicks must not create an unbounded paid-read path. A
manager reread uses the exact stored evidence attachment selected in the review and returns all rows
as suggestions only. It cannot mutate an operation or settlement. The separate audit event records
who requested it, why, the media id and immutable attachment token, result/usage metadata, and the
reviewed order and settlement hashes; applying any suggestion requires a separate audited action.

Release evidence: the full Node 24 gates passed, as did **69/69** database tests on real disposable
PostgreSQL 17 after all 33 migrations. The validated production backups were 53 tables / 2,993 rows /
32 migrations before maintenance and 53 / 2,994 / 33 afterward; the applied `0033` ledger checksum
was `687e773f`. The API stayed paused through migration, postflight, post-backup, and coordinated
promotion of API, admin, and driver; it was unpaused only before the final smoke tests.

### Manager procedure for approving a submitted shift

1. Resolve every `unknown`-time order or cash deduction before touching the physical handover
   confirmations. It starts outside BR1 and settlement. Correct its printed date/time or make an
   explicit include/exclude decision with the real reason; a stored-image AI reread is only a
   suggestion and never makes that decision for the manager.
2. Confirm the screen identifies the difference as **surplus**, **shortage**, or **zero** and shows
   delivery fees, fixed 40% share, manual share, cash deductions, expected, collected, variance, and
   final employee settlement.
3. Execute the displayed full-wallet action and tick its confirmation only afterward.
4. Execute exactly the displayed cash action — collect from the employee or pay the employee — and
   tick its confirmation only afterward. Do not leave share unpaid and do not convert a shortage to
   a receivable.
5. If variance is non-zero, enter the actual explanation. Payments Log evidence may be attached for
   archive, but never require it and never add its rows to today's orders or wallet.
6. Approve. If the server reports a stale settlement, reload and repeat the physical comparison;
   never reuse the old confirmations against changed orders, deductions, or declared balances.

If approval fails, show and act on the named validation issue: incomplete end evidence, unresolved
operation-window row, missing wallet confirmation, missing cash confirmation, missing variance
reason, stale settlement hash, locked week, or already-processed close. A generic “operation failed”
is not an acceptable operator diagnosis. Exceptional close is explicitly two-phase: first enter
the counted cash/wallet, odometer and reason to freeze the close boundary, without moving money or
ticking confirmations. The resulting review screen then recomputes the final settlement; only
there does the manager perform and confirm the full-wallet and cash actions. A refresh resumes that
prepared review, while an old preparation from a rejected/re-photo close cannot apply to a later
submission. Exceptional close uses the same calculation and does not provide a route around
settlement.

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

**Rehearsed again 2026-08-14** against an isolated scratch database on the live Neon project:
all **30 migrations**, **2,360 rows**, and **52 tables** were recovered. Migration/data fingerprints,
trial balance zero, sequences, enabled triggers, and the write-with-rollback probe all passed.
The target was positively identified as scratch before loading; production was never truncated.
After verification, the scratch database was dropped normally after confirming it had zero active
sessions. Local PostgreSQL test databases were dropped and the local server stopped too. Its
temporary installation root may remain on disk; that is filesystem cleanup, not a running service.

The earlier 2026-08-09 rehearsal was the one that exposed four loader defects and established the
following measured baseline:

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

**Live Windows operator custody (2026-08-14).** The runtime and Neon owner database secrets are held
outside the repository under Windows DPAPI protection. The owner credential was rotated, and the old
credential was tested and rejected through both direct and pooled endpoints. Do not copy either URL
into a ticket, chat, log, or checked-in environment file.

The only remaining credential action is a single personal-account Dashboard task: create a successor
Vercel token, verify it can reach every required project, and only then revoke the predecessor. The
token-creation API returned forbidden for automated attempts, so the existing token was deliberately
left active to avoid stranding deployment access.

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

**`OPENAI_API_KEY` / `OPENROUTER_API_KEY` (cloud OCR).** Each is read only by its own driver —
`OCR_DRIVER=openai` and `OCR_DRIVER=openrouter` respectively — and the boot refuses either
combination without its key, naming the variable an operator must actually set. Both live in the
Vercel project, never in the repo.

---

## 7a. The cloud OCR reader — turning it on, watching it, turning it off

**Turning it on** (env vars on the `ash-api` Vercel project, then redeploy):

```
OCR_DRIVER=openrouter
OPENROUTER_API_KEY=sk-or-…
OCR_MAX_READS_PER_SHIFT=15        # optional; this is the default
```

`OPENROUTER_OCR_MODEL` defaults to **google/gemini-3.7-flash** with thinking **uncapped**. Measured
over 66 real screens and 319 hand-transcribed rows, three full passes:

| reader | MISREAD | disagrees with ITSELF on money | cost/run |
| --- | --- | --- | --- |
| `google/gemini-3.7-flash` | **5** | **0 of 3 passes** | $0.180 |
| `gpt-5.4` | 26–34 | **14 of 48 images** | $0.550 |

The second column is the one that decided it. Asked the same image twice, gpt-5.4 read `-16500`
where its own other pass read `-165.50`.

**Do not cap the thinking.** `reasoning.max_tokens=256` measured 3× faster, 40% cheaper and the
*same* 5 misreads — then a second pass showed it disagreeing with itself twice in fifty images, once
tenfold. The misread COUNT hid it because both passes scored 5 on different rows. Effort and
verbosity are OpenAI-only and are not sent on this path; `temperature: 0` is what was measured.

**The revert reader**, still one env var away and still measured:

```
OCR_DRIVER=openai
OPENAI_API_KEY=sk-…
# OPENAI_OCR_MODEL / _EFFORT / _VERBOSITY default to gpt-5.4 / default / default
```

Because the provider is now part of the cache signature, **no Gemini-produced row can ever be served
to the OpenAI reader**, or the reverse.

```bash
node scripts/vision-bench.mjs --provider=openrouter --model=google/gemini-3.7-flash
node scripts/ocr-compare.mjs                 # the scoreboard; MISREAD is the only column that decides
node scripts/ocr-failures.mjs --run=<folder>  # every wrong row, with the glyphs it claims to have seen
```

**Which reader produced a row**, now unambiguous:

```sql
SELECT split_part(cache_signature, ':', 1) AS reader, count(*)
  FROM ocr_reads WHERE created_at > now() - interval '1 day' GROUP BY 1;
```

**Why a read failed** — `detail` is the field that did not exist before, and the reason it was
added. A completion truncated by its token ceiling comes back EMPTY, which is byte-identical in the
ledger to "the driver photographed a blank screen". Both are `no_fields`; only `detail` separates
them:

```sql
SELECT field, result->>'reason' AS reason, result->>'detail' AS detail, count(*)
  FROM ocr_reads
 WHERE (result->>'ok')::boolean IS NOT TRUE AND created_at > now() - interval '1 day'
 GROUP BY 1,2,3 ORDER BY 4 DESC;
```

A spike of `field='orders'` / `reason='no_fields'` whose `detail` says `ceiling orders_screen_kind`
means the 512-token classifier budget is too small for the current model. Raise
`ORDERS_SCREEN_KIND_MAX_COMPLETION_TOKENS` — noting that it is inside `cacheSignature`, so it turns
the cache over.

**TURNING IT OFF — the one thing to know at 3 a.m.** Set `OCR_DRIVER=none` in the Vercel project
and redeploy. No code change. Every read then answers `unavailable`; automatic screenshot prefill
stops and the driver retries later or enters the value manually. The phone reader can still retain
training samples, but owner decision A-31 forbids publishing its guess as money. Reach for the kill
switch if the bill runs away, the provider degrades, or a model update starts misreading. A failed
read remains a structured 200 response rather than a failed money request.

**«هل قرأها الهاتف أم الذكاء الاصطناعي؟» — which reader produced a number.**

`ocr_reads` holds one row per **cloud** read and nothing else writes to it, so it answers this
completely: a photo in the table was read by the model, a photo not in it was read by the phone.

```sql
-- Which screens the cloud read, for one shift, in Damascus time.
SELECT to_char(r.created_at AT TIME ZONE 'Asia/Damascus', 'HH24:MI') AS at,
       r.field, r.model, (r.result->>'ok') AS ok, r.latency_ms
  FROM ocr_reads r JOIN shifts s ON s.id = r.shift_id
 WHERE s.shift_no = :n AND s.business_date = :d
 ORDER BY r.created_at;
```

**The app now treats the cloud result as the automatic authority.** The phone reader may produce a
training observation, but it does not publish field values. `ocr_reads` remains the definitive
server record of the model call and its structured failure/success reason; an explicit typed value
is still the human override and the manager sees its delta from the stored cloud baseline.

For Recent Orders, “cloud authority” means the `0033` consensus rule, not one completion: three
independent passes provide time evidence, two must agree on the literal printed clock, and AM/PM is
converted deterministically only after that vote. An unresolved clock stays `unknown` and excluded
from BR1/settlement pending an audited manager decision. Old `11:*` cache signatures are invalid;
the current failed/partial image read permits one explicit retry. Rereading that same stored image
from manager review is suggestion-only and creates its own audit event—it never edits money by
itself. See §5's `0033` release section for the full control and release evidence.

**Watching the bill.** `ocr_reads` is the only cost meter that exists.

```sql
-- What it cost, by day AND BY MODEL. Grouping by model is not cosmetic: priced with one rate,
-- this query silently bills a Gemini day at OpenAI rates and reports four times the real number.
--   google/gemini-3.7-flash  $0.375 / $1.875 per 1M
--   gpt-5.4                  $2.50  / $15.00  per 1M
SELECT created_at::date AS day, model,
       count(*) AS reads,
       sum(tokens_in) AS tin, sum(tokens_out) AS tout,
       round((sum(tokens_in) * CASE WHEN model LIKE 'google/%' THEN 0.375 ELSE 2.5 END
            + sum(tokens_out) * CASE WHEN model LIKE 'google/%' THEN 1.875 ELSE 15.0 END) / 1e6, 4) AS usd
  FROM ocr_reads GROUP BY 1, 2 ORDER BY 1 DESC, 2;

-- How often it fails, and how.
SELECT field, result->>'reason' AS reason, count(*)
  FROM ocr_reads WHERE (result->>'ok')::boolean IS NOT TRUE GROUP BY 1,2 ORDER BY 3 DESC;

-- Shifts pressed against the cap: candidates for a higher ceiling, or a driver retaking photos.
SELECT shift_id, count(*) FROM ocr_reads WHERE shift_id IS NOT NULL
 GROUP BY 1 HAVING count(*) >= 15;
```

**MEASURED, 2026-09-01** — 640 real reads across 72 shifts over 11 days, from `ocr_reads` tokens at
the Vertex rate below. This supersedes the projection that follows it, which assumed 15 reads a
shift; the fleet actually averages **8.7**, and the real bill is about a third lower.

| | per shift | 10 shifts/day | 100 shifts/day |
| --- | --- | --- | --- |
| median | $0.0435 | **$13.06/month** | $130.61/month |
| mean | $0.0442 | **$13.26/month** | $132.64/month |
| p90 — plan on this | $0.0744 | **$22.32/month** | $223.20/month |

A busy full day (2026-08-27, 2026-08-28) ran $0.060–0.063 a shift, so the honest planning range at
ten shifts a day is **$13–19/month**, budgeted at **$22**. Spend follows READS, not drivers: the
worst single shift used 18 reads, and every retake and every failed read costs a whole one.

Older projection, kept because it names the price assumptions:

Budget, measured per field off `ocr_reads` at 15 reads a shift and 26 shifts a month:

| | per shift | 10 bikes | 100 bikes |
| --- | --- | --- | --- |
| `gpt-5.4` | $0.309 | **$80/month** | $804/month |
| `google/gemini-3.7-flash` | $0.076 | **$20/month** | $199/month |

Price check, **2026-08-24**: the [OpenRouter model page](https://openrouter.ai/google/gemini-3.7-flash)
lists Google Vertex at **$0.375/M input + $1.875/M output (75% promotional discount)** and Google
AI Studio at **$0.75/M + $3.75/M (50% promotional discount)**. The table above assumes the Vertex
route: `10 drivers × 26 shifts × $0.076 = $19.76/month`. If every read fell back to the currently
listed AI Studio route, the same workload would be about **$39.52/month**; at the displayed
undiscounted list price it would be about **$79.04/month**. Spend scales with completed OCR reads,
not with licensed drivers. `ocr_reads` stores model and tokens but not the selected upstream or the
provider's charged amount, so the SQL estimate is not a substitute for the OpenRouter invoice.

**Orders is 53% of that bill** — 4 pages × 4 passes = 16 model calls a shift, before anything else
runs. That is a bigger lever than the model choice, and cutting a pass needs instrumenting first:
`ocr_reads` keeps only the consensus outcome, not what each pass said.

**`maxDuration` is 60s** in `vercel.json` (raised from 30 — a measured read took 24.9s). The fetch
aborts at `OCR_TIMEOUT_MS`, default 50s, deliberately *inside* that window: set the two equal and
the socket dies at the same instant the platform gives up, turning a clean 504 into an opaque
error. If the ceiling ever changes, move the timeout with it and keep the gap.

**Privacy.** These screenshots carry real customer addresses, named businesses and metre-level GPS,
and they now leave the country. Recorded as `ASSUMPTIONS.md` A-30. The **paid** OpenAI API does not
train on submitted content by default (30-day retention for abuse review); a free tier is a
different bargain and this must not be pointed at one.

---

## 7b. Evidence uploads — telling an outage from an ordinary discard

Between 2026-08-15 and 2026-08-18 **every** evidence upload in the fleet failed to attach, and it
took three days to find because the driver saw «فشل الرفع» and nothing else did. The lesson is not
the bug (a `SELECT … FOR UPDATE` on an append-only table the runtime role may only read). The lesson
is that the obvious signal is ambiguous, so here is the unambiguous one.

**An orphaned `media` row does NOT mean an upload failed.** A blob with no `shift_media` row is the
normal residue of a **discarded shift**: `shift_media` cascades on `shifts` delete, so every photo
of a cancelled-and-deleted shift is orphaned by design. Measured 2026-08-21: of 36 orphans, only 9
came from the outage; the rest are ordinary discards.

**`shift_media_attachment_history` is the discriminator.** It is append-only (`0028` REVOKEs
UPDATE/DELETE from `app_user`) and a trigger writes it on every attach, so it survives the cascade
that removes `shift_media`. That gives a clean test:

```sql
-- For a suspect window: did the attach ever RUN?
SELECT m.created_at, m.byte_size,
       (h.id IS NOT NULL) AS attach_ran,
       (sm.id IS NOT NULL) AS still_attached
  FROM media m
  LEFT JOIN shift_media_attachment_history h ON h.media_id = m.id
  LEFT JOIN shift_media sm ON sm.media_id = m.id
 WHERE m.created_at > now() - interval '1 day'
 ORDER BY m.created_at;
```

| `attach_ran` | `still_attached` | what it means |
| --- | --- | --- |
| true | true | healthy |
| true | false | the shift was **discarded**. Ordinary. Confirm in `audit_log` |
| **false** | **false** | **the attach never ran — this is the outage shape.** Investigate now |

`audit_log` settles the middle row, because `shift_media` mutations are audited by trigger (`0028`):

```sql
SELECT occurred_at, table_name, action, record_id FROM audit_log
 WHERE occurred_at > now() - interval '1 day' AND table_name IN ('shifts', 'shift_media')
 ORDER BY occurred_at;
```

A `shifts DELETE` followed by `shift_media DELETE` rows is a driver discarding a shift. No such
pair, and no history row, means the upload died before the attachment. Grep the API logs for the
two lines added after the outage — both are real strings in `apps/api/src/app.ts`:

```
insufficient database privilege        # a 42501: the runtime role lacks a grant. THE outage's cause
refused before the handler             # a 4xx from Fastify's parser: too large, or not an image
```

**The reason it stayed hidden for three days** is worth keeping in view: the upload writes the blob
and the `media` row BEFORE the attachment, outside its transaction. Every rejected upload therefore
leaves a real, billed blob behind. That is intentional — a blob with no row is harmless garbage,
while a row with no blob is a broken evidence link a manager cannot open — but it means orphan count
grows in normal operation and cannot be read as an alarm on its own.

**Reaping orphans.** Safe, and pure housekeeping rather than a fix. Never reap inside the window you
are diagnosing: the orphan is the only trace of a rejected upload.

```sql
-- Look first. 36 rows / 4.2 MB as of 2026-08-21 — small enough that this is not urgent.
SELECT count(*), pg_size_pretty(sum(byte_size)::bigint)
  FROM media m LEFT JOIN shift_media sm ON sm.media_id = m.id
 WHERE sm.id IS NULL AND m.created_at < now() - interval '30 days';
```

Delete the blob from the store first, then the row — the opposite order leaves a blob nothing points
at. Note `media` is deduped by `(branch_id, sha256)`, so a row may be orphaned now and referenced
again later by an identical re-upload; only reap rows older than the retention window.

---

## 7c. Data health — the four questions, and the two traps

Run these before believing anything is wrong, and after any migration. Verified against production
on 2026-08-21: ledger clean (70 entries / 140 lines), no stuck reads, no dangling references.

```sql
-- 1. DOUBLE ENTRY. The invariant that must never fail.
--    TRAP: debits and credits are BOTH POSITIVE with a `side` discriminator ('D'/'C').
--    `sum(amount_minor)` therefore never reaches zero and reports EVERY entry as broken.
SELECT entry_id, sum(CASE WHEN side = 'D' THEN amount_minor ELSE -amount_minor END) AS delta
  FROM journal_lines
 GROUP BY entry_id
HAVING sum(CASE WHEN side = 'D' THEN amount_minor ELSE -amount_minor END) <> 0;   -- expect 0 rows

SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING count(DISTINCT side) < 2;  -- expect 0
SELECT count(*) FROM journal_lines WHERE amount_minor < 0;  -- expect 0; allocate() refuses negatives

-- 2. BR7. The financial week closes SUNDAY, never ISO Monday.
--    TRAP: compute the day IN POSTGRES. A DATE read into JS becomes local midnight, and
--    getUTCDay() on Asia/Damascus (UTC+3) then reports the PREVIOUS day — a Sunday reads Saturday.
SELECT week_start_date, to_char(week_start_date, 'Dy') AS day, count(*)
  FROM journal_entries GROUP BY 1, 2 ORDER BY 1 DESC;      -- every row must say Sun

-- 3. Dangling references.
SELECT count(*) FROM shift_media sm LEFT JOIN shifts s ON s.id = sm.shift_id WHERE s.id IS NULL;
SELECT count(*) FROM ocr_reads o WHERE o.shift_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = o.shift_id);

-- 4. Reads that never finished. A row stuck 'running' makes the NEXT request for the same image
--    wait out OCR_RUNNING_MAX_WAIT_MS (50s) before it can proceed.
SELECT count(*) FROM ocr_reads WHERE read_state = 'running'
   AND reserved_at < now() - interval '5 minutes';
```

**A check that fails universally is a broken check.** Both traps above were hit while writing this
section, and in each case the query reported that *every* row was wrong — 70 of 70 entries
unbalanced, every week starting on Saturday. That shape is the tell: real corruption is almost
always partial. Confirm the query before raising the alarm.

---

## 7d. A driver cannot close — what to do, and what NOT to do

**Read this before touching a stuck shift. On 2026-08-25 the wrong choice was made four times and
cost 4,325 SYP of deliveries.**

### The two overrides are not interchangeable

| | «إلغاء النوبة» (void / force-cancel) | «إغلاق قسري» (force-close) |
| --- | --- | --- |
| shift ends | `cancelled` | `approved` |
| its deliveries | **discarded — gone** | **posted and paid** |
| float / top-up | returned to the office | settled properly |
| when to use | the shift produced **no real work** | the driver worked and cannot finish the evidence |

`force-close` bypasses the BR5 evidence gate — that is its entire purpose — but it still submits the
close draft's operations (`forceCloseLocked`). It asks for cash, wallet and odometer, which the
manager may type when the driver's figures are missing.

**A driver who worked is ALWAYS a force-close.** Since the 08-25 fix the void panel names how many
deliveries it is about to discard and requires an explicit acknowledgement, but the judgement is
still yours.

### Before overriding, try this — it is usually two taps

1. **Ask the driver to tap «تحديث» if the update bar is showing.** The PWA is `registerType: 'prompt'`
   deliberately, so a phone keeps running the bundle it started the shift on. A fix deployed at
   19:50 did not reach three drivers who were still closing at 01:30.
2. **A battery the reader will not read is not a blocker.** «تطبيق البطارية لا يعمل على جهازي» hands
   that pack to the manager and lets the driver submit.
3. **A number the reader refused can simply be typed.** Manual entry always works, including after
   the per-shift read budget is spent.

### Why a close gets stuck

```sql
-- Which shifts are stuck, and how much work is inside them.
SELECT d.full_name_ar AS driver, s.state, cd.revision,
       jsonb_array_length(COALESCE(cd.payload->'operations'->'orders','[]'::jsonb)) AS orders_in_draft,
       cd.payload->'figures'->>'cashDeclared'   AS cash,
       cd.payload->'figures'->>'walletDeclared' AS wallet,
       cd.payload->'figures'->>'odometerKm'     AS odometer
  FROM shifts s
  LEFT JOIN drivers d ON d.id = s.driver_id
  LEFT JOIN shift_close_drafts cd ON cd.shift_id = s.id
 WHERE s.state IN ('open', 'suspended') ORDER BY s.open_approved_at;

-- Has the shift spent its OCR read budget? (default 40 since 2026-08-25; it was 15)
SELECT count(*) FROM ocr_reads WHERE shift_id = $1;

-- Which end photos exist, and which battery packs still have no usable reading.
SELECT sm.slot FROM shift_media sm WHERE sm.shift_id = $1 AND sm.package = 'end' ORDER BY sm.slot;
SELECT b.slot_no, r.percent, r.unavailable, r.source
  FROM batteries b
  LEFT JOIN shift_battery_readings r ON r.battery_id = b.id AND r.shift_id = $1 AND r.package = 'end'
 WHERE b.vehicle_id = (SELECT vehicle_id FROM shifts WHERE id = $1) ORDER BY b.slot_no;
```

**A draft revision in the hundreds means the autosave could not converge** — that was the 2026-08-24
signature (حيدر محمد reached 258 in thirteen minutes, one every three seconds). Since `644306a` the
fingerprint compares canonical money, so `500` and `500.00` no longer disagree forever. If you ever
see a revision climbing again, that is the bug returning and the driver's submit button is dead.

---

## 8. Known operational gaps

| Gap | Impact | Owner action |
| --- | --- | --- |
| Client samples not received | BR1 is calibrated against Yallago's arithmetic, which we do not control | Send `docs/client-request-samples.md` |
| No off-site logical/Blob copy | A laptop loss or provider-account incident can remove the independent recovery path or its evidence | Copy encrypted backups and Blob evidence to separately controlled storage |
| Full real-device QA incomplete | Smoke tests do not prove camera, offline resume, PWA update, or every Arabic layout | Exercise one complete shift on the supported phones |
| Admin security enrolment incomplete | A generated bootstrap password without TOTP is not acceptable steady state | Change passwords and enrol 2FA |
| Vercel token successor requires the personal Dashboard | Revoking the working token before a verified successor would strand deployment access | Create and test the successor in the Dashboard, then revoke the predecessor |
| Opening balances not imported | SRS §10 م-2: section E cannot go live productively without them | Before go-live |
