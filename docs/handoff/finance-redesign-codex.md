# HANDOFF — Finance & fleet redesign (for Codex or any engineer finishing this work)

> Self-contained brief. Read it top to bottom before touching code. Then read `CLAUDE.md` (project rules —
> they are binding) and open `docs/design/2026-09-redesign/index.html` in a browser (the approved mockups).
> Branch: **`feat/finance-redesign`** (created from `fix/overlapping-dashboard-scans` @ `f953906`).
> Last updated: 2026-09-18 by Codex (see §3 for the live status checklist).

---

## 0. Hard rules (non-negotiable)

1. **This system moves real cash daily.** Production correctness beats speed. Money is `bigint` minor units,
   never `number`/float. Read `CLAUDE.md` §"Money rules" and §"Database rules".
2. **Never deploy to production, never run migrations against production, never write to the production
   database** without the owner's explicit written go-ahead. The production Neon URL is NOT for tests.
3. **Never modify anything under `C:\Users\Badee Salloum\Desktop\ASH deliver cal`** (the Telegram bot). Owner order.
4. **No direct SQL repairs** of shift/ledger data (RUNBOOK). Everything goes through the API.
   (One owner-ordered exception already happened — see memory note: shift `3ccda1d3…` has
   `open_approved_at = window_opens_at = 2026-09-11T16:00Z` on purpose. Do not "fix" it.)
5. Migrations are **forward-only and checksum-locked** (`packages/db/src/migrate.ts`). Never edit a migration
   that could already be applied in production (0001–0063 are applied; 0064 is NOT yet applied anywhere).
   A new Postgres **enum value needs its own enum-only migration** (precedent 0023/0046/0055).
6. **Never mark work done with failing tests. Never fabricate test output.** Keep source-pinning tests
   (tests that read `.tsx` source text) — update what they pin, never delete the pin.
7. UI is Arabic-first RTL; CSS logical properties only (`check:css`); design tokens only
   (`check:tokens` — new files have a raw-colour budget of 0); `ar.ts`/`en.ts` key-identical (`check:i18n`).
8. Commit in small conventional commits ending with
   `Co-Authored-By: <your agent identity>`; do not push unless the owner asks.

---

## 1. What the owner asked for (2026-09-17) and every decision taken

Requests:
1. New work schedule: **morning 09:00–17:00, evening 18:00–02:00, double = 12 hours.**
2. Clearer **dashboard**, default view **cumulative since operations began**, adjustable time filters (styled after
   `C:\Users\Badee Salloum\Desktop\New folder (4)\Ash group v2` — copy the look, NOT its date logic: it has
   Damascus-timezone bugs and a Saturday week start), buttons that jump to **completed / live shifts pre-filtered**.
3. **Net profit = company share − expenses.**
4. **Recurring (fixed) expenses** (weekly, first of month, every N days) besides manual ones.
5. **«صندوق الشركة» (company fund) becomes a whole financial system, separate from the branch box**, in **USD and SYP**,
   with **expenses, incomes and debts** (both directions), **fixed assets** (vehicles and other purchases) with
   **instalment tracking** (unpaid balance, payments recorded as they happen), linked to **vehicle cards**.
6. **Depreciation** per vehicle = price ÷ 36 months; at the start of each month a **button** (in the restoration
   «الترميم» area) moves the month's depreciation from the company fund into a new fund **«الاهتلاك»**; shown on the dashboard.
7. **Vehicle history** page: shifts run on it, orders, km, and other useful data.
8. "Draw the new design for every page" → done as `docs/design/2026-09-redesign/index.html`.

Owner decisions (collected in writing; treat as requirements):

