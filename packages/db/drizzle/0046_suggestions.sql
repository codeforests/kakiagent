CREATE TABLE "suggestions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"for_message_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"outcome" text NOT NULL,
	"body" text,
	"fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"language" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sent_message_id" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "suggestions_outcome_ck" CHECK ("suggestions"."outcome" in ('ready', 'no_checked_answer', 'unavailable')),
	CONSTRAINT "suggestions_body_ck" CHECK (("suggestions"."outcome" = 'ready') = ("suggestions"."body" is not null)),
	CONSTRAINT "suggestions_language_ck" CHECK ("suggestions"."language" in ('en', 'zh')),
	CONSTRAINT "suggestions_status_ck" CHECK ("suggestions"."status" in ('open', 'sent', 'sent_edited', 'superseded')),
	CONSTRAINT "suggestions_used_ck" CHECK (("suggestions"."status" in ('sent', 'sent_edited')) = ("suggestions"."used_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tenant_id_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tenant_id_for_message_id_messages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","for_message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestions_conversation_idx" ON "suggestions" USING btree ("tenant_id","conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "corrections_reply_edit_uq" ON "corrections" USING btree ("tenant_id",("proposed_change"->>'suggestionId')) WHERE "corrections"."proposed_change"->>'kind' = 'reply_edit';--> statement-breakpoint

-- FEAT-045 §4, hand-written: the sent-message FK, RLS and grants.
-- PG 15+ column list: a deleted message clears only sent_message_id, never tenant_id.
ALTER TABLE suggestions ADD CONSTRAINT "suggestions_sent_message_fk" FOREIGN KEY ("tenant_id","sent_message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE SET NULL ("sent_message_id");--> statement-breakpoint
ALTER TABLE suggestions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE suggestions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON suggestions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- Drafts are the dashboard's alone (ADR-009): the visitor zone has no grant.
GRANT SELECT, INSERT ON suggestions TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (status, sent_message_id, used_at) ON suggestions TO app_dashboard;--> statement-breakpoint
-- An unedited draft's fact IDs are copied onto the staff message that sent it (§5.2, ADR-008);
-- the dashboard updates only that column, and only on staff rows.
GRANT UPDATE (fact_ids) ON messages TO app_dashboard;--> statement-breakpoint
CREATE POLICY messages_dashboard_update ON messages AS RESTRICTIVE FOR UPDATE TO app_dashboard USING (author = 'staff') WITH CHECK (author = 'staff');
