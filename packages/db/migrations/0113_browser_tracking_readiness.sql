-- Identify the permission model used for this shift's opening check.
ALTER TABLE gps_tracker_health ADD COLUMN readiness_client text NOT NULL DEFAULT 'android'
  CHECK (readiness_client IN ('android','browser'));