| Topic | Decision |
|---|---|
| Double-shift rule | **Automatic from times:** a *closed* shift lasting **≥ 10 h (600 min) is a double, target 12 h (720)**; otherwise **morning** (start before 15:00 local) or **evening** (start ≥ 15:00, or 00:00–03:59), target **8 h (480)**. A running shift is shown «جارية» with its slot. Abandoned (> 16 h) keeps its slot and is not judged. |
| Recurring expenses | Shown as **due**, **paid by a button** (human decision). No automatic posting. No cron exists — compute due items on read. |
| Net profit | **company share + other income − expenses**. **Vehicle cost-centre expenses must count** (current bug). **Depreciation is NOT subtracted** — shown separately. **Branch and company values separate**, plus a combined total. |
| Company fund access | **general_manager and system_admin only** (new permission key `company_fund.manage`). |
| Debts | **Both directions** (we owe / owed to us); payments recorded as events; outstanding shown. No interest, no planned schedule for now. |
| Asset currency | **Purchase currency** (USD or SYP); instalments paid from that currency pocket; depreciation in that currency. |
| Instalment source | **Company fund**, plus "paid outside the system (owner directly)" for historical payments. |
| Existing vehicles | Depreciate **from purchase date with catch-up** of missed months. **Period 1 = the purchase month.** |
| Depreciation transfer shortfall | Button moves **only what is available**; the remainder stays due and visible. |
| Depreciation reserve use | Can **buy vehicles / pay instalments directly**, and can be **released back** to the company fund with a written reason (release does not reopen funded months). |
| USD⇄SYP exchange | **Both actual amounts** entered per exchange; the resulting rate is **frozen** on the entry. |
| Restoration top-up when company SYP is short | **Allowed to go negative**, with a visible warning. |
| Current company_box balance (79,057.26 SYP in DAM ledger on 2026-09-17) | **Moved as-is** as the new fund's SYP opening balance, then **reconciled by a count** (difference = visible correction entry with reason). USD opening entered manually. |
| Company fund cash count | **Exempt** from cash counts; HQ week close checks balance + clearing invariant only. |
| Order of work | **Schedule → dashboard → company fund**, then recurring expenses and vehicle history. |

Defaults assumed (record in `ASSUMPTIONS.md` when their phase lands): book value is time-based (price − depreciation
due to date); every asset lives 36 months; disposal/sale before 36 months is deferred; one asset per vehicle;
historical company items are posted **today** with the real date in a column (profit counts them on the posting
date; screens show both dates); USD rate for company expenses/incomes/payments defaults to today's system rate,
overridable, frozen on the entry; editing a recurring amount at payment requires a reason; «الكل منذ البدء» starts at
the go-live date (fallback: first ledger activity); «هذا الشهر» = calendar month in business days (day starts 04:00);
branch managers never see purchase prices/instalments/book values; company debts never affect branch figures.

---

## 2. Environment & how to run things

- Node 24 expected (25 works with an engine warning), pnpm 11. `pnpm install`.
- `pnpm check` = typecheck + all `check:*` + `pnpm -r test`. Individually: `pnpm typecheck`, `pnpm check:domain-pure`,
  `check:sql`, `check:wire`, `check:strip`, `check:i18n`, `check:css`, `check:tokens`, `check:glyphs`, `pnpm -r test`.
- **PostgreSQL tests** (guards/migrations — the memory adapter has NO triggers, so these are the only real proof)
  need a *disposable local* database:
  - A portable PostgreSQL 17.6 was installed at `C:\pgsql` (data dir `C:\pgsql-data`, port **54329**, trust auth).
    Start it if needed: `C:\pgsql\bin\pg_ctl.exe -D C:\pgsql-data -o "-p 54329" -l C:\pgsql-data\server.log start`.
  - Test databases created: `ash_test`, `ash_test_base`, `ash_test_ui`, `ash_test_ledger` (names must match
    `^ash_(test|conformance|release_gate|guardcheck|integritycheck)(_…)?$`, see `packages/db/test/disposable-database.ts`).
  - Run: `DATABASE_URL=postgresql://postgres@localhost:54329/ash_test ASH_ALLOW_DESTRUCTIVE_DATABASE_TESTS=1 pnpm -r test`
  - If you have Docker instead: `pnpm dev:db` (infra/compose) and point `DATABASE_URL` at an `ash_test*` database.
- Baseline measured at `f953906` with that database: domain 571, contracts 30, client 313, adapters 154, admin 265,
  driver 341, api 919 all green; db had 3 failing tests + 1 unloadable file, all stale fixtures missing
  `window_opens_at` (fixed in `b0c469f`).
- A clean baseline worktree exists at `C:\ash-wt\baseline` (detached at `f953906`) for comparisons.
- Vitest breaks when the repo path contains the Windows 8.3 short name (`BADEES~1`) — use long or short plain paths.
- Deploy procedure (ONLY with owner approval): see memory `vercel-deploy.md` / `docs/DEPLOY-VERCEL-NEON.md`;
  migrations via `pnpm migrate` against the Neon **direct** endpoint (drop `-pooler`).

---

## 3. LIVE STATUS CHECKLIST (update after every phase)

