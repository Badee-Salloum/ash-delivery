# ASH Delivery — Engineering Kickoff Brief

You are the entire engineering team for this project: tech lead, backend, frontend, QA, and DevOps. Work in disciplined milestones with real tests and a real deployment pipeline. Use subagents in parallel where it helps (independent code review, test authoring, doc checks). I am the product owner and sole human developer; the paying client is a finance business in Damascus, Syria. Production correctness beats speed — this system moves real cash daily.

## 1. Inputs and authority

- `SRS-v1.0.md` (in this folder, Arabic) is the authoritative specification: 14 priced sections A–N, business rules, role matrix, data models, workflows, and 12 acceptance criteria. Read it fully before anything else.
- This brief is the delivery contract: scope, order, and quality gates. If this brief and the SRS conflict, stop and ask me.
- UI is bilingual Arabic/English, **RTL-first** (Arabic is the default). Code, identifiers, commits, and engineering docs are English.

## 2. Scope now: Bundle 1 ("Launch") only

Build SRS sections **A, B, C, E, F, G**:

- **A** Platform core — auth (2FA-ready), roles, single-branch model built multi-branch-ready, settings, audit log
- **B** Drivers & vehicles — profiles, documents with expiry alerts, mandatory driver↔vehicle↔shift binding
- **C** Shift lifecycle & photo evidence — the heart: gates, evidence packages, the zero equation, two-step approvals
- **E** Financial core — double-entry ledger, the client's exact funds tree, FX, daily cash count, Sunday week-lock
- **F** Tier & share engine
- **G** Expenses

**Explicitly deferred** (build clean seams, not features): D OCR (drivers type numbers manually, photos attached as evidence), H Yallago PDF reconciliation, I report builder (a minimal ops dashboard IS in scope), J geographic maps, K GPS, L battery analytics, M push/anomaly detection, N accounting bridge export.

## 3. Non-negotiable business rules (condensed from client answers)

**BR1 — Zero-shift equation (the core invariant).** At shift close:

```
driver_cash_on_hand + driver_app_wallet_balance
  == cash_float_given + wallet_topup_given + 0.80 × Σ(delivery fees of the shift's orders)
```

Tolerance is **zero**. A non-zero difference blocks approval and must display a breakdown of likely causes (missing order, wrong payment mode, odometer/cash mismatch).

Canonical worked example — encode as a test verbatim: float 100,000 + topup 50,000 (new SYP); 20 orders × 5,000 fee (12 cash, 6 electronic, 2 free) → end cash 160,000, end wallet 70,000; check: 230,000 == 150,000 + 0.80×100,000. ✔

**BR2 — No weekly settlement.** Yallago's 20% is deducted **instantly** from the driver's in-app wallet (which the company tops up). The weekly Yallago PDF is a Bundle-2 audit artifact, never a settlement mechanism.

**BR3 — Three payment modes per order**, captured per order:
- `cash`: driver collects goods value + fee in cash; wallet −20% of fee (instant Yallago cut)
- `electronic`: nothing collected in cash; order counterpart lands in wallet (net effect +80% of fee)
- `free` (Yallago promo): wallet +80% of fee, funded by Yallago

**BR4 — The 80% block.** In the field, driver + company share (80% of fees) stays merged in the driver's hands/wallet. The ledger splits driver-vs-company **at approval time** using the daily tier. Yallago's 20% is always fixed; tier changes come only out of the company's side.

**BR5 — Shift gates, both ends.** Open requires: start package (odometer photo, battery %, float amount, topup amount) + driver confirmation + branch-manager approval. Close requires: end package (dashboard screenshot, wallet photo, odometer photo, cash handed over) + BR1 == 0 + branch-manager approval after matching ground numbers to system numbers. A `suspended` state exists for mid-shift incidents; data is completed later and the same equation applies.

**BR6 — Currency.** Base currency = **new Syrian Lira** (1 new = 100 old — keep the factor configurable). Reports show SYP + USD equivalent using **one daily rate** entered each morning by the system admin and applied to that entire day's transactions. Seed value ≈ 130 new SYP/USD (market, July 2026) — seed only, never hardcoded logic.

**BR7 — Financial week.** Closes every **Sunday** by explicit system-admin action. Locked entries are immutable; corrections happen only via visible, dated correction entries.

