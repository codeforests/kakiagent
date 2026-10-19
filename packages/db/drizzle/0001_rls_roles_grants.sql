-- Tenant isolation, trust-zone grants and the outbox trigger (ADR-005, ADR-012).
-- Hand-written; drizzle-kit owns only the table DDL. The login roles app_dashboard,
-- app_agent_visitor and app_outbox are created by `pnpm db:setup` before migrations
-- run, because they carry passwords (packages/db/src/setup.ts).

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint

-- Fail-closed tenant context: unset or empty app.tenant_id matches nothing.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;--> statement-breakpoint

-- Forced RLS on every tenant-scoped table: applies to the owner too.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());--> statement-breakpoint

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON messages USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The dispatcher's trust zone reads pending rows across tenants; it can't see any other table.
CREATE POLICY outbox_dispatcher ON outbox FOR ALL TO app_outbox USING (true) WITH CHECK (true);--> statement-breakpoint

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_events USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- Grants per trust zone (least privilege). No role gets DELETE in the skeleton.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_dashboard, app_agent_visitor, app_outbox;--> statement-breakpoint

-- Dashboard: reads its tenant and the inbox; writes audit and outbox rows.
GRANT SELECT ON tenants, conversations, messages TO app_dashboard;--> statement-breakpoint
GRANT INSERT ON audit_events, outbox TO app_dashboard;--> statement-breakpoint

-- Visitor zone (widget API, agent worker, widget stream): its own conversation tables
-- only. It cannot read `tenants`; the widget key resolver below is its only way in.
-- ADR-009's visitor-safe fact views are added with the fact tables (FEAT-011/022).
GRANT SELECT, INSERT ON conversations, messages TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (last_message_at, status) ON conversations TO app_agent_visitor;--> statement-breakpoint
GRANT INSERT ON audit_events, outbox TO app_agent_visitor;--> statement-breakpoint

-- Outbox dispatcher: pending rows only.
GRANT SELECT, UPDATE (dispatched_at) ON outbox TO app_outbox;--> statement-breakpoint

-- Widget key → tenant, before any tenant context exists (ADR-016 decision 6). Runs as a
-- NOLOGIN role whose only privilege is reading these columns of `tenants`, through a
-- policy scoped to it; callers get one row for one key and nothing else.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_widget_resolver') THEN
    CREATE ROLE kaki_widget_resolver NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_widget_resolver;--> statement-breakpoint
GRANT SELECT (id, widget_key, allowed_origins, status) ON tenants TO kaki_widget_resolver;--> statement-breakpoint
CREATE POLICY widget_resolver ON tenants FOR SELECT TO kaki_widget_resolver USING (true);--> statement-breakpoint
CREATE FUNCTION resolve_widget_key(p_key text)
  RETURNS TABLE (tenant_id uuid, allowed_origins text[], status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT t.id, t.allowed_origins, t.status FROM tenants t WHERE t.widget_key = p_key $$;--> statement-breakpoint
ALTER FUNCTION resolve_widget_key(text) OWNER TO kaki_widget_resolver;--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_widget_key(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_widget_key(text) TO app_agent_visitor;--> statement-breakpoint

-- Wake the outbox dispatcher on commit (it also sweeps on an interval).
CREATE FUNCTION outbox_notify() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN PERFORM pg_notify('outbox_pending', NEW.topic); RETURN NULL; END $$;--> statement-breakpoint
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_notify();