- [x] Plan approved (owner) — full Arabic plan kept outside the repo; this file is the English source of truth.
- [x] **Step 0** mockups — `docs/design/2026-09-redesign/index.html` (commit `ef81c65`). Owner sign-off: owner said "don't stop", proceed.
- [x] Local PostgreSQL + baseline; stale db fixtures fixed (commit `b0c469f`).
- [x] **P0** company-fund permission gap — committed (`fix(treasury): only company-fund managers move company money`). Migration 0064 NOT applied to production.
- [x] **P1** schedule & targets — committed (`feat(shifts): the owner's schedule …`). 212 prod shifts measured: 7 change pattern.
- [x] **P2** router params + time filter + range read model + profit fix — committed
      (`feat(dashboard): any period, one read …`). Production has NO vehicle cost-centre expenses yet, so the
      profit fix restates nothing.
- [x] **P3** dashboard redesign + drill-down — committed (`1d22365`, `a44c5e7`, `991fdb9`): eight independent
      sections, trend/range views, filtered links and fleet performance.
- [x] **C1** HQ ledger + currency foundation — DONE on branch `worktree-agent-ae074aa887cf11d96`
      (worktree `.claude/worktrees/agent-ae074aa887cf11d96`), 8 commits ending `4d47ffc`: 0065 enum-only, 0066
      foundation (HQ row `10000000-0000-4000-8000-000000000100`, `branches.kind`, per-currency balance trigger,
      ledger partition + pocket guards), `money/currency.ts`, strict fund codes, HQ refusal in rbac, HQ week close
      per currency. MERGED into `feat/finance-redesign` as `2e6dedc` (no textual conflicts); the follow-up
      commit adds `sypMinorPerUsd: null` / line `currency: 'SYP_NEW'` to P2's range fixtures. C1 made
      `LedgerRepo.post` meta `sypMinorPerUsd` REQUIRED — every new caller must pass `null` for branch postings.
      Merged state verified: domain 743, client 314, adapters 162, admin 318, driver 341, db 244, api 977,
      typecheck + all checks green.
- [x] **C2** company transactions + FX exchange + restoration mirror + cutover — migration 0067 and guarded
      command ledger committed (`4467a78`); real-PostgreSQL mirror/invariant suite green.
- [x] **C3** debts register — migration 0069, repository and HTTP workflows complete (`98bf74e`, `853fb9a`).
- [x] **C4** fixed assets — migration 0070, financed purchase and vehicle linking complete.
- [x] **C5** depreciation — migration 0071, 36-period schedule, FIFO funding, reserve spending/release complete.
- [x] **P6** vehicle history — committed (`e09988d`), including company-finance cards behind server RBAC.
- [x] **P4** branch recurring expenses + receipt upload — committed (`08cb030`, `656c1e1`), human-triggered only.
- [x] **C6** company recurring expenses + full company dashboard section — committed (`1383b50`), including
      branch/company/combined profit and company balance/reserve/depreciation digest.
- [x] Docs: CLAUDE.md decisions 18–23 + money rules 9–12, ASSUMPTIONS, RUNBOOK «صندوق الشركة», PROGRESS, TESTS.md.
- [ ] **Production** (owner go-ahead required): deploy api/admin/driver, run migrations 0064+, cutover.

Migration numbers (none applied to production yet; `migrate.ts` applies files in sorted order, gaps are fine):
0064 P0 permission · 0065–0066 C1 · 0067 C2 (0068 spare) · 0069–0071 reserved C3–C5 · 0072–0074 reserved P6 ·
0075(–0076) P4 · 0077+ C6.

Final local verification (2026-09-18): `pnpm check` passed every static gate and 3,168 default tests; the focused
real-PostgreSQL company-command and recurrence suites passed 33/33 on PostgreSQL 17.6. Node 25.8 emitted only
the expected engine warning; production and its migrations were not touched.

---

## 4. Phase specs

Everything below was verified against the code (file:line at `f953906`; lines may drift a little).

### P0 — Close the company-fund permission gap  (DONE — kept here for context)
Problem: `POST /company-fund/deposit|withdraw` (`apps/api/src/treasury.routes.ts` ~1061-1106) needed only
`journal.manual.write`, which **branch managers** hold (`packages/domain/src/rbac/can.ts` ~101), though they cannot
read the fund. Random idempotency keys (`deps.ids.uuid()` ~1070/1098); balance check outside the lock; `/journal/manual`
and `/treasury/withdraw` free-text `to` could name `company_box`; admin `MANUAL_FUNDS` listed it (`Treasury.tsx:32`).

