-- The cloud reader gets a ledger of its own.
--
-- Until now every reader ran on the driver's phone and cost nothing, so nothing in this schema ever
-- had to know how many times a screenshot had been read. A paid vision model changes that in three
-- ways at once, and one table answers all three:
--
--   1. DEDUPE.   The same pixels must never be billed twice. A driver retakes a screenshot; a client
--                retries after a timeout; a shift is re-submitted. At roughly three cents a call
--                with a hundred bikes, "read it again" is the difference between a line item and a
--                problem. The unique index below is the whole mechanism.
--   2. A CAP.    `countBilledForShift` reads this table. Nothing else in this API rate-limits
--                anything — `@fastify/rate-limit` is a declared dependency that has never been
--                registered — so without this a single phone in a retry loop is unbounded spend.
--   3. THE BILL. `tokens_in` / `tokens_out` / `latency_ms` are the only cost telemetry that will
--                exist. Estimating a recurring charge from a vendor's price page and never
--                measuring it is how a monthly bill becomes a surprise.
--
-- WHY IT CANNOT REUSE `media.sha256`. The evidence upload hashes the COMPRESSED copy — 1280 px at
-- quality 0.4, which migration 0019 calls "the single largest accuracy lever in the whole feature"
-- and which is deliberately too degraded to read. The cloud reader is sent a much larger image, so
-- the two hashes are different bytes describing the same photograph. Joining on one would silently
-- never hit.
--
-- NOT AUDITED, and that is deliberate: nothing here is money, nobody can edit it, and it holds no
-- decision. It is a receipt.

CREATE TABLE ocr_reads (
  id           uuid PRIMARY KEY,
  branch_id    uuid NOT NULL REFERENCES branches(id),

  -- Null when a read is not tied to a shift. Today every caller passes one; the column stays
  -- nullable so a manager re-reading an old photo from the review screen does not need a fiction.
  shift_id     uuid REFERENCES shifts(id) ON DELETE CASCADE,

  -- WHICH SCREEN. Not a foreign key: it is the name of a code path, exactly like `ocr_samples.kind`.
  field        text NOT NULL CHECK (field IN ('orders', 'payments_log', 'wallet', 'odometer', 'bms')),

  -- Content address of the bytes SENT. See the note above on why this is not `media.sha256`.
  -- `text` hex, matching `media.sha256` and `cash_counts.proof_sha256` — this schema has one
  -- spelling for a hash and a second one would be a trap for the first person who joins them.
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size    integer NOT NULL CHECK (byte_size > 0),

  -- The reader, named. `gpt-5.5` at low effort and at medium effort are two different readers
  -- wearing one name, so the settings ride along in `result` rather than being inferred later.
  model        text NOT NULL,

  -- What came back, verbatim, including a failure. A stored `{"ok":false,"reason":"timeout"}` is
  -- what stops us paying to rediscover that this image times out.
  result       jsonb NOT NULL,

  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  latency_ms   integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES users(id)
);

COMMENT ON TABLE ocr_reads IS
  'One row per billed cloud OCR call. Doubles as the dedupe cache, the per-shift cap counter and the only cost meter this API has.';

COMMENT ON COLUMN ocr_reads.sha256 IS
  'Lowercase hex sha256 of the bytes sent to the provider — NOT media.sha256, which hashes the smaller compressed evidence copy of the same photograph.';

-- THE DEDUPE KEY, and the reason this table exists at all.
--
-- Scoped by branch so one branch can never learn what another photographed, and by field because
-- the same pixels asked a different question are a different answer: an orders screen read as a
-- payments log returns different rows.
CREATE UNIQUE INDEX ocr_reads_sha_uq ON ocr_reads (branch_id, sha256, field);

-- The cap counts rows for a shift. A cache hit writes nothing and therefore costs nothing against
-- it — capping cache hits would punish a driver for the network being bad.
CREATE INDEX ocr_reads_shift_idx ON ocr_reads (shift_id) WHERE shift_id IS NOT NULL;

-- The bill, by day. `created_at` alone is enough; there is no business_date here because a token is
-- spent when it is spent and does not belong to a shift's business day.
CREATE INDEX ocr_reads_cost_idx ON ocr_reads (created_at);

-- ── The training corpus keeps both opinions ──────────────────────────────────────────────────
--
-- The cloud read becomes the value that PREFILLS the driver's field, so `fee_ocr_minor`,
-- `odo_start_ocr` and `end_wallet_declared_ocr_minor` now record what the cloud said — that is what
-- keeps the D-3 «OCR → confirmed» delta on the manager's review honest about the reader that
-- actually made the suggestion.
--
-- But the on-device reader is being kept precisely so it can be TRAINED, and training data is a
-- triple: the pixels, what the reader said, and what the human confirmed. Take away the middle term
-- and the strips become unlabelled images. So the sample rows carry the LOCAL reading, beside the
-- strip they came from, whatever the cloud said about the same screen.
ALTER TABLE ocr_samples
  ADD COLUMN reader  text NOT NULL DEFAULT 'local' CHECK (reader IN ('local', 'cloud')),
  ADD COLUMN reading text;

ALTER TABLE ocr_fee_samples
  ADD COLUMN reader  text NOT NULL DEFAULT 'local' CHECK (reader IN ('local', 'cloud')),
  ADD COLUMN reading text;

COMMENT ON COLUMN ocr_samples.reading IS
  'What THIS reader made of these pixels, as printed. Null for a refusal. The human-approved value is still joined from the owning row at export — never copied here.';

COMMENT ON COLUMN ocr_samples.reader IS
  'Which reader produced the reading. Defaults to local: every row that existed before the cloud reader did came from the on-device one.';

-- The existing unique indexes key on (shift_order_id) and (shift_id, package, kind), which was right
-- when there was one reader. With two, the same strip can legitimately carry a local reading and a
-- cloud one, and the old index would let the second silently do nothing.
DROP INDEX ocr_samples_fee_idx;
DROP INDEX ocr_samples_shift_idx;
CREATE UNIQUE INDEX ocr_samples_fee_idx   ON ocr_samples (shift_order_id, reader) WHERE kind = 'fee';
CREATE UNIQUE INDEX ocr_samples_shift_idx ON ocr_samples (shift_id, package, kind, reader) WHERE kind <> 'fee';
