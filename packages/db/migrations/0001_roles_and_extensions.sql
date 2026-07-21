-- 0001 — database roles and extensions
--
-- ⚠ NOT YET EXECUTED. Written without a Postgres instance available (no Docker, no psql on the
--   dev machine). Every statement here must be run against real PostgreSQL 17 and the guards in
--   0006 must be proven to REJECT the writes they claim to reject before M2 depends on them.
--   See RUNBOOK.md › "Verifying the database guards".
--
-- Two roles, deliberately:
--   app_migrator — owns the schema, runs migrations, may DDL.
--   app_user     — what the API connects as. Cannot UPDATE or DELETE the ledger, ever.
-- That split is what makes ledger immutability a property of the database rather than of
-- everybody remembering to be careful.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user, app_migrator;

-- New tables should be reachable by app_user by default; 0006 then REVOKEs the ledger back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
