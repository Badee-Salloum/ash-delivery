# PROGRESS

## 2026-08-25 — five drivers could not close, and why the fix did not reach them

**On the night of 2026-08-24 five drivers finished work and could not submit their shift close.**
Four shifts were force-CANCELLED the next morning (10:35, 12:10, 12:18, 14:01), which **discards the
orders**: 1,870 SYP of امجد عبدالله's deliveries and 2,455 SYP of ثائر قدورة's are gone from the
books. محمد البلح's shift is still open with 5,250 SYP unposted.

### The root cause, and the thing that made it survive a fix

The driver types `160000`; the server canonicalises to `160000.00`. The phone compared those two
strings **as text** when deciding whether the draft was saved, so from the first successful save the
draft was dirty forever. `draftSaved` is a hard condition on the submit button — and it was the one
condition with no words anywhere on the page, because the "what is still missing" panel rendered
only when the named list was non-empty.

So a driver with a complete package saw a dead green button, an empty list, and a 12px grey
«حفظ المسودة» that never went away. That is امجد at 01:39 with thirteen photos, fifteen orders and
every figure filled in.

**The fix already existed.** `644306a` (24 Aug, 19:50) canonicalises money in the fingerprint, and
its own comment says so: *"The server accepts 500 and persists 500.00; treating those as different
keeps autosave dirty forever after a successful PATCH."* It was deployed before 01:26 — proven
independently: `bms-prompt-v2` cache signatures appear in `ocr_reads` from 01:26, and that prompt
version ships in `c33e775`, a descendant.

**It did not reach three of the four drivers, because the driver app is a PWA that updates only when
the driver taps «تحديث».** `registerType: 'prompt'` is deliberate — a money app must not swap its
code mid-shift. محمد عقيل's phone had taken the update and he closed successfully at 01:33. The
others were tapping a button whose logic lived in yesterday's JavaScript.

**A server fix is not a fix for the driver app.** That is the operational lesson, and it is now in
RUNBOOK §7d.

### What else was found on the way

- **The OCR read budget starved the readings BR5 requires.** امجد's shift spent exactly 15 — the cap
  — and read #15 was his odometer at 01:33:43, so the two BMS reads at 01:35 were refused. Four of
  those fifteen were payments-log pages, which the rules call archival and non-blocking.
- **A spent budget reported itself as `unavailable`**, whose copy says «أعد المحاولة» — while the
  retry button is hidden for it. The app told him to do the one thing it had made impossible.
- **Only the BMS read had a browser deadline.** The other four fields ran bare, so a socket that
  never settled left a `running` marker that blocks the close permanently.
- **Cash and wallet accepted «٧٠٠٠٠»** — natural on an Arabic keyboard, rejected by the ASCII money
  schema, 400ing every autosave. The odometer field had normalised digits since forever; these two
  never did.
- **A cash-deduction row the driver was not claiming still had to be priced**, though the server
  explicitly exempts exactly those rows. The client was stricter than the server it talks to.
- **The start-package gate carried the identical silent-condition flaw** (`shiftId !== null`).

### What was NOT the cause

Checked and cleared, so nobody re-opens them: the OCR provider was healthy (every BMS read ever
recorded returned OK; latency normal), the 50Ah packs read *better* than the 30Ah ones (42/43 vs
33/36), and the API was current that night. `docs/DEPLOY-VERCEL-NEON.md` was simply stale.

**Done**

- `9efd500` — the close gate is a pure module returning codes, so `ready` is that list being empty
  and the panel renders the same list. They cannot drift apart, because there is only one of them.
  Money fields normalise; an unrescuable figure names itself; excluded deduction rows stop blocking.
- `8d1e84b` — archival reads keep back a reserve, the budget default rises 15 → 40 with the five
  `?? 15` route fallbacks unified onto it, a spent budget gets its own reason and copy, every read
  gets a browser deadline, and voiding a shift now states how many deliveries it will destroy,
  names force-close as the alternative, and requires an acknowledgement.

**Next**

1. **Deploy, and make sure the drivers actually take the update.** The driver bundle is the half that
   does not arrive on its own.
2. Rescue محمد البلح's open shift (5,250 SYP) before it is voted off with the others.
3. Decide how to recover the 4,325 SYP already discarded — the close drafts still hold every order.

**Risks**

- 🔴 **A fix in the driver app reaches a phone only when its driver taps «تحديث».** Nothing here
  changes that, and it is what turned a fixed bug into a lost night. Worth a version indicator the
  branch manager can read.
- 🟠 Force-cancel is still one tap from force-close. The warning is new and untested in the field.
- 🟡 The read budget is now 40 with a reserve of 8; both numbers are judgement, not measurement.

**See it in 2 minutes**

```bash
pnpm check   # 2,123 tests, 11 expected PostgreSQL-only skips
```

Then read RUNBOOK §7d before anyone touches a stuck shift again.


## 2026-08-25 — four confirmed review findings fixed, and a fifth the fixing uncovered

An adversarial review of the 15 Codex commits (~24k insertions) produced 18 candidates. **14 were
refuted, 4 confirmed.** Fixing them found a fifth. Migrations `0041`–`0043`; nothing deployed yet.

### The one that moved money

At close a manager may defer part of the collection, and the driver keeps that cash and that Yallago
balance. The postings booked it to the **ordinary** receivable — which 0036 documents as never
auto-consumed by an open — while the next open reads only `driver_shift_funding_*`. So no carry
tranche was created, `floatTotal`/`topupTotal` omitted it, BR1 at the next close read money the
driver already owed as a **surplus**, and decision 13 assigned that surplus to the employee. The
system paid the driver his own debt, once, in full. The receivable still counted toward the capital
target, so الترميم read whole and nothing rang.

**Both channels were affected**, and it was a rename regression rather than a design:
`shifts.kept_as_receivable_minor` still carries its 0025 comment «Cleared when he opens his next
shift». 0036 moved that behaviour to the new fund names and this one posting was left behind.

The regression test that would have caught it did not exist. It does now, and it fails on the old
routing.

### The other three

- **BR5 battery evidence could be bypassed from a driver's own token.** `requiredPhotoSlots` waived
  the `bms_N` screenshot on `unavailable` alone; `batteryGaps` raised the compensating gap only
  while the percent was null. A reading carrying **both** fell between them — no photo, no gap, both
  gates satisfied, no evidence of any kind. It could not simply be refused: that is the legitimate
  shape of a pack the MANAGER read, and production holds 18 of them. The real defect was that
  `source` is recorded faithfully everywhere and then **discarded** in `batteryContext`.
- **Three definitions of «a reason was given»** — JS `.trim()`, one-argument `btrim()`, and
  `ash_has_visible_text` — disagreeing about the same column. In an Arabic-first product U+200F rides
  along in pasted text constantly and `'‏'.trim()` is truthy, so a fee could enter BR1 with an
  unreadable audit trail while the release blocker judged the same row blank and reported the
  settlement as wrong. Now one predicate, from the wire to the CHECK constraints.
- **Ten of fifteen integrity checks had never touched a query planner** — asserted only with
  `expect(sql).toContain(...)`, and the five that ran used TEMP tables typed `state text` /
  `event_type text` with no `amount_minor > 0` and no foreign keys. It was the only
  Postgres-touching test in `packages/db` that never called `migrate()`.

### What that last one immediately found

Running all fifteen against production for the first time failed a cancelled shift whose driver
cash, driver wallet, office cash and office wallet **all net to zero**, and for which the database's
own `shift_void_journals_match` returns `true`. `force_cancel_integrity` swept every `correction`
entry into the void's actual line set, so an unrelated audited wallet top-up adjustment recorded
before the cancel («تصحيح القيمة الفعلية لشحن المحفظة حسب توجيه الإدارة: 500.00 بدل 600.00») became
an unexpected line against a recipe that never described it.

So `check-shift-money-integrity.mjs` **exited 2 on a correct ledger** — which is how a release
blocker stops being read. `tranche_journal_totals` already nets exactly these adjustments; this
check was the only one that did not.

**Done**

- `0041` re-points the close matcher at the funding funds. No rollout gate: 0037 filters expected
  lines by `movement <> 0`, so a zero-deferral settlement is unaffected by the fund name, and the
  migration **refuses to apply** if a non-zero deferral is already on the ordinary funds.
- `0042` makes the battery invariant a CHECK; `0021` had left it as an index predicate.
- `0043` puts two CHECK constraints and five guard functions on `ash_has_visible_text` — 11
  occurrences, each definition otherwise byte-identical to its predecessor.
- Every integrity check now runs against the real migrated schema in CI, and a clean ledger must
  report clean.
- A failed OCR pass now says WHICH kind of nothing it got. Three of four failed production reads
  carried `reason: no_fields` with no `detail` at all, leaving "the model transcribed rows and
  verification rejected every one" indistinguishable from "the screen was blank" — the same shape as
  the upload outage.

**Verified against production, read-only (2026-08-25)**

| what | result |
| --- | --- |
| all 17 integrity checks | run, **0 violations** (was 1 false positive) |
| replacement `shift_close_journals_match` | `true` for all 4 settled shifts, agreeing with the installed one |
| deferrals already on the ordinary funds | **0** — `0041` applies cleanly |
| rows violating the new battery CHECK | **0** of 75 |
| rows violating either new reason CHECK | **0** — in fact no order or deduction has a reason yet |

**Next**

1. Apply `0041`–`0043` and deploy. Nothing is live yet.
2. Rotate the credentials pasted in that session — Neon, OpenRouter, Vercel.
3. Confirm prompt logging is off on the OpenRouter account (A-30 still records this as unconfirmed).

**Risks**

- 🟠 **The DB-gated tests could not run on this machine** — no Docker, no local Postgres, and Neon is
  TCP-geo-blocked from Damascus. 11 tests skip locally and CI is their only gate. The SQL itself was
  executed against production Postgres 17 through the HTTP driver, so the queries are known-good;
  what is unverified here is the vitest plumbing around them.
- 🟠 **`fixed_40_cash_close_v2_receivable` re-introduces the receivable decision 13 abolished**
  («No current-shift cash, wallet, share payable, or receivable may remain»). This work makes the
  feature behave correctly; whether it should exist is a product-owner question under the authority
  order in `CLAUDE.md`.
- 🟡 36 orphaned media rows (~4.2 MB) remain; RUNBOOK §7b explains why that signal is ambiguous.

**See it in 2 minutes**

```bash
pnpm check                                   # 2,101 tests, 11 PostgreSQL-only skips
node scripts/check-shift-money-integrity.mjs # exit 0 — and it no longer cries wolf
```


## 2026-08-24 — pre-approved openings, completed-shift history, and share clarification are live

**Done, verified, and deployed:** managers can publish single-use pre-approved opening rules for one
driver over explicit custom dates, an inclusive same-day time window, and exact cash-float/wallet-
top-up amounts. The driver's complete BR5 package and confirmation remain mandatory. A match runs
the ordinary manager gate and opening journal atomically, includes current shift-funding carry,
records the original author, consumes the rule once, and falls back safely to the ordinary queue
after revocation, changed authority, incomplete evidence, a race, or a posting failure. The driver
receives the opened state and approved funding in the submission response without a misleading poll
delay.

The admin console now has separate **Pre-approved shifts** and **Completed shifts** sections.
Completed history defaults to seven business dates, permits a bounded 31-date custom range, shows
`approved`/`week_locked` settlements, and keeps `cancelled` shifts visibly separate. The close
workspace now states the owner's rule that the driver share is retained/paid from returned shift
cash and never deducted from company capital. A ledger regression proves the office net equals the
company share, `driver_share_payable` clears, and no `company_box` line is posted.

The OCR budget was rechecked against OpenRouter's 2026-08-24 published rates. At the measured
`$0.076/shift`, ten drivers working 26 shifts each are **$19.76/month** on the current Vertex
promotion; the currently listed AI Studio fallback is about **$39.52**, and displayed
undiscounted list pricing would be about **$79.04** for the same workload. `RUNBOOK.md` now records
that range and that actual spend follows OCR reads rather than licensed headcount.

The local Node 24 `pnpm check` passes **2,041 tests** with the expected 11 PostgreSQL-only skips. TypeScript, domain
purity, 40-migration SQL static checks, wire-money, strippable TypeScript, bilingual parity, RTL CSS,
glyph checks, all package tests, both production frontend builds, and the API bundle pass. The
feature-specific API suite is 21/21.

