CREATE TABLE "conversation_owners" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"visitor_name" text,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_owners_tenant_id_conversation_id_pk" PRIMARY KEY("tenant_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "conversation_owners" ADD CONSTRAINT "conversation_owners_tenant_id_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_owners_tenant_user_idx" ON "conversation_owners" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_staff_author_ck" CHECK ("messages"."author_user_id" is null or "messages"."author" in ('staff', 'system'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left')));--> statement-breakpoint

-- FEAT-043 §4, hand-written: RLS, grants and the dashboard's insert policy on messages.
ALTER TABLE conversation_owners ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation_owners FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_owners USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The dashboard takes over, takes from, hands back and reads owners; the visitor zone's
-- closes (auto-close, End chat, abuse) delete the row and the send gate reads it.
GRANT SELECT, INSERT, DELETE ON conversation_owners TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (user_id, visitor_name, since) ON conversation_owners TO app_dashboard;--> statement-breakpoint
GRANT SELECT, DELETE ON conversation_owners TO app_agent_visitor;--> statement-breakpoint
-- Staff messages and notices (D5): the dashboard inserts messages and moves last_message_at,
-- so a live staff chat counts as activity for auto-close.
GRANT INSERT ON messages TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (last_message_at) ON conversations TO app_dashboard;--> statement-breakpoint
-- tenant_isolation on messages (0001) is FOR ALL to every role; this restrictive policy narrows
-- the dashboard's inserts to staff and system rows.
CREATE POLICY messages_dashboard_authors ON messages AS RESTRICTIVE FOR INSERT TO app_dashboard WITH CHECK (author in ('staff', 'system'));
