-- ── 0015: the operations of a shift — what was delivered, and what the wallet actually did ──
--
-- The driver closes his shift from screenshots: «الطلبات الحديثة» for what he delivered and
-- «سجل المدفوعات» for what moved in his wallet. Both scroll, so both arrive as several images, and
-- overlapping pages mean the same row can be read twice. Everything read is shown to him as one
-- list and he CHECKS which rows belong to this shift.
--
--  1. INCLUDED. An unchecked row is kept with the shift and shown to everyone, but it is out of
--     BR1, out of the tier band and out of the ledger. It is data, not money. This is deliberately
--     a NEW column rather than a reuse of `driver_confirmed`: that one feeds `allOrdersConfirmed`
--     → `unconfirmed_orders` → the close gate REFUSES TO SUBMIT. Unchecking a row must take it out
--     of the arithmetic, not strand the shift.
--
--  2. WALLET_AMOUNT. How much of THIS order's fee actually reached the wallet, read off the log.
--     `pay_mode` says an order is all-cash or all-wallet and the client's real log shows it is
--     neither: a customer settles part electronically and hands over the rest. NULL means nobody
--     measured it, which is exactly `orderWalletAmount`'s fallback-to-pay-mode case — so every
--     shift closed before the log was read keeps its arithmetic to the minor unit.
--
--  3. WALLET MOVEMENTS. The log's own rows: Yallago's 20% per order, the electronic part of an
--     order, and the ones no order explains at all — a merchant paid, an incentive, a top-up.
--     Those last are the term BR1 needs so it stops blaming the driver for money the app moved on
--     its own, and they are what the accounting engine will reclassify later.

ALTER TABLE shift_orders
  ADD COLUMN included boolean NOT NULL DEFAULT true,
  ADD COLUMN wallet_amount_minor bigint,
  -- «HH:MM» as read off the dashboard: the key a log row is paired to, and the evidence of WHY the
  -- two were paired. Unreadable stays NULL rather than becoming a plausible wrong minute.
  ADD COLUMN occurred_minute text;

ALTER TABLE shift_orders
  ADD CONSTRAINT shift_orders_wallet_amount_ck
    CHECK (wallet_amount_minor IS NULL
           OR (wallet_amount_minor >= 0 AND wallet_amount_minor <= fee_minor)),
  ADD CONSTRAINT shift_orders_minute_ck
    CHECK (occurred_minute IS NULL OR occurred_minute ~ '^[0-2][0-9]:[0-5][0-9]$');

COMMENT ON COLUMN shift_orders.included IS
  'unchecked at close: kept as data and shown to everyone, but out of BR1, the tier band and the ledger';
COMMENT ON COLUMN shift_orders.wallet_amount_minor IS
  'measured off the payments log; NULL means unmeasured and the pay mode decides, exactly as before';

-- ── What the wallet actually did ─────────────────────────────────────────────────────────
CREATE TABLE shift_wallet_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  -- SIGNED, because this is a MOVEMENT and not a balance: negative left the wallet (Yallago's cut,
  -- a merchant paid, a withdrawal), positive arrived (an incentive, a top-up, an order's
  -- electronic part). BIGINT minor units like every other money column here.
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0),
  -- «HH:MM» as read; '' when the row's clock was not legible. NOT NULL with '' as a real value,
  -- because SQL treats NULLs as distinct and a NULL here would defeat the natural key below.
  occurred_minute text NOT NULL DEFAULT ''
                  CHECK (occurred_minute = '' OR occurred_minute ~ '^[0-2][0-9]:[0-5][0-9]$'),
  -- Position among rows sharing (shift, minute, amount). A minute genuinely can hold two identical
  -- amounts, so this is part of the row's identity rather than a tiebreak, and it is assigned
  -- server-side — never by the client — as the ordinal among what is already stored.
  seq             smallint NOT NULL CHECK (seq >= 1),
  -- The order this belongs to, or was merely read beside. ON DELETE SET NULL because `voidShift`
  -- deletes a voided shift's orders and a dangling reference would abort the void.
  order_id        uuid REFERENCES shift_orders(id) ON DELETE SET NULL,
  -- What the row IS, which decides how BR1 may use it. The three are disjoint and the distinction
  -- is the whole defence against double counting:
  --   yalago_cut    the 20%. NEVER enters BR1 — the equation derives the cut from the fee, because
  --                 the 80% block is a residual. This row only corroborates that they agree.
  --   order_credit  the electronic part of its order; becomes that order's wallet_amount_minor,
  --                 and is therefore already inside the order's arithmetic.
  --   unmatched     belongs to no order. The ONLY rows summed into BR1's walletAdjustments.
  role            text NOT NULL DEFAULT 'unmatched'
                  CHECK (role IN ('yalago_cut', 'order_credit', 'unmatched')),
  -- TRUE while nobody has yet said whether a credit at an order's minute is that order's
  -- electronic part or an unrelated incentive. The two readings agree on the wallet exactly and
  -- differ on the CASH by the credit, so BR1 catches a wrong guess — no machine may decide it.
  ambiguous       boolean NOT NULL DEFAULT false,
  included        boolean NOT NULL DEFAULT true,
  source          text NOT NULL DEFAULT 'ocr' CHECK (source IN ('ocr', 'manual')),
  -- Which screenshot it was read off: evidence, and how a re-read of one page is traced.
  media_id        uuid REFERENCES media(id),
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A matched row must name its order. An unmatched one may still keep the link as provenance —
  -- it shared a minute — without being counted against that order.
  CONSTRAINT shift_wallet_movements_role_ck CHECK (role = 'unmatched' OR order_id IS NOT NULL),
  -- THE NATURAL KEY. Two overlapping screenshots of one log re-read the same rows, and re-uploading
  -- a page must add nothing. Insert only the surplus per (minute, amount) and this holds.
  CONSTRAINT shift_wallet_movements_natural_uq UNIQUE (shift_id, occurred_minute, amount_minor, seq)
);
CREATE INDEX shift_wallet_movements_shift_idx
  ON shift_wallet_movements (shift_id, occurred_minute, seq);
CREATE INDEX shift_wallet_movements_order_idx
  ON shift_wallet_movements (order_id) WHERE order_id IS NOT NULL;

-- It moves BR1, for the same reason shift_orders does.
CREATE TRIGGER audit_shift_wallet_movements
  AFTER INSERT OR UPDATE OR DELETE ON shift_wallet_movements
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
