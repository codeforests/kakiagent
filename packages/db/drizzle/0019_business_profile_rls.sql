-- FEAT-009: business profile, hours and holidays (ONB-03; FEAT-009 §4). Hand-written;
-- drizzle-kit owns the DDL in 0018. The dashboard edits the profile, the tenant's name
-- and its holiday exceptions; it still can't change any other tenant column (D1). The
-- visitor role sees the exceptions only through visitor_tenant_state(), never directly.
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON holidays USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON holidays TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON holidays TO kaki_tenant_state;--> statement-breakpoint
GRANT UPDATE (gst_registered, hours, open_on_public_holidays, version, uen, industry, contact_email, contact_phone, languages, updated_at) ON business_profiles TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (name) ON tenants TO app_dashboard;--> statement-breakpoint
DROP FUNCTION visitor_tenant_state();--> statement-breakpoint
CREATE FUNCTION visitor_tenant_state()
  RETURNS TABLE (
    ai_paused boolean, business_name text, gst_registered boolean,
    route_complexity_threshold real, route_min_confidence real, cost_governor_step smallint,
    hours jsonb, open_on_public_holidays boolean,
    bot_name text, tone text, emoji boolean,
    greeting_en text, greeting_zh text, disclosure_note_en text, disclosure_note_zh text,
    after_hours_en text, after_hours_zh text, fallback_en text, fallback_zh text,
    holidays jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.ai_paused, t.name, coalesce(bp.gst_registered, false),
           t.route_complexity_threshold, t.route_min_confidence, t.cost_governor_step,
           bp.hours, coalesce(bp.open_on_public_holidays, false),
           a.bot_name, coalesce(a.tone, 'friendly'), coalesce(a.emoji, false),
           a.greeting_en, a.greeting_zh, a.disclosure_note_en, a.disclosure_note_zh,
           a.after_hours_en, a.after_hours_zh, a.fallback_en, a.fallback_zh,
           -- Only the days openStatus can look at (its horizon is 14 days either side).
           coalesce(
             (SELECT jsonb_object_agg(to_char(h.day, 'YYYY-MM-DD'), h.kind ORDER BY h.day)
                FROM holidays h
               WHERE h.tenant_id = t.id
                 AND h.day BETWEEN (now() AT TIME ZONE 'Asia/Singapore')::date - 15
                               AND (now() AT TIME ZONE 'Asia/Singapore')::date + 15),
             '{}'::jsonb)
    FROM tenants t
      LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
      LEFT JOIN assistant_settings a ON a.tenant_id = t.id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_tenant_state() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_tenant_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_agent_visitor;
