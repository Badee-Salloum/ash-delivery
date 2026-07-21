-- 0002 — platform core: branches, users, roles as data, sessions, settings, audit, notifications
-- SRS §A. ⚠ NOT YET EXECUTED — see 0001.

-- ── Branches (A-3) ───────────────────────────────────────────────────────────────────────
-- One Damascus branch today. Every shift, fund and journal entry carries branch_id from day
-- one, so the second branch is a data change and not a rewrite.
CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Damascus',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Roles and permissions as DATA (A-2) ──────────────────────────────────────────────────
-- SRS §3 says the matrix is customisable by the system admin, so it cannot be an enum of
-- hardcoded checks. `packages/domain/src/rbac/can.ts` evaluates these rows.
CREATE TABLE roles (
  key         text PRIMARY KEY,          -- driver | branch_manager | system_admin | general_manager | accountant
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  is_system   boolean NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,          -- matches PermissionKey in the domain
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  srs_ref     text                       -- e.g. '§3 row 5, س46'
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  scope          text NOT NULL CHECK (scope IN ('own', 'branch', 'all')),
  PRIMARY KEY (role_key, permission_key)
);

-- ── Users and authentication (A-1, SRS §7) ───────────────────────────────────────────────
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid REFERENCES branches(id),   -- NULL for org-wide roles
  role_key           text NOT NULL REFERENCES roles(key),
  username           text NOT NULL UNIQUE,
  full_name_ar       text NOT NULL,
  full_name_en       text,
  phone              text,
  password_hash      text NOT NULL,                  -- bcrypt, cost 12 (SRS §7 mandates bcrypt)
  -- AES-256-GCM ciphertext, app-side, key from the SOPS-held master. Never plaintext at rest.
  mfa_secret_enc     bytea,
  mfa_enrolled_at    timestamptz,
  -- 5-attempt lockout (SRS A-1). These columns are written on the UNAUTHENTICATED path, which
  -- is why the audit trigger in 0006 must tolerate a NULL actor instead of raising.
  failed_attempts    smallint NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_branch_required_for_scoped_roles
    CHECK (role_key NOT IN ('driver', 'branch_manager') OR branch_id IS NOT NULL)
);
CREATE INDEX users_branch_idx ON users (branch_id) WHERE active;

-- Opaque, DB-backed sessions: instantly revocable, and a 30-minute sliding idle timeout that a
-- stateless JWT cannot honour without a blocklist that is itself a session table.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,          -- sha256 of the cookie value; the raw token is never stored
  mfa_satisfied   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip              inet,
  user_agent      text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL,
  succeeded     boolean NOT NULL,
  ip            inet,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_username_idx ON login_attempts (username, attempted_at DESC);

-- ── Settings (A-4) ───────────────────────────────────────────────────────────────────────
-- Typed, validated at the edge by Zod, audited. Not a stringly-typed bag.
CREATE TABLE settings (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL,
  value_type   text NOT NULL CHECK (value_type IN ('string', 'integer', 'money_minor', 'boolean', 'json')),
  description  text,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Approval ceilings (A-4 / س52): above this, a manual entry or expense needs a receipt/approval.
CREATE TABLE approval_ceilings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_key       text NOT NULL REFERENCES roles(key),
  operation      text NOT NULL CHECK (operation IN ('manual_entry', 'expense', 'salary')),
  ceiling_minor  bigint NOT NULL CHECK (ceiling_minor >= 0),
  requires_receipt_above_minor bigint CHECK (requires_receipt_above_minor >= 0),
  UNIQUE (role_key, operation)
);

-- ── Audit log (A-5 / س79) ────────────────────────────────────────────────────────────────
-- before/after snapshots built with to_jsonb and READ BACK as jsonb::text, then parsed with a
-- lossless JSON reader: a plain JSON.parse silently rounds a bigint amount INSIDE the audit
-- trail — corruption invisible to the very instrument you would use to detect it.
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name   text NOT NULL,
  record_id    text NOT NULL,
  action       text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id     uuid REFERENCES users(id),        -- NULL is legal: see actor_kind
  actor_kind   text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'system', 'anonymous')),
  branch_id    uuid REFERENCES branches(id),
  request_id   text,
  before       jsonb,
  after        jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX audit_log_time_idx   ON audit_log (occurred_at DESC);

-- ── In-platform notifications (A-6) ──────────────────────────────────────────────────────
-- SRS A-6 is one sentence: «جرس بعداد داخل المنصة» — a bell with a counter. Push is section M.
CREATE TABLE notifications (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id     uuid REFERENCES branches(id),
  kind          text NOT NULL,      -- shift_awaiting_approval | document_expiring | cash_count_variance | …
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Collapses duplicates of the same real-world event without hiding a genuinely new occurrence.
  dedupe_key    text,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