**BR8 — Visibility.** Total profits/shares: General Manager **only**. Branch manager: everything in his branch. Driver: his own shifts and earnings only. Tier/rule editing: **system admin only** (not even the GM — client's explicit answer; keep it configurable).

**Default tier table** (fully editable by system admin, effective-dated, whole-amount mode, basis = approved orders per day): 0–14 → driver 35% · 15–24 → 40% · 25–34 → 43% · 35+ → 46%. Marginal mode must exist as a config switch.

## 4. Engineering constraints and defaults

- **Stack: you propose it.** In your first plan, present ONE recommended stack (≤10 lines of justification: solo maintainer, cheap VPS, Arabic RTL admin, PWA driver app, report-heavy future) plus one alternative in two lines. I approve before any code. **PostgreSQL is mandatory** regardless.
- **Money = integer minor units. Never floats.** All money math lives in a pure, framework-free domain layer.
- Timezone **Asia/Damascus** for all business-day and Sunday-close logic; test midnight and week-boundary edges.
- **Idempotent postings**: approving a shift twice (double-click, retry, race) must not double-post — DB unique constraint on (shift_id, event_type) + a concurrency test.
- **Immutability**: entries in a locked week are non-editable — enforce in the app layer AND a DB-level guard.
- **RBAC server-side** per the SRS §3 matrix; UI hiding is not security. Audit log on every mutation (who, when, before/after).
- Driver app: **PWA** for modest Android phones; uploads happen on office Wi-Fi — simple retry is enough, no heavy offline sync. Client-side image compression (~300 KB) + timestamps.
- i18n from day one (`ar` default, `en` secondary), RTL-first layouts.
- Scale: 10 vehicles now → **100 within a year**. Nothing that breaks at 10×.
- Config via `.env`; secrets never committed.

## 5. Testing policy (what "tested the right way" means)

- **Property-based tests on the money core**: (a) every posting balances (Σ debits == Σ credits) under randomly generated event streams; (b) BR1 holds for random mixes of the three payment modes; (c) tier engine boundaries (14/15, 24/25, 34/35), whole vs marginal, effective-date selection.
- **Integration tests**: full shift lifecycle happy path; every gate failure; concurrent double-approve; edit-after-Sunday-lock rejected; correction-entry path; RBAC denial per role.
- **Traceability**: SRS §8 acceptance criteria #1, 2, 3, 4, 5, 6, 7, 9, 12 (the Bundle-1 ones) each map to at least one automated test — maintain the mapping in `TESTS.md`.
- **Fixtures behind adapters**: fake Yallago dashboard data and fake battery CSV live behind interfaces, because real samples arrive mid-development — swapping them in must not touch domain code.
- **Seed command**: 1 branch; GM, sysadmin, branch-manager, 2 drivers; 10 vehicles; one demo day of shifts that passes BR1.
- CI runs lint + typecheck + full suite on every push. A red suite blocks the milestone. Never mark work done with failing tests; never fabricate test output.

## 6. Deployment (what "deployed the right way" means)

- Dockerized: `docker-compose.dev.yml` (hot reload) and `docker-compose.prod.yml` (app, Postgres, Caddy auto-HTTPS, backup sidecar).
- Target: one economical VPS (Hetzner-class), **staging + production** as separate compose projects on subdomains.
- CI/CD (GitHub Actions): PRs → lint + tests; version tag → build image, SSH deploy, run migrations, then a **smoke test** (login, open shift, post entry, BR1 check on seed data).
- Backups: nightly `pg_dump`, 90-day retention, media volume included, and a **restore script you actually rehearse once** (SRS target: recovery < 4 h).
- `RUNBOOK.md`: deploy, rollback, restore, set daily FX rate, Sunday close checklist, onboard a driver/vehicle.

## 7. Working agreement

1. **First action**: read `SRS-v1.0.md` fully. Then **enter plan mode** and present: stack choice, repo layout, DB schema draft for funds/entries/shifts/shift_orders/tier_rules, and the milestone plan below (confirmed or amended). **Stop for my approval before writing code.**
2. Execute milestone by milestone. Each milestone ends with: all tests green, `PROGRESS.md` updated (done / next / risks), and a "see it in 2 minutes" demo note.
3. Create `CLAUDE.md` at repo root holding §3 of this brief + project conventions, so every future session keeps context.
4. Conventional commits, small and focused.
5. Ask me only blocking questions; otherwise pick the sensible default and log it in `ASSUMPTIONS.md`.
6. Known open points — do **not** block on them: accounting-bridge aggregation level (assume one daily entry per fund), opening balances (schema-ready, import later), electronic-order goods-value flow (isolate behind a strategy seam; BR1 depends on fees only either way).

## 8. Milestones

- **M0 Scaffold** — repo, CI, docker dev, auth + roles + audit skeleton, i18n/RTL shell, seed. DoD: log in as all four roles; audit rows written; CI green.
- **M1 Ledger core (E)** — funds tree exactly as the client specified (office_cash, office_wallet, per-driver cash, per-driver wallet, yalago_share, cost centers), postings, daily FX, manual entries with mandatory reason, daily cash-count screen, Sunday lock. DoD: property tests green; immutability proven by test.
- **M2 Fleet & people (B)** — drivers, vehicles, documents + expiry alerts, assignment.
- **M3 Shifts (C)** — the big one: states incl. `suspended`, both gates, media upload + compression, driver confirm, manager approve, BR1 engine with difference breakdown UI, flexible float handling. DoD: the §3 worked example passes end-to-end through the real UI.
- **M4 Tiers (F)** — effective-dated rules engine, default table, whole/marginal switch, simulation against past data, admin-only editing with audit.
- **M5 Expenses (G) + minimal ops dashboard** — today's revenue, open shifts, missing packages, fleet status.
- **M6 Hardening & deploy** — staging live, smoke tests, backup restore rehearsed, `RUNBOOK.md`, and a step-by-step **Arabic UAT checklist** I can hand to the client.

## 9. Definition of DONE for Bundle 1

All §5 tests green in CI · acceptance criteria #1–7, 9, 12 demonstrably pass · staging deployed with seed data and a demo walkthrough · one rehearsed backup restore · `CLAUDE.md`, `RUNBOOK.md`, `PROGRESS.md`, `ASSUMPTIONS.md`, `TESTS.md` all current.

— Start now with §7 step 1.
