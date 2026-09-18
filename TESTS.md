# TESTS.md — acceptance-criteria traceability

Maps SRS §8 acceptance criteria to named automated tests. **#8, #10 and #11 belong to Bundles 2–3**
(Yallago PDF reconciliation, OCR, live GPS map) and are out of Bundle-1 scope.

A CI check fails the build when a test named here is renamed or deleted, so this table cannot rot.

**Legend:** ✅ implemented and green · ⚠ written but never executed · 🔜 planned, milestone named.

## 2026-09-18 driver self-registration

| Gate | Named test | Result |
| --- | --- | --- |
| The strict contract normalizes usernames, enforces password/username bounds and rejects privileged fields | `contracts/driver-registration.test.ts` | ✅ |
| Public branch listing excludes HQ; signup creates an active fixed-role driver, session and immediate ordinary driver access | `api/driver-registration.test.ts` — *lists only operating branches* / *creates an active driver…* | ✅ |
| Unknown/HQ branches, role/active/id injection, duplicate username/code, concurrent duplicate and authenticated callers fail by name | `api/driver-registration.test.ts` | ✅ |
| A lost signup response recovers through login; three business outcomes consume the window, malformed input does not, and the fourth returns stable `Retry-After` | `api/driver-registration.test.ts` — *supports lost-response recovery* / *counts three schema-valid business outcomes…* | ✅ |
| Separate addresses remain separate and IPv6 privacy addresses share a `/64`; proxy headers are trusted only on the Vercel/Caddy paths | `api/driver-registration.test.ts`, `api/registration-address.test.ts` | ✅ |
| User, driver, session and audit commit together or all roll back; PostgreSQL serializes concurrent claims and duplicate provisioning across repository instances | `db/driver-registration-postgres.test.ts` (5 cases) | ✅ PostgreSQL 17.6 |
| Login/register switching, required fields, normalized username, eight-character password and client-only matching confirmation stay wired | `driver/driver-registration.test.ts` | ✅ |
| Full repository and production-build gates | `pnpm check`: 3,190 passed, 18 expected PostgreSQL-only skips; `pnpm --filter @ash/driver build` | ✅ |

## 2026-09-18 finance and fleet redesign — P3/P4/P6 and C1–C6

| Gate | Named test | Result |
| --- | --- | --- |
| HQ is not a branch; its close needs no cash count and its trial balance is per currency | `api/company-branch.test.ts`, `db/migration-0065-0066.test.ts`, `db/company-ledger-postgres.test.ts` | ✅ |
| Company commands are actor-bound, immutable, dual-currency, rate-frozen, idempotent and cannot overdraw a protected pocket | `db/company-commands-postgres.test.ts` — *company_moves*, *company_expenses and company_incomes*, *company_fx_exchanges*, *company_reversals* | ✅ PostgreSQL 17.6 |
| Cutover moves the exact opening once; every later branch company-box movement has one exact HQ mirror and the invariant survives randomized activity | `db/company-commands-postgres.test.ts` — *cutover and the restoration mirror* | ✅ PostgreSQL 17.6 |
| Public company routes preserve permission, identity, balances, exchange, reversal and lock ordering | `api/company-finance.test.ts`, `api/company-fund.test.ts` | ✅ |
| Debt payments/write-offs, financed assets, 36 exact periods and FIFO depreciation are indivisible guarded commands | `domain/assets/depreciation.test.ts`, `api/company-finance.test.ts`, `db/company-commands-postgres.test.ts` | ✅ |
| Linked asset finance appears only to company managers in bounded vehicle history | `api/fleet.test.ts` — `GET /vehicles/:id/history (P6)`; `admin/vehicle-history.test.ts` | ✅ |
| Dashboard money stays bigint; all eight sections, filtered drills, fleet performance and branch/company/combined frozen-rate profit remain wired | `api/dashboard.test.ts`, `admin/dashboard-redesign.test.ts` | ✅ |
| Company recurring dues are read-only until a human pays/skips; a payment creates one HQ expense command; PostgreSQL enforces HQ and permission | `api/company-recurring.test.ts`, `db/recurrence-parity-postgres.test.ts` — *keeps company schedules in HQ…* | ✅ |
| Focused completion gate | API finance/dashboard/recurrence: 104/104; admin dashboard/company/recurrence/history: 27/27; PostgreSQL company commands + recurrence: 33/33 | ✅ |
| Full repository gate | `pnpm check`: every static check plus 3,168 passed tests; 17 expected PostgreSQL-only skips rerun separately where relevant | ✅ |

## 2026-09-17 P4 — recurring branch expenses and non-shift receipts

