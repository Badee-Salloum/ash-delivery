# Deploying to Vercel + Neon

The VPS path (Docker Compose + Caddy) is in `infra/` and still works. This is the serverless
path. **Read §3 before going live — one of those points loses evidence photos if ignored.**

---

## 1. Neon

Create the project, then take **two** connection strings from the dashboard:

| Use | Which string | Why |
| --- | --- | --- |
| `DATABASE_URL` for the app | the **pooled** one (host contains `-pooler`) | Every warm Vercel instance holds its own pool. The direct endpoint exhausts Postgres under modest concurrency. |
| Migrations | the **direct** one | Migrations take an advisory lock and run DDL; a pooler can hand those statements to different backends. |

```bash
# once, and on every schema change — from CI or your laptop, never from a serverless function
DATABASE_URL='postgres://…@ep-xxx.eu-central-1.aws.neon.tech/ash?sslmode=require' \
  pnpm --filter @ash/api exec node src/migrate-cli.ts
```

Then prove the guards actually hold on Neon — they have only been proven on stock Postgres 17:

```bash
psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/verify-guards.sql
```

**If this fails on Neon, stop and tell the client before go-live.** The three claims it checks —
an unbalanced entry rejected at COMMIT, `app_user` unable to UPDATE the ledger, a locked-week
write raising `25006` — are what make the ledger trustworthy.

> Note: Neon runs a recent Postgres and supports roles, triggers and `REVOKE` normally, so this
> is expected to pass. It has not been run, so it is not yet evidence.

---

## 2. Environment variables

Set in Vercel → Project → Settings → Environment Variables.

```bash
NODE_ENV=production
DATABASE_URL=postgres://…-pooler…/ash?sslmode=require
DB_POOL_MAX=3            # small on purpose: pools multiply across warm instances

BCRYPT_ROUNDS=12
TZ_OFFSET_MINUTES=180    # Asia/Damascus, UTC+3 year-round since Oct 2022
BR1_SPLIT_GATE=advisory  # keep advisory until BR1 is calibrated — see RUNBOOK §1

BLOB_DRIVER=s3           # NOT `disk` — see §3
S3_ENDPOINT=https://…
S3_BUCKET=ash-evidence
S3_REGION=auto
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

`loadConfig()` validates all of this at boot and names the offending variable. It refuses to
start in production without `DATABASE_URL`, and refuses `BLOB_DRIVER=s3` with any S3 setting
missing — so a misconfiguration is a failed deploy, not a 500 on the first photo a driver takes.

---

## 3. Evidence photos — the one that bites

**Vercel's filesystem is ephemeral and per-invocation.** With `BLOB_DRIVER=disk`, every photo a
driver uploads is gone on the next deploy — while the ledger still records the shift as
approved and photo-documented. The audit trail would point at files that no longer exist.

`assertDurableBlobStore()` refuses to boot production on a non-durable store, so this cannot
happen silently. But it does mean **you must pick an object store before go-live.** Any
S3-compatible provider works — the client is hand-rolled SigV4 over `fetch`, no AWS SDK:

- **Cloudflare R2** — no egress fees, S3-compatible, good from Damascus
- **Backblaze B2** — cheapest storage, S3-compatible
- **Hetzner Object Storage** — same vendor as the VPS option
- Vercel Blob would need a small adapter (~40 lines against the `BlobStore` port)

Storage estimate from SRS §7: ~10 GB/year at 10 vehicles, ~100 GB at 100.

---

## 4. What does NOT run on Vercel

| Thing | Why | Where it goes instead |
| --- | --- | --- |
| Migrations | Concurrent cold starts would race; a failure would hide behind a 500 | CI deploy step, direct connection |
| Nightly backups | No cron process, and Neon holds the data | Neon's own PITR + a scheduled `pg_dump` from CI |
| The seed | Guarded to refuse production anyway | Local / staging only |

Neon's branching gives point-in-time recovery, which covers the SRS's RPO of 1 day better than
`pg_dump` alone — but **the restore must still be rehearsed and timed once** before go-live, and
the measured number written into `RUNBOOK.md`. RTO < 4 h is a requirement, not an aspiration.

---

## 5. Front-ends

Not built yet. When they are, they deploy as static builds on the same Vercel project, with
`/api/*` rewritten to the function (already configured in `vercel.json`) — so the SPA and the API
share an origin and the session cookie stays `SameSite=Lax` with no CORS.

---

## 6. Deploy checklist

- [ ] Migrations applied against the **direct** Neon URL
- [ ] `verify-guards.sql` run against Neon and green
- [ ] `BLOB_DRIVER=s3` with a real bucket, and a photo uploaded and read back
- [ ] `DATABASE_URL` is the **pooled** endpoint, `DB_POOL_MAX` small
- [ ] `BR1_SPLIT_GATE=advisory` for the pilot
- [ ] A real admin user created (the seed refuses to run in production — create the first user by hand)
- [ ] Restore rehearsed and **timed**, number written into `RUNBOOK.md`
