-- ── 0064: «إدارة صندوق الشركة» becomes its own permission ─────────────────────────────────────
--
-- THE GAP. صندوق الشركة (`company_box`) was READ under `profit.view_total` (GM + sysadmin) but
-- WRITTEN under `journal.manual.write`, which the branch manager holds. So he could deposit into
-- and withdraw from a fund he was not allowed to see. Owner decision (2026-09-17): «إدارة صندوق
-- الشركة: المدير العام ومدير النظام فقط». The API now gates the read and both writes on one key,
-- `company_fund.manage`, and this migration makes that key exist in live data.
--
-- WHY THE GRANT IS CONDITIONAL. `apps/api/src/rbac.ts` (`grantsFromRows`) treats an EMPTY
-- `role_permissions` as «not seeded yet» and authorises from the compiled DEFAULT_GRANTS, which
-- already carry this key. Inserting two rows into an empty table would replace that whole
-- fallback with just these two grants and silently strip every other permission in the system —
-- the same trap `PUT /role-permissions` materialises the defaults to avoid. So the grant is
-- written only where the matrix is already data; a fresh database gets it from
-- `seedReferenceData`, like every other grant.
--
-- The permission row itself is reference data and is always safe to add (nothing reads
-- `permissions` to authorise). ON CONFLICT DO NOTHING: a database seeded by a newer
-- `seedReferenceData` before this ran already has the row, and applied history must not fight it.
--
-- The `role_permissions` audit trigger (0006) fires with no actor GUC set and records
-- actor_kind='system' — truthful: a migration made this change, not a person on a screen.
INSERT INTO permissions (key, name_ar, name_en, srs_ref)
VALUES ('company_fund.manage', 'إدارة صندوق الشركة', 'Manage company fund', 'owner decision 2026-09-17')
ON CONFLICT (key) DO NOTHING;

-- Scope 'all' for exactly the two organisation-wide roles, and never the branch manager. Joined to
-- `roles` so a database without one of them cannot fail the foreign key. DO NOTHING rather than
-- DO UPDATE: if a system admin already set this grant by hand, his decision stands.
INSERT INTO role_permissions (role_key, permission_key, scope)
SELECT r.key, 'company_fund.manage', 'all'
  FROM roles r
 WHERE r.key IN ('general_manager', 'system_admin')
   AND EXISTS (SELECT 1 FROM role_permissions)
ON CONFLICT (role_key, permission_key) DO NOTHING;