| Gate | Named test | Result |
| --- | --- | --- |
| The three schedule predicates, boundaries, due buckets and payment-date rule agree with brute force | `domain/expenses/recurrence.test.ts` (21 tests, including four fast-check properties) | ✅ |
| A due read creates no accounting row; pay and skip remain explicit, idempotent human decisions | `api/recurring-expenses.test.ts` (11 tests) | ✅ |
| Pay reuses the ordinary expense journal recipe exactly once, including after its week later closes | `api/recurring-expenses.test.ts` — *pays through the ordinary expense recipe exactly once* / *replays a committed payment before a newly closed week is revalidated* | ✅ |
| Receipt bytes are magic-byte checked, content-addressed and usable by manual and recurring expenses | `api/recurring-expenses.test.ts`, `api/expenses.test.ts`, `api/settings.test.ts` | ✅ |
| Memory and PostgreSQL repositories round-trip the same records and roll back with the financial unit of work | shared `testkit/conformance.ts` — *recurring expenses* (2 cases) | ✅ memory + PostgreSQL |
| The immutable SQL predicate agrees with TypeScript; invalid dates/deactivation/history edits and runtime mutation fail; audit rows exist | `db/recurrence-parity-postgres.test.ts` (3 cases on disposable PostgreSQL) | ✅ PostgreSQL 17.6 |
| The approved log / due / fixed-template tabs and all four explicit actions stay wired | `admin/recurring-expenses-wiring.test.ts` (3 source pins) | ✅ |

## 2026-08-26 closing-battery gate — the read the driver never saw

Full `pnpm check` passes **2,207 tests**. The regression had been live since 2026-08-14 and no test
caught it, because the only test over that path matched source text without executing it.

| # | What it pins | Named test | Result |
| --- | --- | --- | --- |
| B1 | The shape the API really sends (`{draft, rows, fields}`) yields a COMPLETE read, and the old expression throws on it | `linked-bms-read-state.test.ts` › *accepts the response shape the API really sends* | ✅ |
| B2 | The status is read for the requested slot, so one pack cannot suppress the other | `linked-bms-read-state.test.ts` › *reads the status of the requested slot, not of some other pack* | ✅ |
| B3 | A terminal failure reports its own reason, not a blanket `unavailable` | `linked-bms-read-state.test.ts` › *reports the server-recorded failure reason…* | ✅ |
| B4 | The decision never throws on any malformed payload — the defect was an exception, not a wrong answer | `linked-bms-read-state.test.ts` › *never throws, whatever the server sends* | ✅ |

## 2026-08-26 overlapping-scan gate — the duplicate hint and the read guard (`0045`)

Full `pnpm check` passes **2,201 tests** with the same 12 PostgreSQL-only skips. Each test below was
proven to fail before its fix; the domain detector was additionally mutation-checked — inverting the
maximal-overlap search, comparing magnitudes instead of signed amounts, letting an unread amount
match, and dropping the clock refutation each fail a distinct named test.

| # | What it pins | Named test | Result |
| --- | --- | --- | --- |
| D1 | The two rows ثائر photographed twice are found, and the match is labelled amount-only | `page-overlap.test.ts` › *finds the two rows photographed twice, and says the match is amount-only* | ✅ |
| D2 | The answer does not depend on which page is passed first, or on slot names | `page-overlap.test.ts` › *does not care which page it is handed first* | ✅ |
| D3 | A deduction never matches an order of the same magnitude | `page-overlap.test.ts` › *keeps a deduction distinct from an order of the same magnitude* | ✅ |
| D4 | A disagreeing clock or route refutes; a missing one is neutral | `page-overlap.test.ts` › *is refuted by a printed clock that disagrees* | ✅ |
| D5 | Pairs are a contiguous suffix/prefix run of equal amounts (fast-check) | `page-overlap.test.ts` › *pairs are a contiguous suffix/prefix run of equal amounts* | ✅ |
| D6 | The manager's review names both duplicated orders and the page each came from | `scan-page-overlap.test.ts` › *names the two rows the second photo repeated…* | ✅ |
| D7 | **The hint changes nothing** — br1, ordersHash, every `included`, every decision field | `scan-page-overlap.test.ts` › *changes no money, no inclusion and no hash by being there* | ✅ |
| D8 | A page read twice is still one page, not ten rows | `scan-page-overlap.test.ts` › *reads a twice-read page as one page, not as ten rows* | ✅ |
| D9 | The hint never reaches the driver's own shift state | `scan-page-overlap.test.ts` › *keeps the hint off the driver-facing shift state* | ✅ |
| D10 | The hint component has no button, no `revise(`, no `included` | `approval-duplicate-hint-wiring.test.ts` › *never lets the hint itself change an operation* | ✅ |
| D11 | The incident replayed: a second read writes no row and no sightings | `close-draft-repeat-read.test.ts` › *replays the incident: a second read of the same photo changes nothing* | ✅ |
| D12 | Two in-flight reads of one photo coalesce | `close-draft-repeat-read.test.ts` › *coalesces two in-flight reads of the same photo* | ✅ |
| D13 | A genuinely failed read is still retryable; a replaced photo is a new page | `close-draft-repeat-read.test.ts` › *still allows a retry after a failed read* | ✅ |
| D14 | Where two reads do land, `clientKey` still collapses them to one order per row | `close-draft-repeat-read.test.ts` › *still collapses duplicate sightings to one order per row…* | ✅ |
| D15 | `0045` is an index and a comment — never a UNIQUE index or a raising trigger | `migration-0045.test.ts` › *never turns the invariant into a constraint that could abort a deploy or a close* | ✅ |