Implemented (uncommitted at time of writing):
- Key `company_fund.manage` (GM + sysadmin, scope all) in `can.ts` (+ matrix test, SRS rows byte-identical).
- `packages/db/migrations/0064_company_fund_permission.sql`: insert permission; grant GM+sysadmin **only if
  `role_permissions` is non-empty** (`apps/api/src/rbac.ts:48-55` falls back to defaults when empty).
- `/company-fund`, `/company-fund/deposit|withdraw` → `company_fund.manage`; required client `idempotencyKey` (uuid)
  → ledger key `client:<uuid>`; replay → 200 `replayed:true`; changed body → 409 `idempotency_key_conflict`;
  balance check inside `financialUnitOfWork` lock `receivables:<branchId>`. New port
  `LedgerRepo.findStandaloneEntry(branchId, eventType, occurrenceKey)` (pg + memory + conformance).
- `/treasury/deposit` keyed the same way; `/journal/manual` refuses `company_box` → 422 `company_fund_not_manual`.
- Admin: `money-move-idempotency.ts` (held keys), company-fund card gated by `can('company_fund.manage')`.

Requested corrections (being applied):
1. `/treasury/withdraw`: allow `to='company_box'` **only** for `company_fund.manage` holders (403
   `company_fund_forbidden` for branch managers); keep `owner_drawings`; add client idempotency key + in-lock balance
   check; restore the admin hand «كييش» row only for `company_fund.manage`.
2. `POST /journal/:entryId/reverse`: if the original entry has any `company_box` line → require `company_fund.manage`.
3. Generic `idempotency_key_conflict` message (ar/en).
Verify: full `pnpm check` + PostgreSQL run (migration-0064 real-DB case). Then commit
`fix(treasury): only company-fund managers move company money`.

### P1 — Work schedule & targets (no migration)
- Rewrite `packages/domain/src/shift/worked-time.ts`: today `EVENING_START_MINUTES=900`, `DAY_END_LIMIT_MINUTES=1320`
  (misreads a 09:00→21:00 double as `day`, :143-144), `ABANDONED_AFTER_MINUTES=960`. New:
  `SLOT_SPLIT_MINUTES=900` (keep `EVENING_START_MINUTES` alias), `DOUBLE_SHIFT_MIN_MINUTES=600`,
  `SHIFT_TARGET_MINUTES={day:480,evening:480,full:720,unknown:null}`, `OWNER_SHIFT_HOURS` (display),
  delete `DAY_END_LIMIT_MINUTES`. `slotOfStart(ms, offset, dayStart)` → evening when business-day minute ≥ 660
  (i.e. 15:00; 00:00–03:59 starts count as evening). `workedTime(start,end,…)` → `{minutes, pattern, slot, abandoned}`:
  live → `unknown` + slot; abandoned → pattern = slot, not judged; `minutes ≥ 600` → `full`; else slot.
  `shiftTargetMinutes(p)`; `shortfallMinutes(worked, target?)`.
- Move `shiftShapeOf/ForDay` from `apps/admin/src/shift-shape.ts` into `packages/domain/src/shift/shape.ts` (admin re-exports).
- `GET /shifts` (`apps/api/src/app.ts` ~627-637) adds `worked.slot`.
- Replace duplicated targets in `apps/admin/src/screens/CompletedShifts.tsx:45-50` and `Dashboard.tsx:46-51`
  (`full: 16 * 60`) with the shared export. Labels: `packages/client/src/i18n/ar.ts` ~1434 «نهارية»→«صباحية», add
  target text «٨ س»/«١٢ س» (+ en). Pattern+target badge in `Approval.tsx` (~1043) and `LiveShifts.tsx` (~395).
- Tests: `packages/domain/test/shift/worked-time.test.ts` cases 09→17 day, 18→02 evening, **09→21 full**,
  11:00→20:59 day / 21:00 full, 15:00→03:00 full, 02:00 start evening, abandoned; property: closed & ≥600 ⇒ full.
  Update source pins in `apps/admin/src/completed-shifts.test.ts:149-193` (pin the shared import; assert
  `not.toContain('16 * 60')`).
- Before deploy: read-only count of historical shifts whose pattern changes; put the number in PROGRESS.

### P2 — Router params, time filter, range read model, profit fix (no migration)
- `apps/admin/src/route.ts` (pure): `parseHash/formatHash` with validation (dates via domain parser, enum values,
  ids ≤ 64 chars; unknown keys dropped). Today `AdminApp.tsx:48-52` accepts only `#section` / `#shift:<id>` and the
  effect at :75-79 strips params. Add sections `companyFund` (GM/sysadmin) and `vehicle` (hidden from rail).
  Screens mount with `key={paramsKey} initial={params}`; closing a `#shift:` overlay restores the filtered hash.
  `use-hash-params.ts` (history.replaceState), `drill.ts` typed href builders. Tests `route.test.ts`, `drill.test.ts`.
