# ASH Delivery — project context for every session

Operational-financial platform for a Damascus fleet-delivery business partnered with Yallago.
10 electric motorbikes today → 100 within a year. **This system moves real cash daily.
Production correctness beats speed.**

**Authority order:** [SRSv1.0.md](SRSv1.0.md) (authoritative, Arabic) → [CLAUDECODEKICKOFF.md](CLAUDECODEKICKOFF.md)
(delivery contract) → this file. If the SRS and the brief conflict, **stop and ask the product
owner** — do not pick one silently.

**Scope now — Bundle 1:** SRS sections A, B, C, E, F, G.
**Deferred — build clean seams, not features:** D OCR (drivers type numbers manually; photos are
evidence), H Yallago PDF reconciliation, I report builder (a *minimal ops dashboard* IS in scope),
J maps, K GPS, L battery, M push/anomaly, N accounting bridge.

---

## The eight business rules

**BR1 — the shift reconciliation equation.** At shift close:

```
actual_total = driver_cash_on_hand + driver_app_wallet_balance
expected_total = cash_float_given + wallet_topup_given
               + residual_after_per_order_yallago_cuts - cash_deductions
variance = actual_total - expected_total
```

The difference is still calculated and explained, but **it does not block the driver from submitting
the close package or the manager from settling it**. A non-zero variance belongs to the employee:
surplus increases the employee settlement and shortage reduces it. Manager approval then requires
an audited variance reason plus explicit confirmation that the complete wallet transfer and signed
cash transaction were both executed.

Canonical worked example, encoded verbatim in `packages/domain/test/br1/canonical.test.ts`:
float 100,000 + topup 50,000 (new SYP); 20 orders × 5,000 fee (12 cash, 6 electronic, 2 free)
→ end cash 160,000, end wallet 70,000; check: 230,000 == 150,000 + 0.80×100,000. ✔

**BR2 — no weekly settlement.** Yallago's 20% is deducted **instantly** from the driver's in-app
wallet (which the company tops up). The weekly Yallago PDF is a Bundle-2 audit artifact, never a
settlement mechanism.

**BR3 — three payment modes per order** — ⚠️ **RETIRED at the driver's screen (decision 8).** The
modes remain in the schema and on the wire, every order defaulting to `cash`; nothing asks for them
and nothing depends on them being right:
- `cash`: driver collects goods value + fee in cash; wallet −20% of fee (instant Yallago cut)
- `electronic`: nothing collected in cash; order counterpart lands in wallet (net +80% of fee)
- `free` (Yallago promo): wallet +80% of fee, funded by Yallago