**CI-only:** the `PgCloseDraftRepo` half of `listObservationsByShift` and the SQL guard inside
`saveRead` run only against real PostgreSQL. There is no local Postgres on the build machine.

## 2026-08-26 live release gate — attachment-bound OCR and funding (`0041`–`0044`)

Release commit `5d76a539af517a914c59a455cdc8c2d3bafb4ce6` passed the full local Node 24
`pnpm check`, both front-end production builds, and the standalone API build. GitHub Actions run
[`32909487259`](https://github.com/Badee-Salloum/ash-delivery/actions/runs/32909487259) passed all
three jobs, including the disposable PostgreSQL 17 migration/guard suite. The final major suites
include API 724/724, driver 301/301, shared client 284/284, and admin 157/157.

| Gate | Production / restore evidence | Result |
| --- | --- | --- |
| Migration identity | exactly 0041–0044; checksums `71092d71`, `41a5736c`, `f9b1273d`, `ef30d32e`; idempotent rerun 0 applied / 44 present | ✅ |
| Pre/post preservation | 60 tables; 59 business fingerprints equal; 6,233 → 6,237 rows, exactly four migration rows | ✅ |
| Ledger and guards | trial balance 0; all user triggers enabled; runtime cannot TEMP, mutate journal rows, or delete rules | ✅ |
| HTTP release | health 200, direct and proxied auth 401, both SPAs/fallbacks/proxies, manifest, service worker, and exact bundles | ✅ |
| Restore | 6,237/6,237 rows; 60/60 fingerprints; 27/27 sequences; rollback probe left audit and data unchanged | ✅ |

The post-release production audit has one explicit non-zero group: five `unresolved_operations` on
Thaer's submitted shift `4f40640e-e8dd-4966-b547-d20656136fde`. All five are `unknown` and excluded;
the other 16 integrity groups are zero. The restore reproduces the same baseline exactly. This is a
manager-review queue, not a ledger mismatch, and the release did not fabricate timestamps or money
to make the checker green.

## 2026-08-25 incident gate — the shift-close failures of 2026-08-24

Five drivers could not submit their close; four shifts were force-cancelled, discarding 4,325 SYP of
deliveries. Full `pnpm check` passes **2,123 tests** with the same 11 PostgreSQL-only skips.

| # | What it pins | Named test | Result |
| --- | --- | --- | --- |
| C1 | A refused close always names a reason — the regression that trapped امجد | `close-gate.test.ts` › *names an unsaved draft instead of disabling the button in silence* | ✅ |
| C1 | Readiness is the blocker list being empty, and the panel renders on `!ready` | `close-gate.test.ts` › *the screen cannot re-open the silent-refusal hole* (proven to fail if either half returns) | ✅ |
| C1 | Every single-cause refusal produces at least one named reason | `close-gate.test.ts` › *never refuses without a reason, across every single-cause case* | ✅ |
| C2 | «٧٠٠٠٠» off an Arabic keyboard is usable, not merely diagnosed | `numerals.test.ts` › *money text the wire can actually accept* | ✅ |
| C3 | An excluded deduction row stops blocking, exactly as the server already allowed | `order-entry.test.ts` › *exempts an excluded row exactly as the server does* | ✅ |
| C4 | The archival field keeps headroom back for the readings BR5 requires | `ocr-read-budget.test.ts` › *keeps headroom back from the archival field, and only from it* | ✅ |
| C4 | One default for the read cap — no route re-states it | `ocr-read-budget.test.ts` › *has exactly one default, and no route re-states it* | ✅ |
| C5 | A spent budget is named as such, not as an outage | `ocr-read.test.ts` › *stops calling out at the cap and names the spent budget instead of an outage* | ✅ |
| C6 | Every read is bounded, not just the battery one | `linked-bms-escape-wiring.test.ts` › *bounds a read even when the caller brings no lifetime of its own* | ✅ |
| C7 | Voiding states what it destroys and offers force-close | `void-guard.test.ts` › *voiding a shift states what it destroys* | ✅ |
| C7 | An unknown order count is treated as dangerous, not as zero | `void-guard.test.ts` › *treats an unknown count as dangerous, not as zero* | ✅ |

**Verified against production Postgres 17, read-only:** the root cause (`500` vs `500.00`) is
confirmed by `644306a`'s own commit message; its deployment before the 01:2x window is confirmed by
`bms-prompt-v2` cache signatures appearing in `ocr_reads` from 01:26.

## 2026-08-25 review gate — four confirmed findings, and one the fix itself uncovered

An adversarial review of the 15 Codex commits produced 18 candidates; 14 were refuted and 4
confirmed. Fixing them surfaced a fifth. Full default `pnpm check` passes **2,101 tests** with the
same 11 PostgreSQL-only skips (no Docker or local Postgres on this machine — CI is their gate).

| Package | Tests |
| --- | ---: |
| Domain | 433 |
| Contracts | 29 |
| Shared client | 277 |
| Admin | 153 |
| Driver | 274 |
| Adapters | 133 |
| Database, default run | 92 passed / 11 skipped |
| API | 710 |

| # | What it pins | Named test | Result |
| --- | --- | --- | --- |
| F1 | A deferred collection funds the next shift instead of being paid back as a surplus | `receivables.test.ts` › *carries a deferred collection into the next shift instead of paying it back as a surplus* | ✅ |
| F1 | The deferral postings land in the shift-funding funds, never the ordinary debt funds | `cash-settled-approval.test.ts` › *books a deferred collection as next-shift funding, never as an ordinary debt* | ✅ |
| F1 | The close settlement writes the funding funds end to end over HTTP | `settlement.test.ts` › *supports combined partial cash/wallet deferral, exact replay, and immutable hash binding* | ✅ |
| F2 | A driver cannot type a charge onto a pack he declared unreadable | `state.test.ts` › *refuses a percent the driver typed onto a pack he declared unreadable* | ✅ |
| F2 | The same hole is closed at the CLOSE gate, where the money is | `state.test.ts` › *closes the same hole at the END gate, where the money is* | ✅ |
| F2 | The driver route refuses the contradictory shape and a claimed manager source | `battery-app-wont-run.test.ts` › *refuses a driver who declares a pack unreadable and then types a charge for it anyway* · *refuses a driver claiming the manager as the source of his own reading* | ✅ |
| F2 | A manager-completed pack still opens the shift — the legitimate case survives | `state.test.ts` › *and once the manager supplies the charge, the shift opens* | ✅ |
| F3 | An invisible decision reason is not an audit trail, and real Arabic is unaffected | `decision-reason.test.ts` › *a decision reason must contain something a human can read* | ✅ |
| F4 | Every integrity check parses and executes against the real migrated schema | `shift-money-integrity-script.test.mjs` › *parses and executes all fifteen, plus both hash checks* | ⚠ CI-only (needs `DATABASE_URL`) |
| F4 | A clean ledger reports clean, not merely "ran" | `shift-money-integrity-script.test.mjs` › *reports a clean database as clean rather than merely running* | ⚠ CI-only (needs `DATABASE_URL`) |
| F5 | Only the void's own carry reversals count as its corrections | `shift-money-integrity-script.test.mjs` › *counts only the void carry reversals as corrections, not every correction on the shift* | ✅ |
| — | A failed OCR pass says WHICH kind of nothing it got | `chat-completions-ocr.test.ts` › *says WHICH kind of nothing it got when the model returns an empty transcription* · *names an out-of-enum screen kind* | ✅ |

**Executed against production Postgres 17, read-only, 2026-08-25:** all 17 integrity checks run and
report 0 violations; the replacement `shift_close_journals_match` returns `true` for all 4 settled
shifts, agreeing with the installed one; 0 rows would violate either new CHECK constraint.

## 2026-08-23 release gate — receivables, restoration, and editable targets (`0036`–`0039`)

Application artifacts were frozen at commit `1407676b9802382b926b9b4f07f59636cb0ea0ee` and tested
under Node `24.19.0`. The full default `pnpm check` passed **1,998 tests** with 11 expected
PostgreSQL-only skips:

| Package | Tests |
| --- | ---: |
| Domain | 429 |
| Contracts | 19 |
| Shared client | 263 |
| Admin | 136 |
| Driver | 263 |
| Adapters | 130 |
| Database, default run | 83 passed / 11 skipped |
| API | 675 |

The required fresh disposable-PostgreSQL rerun executed 27/27 database test files and passed
**141/141 with zero skips**. Fresh migrations applied 39/39; the immediate checksum rerun applied
zero and found all 39 present. Release checksums are `0036 adbfc150`, `0037 5fdf1556`,
`0038 b2dd47f0`, and `0039 ec71e10c`. Both frontend production builds, the standalone API bundle,
and all three Vercel production builds passed.

Automated coverage includes ordinary and shift-funding receivables in both cash and wallet, direct
driver assignment without a shift, automatic next-shift carry, exact/concurrent/conflicting event
retries, immutable settlement and force-void journals, deferred money and battery review, zero
opening funds, expense atomicity, receivable-aware restoration, editable capital targets, negative
physical-cash rejection, restoration/target actor guards, journal metadata coupling, and the full
17-check read-only money-integrity audit. Dashboard coverage retains exact-`open` counts, suspended
exclusion, cross-midnight and branch isolation, distinct actors, polling, branch switching, and
stale-value preservation.

Production migration and smoke evidence is also green: writes were paused and drained to two
zero-activity samples; migrations `0036`–`0039` applied in order; runtime guard probes rolled back;
API, auth, both proxies, PWA manifest/service worker, protected routes, and exact deployed assets
passed. Exact 390×844 driver and 1024×768 admin browser smokes had no horizontal overflow. Final
production state is schema 39/head 0039, working `0/0`, trial balance zero, and zero integrity
violations.

The 59-table / 4,002-row post-release backup was restored end to end into the explicitly identified
Neon scratch database `ash_restore_0039_20260823_1337`. All 59 canonical table fingerprints matched;
all 27 serial/identity sequences were positioned at `max + 1` with `is_called = false`; no user
trigger remained disabled; trial balance and all 17 integrity checks were zero. The rehearsal found
that the old restore loop made 652 Neon HTTPS calls while probing every column. The checked-in fix
uses one catalog lookup and one reset statement; five focused regressions pass. The current HEAD
full gate therefore passes **2,003 tests**, with the same 11 expected non-database skips. Once Neon
reported zero remaining sessions, the exact scratch database was dropped and confirmed absent; no
production row was changed by the rehearsal.

The remaining acceptance case is deliberately live, not simulated: the next ordinary staff shift
must show `0/0 → 1/1` within eight seconds and reverse on end submission, then independently prove
the fixed 40% settlement, one immutable settlement, one decision, matching hashes, balanced
journals, and zero remaining shift cash/wallet/share/receivable balances.

## 2026-08-23 same-day battery-close hotfix

The hotfix is frozen in commits `cee0fca`, `0699581`, and `512b6bf`. Node `24.19.0` full
`pnpm check` passed domain 425, contracts 12, shared client 257, admin 93, driver 263, adapters 121,
and API 649. The local database package passed 63 tests and skipped 8 because no `DATABASE_URL` was
available. Both frontend production builds and the standalone API bundle passed.

The new regressions cover both halves of the hang instead of assuming every promise eventually
settles:

- `api/ocr-read.test.ts` and `adapters/chat-completions-ocr.test.ts` prove that the API-owned BMS
  deadline aborts provider work and returns a terminal timeout even when the provider would stall.
- `driver/linked-read-task.test.ts` advances the clock against a never-resolving request, proves
  immediate manual cancellation, and ignores a late answer.
- `driver/linked-bms-escape-wiring.test.ts` proves that cancellation reaches the linked read and
  evidence-bound battery write, restores only the request-owned pending marker, preserves the
  accepted photo, and exposes the escape only on the end-BMS flow.
- `client/api-abort-signal.test.ts` proves that the same `AbortSignal` reaches both HTTP requests.
- `api/close-draft-adversarial.test.ts` proves an excluded unpriced OCR ghost remains evidence but
  does not block materialization of real priced orders.

Incident evidence is narrower than a successful close: Thaer's close-draft OCR held 47% and 36
cycles, while the per-pack end row remained null/`unavailable` after the linked read/persist
lifecycle stalled. His close draft also held complete values and an excluded unpriced OCR ghost,
which the previous money-completeness check rejected. Tests and production deployment verify the
fixes; they do **not** prove that the live shift closed or that the stored battery row was repaired.

The hotfix contains no database code or migration. The prior disposable-PostgreSQL 17.11 evidence
remains 108/108 with zero skips; it was not rerun and must not be relabelled as a hotfix database
run. A production read-only post-deploy recheck was attempted but the local Neon connection ended
with `ECONNRESET`. Stable index, manifest, service worker, and API-proxy smokes still returned 200,
so the transport failure is not recorded as an application-health failure or a successful database
check.

## 2026-08-23 release gate — dashboard working counts and shift-close integrity

All release-gate commands ran under Node `24.19.0` / pnpm `11.3.0`. The frozen-install full
`pnpm check` plus the required real-PostgreSQL rerun passed **1,916/1,916 tests**:

| Package/gate | Tests | Result |
| --- | ---: | --- |
| Domain | 425 | ✅ |
| Contracts | 12 | ✅ |
| Shared client | 256 | ✅ |
| Admin | 93 | ✅ |
| Driver | 256 | ✅ |
| Adapters | 119 | ✅ |
| Database on disposable PostgreSQL 17.11 | 108 | ✅, zero skips |
| API | 647 | ✅ |

Both frontend production builds and the API bundle passed. Fresh migrations `0001`–`0035` applied
35/35, then the checksum rerun applied 0 and found all 35. The disposable SQL guard harness passed.
Checksums: `0034` FNV `5bc30a31`, SHA-256
`228F090D8FCF2DC0CA1B7EDF6FA500D679CA19ED9E388D2DE9054B7EE2E8659A`; `0035` FNV `087c01d4`,
SHA-256 `D3958FCABB4886E390DBCD969E8BFA1241265A8CA661A843C80FA51176ECEF40`.

Automated coverage includes exact-open/suspended/terminal state counts, distinct actors, branch and
cross-midnight isolation, polling/branch-switch/failure preservation; zero/blank/positive/mixed
opening tranches; exact/concurrent/conflicting mid-shift retries and successful close after retry;
balanced/surplus/shortage/negative-wallet/manual-order/cash-deduction/rephoto/stale-hash/
lost-response/two-phase-force-close flows; inclusive cross-week profit and variance exclusion; and
direct PostgreSQL variance-reason plus near-bigint rejection. A twice-seeded release database passed
all 14 permanent read-only money-integrity checks.

The isolated browser flow passed English/Arabic at 390/768/1280 px: `0/0 → 1/1` in 7,516 ms,
stale failure preserved `1/1`, recovery in 7,693 ms, and end submission returned `1/1 → 0/0` in
7,786 ms before approval. Grid columns were 2/3/6, no overflow or page errors occurred, and seven
lightweight polls did not periodically reload financial dashboard endpoints.

During the historical `0035` rollout, the pre/postflight checker detected three cancelled
2026-08-11 shifts with tranches `300,000`/`30,000` but journals
`30,000,000`/`3,000,000` minor units. A separate backup query confirmed the exact 100× history, and
the owner accepted exactly those rows for that rollout. They were not repaired or hidden. Their IDs
are `0df7c7f1-105c-40b3-97ec-3fc81f83874c`,
`f51cd7a1-ffa5-4e72-b0e4-a1761531b11b`, and `b81ad711-835b-479a-8ee1-37105ca96c21`. The rollout
then completed with the exception set unchanged. This paragraph is historical evidence, not the
current release status: the `0039` production checker reports zero violations and no live row was
rewritten. Validated `0035` backups contained
58 tables / 3,852 pre-migration rows and 58 / 3,853 post-migration rows. Production smokes passed,
and the post-backup restore reproduced all 3,853 rows and every table fingerprint with 27 safe
sequences, no disabled triggers, zero unbalanced entries, and a clean rollback probe. The two shifts
open during deployment remain the real-staff close acceptance cases. The checked-in restore utility
is Neon-HTTP-only, so the localhost rehearsal used a temporary out-of-repository `pg` adapter; a
portable checked-in local restore mode remains deferred.

### Driver end handoff follow-up

Regression coverage now proves that a driver can submit a non-zero money result and can explicitly
defer incomplete end-battery evidence to the manager in the same request. The API test uses two
packs: one valid attachment/reading is preserved, while the unlinked pack becomes a null,
`unavailable: true` manager obligation. It verifies working counts `1/1 → 0/0`, a
`pending_review` state, failed ordinary approval, manager reading completion, and successful final
approval. A no-flag request retains the historical strict battery gate, and domain tests retain the
strict start and manager gates. Driver tests prove that mismatch/battery conditions create visible
review warnings and never enter the end screen's blocking list; active reads, unsaved drafts, other
required evidence/values, invalid operations, and odometer confirmation still block.

| # | Criterion (SRS §8) | Test | Status |
| --- | --- | --- | --- |
| **1** | A shift cannot open before the start package is complete, the driver confirms, and the branch manager approves | `shift/state.test.ts` › "the OPEN gate (BR5, AC #1)" (5 cases) | ✅ |
| | | `api/lifecycle.test.ts` › "will not open without the odometer photo" / "will not open before the branch manager approves" | ✅ |
| **2** | A driver may submit a nonzero result for review; final approval requires BR1 zero or an application-validated settlement, plus branch-manager approval | `br1/canonical.test.ts` › "closes the zero equation exactly" · `br1/property.test.ts` › "closes at exactly zero for any mix" | ✅ |
| | | `shift/state.test.ts` › "the CLOSE gate (BR5, AC #2)" (9 executed cases) | ✅ |
| | | `api/lifecycle.test.ts` › "submits and settles when the equation is not zero, while still explaining the difference" | ✅ |
| | | `api/lifecycle.test.ts` › "the SRS §2.3 shift, end to end over HTTP" | ✅ |
| | | `shift/lifecycle.e2e.ts` — the same, through the real **UI** | 🔜 M3 |
| **3** | A cash order deducts 20% of its fee instantly from the driver's wallet to the Yallago fund | `br1/canonical.test.ts` › "reproduces the SRS table row for row" · "splits at approval" | ✅ |
| | | `ledger/recipes.test.ts` › "yalago_share accumulates the 20,000" | ✅ |
| **4** | An electronic or free order adds 80% of its fee to the driver's wallet | `br1/canonical.test.ts` › "reproduces the SRS table row for row" | ✅ |
| | | `ledger/recipes.test.ts` › "SRS §2.3 walked through the ledger" | ✅ |
| **5** | Σ debits == Σ credits across every entry of any day | `money/allocate.test.ts` › "driver + company + yalago === feeTotal, exactly" | ✅ |
| | | `ledger/recipes.test.ts` › "every posting balances under random event streams" (400 runs) | ✅ |
| | | `db/verify-guards.sql` › guard 1 — rejected at COMMIT by Postgres | ✅ PostgreSQL 17.11 |
| **6** | The day's rate applies to all that day's transactions **and the USD equivalent appears in reports** | `fx/rate.test.ts` › "USD equivalence (BR6, AC #6)" (6 cases) + "resolving the day's rate" (5 cases) | ✅ |
| | | `fx/usd-display.itest.ts` — the *second half* of the criterion, easy to miss | 🔜 M5 |
| | | `api/auth-rbac.test.ts` › "only the system admin may set the daily rate" | ✅ |
| **7** | The daily band is computed automatically from the order count, changes only the company's share, and only the sysadmin may edit it | `tier/bands.test.ts` › "band boundaries — 14/15, 24/25, 34/35" (9 cases) | ✅ |
| | | `tier/bands.test.ts` › "the company absorbs the rounding remainder, never the driver and never Yallago" | ✅ |
| | | `rbac/matrix.test.ts` › "the General Manager may NOT edit tier rules" | ✅ |
| **9** | The Sunday close blocks any edit to that week's entries except via a visible correction entry | `shift/state.test.ts` › "immutability after the week lock" | ✅ |
| | | `db/verify-guards.sql` › guards 3, 5a, 5b, 5c — `REVOKE` *and* trigger, entries **and** lines | ✅ PostgreSQL 17.11 |
| | | `ledger/recipes.test.ts` › "corrections (BR7)" | ✅ |
| **12** | Total profits are visible to the General Manager only; a branch manager sees only his branch | `rbac/matrix.test.ts` — every role × every permission, 93 generated cases | ✅ |
| | | `shift/state.test.ts` › "RBAC on transitions" | ✅ |
| | | `api/auth-rbac.test.ts` › "RBAC over HTTP" (7 cases, every role × protected route) | ✅ |
| | | `rbac/visibility.e2e.ts` — through the real UI | 🔜 M5 |

---

## Business rules → tests

Acceptance criteria do not cover every rule. BR2 in particular is encoded *by absence* — nothing
accrues weekly — which is exactly the kind of thing that silently regresses.

| Rule | Test | Status |
| --- | --- | --- |
| BR1 zero equation | `br1/canonical.test.ts`, `br1/property.test.ts` | ✅ |
| BR1 pay-mode blind spot | `br1/canonical.test.ts` › "the pay-mode blind spot" · `br1/property.test.ts` › "flipping any order cash↔electronic" | ✅ |
| BR1 cause breakdown | `br1/canonical.test.ts` › "difference breakdown — the arithmetic signatures are distinguishable" | ✅ |
| BR2 no weekly settlement | `api/lifecycle.test.ts` — yalago_share lands per order at approval; there is no weekly accrual recipe to call | ✅ |
| BR3 three payment modes | `br1/property.test.ts` (all three generated) | ✅ |
| BR4 80% block + company absorbs remainder | `money/allocate.test.ts` › "the company absorbs the rounding remainder" | ✅ |
| BR5 both gates | `shift/state.test.ts` (30 cases) | ✅ |
| BR6 daily FX, one rate per day | `fx/rate.test.ts` (11 cases) | ✅ |
| BR7 close pre-flight blockers | `week/close.test.ts` (15 cases) | ✅ |
| B-1 document expiry / B-3 assignment binding | `fleet/documents.test.ts` (24 cases) | ✅ |
| BR7 Sunday week, Sunday→Saturday | `time/civil.test.ts` › "financial week — Sunday → Saturday" (7 cases) | ✅ |
| BR7 non-Sunday week start refused by the DB | `db/verify-guards.sql` › guard 4 | ✅ PostgreSQL 17.11 |
| BR8 visibility limits | `rbac/matrix.test.ts` (93 cases) + `api/auth-rbac.test.ts` | ✅ |
| A-1 auth: 5-attempt lockout, 30-min idle sessions | `api/auth-rbac.test.ts` › "authentication" (9 cases) | ✅ |
| Every route declares a permission (boot assertion) | `api/auth-rbac.test.ts` › "the boot assertion" (3 cases) | ✅ |

## Invariants proven by property test

| Property | Test | Runs |
| --- | --- | --- |
| P-A — the 80% block is a residual; `block + yalago === feeTotal` for any basket | `money/allocate.test.ts` | default |
| P-B — `driver + company + yalago === feeTotal` for any fees **and any band rate** | `money/allocate.test.ts` | default |
| P-C — BR1 closes at zero for any mode mix, any fees, any tranche count | `br1/property.test.ts` | 500 |
| P-D — a pay-mode flip leaves `scalarDiff` at 0 and moves the split by ±fee | `br1/property.test.ts` | 500 |
| P-E — dropping an order moves `scalarDiff` by exactly that order's block | `br1/property.test.ts` | 500 |
| P-F — tier split exhaustive in **both** whole and marginal modes | `tier/bands.test.ts` | 300 |
| P-G — every date falls in a 7-day window starting on a Sunday | `time/civil.test.ts` | default |
| P-H — every posting balances under random event streams | `ledger/recipes.test.ts` | 400 |
| P-I — the ledger's driver balances always equal what BR1 expects | `ledger/recipes.test.ts` | 400 |

**Seed policy:** fixed seed on PRs for reproducibility; a nightly job re-runs with a randomised seed
and files an issue on failure. Every shrunk counterexample is frozen as a named regression test —
`money/allocate.test.ts` › "REGRESSION: the naive 0.80 × Σfees formula really does diverge" is the
first of these, and it is the reason the residual rule exists.

## Not a coverage number

Line coverage on a pure arithmetic module lies: it is trivially 100% while the assertions are weak.
The domain package is gated on **mutation score** instead (Stryker, `packages/domain` only) — cut
from the CI gate to a manual M6 run under the agreed cut list, but the property suites above are the
real protection either way.

## Current state

```
domain       430 tests
contracts     19 tests
client       264 tests
admin        148 tests
driver       265 tests
adapters     130 tests
database      89 passed / 11 skipped by default; 141/141 on disposable PostgreSQL at release
api          696 tests
```

### 2026-08-24 feature regressions

- `api/preapproved-shift.test.ts` (21 cases) covers custom-date CRUD and scope, real-date and money
  validation, inclusive boundaries, nonmatches, complete evidence, manager BMS handoff, current
  carried funding, revoked permissions, rule/journal rollback, single use, and automatic/manual
  approval races. It also rejects malformed identifiers without reaching PostgreSQL, hides
  out-of-branch driver identities, refuses a rule signed after driver confirmation, and proves an
  auto-open response contains the exact approved funding and odometer needed by the driver app.
- `db/migration-0036-0037.test.ts` statically pins migration `0040`'s publication shape, active
  actor/driver, immutable terms, advance-signature ordering, scoped consumption identity,
  inclusive window, overlap lock, audit trigger, and delete/truncate revocation. [CI run
  32737035699](https://github.com/Badee-Salloum/ash-delivery/actions/runs/32737035699) applied it in a
  fresh `0001`–`0040` PostgreSQL 17 gate before production deployment.
- `admin/preapproved-shifts.test.ts` and `client/preapproved-shifts.test.ts` cover manager-only
  navigation, form semantics, rule status and branch-scoped API wiring.
- `driver/opened-shift.test.ts` proves an immediate auto-open creates complete local running-shift
  state with the confirmed opening odometer even though no waiting screen existed first, and that
  a later poll preserves the restored opening odometer.
- `admin/completed-shifts.test.ts` (8 cases) covers valid/leap/impossible/bounded ranges,
  `approved`/`week_locked` classification, separate cancellation history, navigation, branch reads,
  detail opening, and bilingual copy.
- `domain/ledger/cash-settled-approval.test.ts` names the capital invariant directly: driver share
  is paid from returned shift money, office cash + wallet net to company share, the payable clears,
  and no `company_box` posting exists.

The 2026-08-24 local `pnpm check` passed **2,041 tests** with 11 expected PostgreSQL-only skips.
Both frontend production builds and the API bundle also passed. Node 25.8 emitted the documented
engine warning because production is pinned to Node 24.

The release database evidence is 141/141 on a positively identified disposable PostgreSQL database,
with zero skips. Destructive conformance and guard suites were never pointed at production. The 11
default skips remain stated rather than folded into the real-database result. Production and the
restored post-release backup both pass all 17 permanent read-only integrity checks with zero
violations.

Run the full gate with `pnpm check`.
