-- ── 0014: manual orders, their shares, their route, and a note ───────────────────────────
--
-- Until now every order was Yallago's: their 20% came off it and the rest was split between the
-- driver and the company at the DAY's tier band (BR4 / SRS F-1). The branch also takes jobs of its
-- own, and those are a different animal — Yallago never sees them, so no cut is due, and the two
-- shares are agreed on the spot rather than derived from a band. Both kinds live in one table
-- because they are both deliveries on one shift and BR1 counts them together.
--
--  1. KIND. `yallago` (the default — every existing row is one) or `manual`.
--  2. THE TWO SHARES, on manual orders only. Held as BIGINT minor units like all money here, and
--     validated app-side to sum to the fee EXACTLY, which is what keeps `shareSplit` able to
--     exhaust `fee_earned` and the ledger from drifting.
--  3. WHERE IT WENT. A manual job is a route, not a zone: a start, an end, and any number of stops
--     between them. Each point carries a written place (always) and coordinates (only if someone
--     dropped a pin), so the common case costs nobody a map.
--  4. A NOTE, and WHO ENTERED IT. Nothing on an order recorded its author before.

ALTER TABLE shift_orders
  ADD COLUMN kind text NOT NULL DEFAULT 'yallago' CHECK (kind IN ('yallago', 'manual')),
  -- NULL for a Yallago order: its split is the day's band, computed at approval, never stored here.
  ADD COLUMN driver_share_minor  bigint CHECK (driver_share_minor  IS NULL OR driver_share_minor  >= 0),
  ADD COLUMN company_share_minor bigint CHECK (company_share_minor IS NULL OR company_share_minor >= 0),
  ADD COLUMN notes text,
  ADD COLUMN created_by uuid REFERENCES users(id);

-- Both shares are present together or not at all — a half-entered split is not a split.
ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_shares_ck
    CHECK ((driver_share_minor IS NULL) = (company_share_minor IS NULL));

-- A manual order must carry its shares; a Yallago order must not (its band decides them).
ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_kind_shares_ck
    CHECK (
      (kind = 'manual'  AND driver_share_minor IS NOT NULL) OR
      (kind = 'yallago' AND driver_share_minor IS NULL)
    );

COMMENT ON COLUMN shift_orders.kind IS
  'yallago = their delivery (20% cut + daily tier band); manual = the branch''s own job (no cut, shares typed)';

-- ── The route of an order ────────────────────────────────────────────────────────────────
-- `label` is what a human would say — «مطعم الشام، شارع بغداد» — and is always required, because
-- that is how the work is actually described. `lat`/`lng` are optional: they exist when someone
-- dropped a pin, and their absence must never stop an order being recorded. Plain double precision,
-- as on gps_pings: coordinates are not money and the bigint rule does not apply to them.
CREATE TABLE shift_order_points (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES shift_orders(id) ON DELETE CASCADE,
  seq        smallint NOT NULL CHECK (seq >= 1),
  role       text NOT NULL CHECK (role IN ('start', 'stop', 'end')),
  label      text NOT NULL,
  lat        double precision CHECK (lat IS NULL OR (lat BETWEEN -90  AND 90)),
  lng        double precision CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180)),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A pin is both coordinates or neither; one of the two alone locates nothing.
  CONSTRAINT shift_order_points_pin_ck CHECK ((lat IS NULL) = (lng IS NULL)),
  UNIQUE (order_id, seq)
);
CREATE INDEX shift_order_points_order_idx ON shift_order_points (order_id, seq);

-- Audited for the same reason the order is: it is evidence a manager approved a shift against.
CREATE TRIGGER audit_shift_order_points
  AFTER INSERT OR UPDATE OR DELETE ON shift_order_points
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
