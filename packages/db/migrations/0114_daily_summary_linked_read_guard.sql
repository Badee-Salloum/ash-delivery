-- Permit optional home-screen OCR in the existing evidence-bound draft write path.
-- No data backfill: submitted/approved shifts and immutable reads remain protected.
CREATE OR REPLACE FUNCTION guard_shift_close_draft_read_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE current_state shift_state;
BEGIN
  SELECT s.state INTO current_state
    FROM public.shifts s
    JOIN public.shift_close_drafts d ON d.shift_id = s.id
   WHERE s.id = NEW.shift_id AND d.submitted_at IS NULL
   FOR UPDATE OF s;
  IF current_state IS NULL OR current_state NOT IN ('open', 'suspended') THEN
    RAISE EXCEPTION 'close-draft OCR is not editable while shift % is %', NEW.shift_id, current_state
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_draft_read_editable_guard';
  END IF;
  IF NOT (
    (NEW.field = 'orders' AND NEW.slot ~ '^dashboard(_([2-9]|[1-9][0-9]+))?$') OR
    (NEW.field = 'payments_log' AND NEW.slot ~ '^payments_log(_([2-9]|[1-9][0-9]+))?$') OR
    (NEW.field = 'wallet' AND NEW.slot = 'wallet') OR
    (NEW.field = 'odometer' AND NEW.slot = 'odometer') OR
    (NEW.field = 'bms' AND NEW.slot ~ '^bms_[1-9][0-9]*$') OR
    (NEW.field = 'daily_summary' AND NEW.slot = 'daily_summary')
  ) THEN
    RAISE EXCEPTION 'close-draft OCR field does not match its evidence slot'
      USING ERRCODE = '23514', CONSTRAINT = 'shift_close_draft_read_slot_field_guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.shift_media sm
     WHERE sm.shift_id = NEW.shift_id AND sm.package = NEW.package AND sm.slot = NEW.slot
       AND sm.media_id = NEW.media_id AND sm.attachment_token = NEW.attachment_token
  ) THEN
    RAISE EXCEPTION 'close-draft OCR attachment generation changed'
      USING ERRCODE = '40001', CONSTRAINT = 'shift_close_draft_read_attachment_guard';
  END IF;
  RETURN NEW;
END
$$;