- Domain `time/civil.ts`: `daysInMonth`, `monthStartFor`, `monthEndFor`, `addMonths` (clamp), `monthKey`,
  `monthsBetween`, `daysBetween` (+ properties). `time/range.ts`: `RangePreset`
  (`all|today|yesterday|this_week|last_week|this_month|last_month|week|custom`), `resolveRange(sel,{today,epoch})`,
  `shiftWeek`, `canGoNextWeek`, `validateCustom`, `bucketFor` (day ≤ 62 days, week ≤ 26 weeks, else month), `bucketKey`.
  Weeks start **Sunday**.
- `apps/admin/src/components/TimeRangeBar.tsx` + `time-range.ts` (hash > `localStorage['ash.admin.range.v1:<userId>']`
  > `all`); "today" from new `GET /dashboard/meta` `{today, goLiveBusinessDate, firstActivityDate, weekStart, monthStart}`
  (session.businessDate goes stale after 04:00). Replace Date arithmetic in `completed-shifts.ts:85-88`.
- `LedgerRangeSource.readRange(branchId, from, to)` (pg SQL aggregate + memory twin + conformance fixture that must
  equal a `listByWeek` reference): today `/dashboard/profit` walks weeks (`dashboard.routes.ts:186-190`, 520-week cap
  :579-598). Include currency + frozen-rate dimension hooks for C6.
- **Profit fix:** `packages/domain/src/reporting/profit.ts` `classifyProfitLine(code, {vehicleIds})`: vehicle
  expenses post to `cost_center:<vehicleUuid>` (`expenses.routes.ts:146`, `advances.routes.ts:99-100`) but
  `isOperatingCost` (`dashboard.routes.ts:564-577`) only matches `vehicle:` → vehicle costs are missing from net profit.
  Count `cost_center:<uuid>` (uuid, or id ∈ branch vehicle ids — memory harness uses non-uuid ids like `vehicle-1`).
  Rewrite `apps/api/test/dashboard.test.ts:418` to post via real `POST /expenses`. Measure the historical restatement
  (read-only) before deploy and tell the owner.
- `GET /dashboard/shifts-summary?from&to`, `/dashboard/profit|treasury` on the range source.
- `GET /shifts` (`app.ts:523-642`): add `vehicleId` filter, `odometerEnd`; cap 31 days (400 with driver/vehicle) → 422
  `range_too_large`. `CompletedShifts`/`LiveShifts` accept `initial` + vehicle/state filters.

### P3 — Dashboard redesign & drill-down (no migration)
- Split `apps/admin/src/screens/Dashboard.tsx` into
  `screens/dashboard/{Now,Profit,Operations,Fleet,CompanyFund,Capital,Due,Alerts}Section.tsx`; each loads/fails on its
  own (`Pending`, `LatestRequestGuard`). Extract `components/TrendBars.tsx` (bucket-aware; scale with bigint, never
  `Number()` on money). New `GET /dashboard/fleet-performance?from&to` (per vehicle: shifts, km, orders, fees, company
  share, costs, contribution; + book value/unpaid once C4 exists, GM only). Links via `drill.ts`.
- Layout = mockup page «الداشبورد». Company-fund section shows the current `company_box` until C2.
- Lower budgets in `scripts/check-design-tokens.mjs` as files shrink. Update pins: `working-now.test.ts:113-153`,
  `latest-request.test.ts:39-61`, `treasury-screen.test.ts:42-52`.

### C1 — Company ledger (HQ) + currency foundation (no new money moves)
Architecture: a dedicated **HQ branch row** — NOT nullable `branch_id` (that breaks fund uniqueness 0004:39,42,
week locks, sealed-week guard 0018:51-68 and the seal advisory lock 0029).
- Enum-only migration: `fund_type` += `company_cash, depreciation_reserve, company_fx_position, branch_clearing,
  company_payable, company_receivable, fixed_asset, company_expense, company_income, company_equity`;
  `ledger_event` += `company_opening_transfer, company_restoration_mirror, company_deposit, company_withdrawal,
  company_expense, company_income, company_fx_exchange, company_debt_open, company_debt_payment, company_debt_writeoff,
  asset_purchase, depreciation_transfer, depreciation_release, company_correction`.
