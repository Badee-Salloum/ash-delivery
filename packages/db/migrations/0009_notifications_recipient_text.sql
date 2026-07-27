-- ── 0009: a notification recipient is an ADDRESS, not always a user ──────────────────────────
--
-- `recipient_id` was `uuid REFERENCES users(id)`, but the bell is addressed two ways: a user's own
-- id, and a shared branch bell «branch:<branchId>» (see notifyBranch / recipientsFor). A branch
-- address is not a UUID, so every branch notification — the "shift awaiting approval" bell the
-- manager's Queue badge depends on, and now the document-expiry alerts — failed the INSERT with
-- 22P02 and was swallowed. Against Postgres the branch bell has therefore never rung; the memory
-- adapter (opaque string keys) hid it in tests.
--
-- The recipient is polymorphic addressing, so the column becomes plain text and the FK is dropped.
-- Existing rows are all real user UUIDs and cast cleanly. The partial unique + unread indexes on
-- the column are rebuilt automatically by the type change.
ALTER TABLE notifications DROP CONSTRAINT notifications_recipient_id_fkey;
ALTER TABLE notifications ALTER COLUMN recipient_id TYPE text USING recipient_id::text;

COMMENT ON COLUMN notifications.recipient_id IS
  'Bell address: a user id, or a shared branch bell «branch:<branchId>». Not an FK — polymorphic.';
