-- ── 0008: which BMS app a battery comes with ─────────────────────────────────────────────
--
-- The packs do not all ship with the same phone app, and the apps agree on nothing: one is a
-- dense two-column table in English on white, another is a card grid in Arabic on cyan with the
-- caption UNDER its reading. One universal reader has to guess at all of it and, on the Arabic
-- app, guessed wrong — the label and its value are never on the same line there.
--
-- Naming the app per battery lets the reader use the right label spellings, the right layout rule
-- and the right page segmentation instead of trying everything. NULL means "not told yet", which
-- the reader treats as `auto`: every label, both layouts, both segmentation modes. That is the
-- slowest and least certain path, which is the point — it works, and assigning the real profile
-- makes it better.
--
-- Deliberately TEXT and unconstrained rather than an enum: the profiles live in the driver app
-- (apps/driver/src/ocr.ts, BMS_PROFILES) and a new one must not need a migration to be usable.
ALTER TABLE batteries ADD COLUMN bms_profile text;

COMMENT ON COLUMN batteries.bms_profile IS
  'BMS app profile id for OCR (see BMS_PROFILES in the driver app). NULL = auto-detect.';
