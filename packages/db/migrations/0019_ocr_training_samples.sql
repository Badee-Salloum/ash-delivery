-- Every shift teaches the reader — the training data the hand-transcription could not produce.
--
-- The classifier ships with ~500 glyphs transcribed by one person off 25 screenshots, and a day
-- spent adding 25 more measurably made it WORSE: averaged prototypes dilute when the samples come
-- from other phones. What it has never had is VOLUME from the phones actually in use.
--
-- That already flows through this system and is thrown away. The driver scans, the reader proposes,
-- the driver corrects, the manager approves — and that approved figure is ground truth, verified by
-- two people, arriving free with every shift.
--
-- WHY A STRIP AND NOT THE SCREENSHOT. Both matter and they are different things:
--   • the screenshot is EVIDENCE, kept in `media`, and it is compressed to ~300 KB / 1280 px /
--     quality 0.4 before upload — at twelve by sixteen pixels a glyph that destroys the strokes a
--     model would learn from, so it is the wrong picture for this even though it is the right one
--     for an audit;
--   • the strip is the fee's own pixels, cut losslessly from what the reader was handed. It holds
--     «٢٣٥ SYP» and nothing else: no address, no name, no dropped map pin. The place lines carry
--     those, which is why the crop stops at the amount box.
-- It stays a STRIP rather than per-glyph bitmaps so the cut points can be revisited later. Freezing
-- today's segmentation into the training set would bake in the very decisions that produced «1105».
--
-- Deliberately NOT columns on shift_orders: this is research material with its own lifetime, it must
-- be deletable without touching a money row, and it must never be dragged into a ledger query.

CREATE TABLE ocr_fee_samples (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_order_id    uuid NOT NULL REFERENCES shift_orders(id) ON DELETE CASCADE,
  -- What the reader said, and how sure it was allowed to be:
  --   'ocr'      it read a fee        → `fee_ocr_minor` on the order is its answer
  --   'refused'  it saw the row and declined → the driver's fee is the correction it needs most
  -- A row typed with no screenshot behind it is not a sample and is never inserted here.
  source            text NOT NULL CHECK (source IN ('ocr', 'refused')),
  -- The strip itself. `bytea`, not a blob key: a couple of kilobytes apiece, and keeping it in the
  -- row is what makes `DELETE` actually delete it rather than orphan an object in a bucket.
  strip_png         bytea NOT NULL CHECK (octet_length(strip_png) BETWEEN 1 AND 65536),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One sample per order. A re-submitted close must not stack duplicates of the same pixels.
  UNIQUE (shift_order_id)
);

COMMENT ON TABLE ocr_fee_samples IS
  'Training samples for the glyph reader: the fee''s own pixels beside what OCR made of them. The '
  'approved value is joined from shift_orders.fee_minor at export time — never copied here, so this '
  'table can never disagree with the money.';

-- The export is always "samples whose order has since been approved", because an unapproved fee is
-- not yet ground truth.
CREATE INDEX ocr_fee_samples_order_idx ON ocr_fee_samples (shift_order_id);
