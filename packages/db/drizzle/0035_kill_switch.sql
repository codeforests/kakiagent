ALTER TABLE "tenants" ADD COLUMN "ai_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ai_paused_by" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ai_paused_by_users_id_fk" FOREIGN KEY ("ai_paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- FEAT-057 §4, hand-written: a tenant already paused (set by hand before this feature) gets
-- a start time so the check below holds.
UPDATE tenants SET ai_paused_at = now() WHERE ai_paused;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ai_paused_at_ck" CHECK (("tenants"."ai_paused" and "tenants"."ai_paused_at" is not null) or (not "tenants"."ai_paused" and "tenants"."ai_paused_at" is null and "tenants"."ai_paused_by" is null));--> statement-breakpoint

-- FEAT-057 §4 (D5), hand-written. The Owner or an Admin pauses and resumes the AI from the
-- dashboard; forced RLS on tenants keeps the grant to the session's own row.
GRANT UPDATE (ai_paused, ai_paused_at, ai_paused_by) ON tenants TO app_dashboard;
