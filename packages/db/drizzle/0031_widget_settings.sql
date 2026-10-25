CREATE TABLE "widget_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"position" text DEFAULT 'right' NOT NULL,
	"theme_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_theme" jsonb,
	"detect_status" text DEFAULT 'none' NOT NULL,
	"detect_failure" text,
	"detect_requested_at" timestamp with time zone,
	"logo" "bytea",
	"logo_type" text,
	"logo_version" integer DEFAULT 0 NOT NULL,
	"install_seen_at" timestamp with time zone,
	"install_seen_origin" text,
	"last_seen_at" timestamp with time zone,
	"rejected_origin" text,
	"rejected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_settings_position_ck" CHECK ("widget_settings"."position" in ('right', 'left')),
	CONSTRAINT "widget_settings_overrides_ck" CHECK (jsonb_typeof("widget_settings"."theme_overrides") = 'object'),
	CONSTRAINT "widget_settings_detected_ck" CHECK ("widget_settings"."detected_theme" is null or jsonb_typeof("widget_settings"."detected_theme") = 'object'),
	CONSTRAINT "widget_settings_detect_ck" CHECK ("widget_settings"."detect_status" in ('none', 'queued', 'running', 'done', 'failed') and ("widget_settings"."detect_failure" is null or ("widget_settings"."detect_status" = 'failed' and "widget_settings"."detect_failure" in ('unreachable', 'blocked', 'timeout', 'no_page')))),
	CONSTRAINT "widget_settings_logo_ck" CHECK (("widget_settings"."logo" is null) = ("widget_settings"."logo_type" is null) and ("widget_settings"."logo_type" is null or "widget_settings"."logo_type" in ('image/png', 'image/jpeg', 'image/webp')) and ("widget_settings"."logo" is null or octet_length("widget_settings"."logo") <= 102400))
);
--> statement-breakpoint
ALTER TABLE "widget_settings" ADD CONSTRAINT "widget_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_allowed_origins_ck" CHECK (cardinality("tenants"."allowed_origins") <= 50);--> statement-breakpoint

-- FEAT-032 §4, hand-written. One row per tenant; the channels module owns the table.
INSERT INTO widget_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE widget_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE widget_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON widget_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- Workspace creation inserts the row with the tenant.
GRANT INSERT ON widget_settings TO app_identity;--> statement-breakpoint
-- The dashboard edits the look, the logo and the detection request, never the install check.
GRANT SELECT, UPDATE (position, theme_overrides, detected_theme, detect_status, detect_failure, detect_requested_at, logo, logo_type, logo_version, updated_at) ON widget_settings TO app_dashboard;--> statement-breakpoint
-- The widget API reads the look and records the install check (D8); the install columns
-- are readable too, because the throttles compare against them.
GRANT SELECT (tenant_id, position, theme_overrides, detected_theme, logo, logo_type, logo_version, install_seen_at, install_seen_origin, last_seen_at, rejected_origin, rejected_at) ON widget_settings TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (install_seen_at, install_seen_origin, last_seen_at, rejected_origin, rejected_at) ON widget_settings TO app_agent_visitor;--> statement-breakpoint
-- The ingest-worker's theme-detect job writes only the result (D4).
GRANT SELECT (tenant_id, detect_status, detect_requested_at), UPDATE (detected_theme, detect_status, detect_failure, updated_at) ON widget_settings TO app_ingest;
