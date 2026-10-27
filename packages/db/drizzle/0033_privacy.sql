CREATE TABLE "privacy_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"notice_wording_id" uuid,
	"purpose_wording_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wording_versions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wording_versions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "wording_versions_kind_ck" CHECK ("wording_versions"."kind" in ('privacy_notice', 'purpose_statement')),
	CONSTRAINT "wording_versions_seq_ck" CHECK ("wording_versions"."seq" >= 1),
	CONSTRAINT "wording_versions_content_ck" CHECK (jsonb_typeof("wording_versions"."content") = 'object')
);
--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_notice_fk" FOREIGN KEY ("tenant_id","notice_wording_id") REFERENCES "public"."wording_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_purpose_fk" FOREIGN KEY ("tenant_id","purpose_wording_id") REFERENCES "public"."wording_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_versions" ADD CONSTRAINT "wording_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wording_versions" ADD CONSTRAINT "wording_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wording_versions_kind_seq_uq" ON "wording_versions" USING btree ("tenant_id","kind","seq");--> statement-breakpoint
-- FEAT-058 §4: hand-written RLS, grants and the visitor read. Wordings are immutable (D3):
-- the dashboard may insert but never update or delete them. The visitor zone has no table
-- grants; it reads the current wordings only through visitor_privacy().
ALTER TABLE wording_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE wording_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON wording_versions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE privacy_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON privacy_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT ON wording_versions TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT ON privacy_settings TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (version, notice_wording_id, purpose_wording_id, updated_at) ON privacy_settings TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON wording_versions, privacy_settings TO kaki_tenant_state;--> statement-breakpoint
CREATE FUNCTION visitor_privacy()
  RETURNS TABLE (
    notice jsonb, notice_wording_id uuid, notice_saved_at timestamptz,
    purpose jsonb, purpose_wording_id uuid, business_name text, uen text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT n.content, n.id, n.created_at, p.content, p.id, t.name, bp.uen
    FROM tenants t
      LEFT JOIN business_profiles bp ON bp.tenant_id = t.id
      LEFT JOIN privacy_settings ps ON ps.tenant_id = t.id
      LEFT JOIN wording_versions n ON n.tenant_id = t.id AND n.id = ps.notice_wording_id
      LEFT JOIN wording_versions p ON p.tenant_id = t.id AND p.id = ps.purpose_wording_id
    WHERE t.id = app_current_tenant()
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_privacy() OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_privacy() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_privacy() TO app_agent_visitor;
