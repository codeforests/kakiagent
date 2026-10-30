CREATE TABLE "onboarding_progress" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"current_step" text DEFAULT 'profile' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_live_at" timestamp with time zone,
	"first_live_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_progress_step_ck" CHECK ("onboarding_progress"."current_step" in ('profile', 'sources', 'review', 'rules', 'test', 'website', 'go_live')),
	CONSTRAINT "onboarding_progress_steps_ck" CHECK (jsonb_typeof("onboarding_progress"."steps") = 'object')
);
--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- FEAT-035 §4: hand-written RLS and grants. Progress is updated in place; nobody deletes it.
ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE onboarding_progress FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON onboarding_progress USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_progress TO app_dashboard;--> statement-breakpoint
-- backfill: tenants already live before this migration are not gated again (D4).
INSERT INTO onboarding_progress (tenant_id, current_step, first_live_at)
SELECT tenant_id, 'go_live', coalesce(min(state_changed_at), now())
FROM channel_connections WHERE state = 'live' GROUP BY tenant_id
ON CONFLICT (tenant_id) DO NOTHING;
