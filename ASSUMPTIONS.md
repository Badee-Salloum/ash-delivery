# ASSUMPTIONS

Every default taken instead of blocking the product owner, per kickoff brief §7.5. Each row says
what was assumed, why, and **how expensive it is to reverse** — that last column is the one that
matters when an answer finally arrives.

**Reversal cost:** `cheap` = a setting or one data row · `moderate` = a migration or a recipe ·
`structural` = re-shapes the ledger or the equation.

---

## Confirmed by the product owner (no longer assumptions)

| # | Decision | Date |
| --- | --- | --- |
| D-1 | Financial week = Sunday 00:00 → Saturday 23:59 Asia/Damascus, closed the *following* Sunday. A shift worked on the closing Sunday belongs to the new week. | 2026-07-21 |
| D-2 | GitHub org, VPS and domain already exist → staging goes live in M0, not M6. | 2026-07-21 |
| D-3 | Old Syrian lira is schema-ready only; all Bundle-1 UI is new SYP + USD equivalent. | 2026-07-21 |
| D-4 | The wallet is returned/zeroed each day exactly like the cash float. BR1 stays in absolute form. | 2026-07-21 |
| D-5 | Manual entries and expenses: branch manager ✓ + general manager ✓, sysadmin ✗ (SRS §3 matrix over E-3 prose). | 2026-07-21 |
| D-6 | Tier band computed over the whole day, with a visible day true-up restating earlier shifts. | 2026-07-21 |
| D-7 | Commercial scope re-cut into Bundle 1a (SRS A–G, as priced) + Bundle 1b (production readiness, separately priced). | 2026-07-21 |

---

## Open assumptions

### Money and the equation

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-01 | **BR1 is fee-only.** Goods value does not appear in the equation, because for a cash order the driver pays the merchant out of the float and collects the same amount back, netting to zero. | SRS §2.1 states the round-trip explicitly for cash orders. | `structural` if the round-trip does not hold |
| A-02 | **The 80% block is a residual**, `Σfees − Σ(per-order 20% cuts)`, never `0.80 × Σfees`. | A zero-tolerance equation cannot absorb a rounding error. Proven by `allocate.test.ts` → "the naive formula really does diverge". | not reversible — this is correctness |
| A-03 | **Yallago floors its own 20% cut.** | We do not control this arithmetic; it happens inside their app. Rounding mode is a parameter (`yalagoCut(fee, rounding)`), not a constant. | `cheap` — one argument |
| A-04 | **The company absorbs every rounding remainder**, never the driver, never Yallago. | BR4: "Yallago's 20% is always fixed; tier changes come only out of the company's side." | `moderate` |
| A-05 | **م-3 — for electronic orders, the goods value round-trips to the wallet.** `goods_value_minor` and the per-order goods flags ship **inactive**. | The brief instructs isolating this behind a strategy seam. BR1 is fee-only under either branch *provided* the round-trip holds. | `cheap` — a setting, not a migration |

### Tier engine

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-06 | **Marginal mode = each order is paid at the rate of its own ordinal position.** With a per-order-*count* band table and varying fees, no other reading is well-defined. | SRS F-2 keeps marginal as a config switch; the client's default is `whole`. | `cheap` |
| A-07 | **Free-delivery orders count toward the daily tier band** and earn a tier share. | SRS §2.1 gives all three modes the same "+80% of fee" net effect, so excluding free orders would make the tier basis inconsistent with the money. | `cheap` |
| A-08 | **A suspended shift completed on a later day is banded against its ORIGINAL business date.** | The driver did the work that day; re-banding it into a later day would corrupt both days' counts. | `moderate` |
| A-09 | **Tier tables are resolved with `status IN ('active','superseded')`.** | Filtering on `'active'` alone silently restates every historical day the first time the table is edited. | not reversible — this is correctness |

