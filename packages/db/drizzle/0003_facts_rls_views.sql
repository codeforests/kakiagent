-- FEAT-022: RLS, grants and the visitor-safe views for facts (ADR-005, ADR-009, ADR-010)
-- and the send gate's tenant state (ADR-013). Hand-written; drizzle-kit owns the DDL in
-- 0002. The views and the function are owned by NOLOGIN roles that are neither
-- superusers nor table owners, so the forced tenant policies apply when they run: a
-- view owned by the migration owner (a superuser locally) would bypass RLS.

ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_profiles USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE facts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON facts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE fact_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE fact_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON fact_versions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE kb_chunks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON kb_chunks USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- Dashboard: manages facts by hand (KB-07). Versions are append-only; no DELETE yet (FEAT-011).
GRANT SELECT, INSERT, UPDATE ON facts, kb_chunks TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT ON fact_versions TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON business_profiles TO app_dashboard;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_visitor_views') THEN
    CREATE ROLE kaki_visitor_views NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_tenant_state') THEN
    CREATE ROLE kaki_tenant_state NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_visitor_views, kaki_tenant_state;--> statement-breakpoint
GRANT SELECT ON facts, kb_chunks, business_profiles TO kaki_visitor_views;--> statement-breakpoint

-- The only facts a visitor turn can read (ADR-010 decision 2): approved, enabled,
-- unexpired, and not a GST-unknown price at a GST-registered tenant (KB-15).
CREATE VIEW visitor_facts WITH (security_barrier = true) AS
  SELECT f.tenant_id, f.id, f.type, f.version, f.value, f.gst_treatment
  FROM facts f
  WHERE f.tenant_id = app_current_tenant()
    AND f.status = 'approved'
    AND (f.valid_until IS NULL OR f.valid_until > now())
    AND NOT (
      f.type = 'product' AND f.gst_treatment = 'unknown'
      AND coalesce((SELECT bp.gst_registered FROM business_profiles bp WHERE bp.tenant_id = f.tenant_id), true)
    );--> statement-breakpoint
ALTER VIEW visitor_facts OWNER TO kaki_visitor_views;--> statement-breakpoint

-- Searchable chunks: only while their fact is visitor-visible and at the same version.
CREATE VIEW visitor_chunks WITH (security_barrier = true) AS
  SELECT c.tenant_id, c.id, c.fact_id, c.content, c.embedding
  FROM kb_chunks c
  JOIN visitor_facts vf ON vf.tenant_id = c.tenant_id AND vf.id = c.fact_id AND vf.version = c.fact_version
  WHERE c.tenant_id = app_current_tenant();--> statement-breakpoint
ALTER VIEW visitor_chunks OWNER TO kaki_visitor_views;--> statement-breakpoint

GRANT SELECT ON visitor_facts, visitor_chunks TO app_agent_visitor;--> statement-breakpoint

-- Send gate and public tenant values for the visitor scope (ADR-013 decision 3; D10).
-- No row (no tenant context, unknown tenant) means the caller treats the AI as paused.
GRANT SELECT (id, name, ai_paused) ON tenants TO kaki_tenant_state;--> statement-breakpoint
GRANT SELECT ON business_profiles TO kaki_tenant_state;--> statement-breakpoint
CREATE FUNCTION visitor_tenant_state()
  RETURNS TABLE (ai_paused boolean, business_name text, gst_registered boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.ai_paused, t.name, coalesce(bp.gst_registered, false)
    FROM tenants t LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_tenant_state() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_tenant_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_agent_visitor;