**BR4 — fixed per-shift 40% share.** In the field, driver + company share (the residual after
Yallago's per-order 20% cuts) stays merged in the driver's hands/wallet. For every unapproved shift,
the driver earns `floor(40% × included Yallago delivery fees)` plus the driver shares explicitly
assigned to manual orders. The company absorbs rounding. Daily tiers and cross-shift true-ups are
historical-only and must never affect an unapproved shift.

**BR5 — shift gates, both ends.** Open requires: start package (odometer photo, battery %, float
amount, topup amount) + driver confirmation + branch-manager approval. The driver may submit a
complete end package regardless of the BR1 variance. Final approval requires branch-manager review,
the two settlement confirmations, a matching `settlementHash`, and a reason when variance is
non-zero. A `suspended` state exists for mid-shift incidents; data is completed later and the same
settlement applies.

**BR6 — currency.** Base = **new Syrian Lira** (1 new = 100 old — factor configurable). Reports
show SYP + USD equivalent using **one daily rate** entered each morning by the system admin and
applied to that entire day's transactions. Seed ≈ 130 new SYP/USD — seed only, never hardcoded logic.

**BR7 — financial week.** Closes every **Sunday** by explicit system-admin action. Locked entries
are immutable; corrections happen only via visible, dated correction entries.

**BR8 — visibility.** Total profits/shares: General Manager **only** — ⚠️ **amended by decision 9**:
the system admin sees them too. Branch manager: everything in his branch. Driver: his own shifts and
earnings only. Tier tables remain readable for approved historical shifts, but their editor and
publication path are retired for the active fixed-share policy.

**Historical tier table — not an active rule:** 0–14 → driver 35% · 15–24 → 40% · 25–34 → 43% ·
35+ → 46%. It is retained only to explain already-approved entries. The fixed 40% policy applies
independently to every shift that was not approved when the policy launched.

---

## Decisions already taken (do not re-litigate)

| # | Decision |
| --- | --- |
| 1 | **Financial week = Sunday 00:00 → Saturday 23:59** Asia/Damascus, closed the *following* Sunday. A shift worked on the closing Sunday belongs to the **new** week. |
| 2 | Infrastructure exists (GitHub, VPS, domain). **Staging goes live in M0**, not M6. |
| 3 | Old lira is **schema-ready only**: `settings.old_lira_factor = 100`, currency tag on every row, but all Bundle-1 UI is new SYP + USD. |
| 4 | ~~The wallet is zeroed each day, like the float.~~ **Superseded for all unapproved shifts by decision 13:** the complete actual wallet is swept at every shift close, with a signed `collect`/`fund` direction. |
| 5 | Manual entries & expenses: **branch manager ✓ + general manager ✓, sysadmin ✗** (SRS §3 matrix wins over the narrower E-3 prose). Stored as data. |
| 6 | ~~Tier band is computed over the whole day, with a visible day true-up.~~ **Superseded by decision 13.** Kept only as history for already-approved shifts. |
| 7 | Commercial scope re-cut: **Bundle 1a** = SRS A–G as priced; **Bundle 1b** = production readiness, separately priced. |
| 8 | **Pay mode is no longer collected** (SRS BR3 retired at the UI). The owner: *"we won't check each delivery how it got paid; we just check how much extra money we have in the wallet and the cash and compare to what he already worked."* BR1's scalar is blind to pay mode by construction — that is why `cashDiff`/`walletDiff` exist beside it — so the only thing lost is the ability to PREDICT the split, and the split was corroboration rather than a control: the wallet is evidenced by a photographed Yallago balance and the cash by a count at the branch. The driver's screen shows **the total only**. **Further amended by decisions 12–13:** deductions adjust expected total, Payments Log has no monetary effect, and all differences are settled rather than used as a zero gate. |
| 9 | **2026-08-12 — the system admin has every permission at scope `all`.** «اعطي صلاحية وصول لكل شيء لمدير النظام و صلاحية لفعل كل شيء», given twice in writing after the narrower rule was put to the owner. **Supersedes decision 5** (manual entries & expenses: sysadmin ✗) and **amends BR8**'s «رؤية الأرباح والحصص الإجمالية: المدير العام فقط». Five rows moved: `shift.operate`, `cash_count.perform`, `journal.manual.write`, `expense.write`, `profit.view_total`. Legitimate rather than an SRS violation: §3 / A-2 make the matrix explicitly sysadmin-customisable with every change logged, and `Permissions.tsx` already edits it as data — one row reverses it. `DEFAULT_GRANTS` only ever seeds a fresh database, so this also required migration `0024`: production was measured holding 11 of 16 for the sysadmin. **The SRS §3 transcription in `matrix.test.ts` stays byte-identical**; the deviation lives beside it as `OWNER_OVERRIDE_2026_08_12`, and a test asserts the override is exactly those five rows and nothing more. |
| 10 | **الترميم — the daily restoration** (2026-08-12). Office capital remains a fixed target per box and historical receivables still count toward it. ~~A new close shortfall may become a driver receivable and BR1 zero blocks ordinary approval.~~ **Superseded by decision 13:** a current-shift shortfall is settled immediately through the signed cash transaction and creates no receivable. |
| 11 | **Operation window** (2026-08-14): included Yallago rows fall within the inclusive branch-local interval from manager open approval through driver close submission. Ambiguous rows block approval until an audited manager decision; a driver cannot exclude a confirmed in-window row. |
| 12 | **Negative Recent Orders row** (2026-08-14): a timed negative row is one cash deduction, never an order, tier input, Yallago share, or wallet movement. Untouched OCR sightings match by known printed date + minute + OCR amount; route text only enriches evidence. This applies to current and legacy automatic keys. The older rule that excess becomes a receivable and that Payments Log rows affect money is superseded by decision 13. |
| 13 | **Fixed 40% cash settlement** (2026-08-14): every unapproved shift uses fixed 40%, with no tier or day true-up. Sweep the full actual wallet, apply surplus/shortage to the employee, and close the rest with exactly one signed cash transaction. No current-shift cash, wallet, share payable, or receivable may remain. Payments Log evidence is optional and archival only. Preview, ordinary approval, and exceptional close must use the same pure calculation and atomic posting recipe. |
| 14 | **Pre-approved shift opening** (2026-08-24): a manager may authorize one driver on explicitly selected local dates, within one inclusive same-day start window, with exact cash-float and wallet-top-up values. The driver must still submit and confirm the complete BR5 start package. A matching confirmation exercises the manager's advance signature through the ordinary opening gate and journal recipe, consumes the rule exactly once in the same transaction, and otherwise falls back to the normal approval queue. |
| 16 | **An order is its printed time and its cost** (2026-08-27): the canonical merge identifies a scanned row by `date + printed clock + value`, and route text no longer blocks a match. Two reads of one screen routinely disagree about the route — present on one page, absent or reworded on the next — so treating that as proof of two deliveries duplicated rows: shift `d0a5a7ec` carried **21 rows for 10 deliveries**, each duplicate stranding the driver's hand-corrected time on a row with no evidence left. The merge no longer requires a candidate to still hold sightings, which a retake empties by rotating the attachment token. Unchanged guards: `matchKey` is null unless date, clock and value are all present, so the **date still separates days** and a clockless page still cannot match; a `manual` row is never taken over by a reader; and the pairing stays one-to-one, so one page showing the same amount at the same minute twice still yields two operations. |
| 17 | **«السلفة» — an expense that must come back** (2026-09-01): «هوي صرفية دفعت لكنها يجب ان ترد كاملة». A third money instrument beside the صرفية and the ذمة: paid out to **any party named as free text** (driver, staff, workshop, supplier), recorded from the Expenses screen with a category, cost centre and receipt, and read from Treasury as its own line. **It is counted as office capital while outstanding**, exactly as a ذمة is, so الترميم moves nothing when one is paid or repaid; capital falls only when an audited decision converts the remainder into an ordinary صرفية, which writes a real `expenses` row. Repayment is a cash payment back into **the box the money left from**, and nothing else — no deduction from a shift settlement, so decision 13's snapshot is untouched. Each advance carries its own ledger fund keyed by the ADVANCE, never the party: the party has no id, and no figure may depend on two spellings of one name. **Supersedes ASSUMPTIONS A-16** and amends `SRSv1.0.md:62`/`:176`, which place «السلف» out of scope — the owner was shown that conflict and chose this deliberately; the instrument is party-agnostic and is not a driver salary system. |
| 15 | **Driver share comes from returned shift money, never company capital** (2026-08-24): at close the employee keeps or receives his settlement from the actual cash being returned. The office receives only the residual `actualCash - employeeSettlement`; the close does not post a company-capital withdrawal and daily restoration must not reinterpret the share as a capital shortfall. This clarifies, rather than replaces, decision 13. |
| 18 | **The owner's work schedule** (2026-09-17): morning 09:00–17:00, evening 18:00–02:00, and a double is **twelve hours**. Classification is automatic from the times, in `packages/domain/src/shift/worked-time.ts`: a **closed shift of at least 600 minutes is a double (`full`, target 720)**; anything shorter is its slot — morning (`day`) when it started before 15:00, evening when it started at/after 15:00 or between 00:00 and 03:59 — each with target 480. A running shift is `unknown` with its slot («جارية»); a close forgotten for more than 960 minutes keeps its slot and is not judged. `SHIFT_TARGET_MINUTES` is the only target table; no screen may keep its own. Supersedes the measured 15:00/22:00 classifier and the sixteen-hour double. |
| 19 | **Net profit** (2026-09-17): «صافي الربح هوي حصة الشركة ناقص الصرفيات». Net = company share + other income − (operating costs + **vehicle costs** + losses), computed by `classifyProfitLine` in `packages/domain/src/reporting/profit.ts`. A vehicle expense posts to `cost_center:<vehicleId>`; the old allowlist only matched a `vehicle:` prefix nothing writes, so vehicle costs were silently missing — measured on production 2026-09-17: none had been booked yet, so no historical figure changed. **Depreciation is never subtracted** — it is reported beside the profit. Owner capital accounts (`owner_funding`, `owner_drawings`, `opening_balance`) stay out. The dashboard reads any range through `LedgerRangeSource` (one aggregate, no week walk) and defaults to «الكل منذ البدء» (from the go-live date). Branch and company figures are reported separately once the company ledger lands (decision 21). |
| 20 | **Recurring expenses are due reminders, never automatic money moves** (2026-09-17). A template may recur weekly on a weekday, on the first of each month, or every N days from its start. Due occurrences are computed when read; no cron posts them and no unpaid occurrence row is generated. A human with `expense.write` explicitly pays or skips each occurrence. Pay writes the ordinary guarded expense and immutable occurrence link in one financial transaction; changing the amount or skipping requires a visible reason. Deactivation preserves earlier unresolved dues and resolved history. Receipt photos are immutable, content-addressed non-shift media referenced by id. |
| 21 | **«صندوق الشركة» is a separate dual-currency company ledger** (2026-09-17), available only through `company_fund.manage` to the general manager and system admin. A dedicated HQ branch row owns independent SYP and USD pockets; currency lives on each fund and every journal balances per currency. Exchanges record both actual amounts and freeze their implied rate. The old branch `company_box` becomes the company's clearing account at that branch: after an explicit cutover every movement is mirrored atomically under the branch→HQ lock order, and `branch company_box + HQ branch_clearing = 0`. Restoration may make company SYP negative, visibly, by owner decision. This amends BR6 and decisions 3 and 10; it does not merge branch and company books. |
| 22 | **Company debts and fixed assets** (2026-09-17). Debts run in both directions, carry no interest or planned instalment schedule, and every payment/write-off is an immutable event against one debt-specific fund. An asset keeps its purchase currency and may be paid from the company pocket, depreciation reserve, or outside by the owner; any unpaid purchase balance is one linked payable, so instalments live in the debt register. One asset may link to one vehicle; branch managers never see purchase price, instalments, outstanding balances, or book value. |
| 23 | **Straight-line depreciation and cumulative finance view** (2026-09-17). Every fixed asset has 36 monthly periods and period 1 is its purchase month. Book value is time-based (`price − scheduled depreciation due through the selected month`), including catch-up for existing vehicles. A manager button moves `min(due, available)` from the same-currency company pocket to «الاستهلاك», FIFO oldest period first; any shortfall remains due. This reserve may buy assets/pay instalments and may be released back with a written reason; releases and spending never reopen funded months. Depreciation is displayed beside net profit and never subtracted from it. The dashboard defaults to the cumulative go-live range and keeps branch, company, and combined results explicit. |
| 24 | **Public active driver signup is a narrow exception to `user.manage`** (2026-09-18). A logged-out caller may create only their own active account with the fixed `driver` role, one selected operating branch, and its linked driver identity. The server never accepts role, activation state, IDs, or extended profile fields. Creation and the eight-hour session commit together, with no invitation or approval. Abuse control is exactly three schema-valid submissions per normalized network address per rolling hour; `DRIVER_SELF_REGISTRATION_ENABLED=false` is the emergency stop. This exception grants no ability to list, edit, deactivate, or create another kind of account. |

---

## Money rules — non-negotiable

1. **Money is `bigint` minor units. Never a float, never a `number`.**
   1 minor unit = 1/100 new SYP = exactly 1 old lira.
2. **The 80% block is a RESIDUAL**: `Σfees − Σ(per-order 20% cuts)`. **Never** `0.80 × Σfees`.
   Multiply-and-round manufactures a false employee variance as soon as a fee is not divisible by
   5. The SRS example (all fees 5,000) hides this — the property tests deliberately do not.
3. **The company absorbs every rounding remainder**, never the driver and never Yallago. The fixed
   share is `floor(fees × 4,000 / 10,000)`; `companyShare = blockTotal − driverShare`.
4. **BR1 returns three differences, not one.** The scalar equation is blind to a pay-mode error:
   flip one order cash↔electronic and `scalarDiff` stays exactly 0 while cash is off by −fee and
   wallet by +fee. Always evaluate `cashDiff` and `walletDiff` too. They diagnose the variance;
   they do not prevent the employee from requesting close.
5. **`allocate()` refuses negative totals.** Signed deltas are always produced by *subtracting two
   allocations*, never by allocating a negative — that keeps the rounding direction unambiguous.
6. **The close settlement is one immutable snapshot.** In minor-unit arithmetic:
   `grossShare = fixed40Share + manualDriverShare`; `baseShare = grossShare − cashDeductions`;
   `variance = actualCash + actualWallet − expectedTotal`; `employeeSettlement = baseShare + variance`;
   `walletToOffice = actualWallet`; `cashToOffice = actualCash − employeeSettlement`. Positive cash
   means collect from the employee; negative means pay the employee. Deductions appear exactly once
   in expected total and exactly once in base share. The employee amount is retained/paid from the
   returned shift cash; it is not a debit to company capital.
7. **Payments Log evidence is optional and archival.** It never changes orders, expected value,
   wallet movements, shares, or settlement, and its absence never blocks close submission.
8. **An outstanding «سلفة» is office capital, not a shortfall.** Working capital is
   `office_cash + office_wallet + الذمم + السلف` in all four places that compute it: the dashboard
   read model, the restoration's own `positionsFor`, the go-live gate, and the guard inside
   PostgreSQL. Paying one moves that sum by exactly `0`. Only `advance_conversion` reduces it.
9. **Currency belongs to the fund, never to an untyped amount.** Company SYP and USD pockets are
   distinct accounts; every entry balances separately in each currency. The only cross-currency
   command is an exchange with two balanced pairs and one frozen `syp_minor_per_usd` derived from
   the two actual amounts. A USD posting without its frozen rate, or a SYP-only posting with one,
   is invalid.
10. **Branch and company ledgers never cross in one journal.** A branch money move that affects
    `company_box` is followed inside the same financial transaction by a separate HQ mirror, after
    locks are taken branch first and HQ second. Every committed cut-over branch must satisfy
    `balance(company_box) + balance(branch_clearing) = 0`.
11. **Every company journal has exactly one immutable command fact** (an asset purchase may also
    create its one linked payable). Historical facts are posted on today's open business date while
    retaining their real `occurred_on`/`purchased_on`; profit therefore follows posting date, and
    screens show both dates. No generic manual journal or generic reversal may manufacture an HQ
    movement.
12. **Depreciation is integer, exact and FIFO.** For price `P` over 36 periods, periods 1–35 are
    `floor(P / 36)` and period 36 receives the remainder, so the schedule sums exactly to `P`.
    Funding allocates oldest due periods first and moves only `min(due, available)`; it is a reserve
    transfer, never a P&L expense, and funded periods remain funded after reserve use or release.

## Time rules

- **`business_date` is a WRITTEN column**, fed by `businessDateFor()`. It is deliberately not a
  Postgres generated column: `(occurred_at AT TIME ZONE 'Asia/Damascus')::date` is `STABLE`, not
  `IMMUTABLE`, and Postgres refuses it there.
- **`week_start_date` is stored explicitly.** Never `date_trunc('week', …)` — that is ISO,
  i.e. **Monday**-based, and BR7 closes on **Sunday**. An off-by-one-day in exactly the place
  entries become immutable is the worst available failure.
- Asia/Damascus is UTC+3 year-round since Syria abolished DST in October 2022. The offset is
  **injected as a value** so the domain stays deterministic and backfilled pre-2022 data stays right.

## Database rules

- **Idempotency key is `(shift_id, event_type, occurrence_key)`** — *not* `(shift_id, event_type)`.
  SRS C-5 allows multiple float/top-up tranches per day; without `occurrence_key` the second
  tranche cannot post and an "idempotent replay" silently swallows it, so cash leaves the office
  with no ledger record.
- Double-entry balance is enforced by a **deferred** constraint trigger at COMMIT.
- Week-lock immutability is enforced **twice**: `REVOKE UPDATE, DELETE` from `app_user` *and* a
  trigger — on **both** `journal_entries` and `journal_lines` (a guard on entries alone leaves the
  amounts mutable).
- Historical tier resolution filters `status IN ('active','superseded')`, never `'active'` alone.
  This exists only to reproduce already-approved history; tier publication is disabled while the
  fixed-share policy is active.

---

## Architecture

```
packages/domain     ★ PURE. No dependencies, no I/O, no clock, no Intl, no framework.
                      All money math lives here and nowhere else.
packages/contracts    Zod schemas + ports (DashboardSource, BlobStore, Clock, …)
packages/adapters     fake/ (fixtures) + real/. OCR & PDF land here in Bundle 2.
packages/db           Drizzle schema, hand-written SQL migrations, repos, seed
packages/testkit      DB harnesses, fast-check arbitraries, builders
apps/api              Fastify 5
apps/admin            React 19 SPA, RTL-first
apps/driver           PWA, separate bundle, tight size budget
```

**Domain purity is enforced four ways**, not by convention: `"dependencies": {}` (asserted by
`scripts/check-domain-pure.mjs`), `"types": []`, TypeScript project references, and ESLint
`no-restricted-imports`/`no-restricted-globals`. The purity script is negative-tested — it
genuinely fails on a violation.

**Stack:** TypeScript 5.9 on Node 24 LTS · Fastify 5 · Zod 4 · PostgreSQL 17 · Drizzle · React 19 +
Vite · Tailwind 4 (logical properties only) · i18next (`ar` default) · Vitest + fast-check +
Testcontainers + Playwright · Caddy 2 · Docker Compose · GitHub Actions → GHCR.

## Conventions

- **Conventional commits**, small and focused. Code, identifiers, commit messages and engineering
  docs are **English**; the UI is Arabic-first.
- UI is **bilingual ar/en, RTL-first**. CSS uses **logical properties only** — CI fails the build
  on any `ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`.
- No human-facing strings in `packages/domain`. It emits cause **codes**; the UI resolves
  `br1.cause.<code>`.
- RBAC is **server-side**, per the SRS §3 matrix. UI hiding is not security.
- Audit log on every mutation (who, when, before/after).
- Config via `.env`; secrets never committed.
- **Never mark work done with failing tests. Never fabricate test output.**
- Every milestone ends with `PROGRESS.md` updated (done / next / risks) and a "see it in 2 minutes"
  demo note.

## Repo documents

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | this file — business rules + conventions, loaded every session |
| `ASSUMPTIONS.md` | every default taken instead of blocking on a question |
| `PROGRESS.md` | done / next / risks, updated at every milestone |
| `TESTS.md` | acceptance criteria #1–7, 9, 12 → named automated tests |
| `RUNBOOK.md` | deploy, rollback, restore, daily FX rate, Sunday close, onboarding |

## Commands

```bash
pnpm install
pnpm -r test                      # unit + property. No Docker required — the domain is pure.
pnpm typecheck
node scripts/check-domain-pure.mjs
```
