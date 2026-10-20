-- Identity zone, RLS and grants (ADR-005, ADR-020; FEAT-005 §4, D2, D3). Hand-written;
-- drizzle-kit owns only the table DDL (0006). The login role app_identity is created
-- by `pnpm db:setup` before migrations run, because it carries a password.

-- Tenant-scoped identity tables: forced RLS like every other tenant table.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- Sign-in must find a user's memberships before any tenant context exists. Read-only,
-- and only for the identity zone; writes still go through tenant_isolation.
CREATE POLICY identity_read ON memberships FOR SELECT TO app_identity USING (true);--> statement-breakpoint

ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE terms_acceptances FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON terms_acceptances USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- A person's tables: no tenant_id (D3). RLS is enabled and forced with a policy for the
-- identity zone only, so a grant added by mistake to any other role still reads nothing.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY identity_zone ON users FOR ALL TO app_identity USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY identity_zone ON sessions FOR ALL TO app_identity USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE magic_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE magic_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY identity_zone ON magic_links FOR ALL TO app_identity USING (true) WITH CHECK (true);--> statement-breakpoint

-- Identity zone grants (least privilege, D2).
GRANT USAGE ON SCHEMA public TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT ON users TO app_identity;--> statement-breakpoint
GRANT UPDATE (google_sub, last_sign_in_at) ON users TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT ON sessions TO app_identity;--> statement-breakpoint
GRANT UPDATE (last_seen_at, active_tenant_id, revoked_at) ON sessions TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON magic_links TO app_identity;--> statement-breakpoint
GRANT UPDATE (consumed_at, sent_at, send_attempts, next_attempt_at) ON magic_links TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT ON memberships TO app_identity;--> statement-breakpoint
-- Creating a workspace (§5.5): the caller sets app.tenant_id to the ID it just minted.
GRANT SELECT (id, name, status), INSERT ON tenants TO app_identity;--> statement-breakpoint
GRANT INSERT ON business_profiles, terms_acceptances, audit_entries TO app_identity;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_head_lock() TO app_identity;--> statement-breakpoint

-- Dashboard zone: its own tenant's memberships and acceptances (ONB-09, team page later).
GRANT SELECT ON memberships, terms_acceptances TO app_dashboard;
