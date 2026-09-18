-- 0063 - GPS ingest that survives buffering: a natural key, capture-order reads, and a source
--
-- Measured in production on 2026-09-08, before this change: seven shifts open, ONE driver
-- broadcasting, and that one fix captured at 12:31:59Z but received at 13:04:13Z. Sampled twice
-- four minutes apart it was byte-identical -- a frozen beacon, not a slow one. The live map draws
-- `received_at`, so it presented a half-hour-old position as current.
--
-- The fix is a background uploader that buffers while offline, and buffering is exactly what makes
-- the three changes below load-bearing rather than tidy.
--
--
-- 1. THE TRAIL MUST READ IN CAPTURE ORDER.
--
-- `listForShift` orders by `received_at`, which is correct only while every fix arrives alone and
-- immediately -- true today, false the moment anything buffers. A batch received at 14:00 carrying
-- fixes captured 12:00-13:00 sorts AFTER fixes captured at 13:30 that arrived live. The trail then
-- zigzags across the city and the summed distance inflates without bound, which is a number a
-- manager would act on. The repository read changes with this migration, in the same release as
-- the buffer and never after it.
--
--
-- 2. THE NATURAL KEY IS (shift_id, captured_at).
--
-- Two fixes at the same millisecond for one shift are physically meaningless, so this is a true
-- natural key rather than a client-supplied token. It makes a retried batch free, kills the
-- duplicate a second open tab produces, and -- because `shift_id` leads -- it also serves the trail
-- read, replacing `gps_pings_shift_idx` outright.
--
-- Its one blind spot, stated: a phone whose clock stands still silently loses fixes. Those fixes
-- carry no information anyway, and the coverage figure on the frozen trail will show it.
--
-- Duplicates are removed FIRST, keeping the lowest id. A unique index cannot be built over existing
-- duplicates, and `migrate.ts` wraps every file in one transaction -- so this either lands whole or
-- not at all, and CREATE INDEX CONCURRENTLY is not available. Both indexes are therefore built now,
-- while the table is small.
--
--
-- 3. THE LIVE MAP'S QUERY SHAPE, NOT JUST ITS INDEX.
--
-- `DISTINCT ON (driver_id) ... ORDER BY driver_id, received_at DESC` does not skip: it reads every
-- tuple for the branch in index order, so it degrades with total history and no index alone fixes
-- that. The repository switches to a lateral seek per live driver, which is O(drivers) and stays
-- flat forever; `(branch_id, driver_id, received_at DESC)` is the index that serves it.
--
-- Net index count is unchanged at three, so the write cost on the hottest path does not move.

-- Keep the lowest id per (shift, captured_at); a duplicate carries no information the original lacks.
DELETE FROM gps_pings a
 USING gps_pings b
 WHERE a.shift_id = b.shift_id
   AND a.captured_at = b.captured_at
   AND a.id > b.id;

CREATE UNIQUE INDEX gps_pings_shift_captured_uidx ON gps_pings (shift_id, captured_at);
CREATE INDEX gps_pings_branch_driver_recent_idx ON gps_pings (branch_id, driver_id, received_at DESC);

DROP INDEX gps_pings_shift_idx;
DROP INDEX gps_pings_branch_recent_idx;

-- Where the fix came from. `phone_fg` is what every existing row is: the foreground beacon that
-- only runs while the driver is looking at the app.
--
-- The column exists now so a hardware tracker can land beside the phone later WITHOUT a second
-- schema -- SRS K-1 specifies a GT06 unit fitted to the bike, and the distinction matters for the
-- odometer cross-check: a tracker measures the BIKE, which is the object the odometer measures,
-- while a phone measures the driver. It also lets coverage be compared before and after the
-- background uploader ships, which is how we find out whether it actually survives on these
-- handsets -- from data rather than from a driver's account of his own phone.
ALTER TABLE gps_pings
  ADD COLUMN source text NOT NULL DEFAULT 'phone_fg'
    CHECK (source IN ('phone_fg', 'phone_bg', 'tracker'));

COMMENT ON COLUMN gps_pings.source IS
  'Which capture layer produced the fix: phone_fg (foreground beacon), phone_bg (Android foreground service), tracker (SRS K-1 hardware unit).';
