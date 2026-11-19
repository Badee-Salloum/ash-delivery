-- A reviewed card must not display a changed recognized price while silently retaining old cost.
CREATE FUNCTION guard_existing_asset_recognized_edit_alignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.kind='edit_confirm' AND COALESCE(NEW.snapshot->'recognition','null'::jsonb)<>'null'::jsonb
    AND (NEW.snapshot->>'price')::bigint IS DISTINCT FROM (NEW.snapshot->'recognition'->>'cost')::bigint
  THEN RAISE EXCEPTION 'recognized edit must align displayed price with verified ledger cost'
    USING ERRCODE='23514',CONSTRAINT='existing_asset_review_price_alignment_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_existing_asset_recognized_edit_alignment BEFORE INSERT ON company_existing_asset_events
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_recognized_edit_alignment();
