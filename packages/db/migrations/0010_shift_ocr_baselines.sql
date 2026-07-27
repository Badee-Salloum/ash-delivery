-- ── 0010: SRS D-3 OCR baselines for the odometer, battery, wallet and order fee ─────────────
--
-- D-3 requires every manual edit to be logged WITH its difference from the OCR reading — raw
-- material for later anomaly detection. The per-pack BMS readings already keep an `ocr_raw`
-- baseline (0007); the dashboard odometer/battery, the close wallet balance and the order fee
-- discarded theirs. These columns keep the pre-correction OCR value so the delta stays computable.
--
-- All additive and nullable: OCR never ran (or the driver typed straight) ⇒ NULL ⇒ no delta.
-- The odometer/battery are plain scaled integers; the wallet and the fee are money in minor units.
ALTER TABLE shifts ADD COLUMN odo_start_ocr                 integer;
ALTER TABLE shifts ADD COLUMN battery_start_ocr             smallint CHECK (battery_start_ocr BETWEEN 0 AND 100);
ALTER TABLE shifts ADD COLUMN end_wallet_declared_ocr_minor bigint;

COMMENT ON COLUMN shifts.odo_start_ocr                 IS 'Pre-correction OCR odometer (readDashboard) — SRS D-3 baseline. NULL = OCR did not run.';
COMMENT ON COLUMN shifts.battery_start_ocr             IS 'Pre-correction OCR battery %% (readDashboard) — SRS D-3 baseline.';
COMMENT ON COLUMN shifts.end_wallet_declared_ocr_minor IS 'Pre-correction OCR wallet balance, minor units (readWallet) — SRS D-3 baseline.';

-- The order fee's OCR baseline. `source` (manual|ocr) already exists on shift_orders (0005); this
-- adds the fee we read, so a driver silently lowering an OCR'd fee is visible (money → anomaly).
ALTER TABLE shift_orders ADD COLUMN fee_ocr_minor bigint;

COMMENT ON COLUMN shift_orders.fee_ocr_minor IS 'Pre-correction OCR delivery fee, minor units (readOrders) — SRS D-3 baseline.';