- Foundation migration:
  - `branches.kind text NOT NULL DEFAULT 'branch' CHECK IN ('branch','company')`, unique partial index for one
    company row, trigger making `kind` immutable. HQ row fixed uuid (e.g. `10000000-0000-4000-8000-000000000100`),
    code `HQ`, `branch_no = 0` → replace the inline 1..99 check (0007:53) with
    `(kind='branch' AND branch_no BETWEEN 1 AND 99) OR (kind='company' AND branch_no=0)` — **read the real constraint
    name from production `pg_constraint` first** (auto-named, likely `branches_branch_no_check`). Mirror in `apps/api/src/seed.ts:131-137`.
  - `assert_branch_kind(expected)` trigger on branch tables (users, drivers, vehicles, shifts, cash_counts,
    office_capital_targets, restorations, expenses, incomes, advances, advance_events, receivable_events,
    checkin_windows, preapproved_shift_rules) and on new company tables.
  - `funds.currency` CHECK → `IN ('SYP_NEW','USD')` (drop the auto-named 0004:28 check — verify name), USD only for
    company fund types; `funds_identity_immutable` trigger (branch_id/type/code/currency).
  - `journal_entries.syp_minor_per_usd bigint NULL CHECK > 0` (frozen rate; `fx_days` is overwritten in place,
    `repos.ts:1478-1488`, so it cannot be the record); deferred rule: USD line ⇔ rate present.
  - Rewrite `assert_entry_balanced()` (0006:22-56) to balance **per currency** (join funds, group by currency); only
    `company_fx_exchange` may span two currencies. In-migration `DO $$` proof aborts if any existing entry fails.
  - `ledger_partition_from_line` deferred guard: company fund types/events only in HQ, never in branches, with a
    per-type allowed-event matrix (blocks `/journal/manual` and generic reverse from HQ).
  - Pocket non-negative guard on `company_cash` and `depreciation_reserve` **except restoration-mirror entries**
    (owner allowed negative on restoration top-up).
- Code: new `FundRef` kinds + `currencyOf()` (`packages/domain/src/ledger/recipes.ts:69-134`); strict
  `fundRefFromCode` (today `case 'company_box': return {kind: head}` drops suffixes, :1401-1402; unknown codes become
  `cost_center:<code>`, :1423); consolidate the three `fundCode` copies (`recipes.ts:1349-1371`, `repos.ts:44-68`,
  `packages/adapters/src/memory/index.ts:1308-1329`) onto the domain one; `packages/domain/src/money/currency.ts`
  (`Currency`, `Money<C>`, `addMoney` refuses mixing, `usdToSypMinor` half-up); `assertBalanced` per currency
  (`recipes.ts:186-199`); `ensureFund` writes/asserts currency (`repos.ts:94-117`); `LedgerRepo.post` meta takes
  `sypMinorPerUsd`; `makeAuthorize` (`rbac.ts:99-101`) refuses any non-company permission whose subject branch is HQ
  (`company_branch_not_addressable`); `listBranches` excludes HQ (`repos-shift.ts:462-465`, memory :1415) + new
  `directory.companyBranch()`; `/weeks/close` (`app.ts:2791-2877`) for HQ: no cash-count requirement, per-currency
  trial balance, clearing-invariant blocker. Admin `Money` gets a currency prop; `CurrencyMoney`;
  `scripts/check-wire-money.mjs:21` learns usd|syp|rate|principal|outstanding|depreci|reserve|book.
- Tests (PostgreSQL): mixed-currency entry fails; 4-line exchange passes; USD without rate fails; HQ manual entry
  fails; legacy entries still pass; lock order helper `lockBranchThenCompany()`.

### C2 — Company transactions, FX, restoration mirror, cutover
- Command tables (all: `id` = client key = occurrence key, `branch_id` = HQ, `currency`, `amount_minor > 0`,
  `occurred_on` real date ≤ `business_date` (= posting date, today), visible reason, `journal_entry_id NOT NULL UNIQUE`,
  REVOKE UPDATE/DELETE/TRUNCATE, audit trigger + `scripts/check-sql.mjs` MUST_AUDIT, 0056-style BEFORE INSERT guard:
  actor holds `company_fund.manage`, journal identity, exact lines; deferred "every company entry has its command row";
  partial unique `je_<event>_command_uq`):
  `company_moves` (deposit/withdrawal/opening), `company_expenses` (category, cost centre general|vehicle|asset,
  paid_from pocket|reserve|owner_outside, receipt), `company_incomes`, `company_fx_exchanges` (both amounts + frozen
  rate), `company_reversals` (line-for-line inverse with per-kind preconditions), `company_ledger_cutovers`,
  `company_restoration_mirrors`.
