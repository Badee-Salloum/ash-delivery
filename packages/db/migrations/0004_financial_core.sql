-- 0004 — funds, daily FX, week locks, the double-entry journal, cash counts, expenses
-- SRS §E, §G, BR6, BR7. ⚠ NOT YET EXECUTED — see 0001.
--
-- EVERY money column in this file is BIGINT minor units. 1 minor = 1/100 new SYP = 1 old lira.
-- No numeric, no real, no double precision, anywhere near money. `scripts/check-sql.mjs`
-- enforces this statically and a boot assertion re-checks information_schema at runtime.

-- ── Funds tree (E-1 / س48) ───────────────────────────────────────────────────────────────
CREATE TYPE fund_type AS ENUM (
  'office_cash',           -- صندوق كاش المكتب
  'office_wallet',         -- صندوق محفظة المكتب
  'driver_cash',           -- صندوق كاش لكل سائق
  'driver_wallet',         -- صندوق محفظة لكل سائق
  'yalago_share',          -- صندوق حصة يلاغو
  'driver_share_payable',  -- what the company owes the driver after the tier split (BR4)
  'company_revenue',       -- the company's side of the block
  'cost_center'            -- vehicle / branch / general (G-1)
);

CREATE TABLE funds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  type          fund_type NOT NULL,
  owner_kind    text NOT NULL CHECK (owner_kind IN ('branch', 'driver', 'vehicle', 'none')),
  owner_id      uuid,
  code          text NOT NULL,
  name_ar       text NOT NULL,
  currency      text NOT NULL DEFAULT 'SYP_NEW' CHECK (currency IN ('SYP_NEW')),
  -- N-2 seam: the accounting bridge maps each fund to a line over there. Nullable and unused
  -- now; adding it later would mean a migration on a live ledger.
  external_account_code text,
  -- A cache, not the truth. The truth is SUM(journal_lines). Recomputed nightly and compared;
  -- a silently stale balance on the cash-count screen is how a branch learns to distrust the
  -- system.
  cached_balance_minor  bigint NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funds_owner_ck CHECK ((owner_kind = 'none') = (owner_id IS NULL)),
  CONSTRAINT funds_code_uq  UNIQUE (branch_id, code)
);
-- One driver_cash fund per driver, one driver_wallet per driver, etc.
CREATE UNIQUE INDEX funds_owner_type_uq ON funds (branch_id, type, owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX funds_branch_type_idx ON funds (branch_id, type) WHERE active;

-- ── Daily FX (BR6, E-4 / س9, س55) ────────────────────────────────────────────────────────
-- ONE rate per business date, applied to that entire day's transactions.
CREATE TABLE fx_days (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_date  date NOT NULL UNIQUE,
  -- USD per 1 new SYP is a tiny fraction, so store the inverse as minor-unit-per-USD:
  -- syp_minor_per_usd = 13_000 means 130 new SYP to the dollar.
  syp_minor_per_usd bigint NOT NULL CHECK (syp_minor_per_usd > 0),
  -- `provisional` marks a rate carried forward because the admin had not entered today's yet.
  -- Posting must NEVER be blocked on a missing rate (a failed cron would freeze the business),
  -- so the posting path lazily upserts a provisional row and flags it for correction.
  provisional    boolean NOT NULL DEFAULT false,
  entered_by     uuid REFERENCES users(id),
  entered_at     timestamptz NOT NULL DEFAULT now()
);

-- Supersession history, so a corrected rate never rewrites what was already reported.
CREATE TABLE fx_rate_versions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fx_day_id         bigint NOT NULL REFERENCES fx_days(id) ON DELETE CASCADE,
  syp_minor_per_usd bigint NOT NULL CHECK (syp_minor_per_usd > 0),
  provisional       boolean NOT NULL,
  entered_by        uuid REFERENCES users(id),
  entered_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz
);

-- ── Financial week locks (BR7, E-6 / س57, س59) ───────────────────────────────────────────
-- The week runs SUNDAY → SATURDAY (product-owner confirmed) and is closed by the system admin
-- the FOLLOWING Sunday. `week_start_date` is stored explicitly and computed in the domain —
-- Postgres date_trunc('week') is ISO, i.e. MONDAY-based, and would put this boundary one day
-- off in exactly the place where entries become immutable.
CREATE TABLE week_locks (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id        uuid NOT NULL REFERENCES branches(id),
  week_start_date  date NOT NULL,        -- always a Sunday; asserted by the app and by 0006
  week_end_date    date NOT NULL,        -- always the following Saturday
  closed_at        timestamptz,
  closed_by        uuid REFERENCES users(id),
  summary          jsonb,
  UNIQUE (branch_id, week_start_date),
  CONSTRAINT week_locks_span_ck CHECK (week_end_date = week_start_date + 6)
);
CREATE INDEX week_locks_open_idx ON week_locks (branch_id, week_start_date) WHERE closed_at IS NULL;

-- ── The journal (E-2, BR4) ───────────────────────────────────────────────────────────────
CREATE TYPE ledger_event AS ENUM (
  'float_out',      -- عهدة: office_cash  → driver_cash
  'wallet_topup',   -- شحن:  office_wallet → driver_wallet
  'order_fee',      -- أجور الطلبات بأنماطها الثلاثة
  'yalago_cut',     -- خصم يلاغو اللحظي (BR2)
  'share_split',    -- التوزيع الدفتري بالشريحة عند الاعتماد (BR4)
  'float_return',   -- إعادة العهدة
  'wallet_return',  -- إعادة رصيد المحفظة — the wallet is zeroed daily like the float (D-4)
  'expense',
  'manual',
  'correction'
);

