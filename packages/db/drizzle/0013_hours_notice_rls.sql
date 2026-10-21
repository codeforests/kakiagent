-- FEAT-023: the visitor turn reads the tenant's opening hours (AGT-09; FEAT-023 §4).
-- Hand-written; drizzle-kit owns the DDL in 0012. Same owner, definer and grant as 0009:
-- the visitor role still cannot read business_profiles directly.
DROP FUNCTION visitor_tenant_state();--> statement-breakpoint
CREATE FUNCTION visitor_tenant_state()
  RETURNS TABLE (
    ai_paused boolean, business_name text, gst_registered boolean,
    route_complexity_threshold real, route_min_confidence real, cost_governor_step smallint,
    hours jsonb, open_on_public_holidays boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.ai_paused, t.name, coalesce(bp.gst_registered, false),
           t.route_complexity_threshold, t.route_min_confidence, t.cost_governor_step,
           bp.hours, coalesce(bp.open_on_public_holidays, false)
    FROM tenants t LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_tenant_state() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_tenant_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_agent_visitor;