- Postings (debit increases a fund): deposit `D company_cash:CUR / C company_equity:CUR:owner_funding|opening`;
  withdrawal reverse; expense `D company_expense:CUR:<centre> / C company_cash|depreciation_reserve|company_equity:owner_funding`;
  income `D company_cash / C company_income:CUR:general`; exchange = 4 lines through `company_fx_position:A/B`
  (no P&L). Fund codes use the enum literal: `company_cash:SYP_NEW`, `company_cash:USD`, etc.
- **Restoration mirror:** DAM's `company_box` stays exactly as is (becomes «حساب الشركة لدى الفرع»); every entry
  touching it after cutover gets, in the SAME transaction (`PgFinancialUnitOfWork` supports two branches — lock branch
  first, then HQ), an HQ entry `company_restoration_mirror` keyed `mirror:<sourceEntryId>`: kaish →
  `D company_cash:SYP_NEW / C branch_clearing:<DAM>` (role `kaish_mirror`), shahn → reverse (`shahn_mirror`); a fact
  row + guard. **Do not touch the restoration guards (0038, 0061).** Invariant (deferred trigger + verify script +
  HQ week-close blocker): `balance(DAM company_box) + balance(HQ branch_clearing:DAM) = 0`. Helper
  `postBranchWithMirror` used by `POST /treasury/restoration` (`treasury.routes.ts:1478-1589`, order: DAM journals →
  restorations row → HQ mirrors sweeps-before-top-ups), `/treasury/withdraw to=company_box`, and generic reverse.
  Top-up when HQ SYP is short: **allowed**, preview/dashboard warn.
- **Cutover** `POST /company/cutover {branchId, expectedOpening, reason}` (needs `company_fund.manage` + `settings.write`):
  under DAM then HQ lock read DAM `company_box` (79,057.26 on 2026-09-17), must equal `expectedOpening`, post HQ
  `company_opening_transfer` `D company_cash:SYP_NEW / C branch_clearing:DAM`, store watermark = max journal id.
  Then USD opening = deposit with `account='opening'`; count differences = visible corrections.
- Routes: `/company/overview|movements|deposits|withdrawals|expenses|incomes|exchanges|reversals|cutover`;
  legacy `/company-fund*` become aliases; go-live gate (`app.ts:2695-2760`) uses `company_box + branch_clearing`;
  `/dashboard/treasury` reads the HQ pocket after cutover. Admin: new `screens/CompanyFund.tsx` (overview + movements).

### C3 — Debts register
`company_debts` (direction payable|receivable, party free text + `normalizePartyName` key
`packages/domain/src/text/party-key.ts`, currency, principal, opened_on, optional due_on, note, origin
cash|expense|income|opening|asset_purchase, optional category/cost centre/asset_id UNIQUE) and
`company_debt_events` (payment|writeoff; source pocket|reserve|owner_outside). Postings: open payable
`D company_cash|company_expense|company_equity:opening / C company_payable:<id>`; receivable mirror;
payment `D payable / C source`; collection `D company_cash / C receivable`; write-off →
`company_income:payable_forgiven` or `company_expense:receivable_writeoff`. Over-payment guard with `FOR UPDATE` on the
debt fund (0056:381-407 pattern); outstanding read from the fund balance. UI: debts tab + drawer.

### C4 — Fixed assets
`fixed_assets` (kind vehicle|equipment|property|other, `vehicle_id UNIQUE`, currency, price, purchased_on,
`useful_months = 36`, paid_now + source pocket|reserve|owner_outside|opening). Event `asset_purchase`:
`D fixed_asset:<id>` price / `C source` paid_now / `C company_payable:<debtId>` financed → a linked debt with
origin `asset_purchase` (deferred check) so **all instalments live in the debts register**.
`asset_depreciation_schedule` (36 rows, `period_month` day 1, period 1 = purchase month) with SQL twin
`ash_depreciation_amount(price, months, k)` = floor for k < months, remainder on the last; deferred check sum = price.
Routes `/company/assets[/:id]`, `/company/assets/by-vehicle/:vehicleId` (GM only). `DELETE /vehicles/:id` → 409 when
an asset exists. UI: assets tab, purchase wizard, asset detail, bike-card finance line.

