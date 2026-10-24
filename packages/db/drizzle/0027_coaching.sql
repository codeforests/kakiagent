CREATE TABLE "coaching_messages" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"include_unreviewed" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"explainer" jsonb,
	"correction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coaching_messages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "coaching_messages_author_ck" CHECK ("coaching_messages"."author" in ('owner', 'agent')),
	CONSTRAINT "coaching_messages_kind_ck" CHECK ("coaching_messages"."kind" in ('question', 'answer', 'proposal', 'after'))
);
--> statement-breakpoint
CREATE TABLE "coaching_sessions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"origin" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coaching_sessions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "coaching_sessions_origin_ck" CHECK ("coaching_sessions"."origin" in ('coach', 'setup', 'panel'))
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"proposed_by" text NOT NULL,
	"conversation_ref" uuid,
	"coaching_session_id" uuid,
	"coaching_message_id" uuid,
	"fact_refs" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corrections_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "corrections_source_ck" CHECK ("corrections"."source_type" in ('thumbs_down', 'staff_reply', 'staff_edit', 'coaching', 'oversight', 'stale', 'coverage_gap')),
	CONSTRAINT "corrections_proposed_by_ck" CHECK ("corrections"."proposed_by" in ('system', 'coaching', 'staff')),
	CONSTRAINT "corrections_status_ck" CHECK ("corrections"."status" in ('open', 'accepted', 'edited_and_accepted', 'dismissed')),
	CONSTRAINT "corrections_decided_ck" CHECK (("corrections"."status" = 'open') = ("corrections"."decided_at" is null)),
	CONSTRAINT "corrections_coaching_ck" CHECK ("corrections"."source_type" <> 'coaching' or "corrections"."coaching_session_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "coaching_session_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_tenant_id_session_id_coaching_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."coaching_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_messages_session_seq_uq" ON "coaching_messages" USING btree ("tenant_id","session_id","seq");--> statement-breakpoint
CREATE INDEX "coaching_sessions_tenant_updated_idx" ON "coaching_sessions" USING btree ("tenant_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "corrections_tenant_status_created_idx" ON "corrections" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_owner_ck" CHECK ("usage_events"."conversation_id" is null or "usage_events"."coaching_session_id" is null);--> statement-breakpoint

-- FEAT-027 §4, hand-written: coaching sessions, their messages and the corrections queue
-- (ADR-010 decision 4). Forced RLS with the tenant policy. Granted to the dashboard trust
-- zone only: the visitor role never sees coaching content or proposals (ADR-009).
ALTER TABLE coaching_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE coaching_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON coaching_sessions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE coaching_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE coaching_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON coaching_messages USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE corrections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON corrections USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT ON coaching_sessions, coaching_messages, corrections TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (title, updated_at) ON coaching_sessions TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, updated_at, coaching_message_id) ON corrections TO app_dashboard;--> statement-breakpoint
-- A coaching turn reads the same tenant state a visitor turn gets (name, GST, routing,
-- persona, hours, kill switch), on the dashboard zone (FEAT-027 §5.2).
GRANT EXECUTE ON FUNCTION visitor_tenant_state() TO app_dashboard;
