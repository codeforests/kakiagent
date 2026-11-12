CREATE TABLE "visitor_events" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"path" text NOT NULL,
	"referrer" text,
	"utm" jsonb,
	"dwell_ms" integer DEFAULT 0 NOT NULL,
	"scroll_pct" smallint DEFAULT 0 NOT NULL,
	"consented" boolean NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "visitor_events_path_ck" CHECK (left("visitor_events"."path", 1) = '/' and length("visitor_events"."path") <= 512),
	CONSTRAINT "visitor_events_referrer_ck" CHECK ("visitor_events"."referrer" is null or length("visitor_events"."referrer") <= 253),
	CONSTRAINT "visitor_events_utm_ck" CHECK ("visitor_events"."utm" is null or jsonb_typeof("visitor_events"."utm") = 'object'),
	CONSTRAINT "visitor_events_engage_ck" CHECK ("visitor_events"."dwell_ms" between 0 and 86400000 and "visitor_events"."scroll_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "visitor_tracking_choices" (
	"tenant_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"wording" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_tracking_choices_tenant_id_visitor_id_pk" PRIMARY KEY("tenant_id","visitor_id"),
	CONSTRAINT "visitor_tracking_choices_choice_ck" CHECK ("visitor_tracking_choices"."choice" in ('accepted', 'declined')),
	CONSTRAINT "visitor_tracking_choices_wording_ck" CHECK (length("visitor_tracking_choices"."wording") between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "page_path" text;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "tracking_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "tracking_consent_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD COLUMN "tracking_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visitor_events" ADD CONSTRAINT "visitor_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_tracking_choices" ADD CONSTRAINT "visitor_tracking_choices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visitor_events_visitor_idx" ON "visitor_events" USING btree ("tenant_id","visitor_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_page_path_ck" CHECK ("messages"."page_path" is null or (left("messages"."page_path", 1) = '/' and length("messages"."page_path") <= 512));--> statement-breakpoint

-- FEAT-029 §4, hand-written: RLS, grants and the purge.
ALTER TABLE visitor_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE visitor_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON visitor_events USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE visitor_tracking_choices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE visitor_tracking_choices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON visitor_tracking_choices USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The widget records views and raises engagement only; a withdrawal deletes the visitor's rows (§5.4).
GRANT SELECT, INSERT, DELETE, UPDATE (dwell_ms, scroll_pct) ON visitor_events TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON visitor_tracking_choices TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON visitor_events, visitor_tracking_choices TO app_dashboard;--> statement-breakpoint
-- The mode: the visitor zone reads it for config, events and turns; the dashboard sets it.
GRANT SELECT (tracking_enabled, tracking_consent_mode, tracking_updated_at) ON widget_settings TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (tracking_enabled, tracking_consent_mode, tracking_updated_at) ON widget_settings TO app_dashboard;--> statement-breakpoint

-- Events are kept 180 days and choices 13 months, across tenants (D6, ADR-015).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_tracking_purge') THEN
    CREATE ROLE kaki_tracking_purge NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_tracking_purge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, viewed_at), DELETE ON visitor_events TO kaki_tracking_purge;--> statement-breakpoint
GRANT SELECT (tenant_id, visitor_id, decided_at), DELETE ON visitor_tracking_choices TO kaki_tracking_purge;--> statement-breakpoint
CREATE POLICY tracking_purge_read ON visitor_events FOR SELECT TO kaki_tracking_purge USING (true);--> statement-breakpoint
CREATE POLICY tracking_purge_delete ON visitor_events FOR DELETE TO kaki_tracking_purge USING (true);--> statement-breakpoint
CREATE POLICY tracking_purge_read ON visitor_tracking_choices FOR SELECT TO kaki_tracking_purge USING (true);--> statement-breakpoint
CREATE POLICY tracking_purge_delete ON visitor_tracking_choices FOR DELETE TO kaki_tracking_purge USING (true);--> statement-breakpoint
CREATE FUNCTION visitor_events_purge()
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH events AS (
      DELETE FROM visitor_events e WHERE e.viewed_at < now() - interval '180 days' RETURNING 1
    ), choices AS (
      DELETE FROM visitor_tracking_choices c WHERE c.decided_at < now() - interval '13 months' RETURNING 1
    ) SELECT ((SELECT count(*) FROM events) + (SELECT count(*) FROM choices))::int
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_events_purge() OWNER TO kaki_tracking_purge;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_events_purge() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_events_purge() TO app_outbox;
