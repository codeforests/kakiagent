CREATE TABLE "notification_prefs" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email_muted" text[] DEFAULT '{}' NOT NULL,
	"quiet_enabled" boolean DEFAULT true NOT NULL,
	"quiet_start" smallint DEFAULT 1320 NOT NULL,
	"quiet_end" smallint DEFAULT 480 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "notification_prefs_muted_ck" CHECK ("notification_prefs"."email_muted" <@ array['escalation','approval_pending','hot_lead']::text[]),
	CONSTRAINT "notification_prefs_quiet_ck" CHECK ("notification_prefs"."quiet_start" between 0 and 1439 and "notification_prefs"."quiet_end" between 0 and 1439 and "notification_prefs"."quiet_start" <> "notification_prefs"."quiet_end")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"digest" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notifications_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'test')),
	CONSTRAINT "notifications_subject_ck" CHECK ("notifications"."subject_type" in ('conversation', 'approval', 'lead', 'user')),
	CONSTRAINT "notifications_status_ck" CHECK ("notifications"."status" in ('pending', 'held', 'sent', 'skipped', 'cancelled', 'failed')),
	CONSTRAINT "notifications_skip_ck" CHECK (("notifications"."skip_reason" is null or "notifications"."skip_reason" in ('muted', 'inactive')) and ("notifications"."skip_reason" is not null) = ("notifications"."status" = 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_tenant_id_user_id_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_user_id_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("tenant_id","user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" in ('pending', 'held');--> statement-breakpoint

-- FEAT-052 §4, hand-written: RLS, grants and the sender's due-scan policy.
ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE notification_prefs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_prefs USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- A member reads and edits their own preferences from the dashboard (D4).
GRANT SELECT, INSERT ON notification_prefs TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (email_muted, quiet_enabled, quiet_start, quiet_end, updated_at) ON notification_prefs TO app_dashboard;--> statement-breakpoint
-- Producers notify and cancel from their own zones (D8).
GRANT SELECT, INSERT ON notifications TO app_dashboard, app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (status) ON notifications TO app_dashboard, app_agent_visitor;--> statement-breakpoint
-- The sender runs in the identity zone, which already emails members (D10). It finds due
-- tenants before any tenant context, as the invitation sweep does; writes stay tenant-scoped.
GRANT SELECT ON notification_prefs TO app_identity;--> statement-breakpoint
GRANT SELECT, DELETE ON notifications TO app_identity;--> statement-breakpoint
GRANT UPDATE (status, skip_reason, digest, attempts, next_attempt_at, held_at, sent_at) ON notifications TO app_identity;--> statement-breakpoint
CREATE POLICY identity_lookup ON notifications FOR SELECT TO app_identity USING (true);
