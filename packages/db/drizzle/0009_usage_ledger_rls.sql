-- Usage ledger and routing policy: RLS, grants and functions (ADR-005, ADR-007, ADR-021;
-- FEAT-004 §4, D9, D10). Hand-written; drizzle-kit owns only the table DDL (0008).

-- The ledger is tenant-scoped like every other tenant table. Writers append; no role
-- can update or delete a row.
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_events USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The visitor zone records the turn's calls; the dashboard zone records fact embeddings.
GRANT INSERT ON usage_events TO app_agent_visitor, app_dashboard;--> statement-breakpoint

-- The send gate's tenant read now carries the reply routing policy (D10). Same owner,
-- same grant, same fail-closed contract: no row means paused.
GRANT SELECT (route_complexity_threshold, route_min_confidence, cost_governor_step) ON tenants TO kaki_tenant_state;--> statement-breakpoint
DROP FUNCTION visitor_tenant_state();--> statement-breakpoint
CREATE FUNCTION visitor_tenant_state()
  RETURNS TABLE (
    ai_paused boolean, business_name text, gst_registered boolean,
    route_complexity_threshold real, route_min_confidence real, cost_governor_step smallint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.ai_paused, t.name, coalesce(bp.gst_registered, false),
           t.route_complexity_threshold, t.route_min_confidence, t.cost_governor_step
    FROM tenants t LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_tenant_state() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_tenant_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_agent_visitor;--> statement-breakpoint

-- The cost governor (ADR-007 decision 3, D9): scheduler-worker's outbox zone runs it
-- hourly across tenants. Its NOLOGIN owner reads the ledger and moves the step; the
-- outbox zone can only execute the function and sees only its result.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_cost_governor') THEN
    CREATE ROLE kaki_cost_governor NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_cost_governor;--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id, cost_usd, created_at) ON usage_events TO kaki_cost_governor;--> statement-breakpoint
CREATE POLICY cost_governor ON usage_events FOR SELECT TO kaki_cost_governor USING (true);--> statement-breakpoint
GRANT SELECT (id, cost_governor_step, cost_governor_changed_at), UPDATE (cost_governor_step, cost_governor_changed_at) ON tenants TO kaki_cost_governor;--> statement-breakpoint
CREATE POLICY cost_governor ON tenants FOR ALL TO kaki_cost_governor USING (true) WITH CHECK (true);--> statement-breakpoint
-- Per tenant with at least p_min_conversations conversations in the last 7 days: the
-- average cost per conversation. Raise one step above p_raise_above_usd (at most step
-- 3, at most once per 24 hours); lower one step below p_relax_below_usd when the last
-- change is more than 7 days old. Returns one row per change.
CREATE FUNCTION cost_governor_evaluate(p_raise_above_usd numeric, p_relax_below_usd numeric, p_min_conversations integer)
  RETURNS TABLE (tenant_id uuid, old_step smallint, new_step smallint, avg_usd numeric, conversations bigint)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH window_cost AS (
      SELECT u.tenant_id,
             sum(u.cost_usd) / count(DISTINCT u.conversation_id) AS avg_usd,
             count(DISTINCT u.conversation_id) AS conversations
      FROM usage_events u
      WHERE u.conversation_id IS NOT NULL AND u.created_at > now() - interval '7 days'
      GROUP BY u.tenant_id
      HAVING count(DISTINCT u.conversation_id) >= p_min_conversations
    ), decided AS (
      SELECT t.id, t.cost_governor_step AS old_step, w.avg_usd, w.conversations,
        CASE
          WHEN w.avg_usd > p_raise_above_usd AND t.cost_governor_step < 3
               AND (t.cost_governor_changed_at IS NULL OR t.cost_governor_changed_at <= now() - interval '24 hours')
            THEN t.cost_governor_step + 1
          WHEN w.avg_usd < p_relax_below_usd AND t.cost_governor_step > 0
               AND (t.cost_governor_changed_at IS NULL OR t.cost_governor_changed_at <= now() - interval '7 days')
            THEN t.cost_governor_step - 1
        END AS new_step
      FROM window_cost w JOIN tenants t ON t.id = w.tenant_id
    ), changed AS (
      UPDATE tenants t SET cost_governor_step = d.new_step, cost_governor_changed_at = now()
      FROM decided d
      WHERE t.id = d.id AND d.new_step IS NOT NULL
      RETURNING t.id, d.old_step, t.cost_governor_step, d.avg_usd, d.conversations
    )
    SELECT c.id, c.old_step, c.cost_governor_step, c.avg_usd, c.conversations FROM changed c ORDER BY c.id
  $$;--> statement-breakpoint
ALTER FUNCTION cost_governor_evaluate(numeric, numeric, integer) OWNER TO kaki_cost_governor;--> statement-breakpoint
REVOKE ALL ON FUNCTION cost_governor_evaluate(numeric, numeric, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cost_governor_evaluate(numeric, numeric, integer) TO app_outbox;
