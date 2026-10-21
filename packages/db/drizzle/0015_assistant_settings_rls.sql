-- FEAT-024: assistant persona settings (AGT-08, AGT-11; FEAT-024 §4). Hand-written;
-- drizzle-kit owns the DDL in 0014. The dashboard reads and writes the row; the visitor
-- role sees it only through visitor_tenant_state(), never directly.
ALTER TABLE assistant_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assistant_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON assistant_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON assistant_settings TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON assistant_settings TO kaki_tenant_state;--> statement-breakpoint
DROP FUNCTION visitor_tenant_state();--> statement-breakpoint
CREATE FUNCTION visitor_tenant_state()
  RETURNS TABLE (
    ai_paused boolean, business_name text, gst_registered boolean,
    route_complexity_threshold real, route_min_confidence real, cost_governor_step smallint,
    hours jsonb, open_on_public_holidays boolean,
    bot_name text, tone text, emoji boolean,
    greeting_en text, greeting_zh text, disclosure_note_en text, disclosure_note_zh text,
    after_hours_en text, after_hours_zh text, fallback_en text, fallback_zh text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.ai_paused, t.name, coalesce(bp.gst_registered, false),
           t.route_complexity_threshold, t.route_min_confidence, t.cost_governor_step,
           bp.hours, coalesce(bp.open_on_public_holidays, false),
           a.bot_name, coalesce(a.tone, 'friendly'), coalesce(a.emoji, false),
           a.greeting_en, a.greeting_zh, a.disclosure_note_en, a.disclosure_note_zh,
           a.after_hours_en, a.after_hours_zh, a.fallback_en, a.fallback_zh
    FROM tenants t
      LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
      LEFT JOIN assistant_settings a ON a.tenant_id = t.id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_tenant_state() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_tenant_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_agent_visitor;
