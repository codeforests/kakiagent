CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'offline' NOT NULL,
	"state_changed_at" timestamp with time zone,
	"state_changed_by" uuid,
	"offline_mode" text DEFAULT 'hidden' NOT NULL,
	"offline_message_en" text,
	"offline_message_zh" text,
	"health" text DEFAULT 'unknown' NOT NULL,
	"health_reason" text,
	"health_failures" integer DEFAULT 0 NOT NULL,
	"health_checked_at" timestamp with time zone,
	"degraded_since" timestamp with time zone,
	"credential_ciphertext" "bytea",
	"credential_key_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connections_kind_ck" CHECK ("channel_connections"."kind" in ('widget', 'email', 'telegram', 'messenger', 'instagram', 'whatsapp')),
	CONSTRAINT "channel_connections_state_ck" CHECK ("channel_connections"."state" in ('live', 'offline')),
	CONSTRAINT "channel_connections_offline_mode_ck" CHECK ("channel_connections"."offline_mode" in ('hidden', 'message') and ("channel_connections"."kind" = 'widget' or "channel_connections"."offline_mode" = 'message')),
	CONSTRAINT "channel_connections_offline_message_ck" CHECK (("channel_connections"."offline_message_en" is null or char_length("channel_connections"."offline_message_en") between 1 and 300) and ("channel_connections"."offline_message_zh" is null or char_length("channel_connections"."offline_message_zh") between 1 and 300)),
	CONSTRAINT "channel_connections_health_ck" CHECK ("channel_connections"."health" in ('ok', 'degraded', 'unknown') and ("channel_connections"."health_reason" is null or "channel_connections"."health_reason" in ('credential_revoked', 'credential_invalid', 'unreachable', 'send_rejected')) and "channel_connections"."health_failures" >= 0),
	CONSTRAINT "channel_connections_credential_ck" CHECK (("channel_connections"."credential_ciphertext" is null) = ("channel_connections"."credential_key_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_kind_uq" ON "channel_connections" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_tenant_id_uq" ON "channel_connections" USING btree ("tenant_id","id");--> statement-breakpoint
-- FEAT-034 §4: hand-written RLS, grants, the new-tenant trigger, the backfill and the definer
-- reads. The credential columns are never granted to the dashboard or visitor zones; the
-- visitor zone reads a channel's state only through visitor_channel().
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_connections USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT (id, tenant_id, kind, state, state_changed_at, state_changed_by, offline_mode,
  offline_message_en, offline_message_zh, health, health_reason, health_failures,
  health_checked_at, degraded_since, version, created_at, updated_at)
  ON channel_connections TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (state, state_changed_at, state_changed_by, offline_mode, offline_message_en,
  offline_message_zh, version, updated_at, health, health_reason, health_failures,
  health_checked_at, degraded_since)
  ON channel_connections TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON channel_connections TO app_outbox;--> statement-breakpoint
GRANT UPDATE (health, health_reason, health_failures, health_checked_at, degraded_since, updated_at)
  ON channel_connections TO app_outbox;--> statement-breakpoint
-- The health job audits channel.degraded / channel.recovered from the outbox zone (D6).
GRANT INSERT ON audit_entries TO app_outbox;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_head_lock() TO app_outbox;--> statement-breakpoint
GRANT SELECT (tenant_id, kind, state, offline_mode, offline_message_en, offline_message_zh)
  ON channel_connections TO kaki_tenant_state;--> statement-breakpoint
-- The NOLOGIN owner of the trigger and of the cross-tenant health list (pattern of 0029).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_channels') THEN
    CREATE ROLE kaki_channels NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_channels;--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind), INSERT (tenant_id, kind, state, offline_mode, health)
  ON channel_connections TO kaki_channels;--> statement-breakpoint
CREATE POLICY channels_owner_read ON channel_connections FOR SELECT TO kaki_channels USING (true);--> statement-breakpoint
CREATE POLICY channels_owner_insert ON channel_connections FOR INSERT TO kaki_channels WITH CHECK (true);--> statement-breakpoint
-- Every new tenant, by any path, starts with its widget offline and hidden (ONB-10, D3).
CREATE FUNCTION tenants_widget_connection() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    INSERT INTO channel_connections (tenant_id, kind, state, offline_mode, health)
    VALUES (NEW.id, 'widget', 'offline', 'hidden', 'ok');
    RETURN NULL;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION tenants_widget_connection() OWNER TO kaki_channels;--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_widget_connection() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tenants_widget_connection AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_widget_connection();--> statement-breakpoint
-- Existing (dev and test) tenants keep answering: their widgets start live (D3).
INSERT INTO channel_connections (tenant_id, kind, state, state_changed_at, offline_mode, health)
  SELECT id, 'widget', 'live', now(), 'hidden', 'ok' FROM tenants
  ON CONFLICT (tenant_id, kind) DO NOTHING;--> statement-breakpoint
CREATE FUNCTION visitor_channel(p_kind text)
  RETURNS TABLE (
    state text, offline_mode text, offline_message_en text, offline_message_zh text,
    contact_email text, contact_phone text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.state, c.offline_mode, c.offline_message_en, c.offline_message_zh,
      bp.contact_email, bp.contact_phone
    FROM channel_connections c
      LEFT JOIN business_profiles bp ON bp.tenant_id = c.tenant_id
    WHERE c.tenant_id = app_current_tenant() AND c.kind = p_kind
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_channel(text) OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_channel(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_channel(text) TO app_agent_visitor, app_dashboard;--> statement-breakpoint
-- The connections the health job checks, across tenants, IDs only (CHN-12, §5.1).
CREATE FUNCTION channel_health_due(p_kinds text[])
  RETURNS TABLE (tenant_id uuid, id uuid, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.tenant_id, c.id, c.kind FROM channel_connections c
    WHERE c.kind = ANY (p_kinds) ORDER BY c.tenant_id, c.kind
  $$;--> statement-breakpoint
ALTER FUNCTION channel_health_due(text[]) OWNER TO kaki_channels;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_health_due(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_health_due(text[]) TO app_outbox;