CREATE TABLE journal_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id        uuid NOT NULL REFERENCES branches(id),
  event_type       ledger_event NOT NULL,
  shift_id         uuid,                              -- FK added in 0005
  -- The discriminator that makes idempotency compatible with SRS C-5's multiple float and
  -- top-up tranches per day. A key of (shift_id, event_type) ALONE — as the kickoff brief
  -- specifies — makes the second tranche unpostable and lets an "idempotent replay" swallow
  -- it silently, so cash leaves the office with no ledger record. See ASSUMPTIONS A-10.
  occurrence_key   text NOT NULL DEFAULT '1',
  -- WRITTEN, never generated: (occurred_at AT TIME ZONE 'Asia/Damascus')::date is STABLE, not
  -- IMMUTABLE, and Postgres refuses it in a generated column. Fed by domain businessDateFor().
  business_date    date NOT NULL,
  -- When it actually hit the books. Differs from business_date for a late correction, which is
  -- how a correction stays visible as a correction rather than quietly editing the past.
  posting_date     date NOT NULL,
  week_start_date  date NOT NULL,
  fx_day_id        bigint NOT NULL REFERENCES fx_days(id),
  week_lock_id     bigint REFERENCES week_locks(id),
  reversal_of_id   bigint REFERENCES journal_entries(id),
  reason           text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A manual entry or a correction without a stated reason is not auditable (E-3 / س50).
  CONSTRAINT je_reason_ck CHECK (event_type NOT IN ('manual', 'correction') OR reason IS NOT NULL)
);

-- THE idempotency guard (kickoff brief §4, corrected per A-10).
CREATE UNIQUE INDEX je_idempotency_uq
  ON journal_entries (shift_id, event_type, occurrence_key) WHERE shift_id IS NOT NULL;
CREATE INDEX je_business_date_idx ON journal_entries (branch_id, business_date);
CREATE INDEX je_week_idx          ON journal_entries (branch_id, week_start_date);
CREATE INDEX je_shift_idx         ON journal_entries (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX je_unlocked_idx      ON journal_entries (branch_id, week_start_date) WHERE week_lock_id IS NULL;

CREATE TABLE journal_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id      bigint NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  fund_id       uuid   NOT NULL REFERENCES funds(id),
  side          char(1) NOT NULL CHECK (side IN ('D', 'C')),
  -- Strictly positive: direction is carried by `side`, never by a negative amount. A signed
  -- amount plus a side is two ways to say the same thing, and they eventually disagree.
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  line_role     text
);
CREATE INDEX jl_entry_idx ON journal_lines (entry_id);
CREATE INDEX jl_fund_idx  ON journal_lines (fund_id, id);

-- ── Daily cash count (E-5 / س51) ─────────────────────────────────────────────────────────
CREATE TABLE cash_counts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id      uuid NOT NULL REFERENCES branches(id),
  business_date  date NOT NULL,
  counted_by     uuid NOT NULL REFERENCES users(id),
  counted_at     timestamptz NOT NULL DEFAULT now(),
  -- Sealed proof of the count: sha256 over the frozen line set, so the record cannot be
  -- quietly restated afterwards. «إثبات الجرد».
  proof_sha256   text,
  sealed_at      timestamptz,
  notes          text,
  UNIQUE (branch_id, business_date)
);

CREATE TABLE cash_count_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cash_count_id   bigint NOT NULL REFERENCES cash_counts(id) ON DELETE CASCADE,
  fund_id         uuid NOT NULL REFERENCES funds(id),
  counted_minor   bigint NOT NULL,
  computed_minor  bigint NOT NULL,     -- frozen at count time, not recomputed at read time
  variance_minor  bigint NOT NULL,
  resolution      text,
  UNIQUE (cash_count_id, fund_id)
);

-- ── Expenses (G) ─────────────────────────────────────────────────────────────────────────
CREATE TABLE expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name_ar    text NOT NULL,
  name_en    text,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL REFERENCES branches(id),
  category_id       uuid NOT NULL REFERENCES expense_categories(id),
  -- G-1 cost centres: vehicle / branch / general — these feed per-axis profitability.
  cost_center_kind  text NOT NULL CHECK (cost_center_kind IN ('vehicle', 'branch', 'general')),
  vehicle_id        uuid REFERENCES vehicles(id),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  business_date     date NOT NULL,
  description       text NOT NULL,
  receipt_media_id  uuid,                       -- FK added in 0005; required above the ceiling
  journal_entry_id  bigint REFERENCES journal_entries(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_vehicle_ck CHECK ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL))
);
CREATE INDEX expenses_branch_date_idx ON expenses (branch_id, business_date);
CREATE INDEX expenses_vehicle_idx     ON expenses (vehicle_id) WHERE vehicle_id IS NOT NULL;

ALTER TABLE vehicle_events
  ADD CONSTRAINT vehicle_events_expense_fk FOREIGN KEY (expense_id) REFERENCES expenses(id);
