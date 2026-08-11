-- Every reader learns, not just the fee one.
--
-- `ocr_fee_samples` (0019) keeps the pixels behind a delivery fee beside what OCR made of them, and
-- it works. Nothing else has it. Measured on three real shifts, the odometer reader was wrong THREE
-- TIMES OUT OF THREE — it read 200 for 6948, 229 for 5426, and refused the third — and every one of
-- those corrections was thrown away the moment the driver typed the right number.
--
-- WHY THE CAPTURE DIFFERS PER READER, rather than one rule for all:
--   • fee, wallet, payments-log amounts — Arabic-Indic digits read by the glyph classifier. A narrow
--     STRIP of the number's own pixels is exactly what the `glyphs:harvest → glyphs:templates`
--     pipeline consumes, and it holds no address, no name and no map pin.
--   • odometer — the failure is not a misread digit. 200 is not a misreading of 6948; it is a
--     DIFFERENT NUMBER on the dashboard (a trip meter, a voltage). A narrow strip would faithfully
--     crop the mistake, so this one keeps a wider region and the reader has to learn WHERE to look.
--   • BMS — the (what OCR said, what the human said) pair already exists in `ocr_raw`, and 0021 gave
--     the row its `media_id`. Nothing more to store; the export joins it.
--
-- Same rules as 0019, which were right: pixels only, never the ground truth (joined at export, so
-- this table can never disagree with the money), `bytea` inline so DELETE really deletes, research
-- material with its own lifetime, deletable without touching a money row.

CREATE TABLE ocr_samples (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHICH READER produced it. Not a foreign key to anything: it is the name of a code path.
  --
  -- «payments_log» is deliberately ABSENT. Its strips are already cut and discarded by the reader,
  -- so they look free — but a log has one amount PER ROW, and this table owns one sample per
  -- (shift, package, reader). Storing them properly needs a per-movement owner, which is its own
  -- migration. Shipping a `kind` nothing writes would be dead vocabulary pretending to be a feature.
  kind         text NOT NULL CHECK (kind IN ('fee', 'wallet', 'odometer')),

  -- WHAT IT BELONGS TO. Exactly one of these, enforced below.
  --   a fee belongs to its order; everything else belongs to a shift and a package.
  shift_order_id uuid REFERENCES shift_orders(id) ON DELETE CASCADE,
  shift_id       uuid REFERENCES shifts(id)       ON DELETE CASCADE,
  package        text CHECK (package IN ('start', 'end')),

  -- What the reader did, and how sure it was allowed to be.
  --   'ocr'      it read a value        → the baseline column on the owning row is its answer
  --   'refused'  it saw the field and declined → the human's value is the correction it needs most
  source       text NOT NULL CHECK (source IN ('ocr', 'refused')),

  strip_png    bytea NOT NULL CHECK (octet_length(strip_png) BETWEEN 1 AND 262144),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- One owner, never both, never neither. A fee sample without its order, or a shift sample without
  -- its package, cannot be joined to a ground truth at export and is therefore not a sample at all.
  CONSTRAINT ocr_samples_one_owner CHECK (
    (kind = 'fee'  AND shift_order_id IS NOT NULL AND shift_id IS NULL     AND package IS NULL) OR
    (kind <> 'fee' AND shift_order_id IS NULL     AND shift_id IS NOT NULL AND package IS NOT NULL)
  )
);

COMMENT ON TABLE ocr_samples IS
  'Training samples for every reader: the pixels beside what OCR made of them. The human-approved value is joined from the owning row at export time — never copied here, so this table can never disagree with the money.';

COMMENT ON COLUMN ocr_samples.strip_png IS
  'A narrow strip for glyph readers; a wider dashboard region for the odometer, whose failure is choosing the wrong number rather than misreading a digit. 256 KB ceiling covers the wide case.';

-- One sample per fee, and one per (shift, package, reader) for the rest: a re-submitted close must
-- not stack duplicates of the same pixels.
CREATE UNIQUE INDEX ocr_samples_fee_idx   ON ocr_samples (shift_order_id) WHERE kind = 'fee';
CREATE UNIQUE INDEX ocr_samples_shift_idx ON ocr_samples (shift_id, package, kind) WHERE kind <> 'fee';

-- The export is always "samples whose owner has since been approved", because an unapproved value
-- is not yet ground truth.
CREATE INDEX ocr_samples_kind_idx ON ocr_samples (kind, created_at);
