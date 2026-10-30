-- Two-step verification, RLS and grants (AUTH-03, ADR-005, ADR-020; FEAT-006 §4). Hand-written;
-- drizzle-kit owns only the table DDL (0036).

-- A person's tables: no tenant_id (FEAT-005 D3). RLS enabled and forced with a policy for the
-- identity zone only, so a grant added by mistake to any other role still reads nothing.
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mfa_factors FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY identity_zone ON mfa_factors FOR ALL TO app_identity USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE recovery_codes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY identity_zone ON recovery_codes FOR ALL TO app_identity USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON mfa_factors TO app_identity;--> statement-breakpoint
GRANT UPDATE (confirmed_at, last_used_step, failed_attempts, locked_until) ON mfa_factors TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON recovery_codes TO app_identity;--> statement-breakpoint
GRANT UPDATE (used_at) ON recovery_codes TO app_identity;--> statement-breakpoint
GRANT UPDATE (mfa_at, reauth_at) ON sessions TO app_identity;--> statement-breakpoint

-- The Owner sets the requirement from the dashboard (D8); forced RLS keeps the grant to the
-- session's own row (like ai_paused, FEAT-057 D5).
GRANT UPDATE (mfa_required) ON tenants TO app_dashboard;--> statement-breakpoint

-- The Team card's counts and the identity zone's view of the requirement go through a
-- NOLOGIN role's SECURITY DEFINER functions: the dashboard zone never reads mfa_factors,
-- and the identity zone still sees only its current tenant's row of tenants (FEAT-005).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_mfa_count') THEN
    CREATE ROLE kaki_mfa_count NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_mfa_count;--> statement-breakpoint
GRANT SELECT (tenant_id, user_id, status) ON memberships TO kaki_mfa_count;--> statement-breakpoint
CREATE POLICY mfa_count ON memberships FOR SELECT TO kaki_mfa_count USING (true);--> statement-breakpoint
GRANT SELECT (user_id, confirmed_at) ON mfa_factors TO kaki_mfa_count;--> statement-breakpoint
GRANT SELECT (id, name, mfa_required) ON tenants TO kaki_mfa_count;--> statement-breakpoint
CREATE POLICY mfa_count ON tenants FOR SELECT TO kaki_mfa_count USING (true);--> statement-breakpoint
CREATE POLICY mfa_count ON mfa_factors FOR SELECT TO kaki_mfa_count USING (true);--> statement-breakpoint
CREATE FUNCTION tenant_mfa_enrolment()
  RETURNS TABLE (members integer, enrolled integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT count(*)::int,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM mfa_factors f
             WHERE f.user_id = m.user_id AND f.confirmed_at IS NOT NULL
           ))::int
    FROM memberships m
    WHERE m.tenant_id = app_current_tenant() AND m.status = 'active'
  $$;--> statement-breakpoint
ALTER FUNCTION tenant_mfa_enrolment() OWNER TO kaki_mfa_count;--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_mfa_enrolment() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_mfa_enrolment() TO app_dashboard;;--> statement-breakpoint
-- The workspaces where a user is an active member and two-step verification is required:
-- `authenticate` checks the active tenant against it on every request (§5.2), removal and
-- the status route name them. Built before any tenant context exists.
CREATE FUNCTION user_mfa_required_by(p_user uuid)
  RETURNS TABLE (tenant_id uuid, name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.name
    FROM memberships m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user AND m.status = 'active' AND t.mfa_required
    ORDER BY t.name
  $$;--> statement-breakpoint
ALTER FUNCTION user_mfa_required_by(uuid) OWNER TO kaki_mfa_count;--> statement-breakpoint
REVOKE ALL ON FUNCTION user_mfa_required_by(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_mfa_required_by(uuid) TO app_identity;