### C5 — Depreciation
`depreciation_transfers` (currency, amount, as_of_month), `depreciation_allocations` (FIFO oldest period first,
Σ per (asset, period) ≤ scheduled), `depreciation_releases` (reason). Transfer
`D depreciation_reserve:CUR / C company_cash:CUR`; server computes amount = min(due, available); client sends
`expectedAmount` (409 on mismatch); remainder stays due; **no profit effect**. Reserve can pay purchases/instalments
(`source='reserve'`) and be released with a reason. Book value = price − scheduled amounts due to the current month.
UI: depreciation tab, restoration panel button (GM only), dashboard figures.

### P6 — Vehicle history
Migration: indexes `shifts(vehicle_id, business_date)`, `expenses(vehicle_id, business_date) WHERE vehicle_id IS NOT NULL`.
Repos: `ShiftRepo.listByVehicle`, `ExpenseRepo.listByVehicle`, `BatteryReading/SwapRepo.listByShiftIds`
(pg + memory + conformance). Domain `fleet/odometer.ts` (km per shift, unlogged gaps, rollbacks; property:
Σkm + Σunlogged = last end − first start). `GET /vehicles/:id/history?from&to` (extract `completedShiftFinancial`
from `app.ts:143-181` to `shift-financial.ts`; life-log costs linked to an expense are shown, not summed;
asset/depreciation block only with `company_fund.manage`; company expenses on the vehicle included).
UI `screens/VehicleHistory.tsx` (mockup «سجل الآلية»); `BikeCard` «السجل الكامل»; replace `Fleet.tsx:851-960`.

### P4 — Branch recurring expenses + receipts
Migration: `recurring_expense_templates` (schedule weekly+weekday | monthly_first | every_n_days+interval,
starts_on, ends_on, deactivation only with reason) and `recurring_expense_occurrences` (PK `(template_id, due_date)`,
status paid|skipped, `expense_id UNIQUE`, reason) with IMMUTABLE `ash_recurrence_matches(...)`, guards, audit.
Domain `expenses/recurrence.ts` (`occurrencesBetween`, `nextOccurrenceOnOrAfter`, `dueStatus`; properties).
Routes `/recurring-expenses` (CRUD-deactivate), `/recurring-expenses/due`, `.../occurrences/:dueDate/pay|skip`
(pay reuses a `recordExpenseInTx` extracted from `expenses.routes.ts:79-224`), `POST /media/receipts`
(non-shift upload; `Expenses.tsx:125-139` never sends `receiptMediaId` today). UI tabs per mockup «الصرفيات».

### C6 — Company recurring expenses + company dashboard section
Extend P4 templates: currency, paid_from, HQ kind, `company_expense_id` (exactly one of expense_id/company_expense_id),
`UNIQUE(template, due_on)`. Profit split branch / company / combined: USD converted with each entry's frozen
`syp_minor_per_usd`; USD balances shown at today's rate for display only (no FX P&L). Full dashboard company section.

---

## 5. Documentation to write as phases land
- `CLAUDE.md` decisions 18 (schedule), 19 (net profit + vehicle-cost fix), 20 (recurring expenses), 21 (separate
  dual-currency company ledger, mirror, cutover — amends BR6 and decisions 3, 10), 22 (debts & assets),
  23 (depreciation; cumulative dashboard). Money rules 9–12: currency lives on the fund & per-currency balance;
  company/branch never cross ledgers, every company posting has its command row, dated today; mirror invariant &
  lock order; depreciation arithmetic & FIFO.
- `ASSUMPTIONS.md` (defaults in §1), `RUNBOOK.md` section «صندوق الشركة» (preflight SQL, cutover, opening balances,
  entering existing vehicles — preferred: `paidNow = 0`, then each historical instalment as a debt payment with source
  `owner_outside` and its real date, then press «نقل الاهتلاك» for catch-up; monthly routine; exchanges; reversals;
  HQ Sunday close; invariant query), fix the false `fx_rate_versions` claim at `RUNBOOK.md:67`.
- `PROGRESS.md` entry per phase (done / next / risks / 2-minute demo); `TESTS.md` mapping.

## 6. Known risks
Historical shift relabelling (double target 960→720) and profit restatement (vehicle costs) — measure and tell the
owner before deploy. The balance-trigger rewrite touches the core ledger — prove on a disposable DB and measure cost on
the largest shift approval. Constraint names in checksum-locked migrations must be read from production first.
Restoration will require HQ's week to be open (add HQ to the Sunday close routine). Wrong lock order deadlocks —
single helper. Use `numeric` when multiplying rate × amount in SQL guards. `/journal/:id/reverse` can still reverse
branch advance/income entries (separate gap). `fx_days` overwrite still affects the branch ledger (separate fix).
