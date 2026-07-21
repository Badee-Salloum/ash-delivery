-- 0005 — shifts, orders, float tranches, photo evidence, tier rules
-- SRS §C, §F. ⚠ NOT YET EXECUTED — see 0001.

-- ── Media / photo evidence (C-6) ─────────────────────────────────────────────────────────
-- Content-addressed. `sha256` doubles as the upload idempotency key, so a driver whose Wi-Fi
-- dropped mid-upload can retry and the server dedupes instead of storing the photo twice.
CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  sha256          text NOT NULL,
  byte_size       integer NOT NULL CHECK (byte_size > 0),
  mime_type       text NOT NULL,
  storage_key     text NOT NULL,      -- BlobStore key; local disk now, S3-compatible later
  width           integer,
  height          integer,
  -- The driver's phone clock is a CLAIM. The server's receipt time is authoritative. Both are
  -- stored, and a large gap is surfaced to the branch manager — that difference is what makes
  -- a photo evidence rather than just a picture.
  client_taken_at timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, sha256)
);

ALTER TABLE documents ADD CONSTRAINT documents_media_fk FOREIGN KEY (media_id) REFERENCES media(id);
ALTER TABLE expenses  ADD CONSTRAINT expenses_receipt_fk FOREIGN KEY (receipt_media_id) REFERENCES media(id);

-- ── Shifts (C-1) ─────────────────────────────────────────────────────────────────────────
CREATE TYPE shift_state AS ENUM (
  'draft',                    -- driver is assembling the start package
  'awaiting_open_approval',   -- driver confirmed; branch manager has not yet approved (BR5)
  'open',
  'pending_review',           -- end package submitted; awaiting the manager (BR5)
  'approved',
  'suspended',                -- mid-shift incident (C-1 / س29); completed later, same equation
  'week_locked'
);

CREATE TABLE shifts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id                 uuid NOT NULL REFERENCES branches(id),
  driver_id                 uuid NOT NULL REFERENCES drivers(id),
  vehicle_id                uuid NOT NULL REFERENCES vehicles(id),
  shift_no                  smallint NOT NULL CHECK (shift_no >= 1),
  business_date             date NOT NULL,
  week_start_date           date NOT NULL,
  state                     shift_state NOT NULL DEFAULT 'draft',

  -- Σ of the tranches below, maintained by trigger. Denormalised because BR1 reads it on every
  -- keystroke of the driver's order-entry screen.
  start_cash_float_minor    bigint NOT NULL DEFAULT 0 CHECK (start_cash_float_minor >= 0),
  start_wallet_topup_minor  bigint NOT NULL DEFAULT 0 CHECK (start_wallet_topup_minor >= 0),

  end_cash_declared_minor   bigint,
  end_wallet_declared_minor bigint,

  odo_start                 integer,
  odo_end                   integer,
  battery_start             smallint CHECK (battery_start BETWEEN 0 AND 100),
  battery_end               smallint CHECK (battery_end   BETWEEN 0 AND 100),

  -- BR1. `equation_diff_minor` must be 0 to approve. The two component differences are stored
  -- because the scalar is blind to a pay-mode error: flip one order cash↔electronic and the
  -- scalar stays at exactly 0 while cash is off by −fee and wallet by +fee.
  equation_diff_minor       bigint,
  cash_diff_minor           bigint,
  wallet_diff_minor         bigint,

  -- Re-verified inside the approval transaction: if the driver edited an order between the
  -- manager loading the screen and pressing approve, the hash no longer matches and the
  -- approval is rejected with a 409 rather than posting against numbers nobody reviewed.
  orders_hash               text,

  driver_confirmed_at       timestamptz,
  opened_by                 uuid REFERENCES users(id),
  open_approved_by          uuid REFERENCES users(id),
  open_approved_at          timestamptz,
  submitted_at              timestamptz,
  approved_by               uuid REFERENCES users(id),
  approved_at               timestamptz,
  suspended_at              timestamptz,
  suspension_reason         text,
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shifts_no_uq UNIQUE (driver_id, business_date, shift_no),
  CONSTRAINT shifts_odo_ck CHECK (odo_end IS NULL OR odo_start IS NULL OR odo_end >= odo_start)
);

-- A driver may hold only one live shift at a time; likewise a vehicle. A vehicle IS shared
-- between drivers (س23) — just not simultaneously.
CREATE UNIQUE INDEX shifts_one_live_per_driver_uq ON shifts (driver_id)
  WHERE state IN ('draft', 'awaiting_open_approval', 'open', 'pending_review', 'suspended');
CREATE UNIQUE INDEX shifts_one_live_per_vehicle_uq ON shifts (vehicle_id)
  WHERE state IN ('draft', 'awaiting_open_approval', 'open', 'pending_review', 'suspended');

CREATE INDEX shifts_branch_date_idx ON shifts (branch_id, business_date);
CREATE INDEX shifts_awaiting_idx    ON shifts (branch_id, submitted_at)
  WHERE state IN ('awaiting_open_approval', 'pending_review');