The frozen release commit is `8222b6aad437e1de6df0d51999f4026808e395ab`. [CI run
32737035699](https://github.com/Badee-Salloum/ash-delivery/actions/runs/32737035699) passed all three
Node 24 jobs: static checks, unit/property tests, and the real-PostgreSQL gate. PostgreSQL 17 applied
fresh migrations `0001`–`0040`, passed every guard and the harness negative test, and passed adapter
conformance. Production migration `0040_preapproved_shift_rules.sql` is recorded with checksum
`e1d2b547`.

The validated pre-backup is
`Desktop\ash-backups\release-0040-20260824\pre\2026-08-24T14-32-31-942Z` (59 tables / 4,884 rows /
39 migrations). The validated post-backup is
`Desktop\ash-backups\release-0040-20260824\post\2026-08-24T14-37-29-598Z` (60 / 4,885 / 40). The
schema-only comparison found exactly the new `preapproved_shift_rules` table and migration row, with
all 58 existing business-table fingerprints unchanged. The post-backup was restored into isolated
database `ash_release_gate_0040_restore_20260824_1748`; its re-backup at
`Desktop\ash-backups\release-0040-20260824\restore-check\2026-08-24T14-49-09-297Z` matched all 60
table fingerprints, all 4,885 rows, and all 40 migrations. All 27 owned sequences matched
`max(column)+1` with `is_called=false`; an audited write/rollback probe left both the row and audit
count unchanged. The scratch database was then dropped and confirmed absent.

The final production audit reports zero violations across all 17 financial-integrity groups. All
three approved shifts already use `fixed_40_cash_close_v2_receivable`, so no immutable historical
settlement was rewritten; the current `cash_deductions` table is empty. API, driver, admin, and both
frontend API proxies are healthy, while the unauthenticated `/me` boundary returns the expected
`401`.

The stable Vercel deployments are API `dpl_HEfzBBSRd78SpB14PJuKfatPhyci`, driver
`dpl_5B2gE3LH6gDvKADzMf6ZehX5yJ65`, and admin `dpl_EyNqnL7gSKWpqcwnCZ5Zva58iqis` at
`https://ash-api-xi.vercel.app`, `https://ash-driver.vercel.app`, and
`https://ash-admin-eta.vercel.app`.

**Next:** exercise the first real pre-approved opening and completed-history review through the
ordinary audited workflow; no production transaction was fabricated for release evidence.

**Risk:** OpenRouter's displayed rates are promotional and its routed alias may use a differently
priced upstream; the provider invoice remains the billing authority.

**See it in 2 minutes:** sign in as a branch manager, open **Pre-approved shifts**, select a driver,
today, a window containing the current branch time, and funding amounts. On the driver's phone,
submit the complete start package; it opens immediately and the rule becomes **Used**. In admin,
open **Completed shifts**, choose a recent range, and open any approved row. The settlement panel
shows that the driver's share comes from returned shift money, not company capital.

## 2026-08-23 — receivables/restoration release `0039` is live

The complete same-day release is live from frozen application commit
`1407676b9802382b926b9b4f07f59636cb0ea0ee`. It adds two dashboard KPIs backed by the lightweight
branch-scoped exact-`open` query; zero cash/wallet openings; retry-safe mid-shift tranches; range-safe
settlement writes; inclusive profit ranges; optional user variance text with a deterministic audit
marker; and driver handoff despite money mismatch or incomplete end-battery evidence.

The finance expansion adds ordinary and shift-funding receivables for cash and wallet, direct entry
against a driver without a shift, automatic shift-funding carry into the next approved shift,
receivable-aware settlement and restoration, atomic expense/restoration guards, and editable office
cash/wallet targets. The live effective targets are SYP 50,000 cash and SYP 10,000 wallet.

The release gate ran on Node `24.19.0`. Frozen `pnpm check` passed 1,998 tests with 11 expected
PostgreSQL-only skips; a fresh disposable database ran 27/27 test files and passed 141/141 with zero
skips. Both frontend builds, the API bundle, and the Vercel production builds passed. Migrations
applied in order and their immediate rerun found 0 pending / 39 present:

- `0036_receivable_ledger_event.sql` — `adbfc150`
- `0037_receivable_settlement_and_events.sql` — `5fdf1556`
- `0038_restoration_atomicity_guards.sql` — `b2dd47f0`
- `0039_editable_office_capital_targets.sql` — `ec71e10c`

Production writes were paused through the provider API and drained to two zero-activity samples.
The pre-backup contains 58 tables / 3,994 rows / 35 migrations with aggregate SHA-256
`dd0e904a228d1022df80e1d5f75b01bec79c829a884154042f6b41ca2a3f7103`. After applying the four
migrations, runtime guard probes rejected journal mutation, temporary-table creation, and an
unaudited target edit. The post-backup contains 59 tables / 4,002 rows / 39 migrations with
aggregate SHA-256 `be8dc82f07b645edcc0463adc43a3ae2588791848dd9da52bde36786ad732a20`.

Artifacts were promoted while writes remained paused, in order: API
`dpl_826jbAVvqCetjgVtGihgCX4Kp16b`, driver `dpl_4YKqcBfCKkHXLr6oggduwx9P5VDE`, then admin
`dpl_6y6NJLBuRy2x73hZ4kqfTykNv1sZ`. After resume, health/auth/proxy/PWA/protected-route smokes and
exact 390×844 driver plus 1024×768 admin browser checks passed. Final production is schema 39/head
0039, working `0/0`, zero active shifts, zero trial-balance difference, and zero violations across
all 17 shift-money integrity checks. No historical live-ledger row was rewritten.

The post-backup was restored completely into isolated Neon database
`ash_restore_0039_20260823_1337`. All 59 table fingerprints and 4,002 rows matched, all 27 sequences
were safe, all user triggers were enabled, and the trial balance and 17-check integrity audit were
zero. The rehearsal exposed a restore-runner performance defect: the old sequence loop made 652
HTTPS requests and could stop partway. The checked-in helper reduces that to one catalog query plus
one reset statement and adds five regressions; current-HEAD `pnpm check` passes 2,003 tests. After
Neon naturally expired all idle rehearsal sessions, the exact scratch database was dropped and
confirmed absent.

The remaining release acceptance is the next normal staff shift. Record the existing `0/0`
baseline, prove `+1/+1` within eight seconds while open and reversal on end submission, independently
recalculate fixed 40%, then verify exactly one immutable settlement, one decision, matching hashes,
balanced journals, and zero residual shift balances. No demo transaction will be written to
production for this evidence.

## 2026-08-23 — battery-close hang hotfix is live

Thaer's end-BMS incident had two independent, read-only-confirmed facts. The close-draft OCR had
saved 47% remaining charge and 36 cycles, but the per-pack end reading was still
null/`unavailable` because the linked read response/persist lifecycle stalled. The close draft
otherwise held complete declared values, but it also retained an
excluded, unpriced OCR ghost; the old money-completeness check wrongly treated that evidence-only
row as a financial operation and refused close materialization.

Three commits address those exact failures:

- `cee0fca` gives the API an outer BMS lifecycle deadline, propagates abort to the provider adapter,
  and durably resolves a stalled read as timeout before the platform kills the request.
- `0699581` keeps excluded null-money OCR rows as draft evidence, omits null-money rows from final
  operation materialization, and treats a null amount as incomplete only when that row is included.
- `512b6bf` bounds the driver's linked-read task, adds an immediate “continue manually” action,
  forwards cancellation through the linked read and battery persistence calls, restores only its
  own local pending marker, and ignores late results without deleting the accepted photo.

The API fixes are live at `dpl_4jybXd5p791i9JpEEF2orikiz3cW`. Driver preview
`dpl_DYt4hwQX7G4WxKaTyd6skhjSgjZA` was promoted, and the resulting driver production deployment is
`dpl_DmFY6NfdgX4fUcPtNv8VZP9ppphh`. Stable driver index, manifest, service worker, and API proxy all
returned 200. Production HTML and the service-worker cache both name the new driver asset
`index-2arO8j3S.js`.

The full gate ran under Node `24.19.0`: domain 425, contracts 12, client 257, admin 93, driver 263,
adapters 121, and API 649 passed. The local database package passed 63 and skipped 8 because
`DATABASE_URL` was absent. Both frontend builds and the API bundle passed. There is no database code
or migration in this hotfix, so the previous real disposable-PostgreSQL evidence remains 108/108;
it was not rerun or presented as new evidence. A read-only production database recheck after deploy
could not complete because the local Neon connection ended with `ECONNRESET`. The public smokes
remained green, so this is recorded as an unavailable database recheck, not an application-health
failure.

This entry records deployed code and smokes only. Thaer's live shift is **not** recorded as closed,
and the existing null/`unavailable` per-pack end row is **not** recorded as repaired. Completion and
manager settlement still require the ordinary audited production workflow.

## 2026-08-23 — `0035` is live

The coordinated Vercel + Neon release completed from frozen commit `6389816`. API writes paused and
drained to two zero-activity samples while the two real open shifts remained intact. The validated
pre-backup contains 58 tables / 3,852 rows / 34 migrations. Only
`0035_shift_money_integrity.sql` applied (FNV `087c01d4`), and the immediate rerun found 0 pending /
all 35 present. Postflight preserved exactly the three owner-accepted cancelled-shift exceptions and
found no other integrity violation; runtime cannot update/delete journal rows or create temp tables.
The validated post-backup contains 58 tables / 3,853 rows / 35 migrations.

All stable aliases were promoted while the API remained paused, in the required order—API first,
then driver and admin: API
`dpl_9DnbaiswA4bPP1bCEJ8H2eLi4Fub`, driver `dpl_GzB3CyzkjEFBeYyP1WaHQwZYHccw`, admin
`dpl_9d5Zp8QHMwuKiUB5SxJXgR5xWvpw`. After resume, health/auth, both frontend proxies and SPA
fallbacks, the protected working-count route, manifest, service worker, and exact production asset
hashes passed: admin `index-DGhFwpyp.js`, driver `index-Z4O4ZOFe.js`. Production reports two
distinct working drivers and two working vehicles.

The post-backup was restored into the explicitly named local disposable database
`ash_restore_0035_post_20260823_0849`. All 58 table fingerprints and 3,853 rows matched, all 27
sequences were positioned safely, no trigger remained disabled, journals balanced, and a rolled-back
write probe left no object. Because the checked-in restore utility targets Neon HTTP, this localhost
rehearsal used a temporary out-of-repository `pg` adapter; adding a portable checked-in local mode is
deferred. The scratch database was dropped and its PostgreSQL server stopped. The next required
evidence is the real-staff close of the two open shifts; no transaction was fabricated.

## 2026-08-23 — `0035` rollout authorized with an explicit historical exception

The read-only production checker was rerun at 08:07 Damascus: 13 checks were clean and the same
three cancelled 2026-08-11 shifts retained the previously confirmed exact 100× tranche/journal
history. At 08:21 the owner explicitly directed the release to proceed while grandfathering exactly
those three cancelled shifts. This is a deployment exception, not a ledger rewrite: the records
remain unchanged, the checker continues to report them, and any new or different discrepancy still
stops the rollout. The exact accepted shift IDs are
`0df7c7f1-105c-40b3-97ec-3fc81f83874c`, `f51cd7a1-ffa5-4e72-b0e4-a1761531b11b`, and
`b81ad711-835b-479a-8ee1-37105ca96c21`. Vercel project access was restored for the coordinated
release.

## 2026-08-23 — driver can finish despite mismatch or missing end-battery evidence

Driver handoff and manager approval are now deliberately separate gates. A non-zero BR1 result was
already allowed to reach `pending_review`; the driver UI now labels it as a manager-review warning
instead of suggesting that it blocks submission. Missing/incomplete end-of-shift BMS pictures or
readings also no longer keep the driver clocked in.

The current driver sends `deferMissingBatteryEvidenceToManager: true`. Inside the close transaction,
the API preserves every fitted pack whose percentage belongs to its current `bms_N` attachment and
converts only incomplete packs to the existing `unavailable: true`, null-reading manager obligation.
The shift then moves to `pending_review`, so working driver/vehicle counts fall immediately. Ordinary
manager approval still refuses until the manager records each deferred reading. A money difference
still requires the immutable fixed-40% settlement, physical confirmations, and a visible variance
reason. Other end requirements—dashboard/wallet/odometer evidence and values, valid operations,
confirmed order rows, current draft hash, stale-evidence acknowledgement, and odometer anomaly
confirmation—remain blocking.

The driver shows an amber list for money and battery issues and changes the CTA to “Finish and send
for review” / “إنهاء وإرسال للمراجعة”. Manager copy now accurately says driver battery evidence was
incomplete instead of always claiming the phone application failed.

Final Node 24 gate: **1,916/1,916** tests (425 domain + 12 contracts + 256 client + 93 admin + 256
driver + 119 adapters + 108 real-PostgreSQL DB + 647 API), zero DB skips. The combined API regression
proves `1/1 → 0/0` working counts on a mismatched close with one complete pack and one missing BMS
photo, preserves the complete pack, blocks manager approval, then succeeds after the manager supplies
the deferred reading. Driver/admin production builds and the API bundle passed. At that checkpoint
the source was still undeployed; the later rollout entry above records its promotion.

## 2026-08-23 — working-count and shift-close candidate green; production blocked by preflight

The release candidate implements the full dashboard/shift-money plan:

- `GET /dashboard/working-now` counts distinct drivers and vehicles from exactly `state = 'open'`,
  branch-scoped and date-independent. The admin dashboard adds localized cards after Orders and
  polls only this endpoint every 7.75 seconds, refreshes on branch changes, preserves the last good
  values on failure, and exposes a stale state instead of a false zero.
- Zero opening float/top-up now means no tranches; every supplied opening/carried/top-up tranche is
  strictly positive. Mid-shift event keys are mandatory (`428 admin_update_required`), exact and
  concurrent retries are idempotent, and conflicting reuse is `409 idempotency_key_conflict`.
- Aggregate money writes fail as named 422 errors before PostgreSQL overflow. Settlement variance
  requires visible reasons, force-cancel decisions are transactional/immutable, and dashboard
  profit ranges are inclusive across weeks with driver share reported net of cash deductions but
  before variance.
- Migration `0035` installs the variance guard and partial open-shift branch index. The permanent
  read-only checker covers 14 settlement, double-entry, tranche/journal, approval, operation,
  close-draft/hash, and residual-balance invariants. The demo seed now follows the modern fixed-40%
  shift lifecycle and is idempotent.

Final isolated evidence: Node `24.19.0`, pnpm `11.3.0`, PostgreSQL `17.11`; frozen install; full
`pnpm check` **1,916/1,916** (425 domain + 12 contracts + 256 client + 93 admin + 256 driver + 119
adapters + 108 real-PostgreSQL DB + 647 API), zero DB skips; both frontend builds and the API bundle
green. Fresh `0001`–`0035` was 35/35 and its checksum rerun was 0 applied/all 35 present. `0035` is
FNV `087c01d4`, SHA-256
`D3958FCABB4886E390DBCD969E8BFA1241265A8CA661A843C80FA51176ECEF40`. A twice-seeded disposable
database passed all 14 integrity checks.

Focused browser acceptance passed English/Arabic at 390/768/1280 px: grid 2/3/6 columns, no
overflow or page errors, `0/0 → 1/1` in 7,516 ms, failed refresh visibly stale while retaining
`1/1`, recovery in 7,693 ms, and end submission `1/1 → 0/0` in 7,786 ms before approval. Seven
lightweight count requests caused no periodic financial-data reload.

At that candidate checkpoint production was not changed. The mandatory read-only checker, run at
2026-08-23 01:07 Damascus,
found three cancelled 2026-08-11 shifts with `300,000`/`30,000` minor-unit tranches but
`30,000,000`/`3,000,000` journal events—exactly 100×. A validated local backup independently
confirmed the history. This violates the tranche/journal invariant and blocks promotion by policy;
there was no automatic repair, migration, deploy, or fabricated live transaction. The later rollout
entry above records the owner exception and successful deployment; the real-staff audit is pending.

## 2026-08-22 — the Gemini reader is LIVE (`dpl_6Rknpd6`)

`OCR_DRIVER=openrouter`, `google/gemini-3.7-flash`, thinking uncapped. The entry below said
"shipped INERT"; this is the flip, and it is deployment evidence rather than intent.

**The pre-flight ran first, and it changed the code.** `ocr-adapter-bench.mjs` against real orders
screens through the SHIPPED adapter:

| pass | max out / ceiling | max ms / budget | ceiling hits |
| --- | --- | --- | --- |
| `orders:screen-kind` | 108 / 512 (21%) | 7,646 / 12,000 | 0 |
| `orders:money` | 2,894 / 4,096 (**71%**) | 4,277 / 30,000 | 0 |
| `orders:time` | 1,417 / 2,048 (**69%**) | 5,317 / 24,000 | 0 |
| `orders:route` | 1,791 / 8,192 (22%) | 6,628 / 44,000 | 0 |

The feared failure does not occur — screen-kind uses a fifth of its budget, so the exhaustion that
would have failed EVERY orders read while looking like a blank screen is not a live risk. But money
and time sat near 70% of ceilings sized for gpt-5.4, because this reader emits ~3.6x the output.
Both were raised to ~2.8x the measured worst case (`0a33051`) **in the same deploy**, because they
live inside `cacheSignature`.

Gate 11 separately proved the ceiling is honoured at all: forced to `max_tokens: 16`, OpenRouter
returned `finish_reason: 'length'` at 12 tokens out. It does not silently ignore the field.

**Verified after deploy:** `/health` 200 — which is not a formality here, because `loadConfig`
throws at boot when `OCR_DRIVER=openrouter` has no `OPENROUTER_API_KEY`. A 200 proves both.

**Not yet verified:** a real driver read. Confirm with the first one —

```sql
SELECT split_part(cache_signature, ':', 1) AS reader, model, count(*)
  FROM ocr_reads WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;
```

Rows should read `openrouter@openrouter.ai` / `google/gemini-3.7-flash`.

**Risks**

- 🔴 **The OpenRouter balance is $0.087 — about ONE shift.** When it empties, every cloud read
  answers `unavailable` and drivers type every number by hand. Degraded, visible, not blocked, and
  the `detail` field will name it. **Top up before the next shift.**
- 🟠 The pre-flight measured 4 orders screens, not the full corpus, because the balance would not
  cover more. Gate 1 has wide margin; the money ceiling now has ~2.8x headroom rather than measured
  proof across 66 images.
- 🟠 Account-level prompt logging on OpenRouter is still unconfirmed (A-30). The request-level
  `data_collection: 'deny'` is verified and in force.

**Revert**, in order of blast radius:

```
OCR_DRIVER=none          # kill switch: no cloud reads at all, drivers type
OCR_DRIVER=openai        # back to gpt-5.4; OPENAI_API_KEY was deliberately left in place
```

Neither needs a code change. The provider is part of the cache signature, so no Gemini-produced row
can ever be served to the OpenAI reader, or the reverse.


## 2026-08-21 — a second OCR provider, shipped INERT; and the evidence-upload outage closed out

Two threads. Neither has changed what production reads with yet.

### The upload outage, and what it cost to find

Between **2026-08-15T23:02Z and 2026-08-18T18:43Z every evidence upload in the fleet failed to
attach.** Blob written, `media` row written, `shift_media` row never created — so drivers could not
start or close a shift, and the screen said «فشل الرفع» and nothing else did.

The cause was one line: `latestAttachmentForMedia(id, { lock: true })` issued
`SELECT … FOR UPDATE` against `shift_media_attachment_history`, which `0028` deliberately makes
append-only by REVOKEing UPDATE from `app_user`. Postgres answered `42501`, which was not a
`ServiceError`, so it became an anonymous 500. Fixed in `f81d8bf`; verified live the same evening.

**It took three days because nothing could name it.** Three layers independently collapsed every
distinct cause into the same nine Arabic words, and there is still no table that records a failed
upload. That is the real defect, and it is the one worth remembering.

Closed out since:

- `863c94b` — a 4xx from Fastify's parser keeps its status; a `42501` gets a named log line.
- `e3da8fc` — an upload the server ACCEPTED is no longer silently dropped when the driver picks a
  second photo mid-flight. `planAcceptedUpload` splits the three questions that were conflated:
  the attachment is a fact and is always reported, while owning the tile and advancing the
  close-draft revision belong to the newest selection only.
- `2614466` — RUNBOOK §7b: **an orphaned blob is not an outage.** `shift_media` cascades on shift
  delete, so every photo of a discarded shift is orphaned by design — measured 2026-08-21, 36
  orphans of which only 9 were the outage. `shift_media_attachment_history` is append-only and
  survives the cascade, which makes it the discriminator.

### The OCR reader: measured, chosen, and NOT yet switched on

66 real screens, 319 hand-transcribed rows, three full passes per candidate, 20 runs over 17 models:

| reader | MISREAD | disagrees with ITSELF on money | cost/run |
| --- | --- | --- | --- |
| `google/gemini-3.7-flash` (uncapped) | **5** | **0 of 3 passes** | $0.180 |
| `gpt-5.4` — what production runs | 26–34 | **14 of 48 images** | $0.550 |

The misread column is five to one; the column that decided it is the second. Asked the same image
twice, gpt-5.4 read `-16500` where its own other pass read `-165.50`. A reader that changes its
mind puts a number in the ledger that depends on which second the request fired — and BR1 balances a
wrong fee against itself, so nobody ever finds it.

Two results worth keeping because they are counter-intuitive:

- **Capping the thinking budget is NOT free.** `reasoning.max_tokens=256` measured 3× faster, 40%
  cheaper and the *same* 5 misreads — then a second pass showed it disagreeing with itself twice in
  fifty images, once tenfold. The misread COUNT hid it, because both passes scored 5 on different
  rows. One measurement is not a measurement.
- **The pro tier is worse and dearer** (`3.1-pro` 10 misreads at $0.617, `2.5-pro` 24 at $0.460),
  and every model under $0.15/1M landed at 26+. Cheap per token is not cheap per correct answer.

`8ba2007` ships the provider as `OCR_DRIVER=openrouter`, **inert**. It also had to fix a signature
that lied: `cacheSignature` began with the literal string `openai` and never included the endpoint,
so two providers on the same model name were indistinguishable in `ocr_reads.cache_signature` and a
swap — or the revert — could have served the other one's rows.

**Done**

- Multi-provider Chat Completions adapter, provider-derived cache signature, per-provider request
  body (`max_tokens` vs `max_completion_tokens`, `temperature: 0`, `data_collection: 'deny'`).
- Failed passes now carry a redacted `detail` into `ocr_reads.result`, which distinguishes a
  completion truncated by its token ceiling from a screen that genuinely had nothing on it. Both
  are `no_fields`; only `detail` separates them.
- OCR config tests, which did not exist at all — not the key guard, not the model defaults.
- `4dc76ca` — four defects a self-review found in the above, including an alert that fired on the
  happy path and a superseded-upload fix that was unsafe for `BatteryPanel`.

**Next**

1. **Phase 2 pre-flight, and it can still say no.** The 5-vs-26 result came from batched requests
   under a 32,768 ceiling; production sends four single-image calls under 512/4,096/2,048/8,192.
   `scripts/ocr-adapter-bench.mjs` must measure the SHIPPED class against twelve gates. Gate 1 is
   screen-kind output ≤307 tokens: if that 512 ceiling exhausts, the completion returns empty and
   **every orders read fails while looking like a blank screen**.
2. Then, and only then, `OCR_DRIVER=openrouter` — one env var, no deploy.

**Risks**

- 🔴 **The measurement does not cover the shipped code path.** See Next 1. Nothing flips until it does.
- 🟠 **The model-selection runs sent 66 real driver screenshots — customer addresses, named
  businesses, metre-level GPS — WITHOUT `data_collection: 'deny'`**, because the bench did not send
  it until `4dc76ca`. Already-sent data cannot be recalled. A-30 is rewritten to describe the real
  path; the account-level logging setting is the owner's to disable.
- 🟠 **`google/gemini-3.7-flash` is a routed alias, not a pinned endpoint.** Upstreams can differ in
  quantisation, latency and retention. A measurement against a broker alias has a shorter shelf life
  than one against a first-party model id.
- 🟡 **Orders is 53% of the OCR bill** — 4 pages × 4 passes = 16 model calls a shift. A bigger lever
  than the model choice, but `ocr_reads` keeps only the consensus outcome, so whether the 4th pass
  earns its keep cannot be answered without instrumenting it first.
- 🟡 Still no table records a failed upload. The orphaned `media` row is the only trace, and §7b now
  explains why that signal is ambiguous.

**See it in 2 minutes**

```bash
pnpm check                                        # 1,763 tests, all green
node -e "import('./apps/api/src/config.ts')"       # OCR_DRIVER: none | openai | openrouter
```

Then in `psql`: `SELECT split_part(cache_signature,':',1) AS reader, count(*) FROM ocr_reads
GROUP BY 1;` — every row is now self-describing about which provider produced it.


## 2026-08-17 — the staged close-draft release is LIVE (migration `0034`)

The candidate described in the entry below was reviewed, committed as `afbb31d`, and promoted. This
is deployment evidence, which the previous entry was careful to say it was not.

**Reviewed before it was trusted.** The candidate arrived as 95 uncommitted files written in an
earlier session. Three things were checked rather than taken on the author's word:

- **`0034` is the most conservative migration in the `0028`–`0034` range.** No `DROP TABLE`, no
  `DROP COLUMN`, no `DELETE`, no `ALTER COLUMN … TYPE`, no bare `NOT NULL`, and **zero
  migration-time DML** — every `UPDATE`/`INSERT` in the file lives inside a function body. Its new
  guards were checked against existing rows: `window_basis IS NULL` and
  `close_draft_review_reasons = '[]'` short-circuit every branch, so legacy rows classify exactly
  as they did under `0033`. The row count afterwards proved it: 3,303 → 3,304, the one new row
  being the migration ledger entry itself.
- **The RBAC skip on the materialisation path is unreachable from the wire.** `submitOperations`
  bypasses the `shift.operate` check when `internal.canonicalCloseDraft` is set; every caller was
  traced. The route passes four arguments and never sets it, the only setter is
  `shifts.service.ts:1897` on the server-internal path, and the DB trigger
  `close_draft_materialized_operation_valid` re-checks driver ownership on INSERT independently.
- **The money maths is unchanged.** `packages/domain` verified: the 80% block is still a residual,
  rounding still lands on the company, and the settlement identity is enforced at runtime — 424/424
  domain tests, `canonical.test.ts` byte-unchanged.

**The release, in order.** Backup → migrate → API → driver → admin, which is the RUNBOOK's sequence
and not negotiable: an earlier deploy in this project inverted it and left two minutes where the API
named columns that did not exist.

| step | evidence |
| --- | --- |
| preflight | 53 tables · 3,303 rows · 33 migrations · `0033` checksum `687e773f` |
| pre-backup | `Desktop\ash-backups\2026-08-17-pre-0034` — 53 tables, 3,303 rows |
| migrate | `0034` applied, checksum **`5bc30a31`** — matches the documented disposable-gate value |
| idempotency | immediate re-run: `0 applied, 34 already present` |
| postflight | 58 tables · 3,304 rows · all five close-draft objects present · shifts untouched |
| post-backup | `Desktop\ash-backups\2026-08-17-post-0034` — 58 tables, 3,304 rows |
| API | `ash-api-xi` · `/health` 200 · `/fx` 401 · region `iad1` |
| driver · admin | both 200; both `/api` proxies reach the new API |

**Why now was the right window.** Production held **zero `open` shifts** — 13 cancelled, one
`draft`, one `pending_review`. That matters because `0034` is a deliberate breaking change:
`PUT /shifts/:id/media/end/:slot` answers **`428 driver_update_required`** without the close-draft
revision header, so a driver on an old PWA bundle cannot upload closing evidence until his app
updates. With nobody mid-shift, nobody could be stranded.

**Known and accepted at promotion time:**

- The candidate's DB gate ran on PostgreSQL **17.11**; production Neon is **18.4**. That gap was
  accepted rather than closed, with the pre-migration backup as the net. `0034` applied cleanly on
  18.4 and postflight was exact, so the gap is now closed by observation rather than by test.
- Both the settlement and orders hashes changed format. A manager holding an already-loaded review
  of the `pending_review` shift will get `409 settlement_changed_since_review` and must reload.
  Fail-safe direction, but it will happen.
- `0034` is **forward-only**. Rollback before any close draft is written is the pre-migration
  restore; after one is written it is a forward fix.

**Still owed, and deliberately not folded into this release:** the Muhammad `01:18` order
verification and the Thaer wrong-screen attachment recovery. Both are audited API operations, never
direct SQL, and neither shift may be auto-approved.

**Next:** the fixed-settlement path has still never executed against a real shift in production —
the one `pending_review` shift is the first opportunity to verify a real immutable receipt and
zeroed driver funds.

## 2026-08-16 — durable close draft staged, not deployed

The source head now contains migration `0034` and the coordinated application changes for a
durable server-side shift-close draft. Attachments, upload/read attempts, incomplete operations,
manual edits, figures, and readiness survive navigation or reload; OCR is linked to the current
attachment token, and replacing or restoring an attachment rotates identity so a stale read cannot
land on a newer image. Final submission identifies the exact draft revision/hash and materialises
the draft atomically with the close package. BR1 and settlement equations are unchanged.

The linked Recent Orders reader now requires the new client protocol. A request without
`X-ASH-ORDERS-TIME-CONSENSUS: close-draft-v1` is refused with
`428 driver_update_required`, and the reader/cache signature changed so an older cached result is
not eligible for this flow. The driver keeps upload and read state separate, restores its durable
draft after return/reload, and uses a local outbox only until the server accepts an attachment or
edit. The admin review retains explicit source and manager-decision provenance.

**Release state:** staged and unpublished. Production Neon and all stable Vercel aliases remain on
the validated `0033` baseline described in the historical records below. No production migration,
deployment, or live Muhammad/Thaer remediation occurred during implementation or verification.
The release must run as one paused-write maintenance operation: validate the pre-backup, apply
`0034`, run postflight, promote the API first, then promote driver/admin, and resume writes only
after all three stable aliases are coherent.

Final database evidence used Node `24.19.0` and PostgreSQL `17.11`. A fresh database applied
`0001`–`0034` (`34/34`), the checksum rerun reported `0 applied / 34 present`, every SQL guard
passed, and the full real-PostgreSQL `@ash/db` gate passed **76/76** tests across 15 files.
Migration `0034` had ledger checksum `5bc30a31` and file SHA-256
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`. Two no-shim API
reproductions on real PostgreSQL passed: ordinary submit and manager force-prepare both preserved
the `created_by=manager` owner of an order that existed before the draft and assigned its canonical
`legacy:order:<orderId>` draft key.

Post-deploy handling of the two named shifts remains pending. Muhammad's `01:18` order must be
verified and saved through the audited manager decision flow before recalculating hashes and
settlement. Thaer's wrong-screen attachments must be invalidated, the last valid order attachments
restored from attachment history, and linked OCR rerun; the 23 suspect local rows must not be
accepted by assumption. Neither shift may be auto-approved, and neither may be repaired with direct
SQL.

---

## 2026-08-15 — branch treasury clarity deployed

The branch treasury now separates the physical-count variance (`counted − system balance`) from
the capital variance (`counted + receivables − target`). Cash and wallet each show the
frozen system balance, counted value, explicit surplus/shortage direction, absolute amount, and the
audited explanation. A non-zero count cannot be sealed without its own server-validated reason,
and the complete sealed result is restored after refresh.

The restoration card keeps cash and wallet legs visible independently, uses directional transfer
copy without negative display amounts, and shows the live current position, target, and capital
surplus/shortage. After execution it reloads the post-action ledger position immediately and uses
`alreadyRestored` to prevent a fresh-looking replay. The Excel acceptance examples are encoded in
tests: `6,102,152 − 5,000,000 = 1,102,152` capital surplus, and corrected kaish
`9,582,553 − 504,322 = 9,078,231` while shahn remains separately classified.

The management dashboard now labels company revenue as “company share before expenses” and shows
the signed capital delta. Company-fund data is neither requested nor rendered for branch managers.
Reversals preserve `kaish`/`shahn` line roles; historical `reversal-of-<entryId>` corrections are
also netted into the original movement category without a database migration. This deliberately
does not add the spreadsheet's historical `177,000` reconciliation report.

Release state: commit `d7b6643` is live. Node 24 `pnpm check` passed, including API **566**, domain
**424**, client **248**, adapters **98**, and the existing DB static suite. A disposable PostgreSQL
17.11 run passed the full DB suite **70/70**, including a real `kaish` line-role round trip. The
final admin suite passed **53/53** and its production build passed. This was a code-only release:
there was no migration, production database write, or driver deployment.

The stable aliases now point to API deployment `dpl_3QkzHvaJ1ijymQWE2oZU8PQzqQXE` and admin
deployment `dpl_8n3sLrMGjF7FQj7EVAhqbbhCM86W`; driver remains on
`dpl_6JVSMPr1ofVwnYhvYJYncygAFpia`. Stable API health and both admin routes/proxies returned `200`,
protected API routes returned `401`, and the promoted bundle contains the new capital, funding,
company-share, and count-reason copy. The only build note is the existing Vite bundle-size warning.

See it in two minutes: open «خزينة الفرع», enter matching and differing cash/wallet counts, confirm
that a reason is required only for each difference, then preview a mixed-leg restoration and verify
that both directions remain visible. After executing in a disposable environment, refresh and
confirm the current position is at target and the action cannot be repeated.

---

## 2026-08-15 — verified order times and focused close review deployed

Commit `a150380` is live. Recent Orders now uses a three-pass AI consensus for printed dates and
times, including the literal AM/PM marker on the image. A disagreement is recorded as `unknown`
rather than guessed. Migration `0033` makes that uncertainty financially safe: an unknown-time
operation is excluded until a manager records an audited decision. The corrected incident replay
contains **six included orders totalling `1,570.00` and one excluded duplicate** — not the earlier
reduced five-row `1,415` fixture.

The close workspace now puts evidence thumbnails beside the operations that need attention. A
manager can reread the exact stored Recent Orders image without asking the driver to upload it
again; the result is a suggestion only and does not enter accounting until the manager saves the
audited correction or inclusion decision.

Release evidence: the complete Node 24 check passed with domain **423**, contracts **10**, shared
client **247**, driver **241**, admin **42**, adapters **97**, and API **558** tests. The static DB
run passed **31** with **5** environment-gated skips, and a real PostgreSQL 17 run passed **69** DB
tests. Production Neon PostgreSQL **18.4** was backed up before the migration (`53` tables / `2,993`
rows / `32` migrations), applied `0033`, and produced a validated post-migration backup (`53` /
`2,994` / `33`) with migration checksum `687e773f`.

The stable aliases now point to API deployment `dpl_7kzCbcYFhuSXVFUtBG4fheEwiT95`, admin
`dpl_41fxrirN8uEcKRHcJaZ1ZKXaYJsv`, and driver `dpl_6JVSMPr1ofVwnYhvYJYncygAFpia`. All stable
API, admin, and driver smoke checks passed after promotion.

---

## 2026-08-15 — resilient AI order reading deployed

> Historical release record for migration `0032`. Its deployment evidence remains valid; the
> reduced `1,415` regression below did not represent the complete incident and is superseded by the
> six-order `1,570.00` replay plus one excluded duplicate in the release above.

The reported Recent Orders image did not produce a bad client merge: its two production AI calls
both reached the 50-second timeout with no rows. The surviving `550` total belonged to the sibling
image. The old cache then made a same-image Retry replay that timeout without calling AI again.

Orders now run a compact money/date/time pass before optional route enrichment. Every accepted
non-cancelled amount is re-derived from the printed glyph string; disagreement between independent
AI passes becomes an explicit refused row, never an arbitrary fee. At this release, the reduced
five-row regression was covered as `155 + 240 + 225 + 425 + 370 = 1,415`; it was not the complete
incident fixture and is corrected by the release above.

Migration `0032` makes every paid logical read an atomic reservation keyed by branch, image hash,
field, and reader signature. It serializes the per-shift cap, allows one explicit retry for a
timeout or partial read, bills a cross-shift retry to its requester, uses a PostgreSQL-clock lease,
and ignores legacy prompt/cache answers. The PWA identifies the failed image, preserves accepted
rows, repairs matching refused cards on retry, and removes the retry button after attempt two.

Release evidence: commit `96bb69e`; Node 24 `pnpm check`, both app builds, and the standalone API
build passed. Production was paused and drained, then fully validated backups were taken before
(`53` tables / `2,915` rows / `31` migrations) and after (`53` / `2,916` / `32`). Postflight found
all eight reservation columns, the versioned cache index, zero running reservations, and zero trial
balance. API health is `200`, `/fx` is `401` without auth, and the public driver PWA, manifest,
service worker, SPA fallback, and `/api/health` all return `200` on the promoted deployment.

## 2026-08-15 — fixed 40% shift settlement deployed

> Historical release record for migration `0031`. Its deployment and policy evidence remains
> valid for that earlier release.

The product owner replaced daily tiers and the old zero-difference close gate with one per-shift
settlement. Every shift that was not already approved at policy launch uses
`floor(40% × included Yallago delivery fees)` plus manager-defined manual-order shares. Tier tables
and the day true-up remain only to reproduce approved history; the active editor/publication path is
retired.

Preview, ordinary approval, and exceptional close now share the same calculation:

```text
gross share = fixed 40% share + manual-order driver shares
base share = gross share - cash deductions
variance = actual cash + actual wallet - expected total
employee settlement = base share + variance
wallet to office = full actual wallet
cash to office = actual cash - employee settlement
```

Positive `cash to office` tells the manager to collect cash; negative tells the manager to pay the
employee. A negative wallet produces the opposite, explicit funding direction. Surplus belongs to
the employee and shortage reduces the employee settlement, including immediate extra collection
when the shortage exceeds the share. Approval clears the shift's cash, wallet, share payable, and
any current-shift receivable; it does not post variance to a branch cost centre and does not create
a new debt.

The manager review makes the two physical actions prominent, requires separate audited
confirmations for the complete wallet transfer and the signed cash transaction, and requires a
reason when variance is non-zero. The approval sends the preview's `settlementHash`; the server
recalculates inside the close transaction and rejects a stale screen. The immutable settlement
snapshot retains inputs, fixed rate, signed outputs, directions, confirmations, reviewer, reason,
and timestamps.

The employee may submit a complete close package at any variance. Payments Log evidence is now
optional and archival only: it cannot change orders, expected totals, wallet movements, shares, or
settlement. Untouched OCR cash deductions from Recent Orders match across screenshots by known
printed date, minute and OCR amount (route is evidence only), for both current and legacy keys, and
still reduce expected cash and the current shift's share once; the former D-12 rule that excess
becomes a receivable is superseded by immediate signed cash settlement.

**Live:** the complete Node 24 `pnpm check`, both production front-end builds, and the standalone API
build passed. Fresh PostgreSQL 17.11 applied 31/31 migrations, reran with 0 pending, passed 59/59 DB
tests and every guard. Production was then paused and drained; fully validated logical backups were
taken both before (52 tables / 2,687 rows / 30 migrations) and after (53 tables / 2,688 rows / 31
migrations) applying `0031`. Postflight retained a zero trial balance, the same two open shifts, no
invalid boundaries or cross-branch/cross-shift links, and the limited `ash_runtime` role retained no
TEMP or ledger mutation rights. The API, admin console, and driver PWA were promoted together and
their public health/auth, proxy, SPA, manifest, service-worker, and exact asset-build checks passed.

---

## 2026-08-14 — the shift has real boundaries, and the release has a rehearsed recovery path

> Historical release record for migrations `0028`–`0030`. Its tier/receivable close behaviour was
> superseded for unapproved shifts by the fixed-settlement decision above; its deployment and
> recovery evidence remains valid for that earlier release.

**Live:** migrations `0028`–`0030` were applied to production, then the API, admin console, and
driver PWA were deployed and smoke-tested. The release gate passed on Node 24: `pnpm check`, both
front-end builds, and the standalone API bundle. PostgreSQL 17.11 passed all **40/40** adapter and
concurrency tests plus every database guard after all 30 migrations.

**Thaer's two Recent Orders screenshots were audited read-only after release.** The production OCR
receipts show that gpt-5.5 returned all six fees (`190`, `145`, `175`, `370`, `240`, `425`) and the
`-50` row correctly. The photographed screen was the new PWA, not an old cached bundle: its client
did not receive/apply the successful server answer and exposed the phone reader's two readable fees
and refusals instead. The red evidence tiles show that requests around the same capture also failed.
The incident fix makes AI the only automatic source of screenshot-derived values; the phone reader
may retain training/diagnostic samples but cannot publish a provisional fee, deduction, movement,
wallet balance, odometer, or BMS reading.
Overlapping partial/full sightings of the same `-50` now heal into one deduction. The exact incident
replay produces six orders, one 50-unit cash deduction, expected total `4,686.00`, and a clearly
labelled **surplus of `528.50`**. No shift row or ledger entry was changed during the diagnosis.

The operation window is now the manager-approved opening through the driver's close submission,
using branch-local time, inclusive minute boundaries, and correct midnight crossing. Confirmed
in-window operations are included automatically; an unresolved timestamp blocks approval, and a
manager correction or exclusion requires an audited reason. `openApprovedAt`, `openApprovedBy`, and
`submittedAt` are stored on the shift and recovered conservatively from audit history for shifts
that were already open.

A negative row from **Recent Orders** is no longer disguised as a delivery. It becomes an explicit
cash deduction: expected cash and this shift's driver share fall, ~~any excess becomes a driver cash
receivable~~ (**superseded: it is now collected in the signed close transaction**), and the row never
increases order count, historical tier progress, Yallago's share, or the wallet.
Old PWA payloads that still send a negative fee are converted atomically. Order/deduction sign
changes, closing a shift, and sealing a week are serialized so retries and concurrent requests
cannot leave half a result.

The end odometer finally uses the same local/cloud OCR path as the opening reading, including Arabic
digits, retry, a refresh-safe draft, and the recorded `odoEndOcr` result and failure reason. A lower
reading is accepted only after explicit anomaly confirmation. Evidence now records each attachment
time and provenance; stale or reused media is warned and confirmed, review locks the exact evidence,
and BMS reading waits for its upload so the number cannot be paired with the wrong photo.

Recovery was exercised again against an isolated Neon scratch database: **2,360 rows across 52
tables** were restored. Migration and data fingerprints, zero trial balance, sequences, enabled
triggers, and a write-with-rollback probe all passed. No conformance or destructive verification ran
against production. After confirming zero sessions, the Neon scratch database was dropped normally.
The local PostgreSQL test databases were also dropped and their server stopped; its temporary install
root may remain on disk, but no test database or server is running.

The Neon owner credential was rotated and the superseded credential was verified rejected through
both direct and pooled connections. Runtime and owner database secrets are DPAPI-protected outside
the repository. One credential follow-up remains: create and verify a successor Vercel token in the
personal-account Dashboard, then revoke the predecessor. API token creation was forbidden, so the
working token was deliberately retained rather than strand deployment access.

---

## 2026-08-13 — the cloud reader: gpt-5.5 reads the screenshots, the phone keeps learning

The owner: «switch the ocr on our side to be gpt 5.5 with this setting / the ocr should run on the
vercel so we shouldn't need to run vpn». Delivered, with one thing changed by measurement.

### The measurement changed the setting, not the model

The chosen settings — effort **low**, verbosity **low** — came from one playground screen that
happened to come back perfect. Run over all 48 corpus screens and 311 hand-transcribed rows, they
are the worst value on the board:

| run | clean | ok | **MISREAD** | ×10/×100 | reasoning | cost |
| --- | --- | --- | --- | --- | --- | --- |
| **gpt-5.5 medium/medium** | **35/48** | **290** | **24** | **1** | 21,628 | $1.58 |
| gpt-5.6-sol | 34/48 | 287 | 27 | — | 11,707 | $1.25 |
| gpt-5.4 | 28/48 | 281 | 26 | — | 0 | $0.44 |
| gpt-5.5 low/low | 32/48 | 283 | 31 | 4 | 1,345 | $0.91 |
| LOCAL glyph reader | 14/48 | 136 | 32 | — | — | free |

Dropping gpt-5.5 from medium to low cut reasoning tokens **16×** and saved 42% of the bill — and
bought **seven more wrong numbers and three more hundredfold errors** (`٧٥٠` read as 75, `٣٥٠` as
35, `−٥٠` as −5). On a ledger with zero tolerance that is not a saving. The model choice was right;
`OPENAI_OCR_EFFORT` and `OPENAI_OCR_VERBOSITY` both default to `medium`, and changing either
without re-running `scripts/vision-bench.mjs` is changing the reader blind.

`vision-bench.mjs` gained `--verbosity` to make this measurable at all.

### Why the phone keeps reading too

The on-device reader is not being replaced, on the owner's instruction — «keep the local ocr so we
can train it». Three reasons it earns the space:

- it is the only reader that works with **no signal**, which is the end of a shift in Damascus;
- it **refuses** when the ٢/٣ margin is thin, and a refusal the driver types is visible and
  therefore safe. The cloud model refused **zero** rows out of 311, so every error it makes is a
  confident wrong number that BR1 balances against itself;
- it is the one being **trained**, and training data is a triple — pixels, what the reader said,
  what the human confirmed. Migration `0027` adds `reader`/`reading` to the sample tables so both
  readers' answers survive against the same strip.

### The seam

`OcrReader` and `OcrReadRepo` are new ports in the Infrastructure block beside `BlobStore`.
`readonly available` mirrors `Cipher` — "not configured" is a state to CHECK, never to throw.
`packages/adapters/src/ocr/` holds the memory fake (available: false), a scripted one that counts
its calls, and the OpenAI adapter: raw `fetch`, no SDK, `detail: 'high'` (on `low` the image becomes
one 512px tile and Arabic-Indic digits stop resolving), no `temperature` (5.x rejects it).

`POST /shifts/:id/ocr/:field` takes raw bytes under `shift.operate` + `shiftSubject` — the same
grant the evidence upload beside it uses, so no new permission key and no RBAC migration.

**The evidence photo could not be the input.** `PhotoSlot` uploads a copy compressed to 1280px at
q0.4, which migration `0019` calls "the single largest accuracy lever in the whole feature" and
which is deliberately too degraded to read. Every accuracy figure above was measured on originals.
So `compressForOcr()` sends a second, larger copy — 2000px/q0.85, matching the on-device reader's
own `OCR_MAX_DIMENSION`, and a straight pass-through when the original is already inside it. That
is the normal case: corpus screenshots are 21–170 KB, often *smaller* than the compressed evidence
copy of the same photo. The cap exists for the odometer, a camera photo of several megabytes.

### The two paged screens needed a different shape

`mergeScannedOrders` identifies a row by (day, minute, fee-as-scanned). Two readers merging their
own rows into one draft would key differently wherever they **disagreed** — precisely the set of
deliveries the cloud reader was added to fix — and every one of them would appear twice. A driver
paid once, counted twice.

So exactly one merge happens over one list. This was first shipped with the local reader owning the
list and `overlayCloudAmounts()` replacing only aligned values. Field evidence later proved that a
count mismatch discarded a correct cloud answer, and the Thaer incident proved that publishing a
fast local guess while AI was pending was unsafe. The current rule is A-31: cloud AI owns the full
automatic list; an equal-length local observation may contribute only aligned training strips. A
failed cloud call leaves existing rows untouched and exposes retry/manual entry—never local money.

### Spend, and the four ways it is bounded

There was no rate limiting anywhere in this API before today — `@fastify/rate-limit` has been a
declared dependency that was never registered.

1. **Dedupe by content hash.** `UNIQUE (branch_id, sha256, field)`. A retake, or a retry after a
   timeout, is never billed twice. Failures are stored too — an unrecorded timeout is one that gets
   paid for again on the next retry.
2. **A per-shift cap** (`OCR_MAX_READS_PER_SHIFT`, default 15). Cache hits do not consume it;
   capping those would punish a driver for a bad connection.
3. **`OCR_DRIVER=none`** — the kill switch and the default. One env var, no code deploy; automatic
   monetary prefill stops and the driver uses retry/manual entry while local samples keep training.
4. **`ocr_reads`** carries `tokens_in`/`tokens_out`/`latency_ms`. It is the only cost telemetry that
   will exist; watch it for the first day.

Measured 3.7¢/image in production shape (one image per request pays the full prompt; the benchmark
batches eight and amortises it). At ~12 photos a shift that is **≈$130/month at today's ten bikes**
and ≈$1,300 at a hundred — a real line item at the target fleet, which is what the switch and the
cap are for.

### What must never happen, and the tests that say so

An OCR failure cannot fail a money request. `wire.ts:322-337` carries the incident: a misread
baseline refused a request and a shift balancing to exactly 0.00 could not be handed over because a
cosmetic field disagreed. The read endpoint answers **200 with a reason** for every upstream
failure; only a malformed request (not an image, empty body, someone else's shift) is a 4xx.

Nine API tests and nine on the join. `check:glyphs` is byte-identical — `fee≥46 clock≥45 date≥28
route≥40` — so the on-device reader is provably untouched.

**Recorded, not absorbed:** `ASSUMPTIONS.md` **A-30**. `apps/driver/src/ocr.ts` promised «no photo
leaves the phone, no cloud»; that is now false and the header says so. These screenshots carry real
customer addresses, named businesses and metre-level GPS. Mitigating and load-bearing: the **paid**
OpenAI API does not train on submitted content by default, unlike the Gemini free tier the
benchmark corpus was sent to.

**Next**

- Turn it on: migrate `0027`, deploy, then `OPENAI_API_KEY` + `OCR_DRIVER=openai` in Vercel.
  **Migrate first** — an earlier deploy inverted the order and left two minutes where the API named
  columns that did not exist.
- Write the local reading into `ocr_samples.reading`; the columns exist, the writer does not yet.
- Retrain the glyph templates on the 48-image key — 3× the labelled data, and 54% of it contains
  the ٢/٣ pair the classifier refuses on.
- Four bugs the benchmark surfaced and this work did not touch: the dropped minus sign (13 of the
  local reader's 18 misreads — `−٧٣` read as 73, on a log where that turns money leaving into money
  arriving), `log-h4`'s missing row in `glyph-harvest.mjs`, «غشت» absent from `MONTHS_AR`, and the
  `،` hole in `normaliseAmount`.

**Risks**

- 🔴 **The cloud reader never refuses.** 24 wrong out of 311, and not one of them announced. The
  on-device reader's 175 refusals are the safe failure; these are not. The manager's «OCR →
  confirmed» delta is the only place they surface, and it depends on him looking.
- 🟠 **`maxDuration` is now 60s** (raised from 30; the measured read was 24.9s). The abort is at
  45s so a slow read returns a clean 504 rather than a dead socket. Untested against a real
  provider from `iad1`.
- 🟠 **Recurring spend on someone else's uptime.** ≈$130/month today, ≈$1,300 at a hundred bikes.

---


## 2026-08-12 — الترميم: the owner's own daily process, built

The owner asked for a redesign of **الصرفيات / خزينة الفرع / الداشبورد** and handed over the
spreadsheet he actually runs the business on. Reading it changed the shape of the work: the system
was never missing screens, it was missing **a daily process the business already performs and the
software had no concept of**.

His book keeps two fixed capital targets — `كاش المكتب 4,000,000` and `محفظة المكتب 1,000,000` — and
every evening restores both. Surplus is withdrawn as profit (**كييش**), shortfall is replenished
(**شحن من الصندوق**), and outstanding **الذمم** count toward the capital. His own numbers are the
specification and they verify exactly: `3,600,000 + 400,000 = 4,000,000` and `970,000 + 30,000 =
1,000,000`, both landing on target — a day already restored.

**All suites green: domain 392, client 149, driver 163, adapters 36, api 448 — 1,188 tests, 8 guards,
26 migrations, 47 tables. Migrations 0023–0026 applied to Neon; API, admin and driver deployed and
verified in production.** Six commits, `d676cfa` → `446ce42`.

### What was built

| Phase | Commit | What |
| --- | --- | --- |
| 0 | (0023/0024) | `wallet_adjustment` added to `ledger_event` — a latent 500 on the first close carrying a payments-log movement. Sysadmin granted every permission at scope `all` (decision 9). Both **applied to production**. |
| 1 | `d676cfa` | **صندوق الشركة** as a real fund; withdraw beside every deposit; `POST /treasury/deposit` finally calls `assertWeekOpen` — it skipped it. |
| 2 | `7904379` | **كشف التسوية** — a pure module that computes and explains where tonight's cash goes, and posts nothing. Shown under the BR1 breakdown at approval. |
| 3 | `edf3430` | **الذمم** — the four-line `float_return`, `floatCarry` for the next morning, and `driver_share_payable` finally gets a debit path. It was credited by `shareSplit` and never debited by anything: the liability grew forever with no settlement. |
| 4 | `4cde6ae` | A force-close shortfall comes **off the driver's share**, with his name on it, instead of vanishing into `cost_center:shift_variance:<branch>`. |
| 5 | `1886b85` | **الترميم** — `office_capital_targets` (effective-dated) and `restorations` (one per branch per day, frozen plan). |
| 6 | `446ce42` | The dashboard in his vocabulary: **راس المال المدور · ربح الشركة · دخل الصندوق · خرج الصندوق · الصافي**. |

### Three things this turned up that nothing else would have

**The in-memory ledger never adopted migration 0017.** It still carried 0004's
`WHERE shift_id IS NOT NULL` idempotency predicate, so a shift-less posting — الترميم, a treasury
move, a manual entry — had no replay protection in the fake at all. It **accepted a second sweep the
real database refuses**, which is the one direction a test double must never be wrong in. The
duplicate test found 1,000,000 in صندوق الشركة where 500,000 belonged.

**`driver_share_payable` had no debit path.** `shareSplit` credits it at every approval and no recipe
ever discharged it. The liability was growing without bound and the driver's share was never
recorded as paid, because in the field it never *was* paid through the system — he simply kept it out
of the cash in his hand. Decision (f) made that explicit and the close posting now says so.

**«كييش» was a typed Arabic word.** In the spreadsheet the daily in/out totals are `SUMIF`s over a
hand-written column: one «كيش» for «كييش» and a month's profit is quietly short with nothing to say
so. The dashboard derives both from the **ledger event** — a `restoration` entry that debits
`company_box` is كييش, one that credits it is شحن — so nobody spells anything and nobody can misspell
it.

### Where the safety actually sits

- **الترميم is computed from the SEALED COUNT, never from the request body** (decision j). Computing
  it from the ledger would make it a tautology that can never find anything; the whole point is that
  it settles against money somebody physically counted. Uncounted, the button is dead and says why.
- **It refuses a sweep larger than what is in the drawer.** A box holding 100,000 with 5,000,000 out
  on ذمم shows a surplus on paper and cannot hand over a lira of it.
- **It refuses when no رأس مال is configured**, which would otherwise read every box as pure surplus
  and sweep the whole treasury on day one.
- **BR1 is untouched.** The driver declares every lira he holds; the ذمة is a manager decision about
  how that declared cash is *posted*. The equation still closes at exactly zero, and the carry enters
  the next day as a tranche so BR1 stays in its absolute form (decision 4).

### One thing to do differently next time

**The API was deployed before its migrations were applied**, and for about two minutes production ran
code whose `UPDATE shifts` named two columns the database did not have. Reads were unaffected —
`SELECT s.*` with `?? '0'` fallbacks degrades cleanly — but every shift WRITE would have failed:
a driver could not have started or closed a shift. Nothing hit it (the logs show only the smoke
probes), and the migration went in immediately after. **Migrate first, then deploy.** `RUNBOOK.md`
says so; the order was inverted because the migration command needed a permission that the deploy
did not.

Verified after: both columns present, the tranche CHECK carries `carried_receivable`, both audit
triggers exist, and the capital targets seeded at `400,000,000` / `100,000,000` minor — 4,000,000 and
1,000,000 new SYP, his figures.

### Next

- Three shifts from 2026-08-11 are still `open` and need closing or force-closing.
- P2 security, untouched: `GET /audit` returns password hashes and plaintext TOTP secrets; the 2FA
  enrolment bypass; no login rate limiting; no helmet; three cross-branch write holes.

## 2026-08-09 — a backup that has been restored from, and four ways the ledger could lose money

A full three-way review (money, security, operations) of the whole platform. The UI work of the
previous three days was real, but this is what it was sitting on top of.

**All suites green (domain 327, client 76, driver 114, adapters 36, api 355), 6 guards green,
migration 0017 applied to Neon, API + admin deployed and verified.** Two commits.

**The system had no backup.** `infra/scripts/backup-loop.sh` (restic) belongs to a docker-compose
stack that is not deployed — production is Vercel + Neon — and the "scheduled `pg_dump`" that
`DEPLOY-VERCEL-NEON.md` promised did not exist in any form: no cron, no `crons` key, nothing.
`scripts/backup-db.mjs` and `scripts/restore-db.mjs` now exist and, more to the point, **the restore
has been run**. Every value is cast to text in SQL and stored as a JSON string, because money is
`bigint` and a JSON number is an IEEE double — a backup that quietly rounds the ledger is worse than
none.

**The rehearsal is the deliverable, and it found four defects in the restore that no amount of
reading would have.** Identity columns rejected explicit ids until `OVERRIDING SYSTEM VALUE`; the
audit triggers fired on the load and collided with the rows being loaded; the deferred balance
trigger checked per row instead of at COMMIT; and sequences were left behind the restored data, so
the first insert after a restore would have collided. Each was fixed and re-verified.
**Measured RTO ≈ 3 min 20 s** at current scale, recorded in `RUNBOOK.md` where it said "not yet
measured" — with the honest warning attached that the loader sustains ~8 rows/sec over HTTPS from
Damascus, which misses SRS §7's four-hour RTO at roughly a million rows.

**Then four money defects, each verified in the source before a line was written, and each now
pinned by a regression test proven to fail with its fix reverted.**

*The ledger's idempotency guard poisoned its own transaction.* `PgLedgerRepo.post` caught a unique
violation and `continue`d — inside a plain `BEGIN…COMMIT`. In PostgreSQL a statement error aborts
the whole transaction: every later statement fails `25P02`, and **`COMMIT` on an aborted block
silently rolls back while reporting success**. So a re-approved shift either 500'd on the next
posting, or committed nothing while `post()` returned the rows it believed it had written. Now
`ON CONFLICT DO NOTHING RETURNING id`, with an empty `rows` as the replay signal. Nothing could see
this: `MemoryLedgerRepo` implements `continue` correctly because an array has no transaction to
poison, and the conformance suite only ever posted one posting per call — exactly the shape where
the difference cannot appear. It now posts a batch mixing a replay with new postings, against both
adapters.

*A double-tapped tranche disbursed twice.* The occurrence key was `tranches.length + 1`, recomputed
per request, so a sequential retry was not a replay — it was tranche #2. SRS C-5 genuinely allows
several tranches a day and the amounts may be identical, so the server cannot tell them apart; only
the caller can. The wire now carries an `occurrenceKey` that the admin console mints per intended
disbursement and clears **only on success**, so a retry after a timeout — the case where the server
may well have committed — posts nothing.

*The idempotency index only covered shifts.* It was partial, `WHERE shift_id IS NOT NULL`, so
deposits, manual entries, expenses and journal **reversals** had no replay guard at all. The
reversal route is the worst of them: its key is deterministic, written by someone who plainly
expected this index to catch a replay. Migration 0017 makes it total over
`COALESCE(shift_id::text,'')` — NULLs are distinct in a unique index, so a partial index on `IS NULL`
would have guarded nothing.

*A week could seal with unapproved shifts inside it.* `unapprovedShiftCount` was fed by a
single-**day** query on the week's Sunday, so Monday–Saturday were invisible. Approving such a shift
after the seal posts ~25 entries into a sealed week with `week_lock_id = NULL`, which can never be
locked, because `week_locks_no_reopen` refuses to re-stamp `closed_at`. The old suite could not
catch it: the harness clock sits on Tuesday, so every shift the tests create lands on the one day
the query looked at.

**What this review found that is still open.** No git remote — GitHub refuses to create repositories
for this account under trade-control restrictions, so the code exists on one machine and
`.github/workflows/*` has never executed once. Evidence photos still have exactly one copy. And the
security pass is not started: 2FA enrolment can be overwritten with only a password, `GET /audit`
returns password hashes and plaintext TOTP secrets, there is no rate limiting and no helmet, and
there are three cross-branch write holes.

**See it in 2 minutes.** `node scripts/backup-db.mjs` writes `backups/<stamp>/` with a manifest and
one gzipped JSONL per table; `node scripts/restore-db.mjs <dir> --to <scratch-branch-url>` puts it
back and refuses outright if the target's migration ledger differs from the backup's.

### Later the same day — the three defects the plan called "lower severity", and was wrong about

Migration 0018 applied and verified in production; API deployed. Suites: domain **333**, client 76,
driver 114, adapters 36, api **368**, 6 guards, 18 migrations. Production is still pre-live — 11
entries, 0 approved shifts, 0 sealed weeks — so all three were **latent, with no data to repair**.
That was checked against Neon first, not assumed.

**A band crossing made the second shift of the day unapprovable.** `shareSplit` pushed a share line
only `if (share > 0n)`, but its caller hands it `trueUp` **deltas**, which are signed. In
whole-amount mode — the configured default — the company's delta is negative on *every* band
crossing, by construction: Yallago's 20% is fixed and the driver's percentage rises, so the
company's is what falls. That is BR4 as arithmetic. The dropped line left `D 500000 <> C 650000`,
`assertBalanced` threw, and the manager got a 500 at «اعتماد الإغلاق» — on the exact case the whole
day-tier true-up exists to handle. Nothing posted, so the shift sat in review with the driver's cash
still on the books as his; retry 500, force-close 500, and only `voidShift` "worked", by deleting
the order. A negative share is a **debit** of that account, not a line to drop. Marginal mode never
goes negative, which is precisely why 327 green domain tests never saw it.

**The tier true-up recomputed what was already paid instead of reading it.** `alreadyPosted` was
`splitDay(priorFees, rule)` where `rule` belongs to *this* shift — its date and **its vehicle's
type**. F-4 tables are per vehicle type, so a bike in the morning and a car in the evening re-prices
the morning under the evening's table. Measured through the real HTTP stack: the driver ends
**9,000 new SYP short**, the company over-credited by exactly the same, one driver, one day; reverse
the shifts and he is over-paid by 9,000 instead. The day settles at **4,181 bps — a rate in no
published table**. No balance check can see it: every entry balances and the deltas still sum to the
shift's fee. It is silently the wrong split of a correct total. Now read from the **ledger**, the
only record of what was actually paid. `driver_day_shares` stays unwritten on purpose — a second
record of one fact eventually disagrees with the first.

**A sealed week accepted new postings.** 0006's two immutability guards both key off
`week_lock_id`, which only `fin_seal_week()` writes, by UPDATE, at seal time — so a *new* row
carries NULL and `IF v_week_lock_id IS NULL THEN RETURN` waved every INSERT through. Unrepairable,
too: `fin_seal_week` stamps only what exists at seal time and `week_locks_no_reopen` refuses to
re-close. Three routes reach it with a **client-supplied date** — expenses, manual entries, cash
counts — and the manager who back-dates Thursday's charging bill on Monday is the whole exploit. The
reversal route was sharpest: its own comment asserts «a locked week is NEVER edited — the database
refuses it twice over», and it copied the original's dates straight back inside the seal. A
correction against a sealed week is now re-homed whole into the current open week, which is SRS
E-6's «قيد ظاهر مؤرَّخ» and ordinary prior-period accounting. Guarded at both layers: migration 0018
refuses the INSERT (25006), and `assertWeekOpen` answers 409 first. `isDateLocked` had sat in the
domain since the week module was written **with no caller at all** — the check it describes was
never once performed.

**One question for the product owner, deliberately not answered here:** when a driver works one day
on two vehicle types with different tier tables, **which table governs the day?** The fix makes the
system pay what it says it pays under either answer; it does not pick one.

---

## 2026-08-08 — the digits are read, and an order stops pretending to have a number

**All suites green (domain 327, client 53, adapters 34, driver 87, api 348), 6 guards green. API and
driver deployed and verified** (`/health` 200, driver serving `index-CnrEOCyl.js`). Five commits.

**The 🔴 STOP of 2026-08-07 is lifted.** The replacement reader that was "proven and waiting" is now
in the app and reading real screenshots. Tesseract is still used for LAYOUT only — it anchors each
row on «SYP», which it reads 11/11 because it is ASCII — and the ink to the left of that anchor is
segmented and classified against harvested templates. Measured on the owner's own screenshots,
end to end through `readOrders`:

```
rows 34   read 30   refused 4   WRONG 0
```

**Zero wrong is the number that matters**, and it is bought by two gates, not one. A distance
threshold alone is unsafe: out-of-vocabulary ink scores as low as 0.35, *below* the worst CORRECT
match at 0.47 — the populations overlap the wrong way round, so no threshold separates them.
Shipping the **margin** between the best and second-best class alongside the distance is what makes
refusal reliable; adversarial verification of the pair recorded no accepted-but-wrong reading. All
four refusals here are the same honest hesitation between «٢» and «٣» at a margin under 0.10. The
driver types those four.

Three defects found along the way, each of which had been quietly producing garbage: a fixed-offset
threshold **merged adjacent glyphs** (Otsu fixed it, 14 → 28 rows); row hairlines were being
**classified as digits** (a 10-character amount arriving as 13 shapes); and `/SYP/i` matched inside
other words, so a **three-row page reported «20 صفوف»**.

**An order is its value, its route and its clock — it has no number.** «الطلبات الحديثة» does not
display one, so nothing invents one any more; the old `YAL-<date>-<HHMM>` key gave two deliveries in
the same minute the same globally-unique `provider_order_no` and silently dropped the second.
Point A and point B come from **Tesseract's own text**, which is not a compromise: its failure is
confined to Arabic-Indic *digits*, while the two place lines are Arabic *words* tagged with a Latin
«A»/«B». They are stored as the order's ROUTE on `shift_order_points`, the table manual orders
already use, so the manager's review renders them with existing machinery and the schema needed
nothing. The driver's row shows clock and route under the fee — with no number, that line is the
only thing on a row a person can recognise as a delivery he made.

**Honest status.** The harness measures the AMOUNT. The clock and the route are not in it yet, and
the clock is the weaker of the two — adjacent minute digits merge in that screen's smaller font.
Folder-4 screens at font sizes with no harvested templates still read poorly. Typing stays
first-class on every field; the reader appends, it does not replace. `minWalletBalance` still walks
orders only (carried over, still not fixed).

**See it in 2 minutes.** Driver → «إنهاء النوبة» → pick a dashboard screenshot: the rows fill in
with their fees, and each shows its time and «A ← B» beneath. Uncheck what is not this shift's.

---

## 2026-08-07 (later) — the operations list: one close screen, and a checkbox that decides money

**All suites green (domain 327, client 45, adapters 34, driver 76, api 348), 6 guards green,
migration 0015 applied to Neon, all three apps deployed and verified.** Eight staged commits.

**Two dormant ledger defects, fixed FIRST.** `orderFee` posted the whole fee to ONE fund chosen by
`payMode` while `closingBalances` split the same order by `orderWalletAmount` — they agreed only
while nothing measured the wallet. And `walletAdjustments` were added into `endWallet` with no
posting ever debiting them. Both were harmless only because the API never populated either field,
and this feature populates exactly those two. Verified by reverting each: both properties fail
(`expected 1n to be 0n`, then `expected 0n to be -1n` — precisely the −Σadjustments symptom).
The property arbitraries were extended, because they had been silently vacuous about the only case
that matters.

**A scrollable screen is several images.** «الطلبات الحديثة» and «سجل المدفوعات» both scroll, so
both are now up to 8 pages. Page 1 keeps the BARE slot name, so no data migration and no alias
table: `dashboard` simply IS page 1. `requiredEndSlots` is untouched, so an extra page can never
become a `missing_photo`.

**One close screen.** The separate «الطلبات» step is gone; uploading, reviewing what was read, and
closing all happen on «حزمة النهاية». Orders and wallet rows are ONE list, because that is how the
day happened — an order and the 20% Yallago took for it are one event seen on two screens.

**The checkbox.** Unchecked = stored, visible to everyone, and out of BR1, the tier band and the
ledger. Filtering happens at `toDomainOrders`, so `packages/domain` never learns what "excluded"
means. `ordersHash` now covers `included`, `walletAmount` and the movements — each changes the
posted money without touching any previously-hashed field, and a movement can do it with every
order untouched.

**Three disjoint roles guard the double count:** a logged `yalago_cut` NEVER enters BR1 (the
equation derives it from the fee — the block is a residual), an `order_credit` is already inside
its order's `walletAmount`, and only `unmatched` rows are summed into `walletAdjustments`.

**The ambiguous credit.** A credit at an order's minute is either that order's electronic part or an
unrelated incentive; the two readings agree on the wallet exactly and differ on the CASH by exactly
the credit. So BR1 already catches a wrong choice — no second gate — and the manager gets a two-way
control plus a named cause, `ambiguous_wallet_credit`, that points at the row.

**See it in 2 minutes.** Driver: «إنهاء النوبة» → one screen with the operations list, «+ صورة
أخرى» under each scrollable screen, a checkbox per row, and the live equation in the footer.
Manager review: every operation checked and unchecked, excluded rows dimmed and badged «مستبعدة» in
place, and «جزء من الطلب» / «حافز منفصل» where the reader flagged doubt.

**Honest status.** The OCR still cannot read Arabic-Indic digits, so in production this list is
filled in BY HAND until the glyph reader lands — the scan buttons only append. A client test pins
that with no movements and no measured wallet amounts the preview is exactly today's arithmetic.
`minWalletBalance` still walks orders only and will under-report the mid-shift trough now that
adjustments are real; noted, not fixed. Audit volume: a 60-row log is 60 audited inserts per submit.

---

## 2026-08-07 — the close from screenshots, a way back out of it, and the digits problem

**All suites green (domain 317, client 34, adapters 30, driver 76, api 325), 6 guards green.**
Driver PWA and API deployed and verified. Five threads, and one of them ends in a deliberate stop.

**BR1 measures the wallet now, it does not classify it.** `payMode` forced every order to be
all-cash or all-wallet; the owner's payments log proves it is neither. An order now carries the
amount that actually reached the wallet — `cash += fee − W`, `wallet += W − cut` — with `W = 0`
reproducing today's cash order and `W = fee` today's electronic, both proved by property test.
`(fee−W) + (W−cut) = fee−cut`, so the 80% block, the tier band, BR4 and the ledger cannot move
however the money splits. Wallet movements no order explains get their own term, so BR1 stops
blaming the driver for money the app moved on its own. A pure matcher pairs orders to log rows by
minute, confirms Yallago's 20%, and **refuses to decide** the ambiguous credits.

**A manager can correct a closing figure at review** (`POST /shifts/:id/close-figures`) without
approving or bouncing the shift — the safety net everything else here depends on.

**A way back out of the close.** «إنهاء النوبة» was a one-way door: no way back to a running shift,
none to the order list after remembering a delivery. Both closing screens now carry a back control
in the sticky header, and the closing package survives the trip — photos, typed figures and battery
readings are all preserved, because a back button that costs four re-uploaded screenshots is a trap.
An order already sent is now shown locked («مُرسَل») rather than offering an edit that changes
nothing on the server. Fixed a pre-existing deadlock this made routine: on a partial submit failure
the rows that saved were never remembered, so every retry re-posted them, all 409'd, and the failure
list grew until nothing the driver could do would clear it.

**An account nobody could log into.** `Ali_Dandah` was stored as U+0650 ARABIC KASRA + `Ali_Dandah`
— what Shift+A produces with the Arabic keyboard layout on. Invisible, so the name looked right
everywhere; login is an exact match, so it never reached its password check. Usernames are now
normalised at login and at creation, and the lookup falls back (on a miss only, and only when
exactly one account matches) so the existing row is reachable without editing it.

### 🔴 STOPPED, BY AGREEMENT: reading the two Yallago screens

**Tesseract cannot read Arabic-Indic digits, and no bundle fixes it.** `tessdata_fast` (shipped),
`tessdata` standard, `script/Arabic` all score 0/11 on the known amounts; `tessdata_best` will not
run at all — its float kernels are missing from tesseract.js's WASM core. Tried every
page-segmentation mode, raw/stretched/inverted, the amount column at 4x and a single amount at 5x.
«٥٢» reads «oY», «٩٥» reads «40», and fatally «٢» and «٣» BOTH read «Y» while «١» and «٦» both read
«\». No table recovers −26 from −36. The app cannot be switched to Western digits — that would mean
changing the whole phone's language.

**The parsers were serving that debris as money** — ٥٢ became −07, ١٥٣ became +017, and two rows of
three were offered as «11» and «11» for fees of 120 and 235. Now a list amount must be digits only
with no leading zero, and a page is offered only if it accounts for ~every row carrying the
currency. No pass on any fixture produces a wrong value; both screens report honestly that they
could not be read. This also exposed a real bug: the row is «٢٣٥ SYP … ٦:٠٦ م» flattened onto one
line, so the RTL pattern `SYP <number>` was matching the **hour** — a fee of 235 read as 6.

**The replacement is proven and waiting.** Tesseract finds «SYP» perfectly (11/11, every pass — it
is ASCII), so it is used for LAYOUT only: it anchors the row, gives the font size in its own cap
height, and the amount is the ink to its left. `scripts/glyph-lab.mjs` segments and classifies those
glyphs: **34/34 rows segmented exactly** (two screens, two scales, including «−١٬١٥٥٫٦٥» into all
nine pieces) and **118/118 correct under leave-one-out**, worst correct match 0.361 so a refusal
threshold has room.

**To resume, at the live test:** collect several days of both screens from the driver's phone, drop
them in `apps/driver/test/fixtures/ocr/`, add their amounts to `TRUTH` in `scripts/glyph-lab.mjs`,
and run it — it reports which characters are still unseen. Today «٨» appears in **no amount**
(it exists only inside the date «٠٨/٠٤», in a smaller font) and «٩» and the thousands mark have one
sample each. Once the alphabet is covered, wire the classifier into `readOrders` /
`readPaymentsLog` and the driver's typed odometer / wallet / order fields can go. **They stay until
then** — the close gate needs at least one order, so a reader that returns nothing would leave a
shift nobody can submit, not the driver and not the manager.

**Open question for the owner.** The log carries negatives that are nobody's 20% — −165.50, −177,
−22 — each at an order's minute, and at no consistent ratio to the fee. Best reading: the goods
value the wallet paid the merchant. If so they are normal and get modelled; if not, they will land
in BR1 as an unexplained wallet difference.

---

## 2026-07-29 (later) — batteries: back/cancel on start, two-or-more packs, mid-shift swap

**All suites green (api 30 files incl. 6 new swap/ceiling tests), 6 guards green, migration 0013
applied to Neon.** Three things the owner hit on the driver's start screen while walking the live
test — a UX dead-end and two battery-model gaps.

**Back / cancel on the start screen.** A fresh open created a draft that held the bike with no way
out (Back is trapped, and the «إلغاء النوبة» discard was gated to the *resume* case only). Now
`StartPackage` owns discard: it shows whenever a cancellable draft exists (`draft`/
`awaiting_open_approval`) and reuses `cancelMyShift`. The start confirm-gate also now waits on every
fitted pack's reading, matching the close screen and the server BR5 gate.

**Two OR MORE packs per bike.** The 2-pack model existed but was hard-capped at `slot_no BETWEEN 1
AND 2`. `vehicle_types` gains a **configurable `battery_slots`** (the ceiling — default 2,
e_motorbike = 3); the per-bike count stays derived (`COUNT(*)` of fitted packs). The SQL cap loosens
to a 1..8 backstop and `MAX_BATTERY_SLOTS` rises to 8; the real per-type limit is enforced app-side
(`slot_out_of_range`). Sysadmin sets it on FleetConfig; the fit-slot picker follows it.

**Mid-shift battery swap (SRS §L seam — new scope, owner-approved).** A driver-recorded event on an
open shift: pick the slot + a ready spare, capture **both** packs' BMS readings (`swap_out` final,
`swap_in` first), and the server re-fits the bike (old → charging spare, new → the slot) and logs
it in `battery_swaps`. **No money moves** — BR1 and the shift state machine are untouched; it mirrors
`addTranche` (C-5), not a transition. The refreshed fitted set flows back to the driver app so the
close gate asks for the pack now on the bike. The manager's review lists each swap (slot, out→in
serials, both percents).

**See it in 2 minutes.** Driver PWA: on a fresh open, a back/cancel now releases the bike. Admin →
FleetConfig: set e_motorbike to 3 packs, fit three; fitting slot 4 is refused. Driver, mid-shift:
«تبديل بطارية» → pick a slot + spare → scan/enter both BMS readings → the manager's review shows the
swap and the bike's fitted set updates.

**Honest status.** New scope beyond the SRS (section-L-adjacent): this captures readings and moves
the asset, it does not yet compute health trends. A swap needs a registered *ready spare* in the
branch (register spares on the Fleet screen first).

---

## 2026-07-29 — upper-level override for a stuck shift (void + force-close) + a live-map fix

**All suites green (306 API tests incl. 4 new money-critical override cases + a new live-map case),
6 guards green, migration 0012 applied to Neon, API redeployed.** A driver can leave a shift open
forever (bike breaks, phone lost). `shift.approve` holders (branch manager + GM + sysadmin) now get
two escape hatches, and using them surfaced — and fixed — a live-map defect.

**Void (→ `cancelled`).** Reverses the float + top-up via the return recipes and discards the shift's
orders; for a shift that produced no real deliveries. Money nets to zero (driver + office funds back
to 0), every posted entry still balances. New terminal `cancelled` state + `manager_force_cancel`
action; migration 0012 adds the enum value.

**Force-close (→ `approved`).** Settles like a normal close using `postingsForApproval` over the
*computed* closing balances, then books any declared-vs-expected gap to a `shift_variance` cost
centre the driver still owes. Leaving a figure blank accepts the expected close (no variance) — this
is how an admin closes "without the needed data". A 10,000 cash shortfall books exactly 1,000,000
minor to variance; verified.

**UI.** Void + Force-close panels on «النوبات الجارية», gated `canApprove` (ar/en), force-close
takes an optional cash / wallet / odometer plus a recorded reason.

**Live-map fix (SRS K).** `/gps/live` returned the latest ping per driver with no shift-state filter,
so a driver whose shift had ended lingered on the map forever (gps_pings is append-only) — voiding
the real stranded shift left him stuck on the map. Now filtered to drivers whose latest ping belongs
to their **current live shift** (new `ShiftRepo.listLiveForBranch`); a ping from an already-ended
shift is dropped even if the driver has opened a fresh one that has not pinged yet.

**See it in 2 minutes.** Admin → «النوبات الجارية» → on a stuck open shift press **إغلاق قسري**
(force-close) or **إلغاء النوبة** (void); the row leaves the live set and, for void, its driver drops
off «الخريطة الحية». (In this session a real stranded shift — driver1, business date 2026-07-28 —
was voided through the deployed API; `/gps/live` went from one lingering pin to `[]`.)

---

## 2026-07-28 (later) — a testable platform: the 3 missing Bundle-1 UIs + live GPS tracking

**310 domain + 297 API + 63 driver + 21 client tests green, 6 guards green, migration 0011 applied
to Neon, all three projects redeployed.** An audit found three in-scope Bundle-1 sections were
backend-complete but had **no admin UI** — reachable only by raw API call. All three are now
screens, and live GPS tracking (SRS K) is built end to end, so the whole platform is manually
testable.

**F — tier admin.** The engine is money-critical (close pay resolves the configured rule) but a
sysadmin couldn't publish a table or flip whole/marginal, so close silently ran the default F-1
fallback. Now `Tiers.tsx` (sysadmin-only): list active/superseded tables, a bands editor (share as
%, converted to bps), effective-dated publish, withdraw, and the read-only what-if simulator
(per-driver Δ + company impact).

**G — expenses.** An entire priced section with no way to use it. Now `Expenses.tsx`: a create form
(category · cost-centre · vehicle · amount · description) gated to BM+GM, a date-range list + total,
and a sysadmin-only category manager.

**E-3 — manual entry + BR7 correction.** Folded into Treasury: a manual journal entry with a
fund/side/amount line editor and a live D-vs-C running total (bigint string math, never `Number()`
on money) that gates the post; and the visible dated reversal (`POST /journal/:id/reverse`).

**K — live GPS tracking.** While the shift is open the driver's phone streams its location: a
`use-gps-beacon` hook runs `watchPosition` + a Screen Wake Lock and POSTs the latest fix every **15
s** to `/shifts/:id/gps` (server stamps `received_at`, so a skewed phone can't rewrite when it was
seen). Migration 0011 adds `gps_pings` (audit-exempt telemetry); the manager watches a **Leaflet +
OpenStreetMap live map** (`/gps/live`, latest fix per driver, polled every 10 s). Foreground-only —
a PWA can't track in the background; true pocket/screen-off tracking is the deferred native-wrapper
or hardware-tracker route. `gps.view` (already in the matrix) gets its first consumer.

**Honest status.** GPS is foreground-only by the PWA's nature. The BR1-vs-Yallago-wallet calibration
(one real shift) and the production-hardening items (Neon guard run, MFA-at-rest, backups, A-4
ceilings) remain the next phase before relying on this for daily cash.

---

## 2026-07-28 — Section D: the D-3 loop finished, plus wallet (D-2) and order-list (D-1) OCR

**311 domain + 297 API + 63 driver + 21 client + 30 adapters tests green, 6 guards green, migration
0010 applied to Neon, all three projects redeployed.** Section D is Bundle-2/deferred; the assisted
on-device reader already over-delivered on the «drivers type, photos are evidence» bridge (D-5). This
round makes **D-3** real end to end and adds two readers the client's real screenshots unblocked.

**D-3 — «any manual edit is logged with its difference from the OCR reading» (acceptance #10).** The
BMS packs already captured that baseline (`ocr_raw`, preserved across retakes) but it was **never
shown**. Now a pure `ocrReadingDelta` (in `@ash/client`) drives an «مُعدّل يدوياً» badge + per-field
«OCR → confirmed» lines on the manager's review, for the BMS packs and — newly trailed — the start
odometer/battery, the close wallet, and each order fee. Migration 0010 adds the four nullable
baseline columns (`shifts.odo_start_ocr`/`battery_start_ocr`/`end_wallet_declared_ocr_minor`,
`shift_orders.fee_ocr_minor`); the odometer/battery are plain integers, the wallet and fee are money
that crosses the wire as decimal strings (wire-money guard clean).

**D-2 — wallet OCR at close.** Given the real Yallago wallet screen (76,509.55 SYP, white on orange,
Arabic-Indic digits), `readWallet` + a pure `parseWallet` pre-fill `walletDeclared` from the wallet
screenshot. The money 2-dp rule (a separator + 1–2 trailing digits is the fraction; grouping is
dropped) and Arabic-digit folding are pinned to that exact sample. String ops only — never `Number()`.

**D-1 — order-list OCR.** The «Recent orders» screen (owner-confirmed: the `NNN SYP` figure is the
delivery fee, BR1's number) is scanned by `readOrders`/`parseOrders`: it anchors each order on a
`NNN SYP` amount with the time on the same row, tracks the «Monday, 27 July» day headers, and drops a
row with no readable fee. A «مسح الطلبات» button on the order screen turns the screenshot into
pre-filled fee rows (auto key `YAL-YYYYMMDD-HHMM`, pay-mode = cash); the driver sets pay-mode, drops
other-day rows and confirms — the existing dup detection, live BR1 preview and submit path unchanged.
The screen carries no order-id or pay-mode, so those stay the driver's; OCR fills only the fees. This
activates the long-dormant `shift_orders.source` seam and adds the fee's D-3 baseline, so a silently
lowered OCR'd fee is now visible to the manager.

**Honest status.** The parsers are pinned to the owner's real screenshots; on-device *recognition*
accuracy on live phones is still the manual calibration the SRS D-4 asks for — the readers degrade to
manual entry on any failure, exactly as D-5 guarantees. Only the wallet + «Recent orders» samples
exist, so odometer/dashboard recognition calibration, per-field confidence (D-4) and server-side OCR
stay out of scope.

**See it in 2 minutes**

```bash
pnpm check
pnpm --filter @ash/driver test -- ocr.test.ts     # parseWallet + parseOrders on the real samples
pnpm --filter @ash/api test -- ocr-trail.test.ts   # the D-3 baselines reaching the review
```

---

## 2026-07-27 — Section C closed: the six modeled-but-unwired gaps in the shift cycle

**311 domain + 291 API + 56 driver + 15 client + 30 adapters tests green, 6 guards green, i18n 21
sections. No migration — every table already existed. Three projects to redeploy.**

Section C's happy path was fully built and tested; six things were modeled in the domain/DB but
never wired end to end (plus one new capability the product owner asked for). All six are now live,
each its own commit with `pnpm check` green.

**Tier at close paid the wrong rate — the single biggest money defect.** `approveClose` hardcoded
`DEFAULT_BANDS` and never called the resolver, so a published / per-vehicle-type / effective-dated /
marginal tier table had **no effect on real driver pay**. Now the configured rule is resolved by the
shift's vehicle type (`resolveTierRule`, sharing one `asDomainRule`+`ruleInForceOn` with the
simulator), and `alreadyPosted`/`trueUp` use that same rule — so a mid-day band crossing and both
whole/marginal modes settle correctly. Falls back to the F-1 default if none is in force, so the
default seed reproduces today's numbers (the canonical §2.3 and every lifecycle test stay green); a
published 50% table now genuinely pays 50%.

**The manager could not review the evidence.** The whole point of C-7 is matching ground photos to
numbers, but the review discarded the media ids. It now carries them, and the approval screen shows
the start/end photos inline with a click-to-enlarge lightbox.

**The manager could only approve.** No retake, no reject, no notes, no log — though the domain
transitions, the `requestRetake` string and the `shift_decisions` table all existed. Wired:
`request-rephoto` and `reject-close` return the shift to the driver with a logged, notified reason;
`approve` writes an `approved` row; the review shows the «سجل القرارات»; the driver sees WHY his
shift bounced instead of a silent reset.

**«معلقة» never triggered.** A manager now suspends a live shift for a mid-shift incident (C-1);
the driver resumes it from his phone, or it closes directly under the **same BR1** — a suspension is
never a way around the zero equation. The driver can't suspend himself (domain: `suspend` =
`shift.approve`), so he «بلاغ حادثة» rings the branch bell and a manager acts. A new «النوبات
الجارية» panel is the manager's home for live shifts.

**No second float/top-up mid-day.** The tranche arrays and the
`(shift_id, event_type, occurrence_key)` idempotency existed, but funds were set once at open and
never appended — so cash handed over mid-day left the office with no ledger entry. Now a tranche
posts ONE balanced entry under its own occurrence key (`existingCount + 1`, never re-posting from
1); BR1's expected end cash/wallet move automatically because the equation sums the arrays.

**Manual orders (new).** A missing order is a cause BR1 ranks at close, but only the operating driver
could add one and only while `open`. Now a higher-level manager adds a manual order to reconcile a
shift through `pending_review` — which moves the orders hash, so the staleness guard forces a
re-review before approval — and a driver past the open window requests one via the branch bell.

**See it in 2 minutes**

```bash
pnpm check                 # 6 guards + every suite, no Docker
pnpm --filter @ash/api test -- suspend.test.ts tranche.test.ts decisions.test.ts manual-orders.test.ts
```

**Honest status:** all code + tests on the memory harness; the Pg paths reuse existing adapters
under the shared conformance suite. Not yet exercised against Neon in this batch, and the live-shift
manager flows (suspend, tranche) have not been clicked through a browser here.

---

## 2026-07-23 (latest) — the BMS reader: a profile per battery, and two confirmed faults fixed

**309 domain + 246 API + 27 driver tests green, 6 guards green, migration 0008 applied, all three
projects redeployed.**

The diagnostics added the round before paid for themselves immediately: the driver's phone reported
**two different failures**, and they were two different faults rather than one mystery.

**«تعذّر تشغيل القارئ» — the reader died once and was never rebuilt.** `getWorker()`'s catch only
ever covered *creation*; once created, the cached promise stayed resolved for the whole session, so
a worker killed later by a wasm abort or an OOM was handed out again on every call and OCR reported
`unavailable` **forever**. Pressing «إعادة القراءة» could not recover it. The worker is now
terminated and dropped on any failure — including a timeout, which leaves it chewing on an
abandoned job — and rebuilt once automatically.

**«لم نتعرّف على أي حقل» — the Arabic app is a CARD GRID and the parser could only read a list.**

```
   81.48V        0A        0.00W       1        ← one recognised line
إجمالي الجهد    التيار      الطاقة     الدورات    ← the next
```

The label and its value are never in the same cell there, so «الدورات» and «إجمالي الجهد» found no
number at all. `parseBms` now takes real line boxes and pairs a caption with the value on the line
**above** it by column overlap, which reads the cards and leaves the inline English table working
unchanged. The screenshot is also white text on saturated cyan, and Tesseract thresholds before it
recognises — `prepareForOcr` converts to luminance and stretches the 5th–95th percentile, which
pulls those apart and leaves an already-black-on-white page untouched. `PSM 3` now leads: a card
grid with a gauge and a nav bar is not the uniform block `PSM 6` assumes.

**A profile per battery**, at the product owner's direction. The packs do not ship with the same
app and the apps agree on nothing, so a battery records which one it uses: `BMS_PROFILES` in the
driver app owns the label spellings, layout rule and segmentation; `batteries.bms_profile`
(migration 0008 — TEXT and unconstrained, so a new profile needs no migration) records the choice;
the admin fleet screen has a picker. `NULL` means `auto` — every label, both layouts, both modes —
which works but is the slowest and least certain path.

**One more bug, caught by the new tests rather than in production:** with three labelled values on
one line (`MOS: 36.9℃  T1: 33.7℃  T2: 33.6℃`) the number search started at the beginning of the
cell, so T1 read 36.9. It now cuts at the label and looks forward, then backward for the RTL case —
and it cannot simply delete the label first, because with spaces stripped «t1» and «33.7» fuse into
`t133.7`.

Also shipped: **«ما قرأه النظام»**, a collapsed disclosure under a failed read showing the text the
reader actually produced. Any future report of "it didn't fill" now arrives as a diagnosis.

**Honest status:** this is the third round on the BMS reader, and on-device OCR of a coloured,
right-to-left, card-grid phone UI is at the hard end. Manual entry of all eight figures works and
the screenshot is the evidence either way — which is exactly what SRS D-5 guarantees.

---

## 2026-07-23 (latest) — a driver could never finish a shift

**309 domain + 246 API + 15 driver tests green, 6 guards green, all three projects redeployed.**

Reported as "stuck on the vehicle picker". It was three stacked defects, two of them total blockers
on the core flow — together they mean **the driver app had never been able to complete a shift end
to end in production.**

**1. The driver polled an endpoint he is forbidden to read.** After submitting his start package
the app polled `GET /shifts/:id/review` every 4 s waiting for the manager. That route is
`shift.approve` — branch manager, sysadmin, GM; **never `driver`**, who holds only `shift.operate`
at scope `own`. Every poll was a 403, the client swallowed it, and the phone sat on
«بانتظار اعتماد البداية» forever: the manager approved, the shift really opened server-side, and
the driver never found out. He could never record an order or close a shift.

The root cause was structural — of every shift route, `shift.operate` reached **only writes**.
There was no endpoint at all by which a driver could read the state of his own shift. Now
`GET /shifts/:id/state`, scoped by the existing `shiftSubject` so `own` means his and nobody
else's. It deliberately carries no BR1 causes: that ranked diagnosis is the manager's approval tool
(BR8). Both screens are now built from one shared snapshot so they cannot drift apart about what a
shift contains.

**2. A live shift was never resumed.** `/me/assignment` has always reported `liveShiftId` and
`liveShiftState`; **nothing read either**, and `StartPackage` could only ever *create*. So a driver
who closed the app, refreshed, or was thrown out by the 403 loop came back to a picker whose every
option `createShift` refuses with `driver_already_on_shift` — his shift existed, held its bike, and
was unreachable by the one person who could finish it. The app now resumes: the phase is derived
from the live state, and the evidence, odometer, the manager's float/top-up and the orders already
recorded all come back.

**3. His own shift made his own bike look taken.** `busy` ignored whose shift it was, so the driver
was told «على نوبة الآن» about his own bike with no way to tell and nothing to do. Now `busyByMe`,
and when every bike genuinely is out the screen says so instead of offering buttons that do
nothing.

Also: **a driver may discard his own shift while it is still `draft` or `awaiting_open_approval`**
— nothing has posted to the ledger at those states, and without it every stuck driver waits for
someone at the office. From `open` onward it stays manager-only, enforced by the same `cancelShift`.

And order entry survives a resume: `provider_order_no` is **globally unique**, so a retyped order is
a 409 — and `submitOrders` had **no catch at all**, so one rejection took the promise down, the
phase never advanced, and «تم» silently did nothing. It now posts only what is new and names what
would not save.

---

## 2026-07-23 — the fleet is modelled as machines, not as rows called "vehicle"

**309 domain + 229 API + 15 driver tests green, 6 guards green, migration 0007 applied to
production, all three projects redeployed.**

The schema described a *vehicle* but not a **machine**. It could not say where a bike sits in the
organisation, could not say that it carries two battery packs, and had nowhere to put what the
driver reads off a pack.

**«رقم الآلية»** is now `<governorate>-<branch>-<type>-<machine>` — the first motorbike of the
first branch in Damascus is `1-1-1-1`. Governorate did not exist anywhere in the repo; branches had
a text code but no number; `vehicle_types` had neither, and no route, no port method and no UI.
`vehicles.code` becomes the **written** result of `formatVehicleNumber` — deliberately not a
generated column, since the expression reaches across `branches` and `governorates`, the same
reason `business_date` is written. Renumbering a type restates every one of its vehicles' codes in
one transaction, which is why `vehicle_types` moved from `AUDIT_EXEMPT` to audited.

**Battery packs are rows, not columns.** They are the expensive consumable, they move between
bikes, and the BMS app shows a serial. How many packs a bike carries is `COUNT(*)` of the packs
fitted — never a number someone typed, so it cannot disagree with reality, and the BR5 gates read
the same fact: a two-pack bike cannot open or close on one screenshot.

**Per-shift BMS readings** hold percent, pack voltage, cycle count, capacities and three
temperatures per pack per end of the shift, as scaled integers (millivolts, deci-Ah, deci-°C),
never floats. `ocr_raw` keeps what the OCR read before correction, which is what finally makes
**SRS D-3** — the manual edit *and its difference from the OCR reading* — computable.

**Three things were already broken, and are fixed:**

1. **Adding a vehicle was impossible in production.** The console sent the literal string
   `'e_motorbike'` for a `uuid` foreign key (Postgres `22P02`), the UI swallowed the 500 and
   cleared the form as if it had worked, and the production bootstrap never created a
   `vehicle_types` row at all — that insert lived only in the demo seed, which refuses to run
   against production. No test caught it because the test adapter is a `Map` with no foreign keys.
2. **The end-of-shift battery was never gated**, and a blank field reached the server as
   `Number('') === 0` — "the driver did not answer" was indistinguishable from "the pack is flat".
   The manager was never shown it either.
3. **OCR was being fed the compressed image.** `compressImage` caps the long edge at 1280 px and
   drops quality to 0.4, putting a screenshot's body text under the LSTM's recognition floor. That
   was the single largest accuracy lever in the whole feature, and it sat upstream of every
   Tesseract parameter. Also fixed while there: a cached *rejected* worker promise that disabled
   OCR for a whole session after one transient failure; a 20 s timeout that exceeded the SRS's
   15 s budget and never cleared its timer; and `compressImage` returning its **largest** encode
   whenever the 300 KB budget was unreachable.

The BMS reader is genuinely hard and the tests say so: the English app is two-column, so one row
carries two label/value pairs; the Arabic app prints the value *before* its label; and several
labels carry a digit of their own — «Battery T2: 32.5C» was being read as 2 °C until the value was
taken from what remains after removing the label.

**Still open:** OCR accuracy on real phones is a calibration question no unit test answers. The
parser is pinned against transcriptions of both apps; the recognition itself needs a morning with
real screenshots on real drivers' handsets.

---

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
