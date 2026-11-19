-- Forward-only hardening: SQL clients cannot omit reminder dates or attribution snapshots.
CREATE FUNCTION guard_existing_asset_payment_shape() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.kind='link' AND (
    NOT(NEW.data ?& ARRAY['sourceKey','sourceHash','amount','currency','occurredOn','paidFrom','description','newExpense'])
    OR jsonb_typeof(NEW.data->'newExpense') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(NEW.data->'description') IS DISTINCT FROM 'string')
  THEN RAISE EXCEPTION 'payment link requires complete source snapshot' USING ERRCODE='23514'; END IF;
  IF NEW.kind='unlink' AND NOT(NEW.data ? 'paymentId') THEN
    RAISE EXCEPTION 'unlink requires payment identity' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='schedule' THEN
    IF NOT(NEW.data ?& ARRAY['supplier','reminderDays','priceSnapshot','baselinePaid','installments'])
      OR jsonb_typeof(NEW.data->'reminderDays') IS DISTINCT FROM 'number'
      OR NOT COALESCE(NEW.data->>'baselinePaid' ~ '^[0-9]+\.[0-9]{2}$',false)
      OR jsonb_typeof(NEW.data->'installments') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'schedule requires complete reminder and balance inputs' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.data->'installments') row WHERE
      jsonb_typeof(row) IS DISTINCT FROM 'object' OR NOT(row ?& ARRAY['dueOn','amount'])
      OR NOT COALESCE(row->>'dueOn' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
      OR (row->>'dueOn')::date NOT BETWEEN DATE '2000-01-01' AND DATE '9999-12-31')
    THEN RAISE EXCEPTION 'every installment requires its real due date and amount' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.kind='cancel_schedule' AND NEW.data IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'schedule cancellation cannot alter payment facts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER existing_asset_payment_00_shape BEFORE INSERT ON company_existing_asset_payment_events
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_payment_shape();