ALTER TABLE journal_entries ADD CONSTRAINT je_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id);
ALTER TABLE vehicle_events  ADD CONSTRAINT vehicle_events_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id);

-- ── Flexible float and top-up tranches (C-5 / س3, س11) ───────────────────────────────────
-- «تسليم كاش التحرك وشحن المحفظة بمبالغ مرنة … مع دعم أكثر من دفعة ضمن اليوم».
-- Each tranche posts its own journal entry, discriminated by occurrence_key = seq_no.
CREATE TABLE float_tranches (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id         uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('cash_float', 'wallet_topup')),
  seq_no           smallint NOT NULL CHECK (seq_no >= 1),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  handed_at        timestamptz NOT NULL DEFAULT now(),
  handed_by        uuid REFERENCES users(id),
  journal_entry_id bigint REFERENCES journal_entries(id),
  UNIQUE (shift_id, kind, seq_no)
);

-- ── Shift orders (C-4, BR3) ──────────────────────────────────────────────────────────────
CREATE TYPE pay_mode AS ENUM ('cash', 'electronic', 'free');

CREATE TABLE shift_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id           uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  provider_order_no  text NOT NULL,
  pay_mode           pay_mode NOT NULL,
  fee_minor          bigint NOT NULL CHECK (fee_minor >= 0),
  -- م-3 seam: shipped inactive. BR1 is fee-only under either answer PROVIDED the goods value
  -- round-trips. Flipping this is a setting, not a migration.
  goods_value_minor  bigint NOT NULL DEFAULT 0 CHECK (goods_value_minor >= 0),
  zone               text,
  -- 'manual' in Bundle 1 (drivers type the numbers; photos are the evidence — SRS D-5).
  -- Bundle 2's OCR writes 'ocr' here and fills ocr_confidence, with no schema change.
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr')),
  ocr_confidence     real,          -- a confidence score, not money — real is correct here
  driver_confirmed   boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Yallago's own order number, globally unique: duplicate entry is a data-entry error worth
-- catching as it is typed, and this doubles as the Bundle-2 reconciliation key (H-2 / س17).
CREATE UNIQUE INDEX shift_orders_provider_no_uq ON shift_orders (provider_order_no);
CREATE INDEX shift_orders_shift_idx ON shift_orders (shift_id);

-- ── Evidence packages (C-2, C-3) ─────────────────────────────────────────────────────────
CREATE TABLE shift_media (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES media(id),
  package     text NOT NULL CHECK (package IN ('start', 'end')),
  slot        text NOT NULL,   -- odometer | battery | dashboard | wallet | cash_handover | wallet_zeroed
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One photo per slot per package: re-uploading replaces rather than accumulating.
  UNIQUE (shift_id, package, slot)
);

-- Manager decisions, including re-shoot requests (C-7).
CREATE TABLE shift_decisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id     uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  gate         text NOT NULL CHECK (gate IN ('open', 'close')),
  decision     text NOT NULL CHECK (decision IN ('approved', 'rejected', 'rephoto_requested')),
  notes        text,
  decided_by   uuid NOT NULL REFERENCES users(id),
  decided_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_decisions_shift_idx ON shift_decisions (shift_id, decided_at DESC);

-- ── Tier rules (F) ───────────────────────────────────────────────────────────────────────
CREATE TABLE tier_rules (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  basis            text NOT NULL DEFAULT 'orders' CHECK (basis IN ('orders', 'revenue')),
  mode             text NOT NULL DEFAULT 'whole'  CHECK (mode  IN ('whole', 'marginal')),
  vehicle_type_id  uuid REFERENCES vehicle_types(id),   -- NULL = applies to all (F-4)
  bands            jsonb NOT NULL,     -- validated by the domain's validateBands() before insert
  effective_from   date NOT NULL,
  -- Resolution reads status IN ('active','superseded'). Filtering on 'active' alone would
  -- silently restate every historical day the first time the table is edited.
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'withdrawn')),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_type_id, effective_from)
);
CREATE INDEX tier_rules_lookup_idx ON tier_rules (effective_from DESC) WHERE status <> 'withdrawn';

-- Per-driver, per-day share state — the basis of the «تسوية شريحة اليوم» true-up when a second
-- shift pushes the day across a band.
CREATE TABLE driver_day_shares (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  driver_id           uuid NOT NULL REFERENCES drivers(id),
  business_date       date NOT NULL,
  order_count         integer NOT NULL DEFAULT 0,
  fee_total_minor     bigint NOT NULL DEFAULT 0,
  driver_share_minor  bigint NOT NULL DEFAULT 0,
  company_share_minor bigint NOT NULL DEFAULT 0,
  yalago_share_minor  bigint NOT NULL DEFAULT 0,
  tier_rule_id        bigint REFERENCES tier_rules(id),
  effective_driver_bps integer,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, business_date)
);