### Ledger and period control

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-10 | **Idempotency key = `(shift_id, event_type, occurrence_key)`**, overriding the kickoff brief's `(shift_id, event_type)`. | SRS C-5 permits multiple float/top-up tranches per day. Under the brief's key the second tranche cannot post and is silently swallowed — cash leaves the office unrecorded. **Escalated to the PO as a correction to the brief.** | not reversible — this is correctness |
| A-11 | **م-1 — the future accounting bridge aggregates at one daily entry per fund.** Unbuilt; recorded only. | Kickoff brief §7.6 instructs exactly this and says not to block. | `cheap` — section N is Bundle 3 |
| A-12 | **م-2 — opening balances are schema-ready and imported before go-live**, not during development. | SRS §10 says section E cannot go live productively without them; the file has not arrived. Added to M6's Definition of Done, with `Σ funds = 0` verified. | `moderate` |
| A-13 | **Funds creatable from settings are limited to `cost_center` type.** | A new fund that needs new *posting behaviour* needs a recipe, and a recipe is code. This is a real narrowing of SRS E-1's "add funds from settings without development", recorded so the PO sees it. | `moderate` |
| A-14 | **The Sunday-close pre-flight omits the H reconciliation gate** (SRS BR7/H-4 require zero-matching against the Yallago weekly PDF, which is Bundle 2). A permanently-satisfied placeholder check holds its place. | Section H is explicitly deferred. | `cheap` |
| A-15 | **A missing daily FX rate must never block posting.** The rate row is created by a race-safe lazy upsert in the posting path, not by a cron that can fail. | A failed 00:05 cron must not make the whole system unable to accept a write. | `cheap` |

### People, roles, scope

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-16 | **No driver salaries, advances or penalties.** Honoured by deliberate omission. | SRS B-1 / س35 / س38–40: the relationship is «نسبة فقط» — share only. Recorded so a future session does not "helpfully" add them. | `moderate` |
| A-17 | **The optional accountant role («محاسب») is seeded inactive** with an empty grant set. | SRS §3 and س77 name it for later. Seeding it as data means enabling it is a row, not a migration. | `cheap` |
| A-18 | **`shift_no` is capped at 2 by a setting, not by a DB constraint.** | SRS س23 says "up to two shifts daily", but a hard constraint would block a legitimate third shift on an exceptional day. | `cheap` |
| A-19 | **م-5 — tier editing is system-admin only**, per the literal SRS §3 matrix and س46, including *not* the GM. Stored as data. | SRS §10 flags this for confirmation at acceptance; one row changes it. | `cheap` |

### Engineering

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-20 | **The no-float rule is scoped to money.** `double precision` remains legal for GPS coordinates, battery percentages and odometer readings. | Applying it dogmatically to physical measurements would be cargo-cult. | `cheap` |
| A-21 | **Asia/Damascus is UTC+3 year-round** (Syria abolished DST in October 2022). The offset is injected as a value, so pre-2022 backfilled data can still be handled correctly. | Keeps the domain deterministic and free of `Intl`. | `cheap` |
| A-22 | **A night shift's `business_date` is the date it OPENED.** A shift running 23:50 → 00:30 belongs to the opening day. | Otherwise a driver's day count splits across two tier bands for one continuous stretch of work. | `moderate` |
| A-23 | **`provider_order_no` is globally unique**, not unique per shift. | It is Yallago's own key and doubles as the Bundle-2 reconciliation seam (SRS H-2, س17). Duplicate entry is a data-entry error worth catching immediately. | `moderate` |
| A-24 | **م-4 — the four real samples arrive mid-development.** Fake dashboard data and battery CSV live behind ports (`DashboardSource`, `BatteryFileParser`) so swapping the real ones in touches zero domain code. | Kickoff brief §5 requires exactly this. | `cheap` |
| A-25 | **Node 24 LTS is the target runtime**, though the current dev machine has Node 25. `.nvmrc` and the Dockerfile pin 24; `engines` warns on mismatch. | Node 24 is maintained to April 2028, covering the three-year horizon. Node 25 is not an LTS line. | `cheap` |

---

## Escalated to the product owner rather than assumed

These were genuine conflicts or real-money questions, and were asked, not defaulted:

1. Financial week boundary → **answered** (D-1).
2. Wallet returned vs. carried forward — SRS §1.4/C-5 contradict the §2.3 example → **answered** (D-4).
3. Manual entries: SRS E-3 vs. the §3 matrix — an internal SRS conflict → **answered** (D-5).
4. Two shifts in one day: whole-day band vs. per-shift → **answered** (D-6).
5. The 19-day contract vs. a realistic 40–56 days → **answered** (D-7).

## Still to escalate before M2

**Get one real shift's ground truth**: a dashboard screenshot, the matching wallet screenshot, and
the branch manager's counted cash and wallet figures for that *same* shift. BR1's zero tolerance is
measured against a number produced by Yallago, whose semantics we do not control. If their wallet
figure carries anything this model does not — tips, promo credits, cancellation reversals, a
pending-vs-settled distinction, or a different rounding direction — then **every shift is
unclosable on day one**. See `docs/client-request-samples.md`.
