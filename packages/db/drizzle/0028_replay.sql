-- FEAT-028 §4: a replay is a coaching session (origin 'replay') whose answers are coaching
-- messages of kind 'replay'. Same tables, so RLS and grants are unchanged: app_dashboard keeps
-- SELECT, INSERT and the visitor role still has no grant (ADR-009). Replays and their answers
-- are deleted with their conversation (ADR-015).
ALTER TABLE "coaching_messages" DROP CONSTRAINT "coaching_messages_kind_ck";--> statement-breakpoint
ALTER TABLE "coaching_sessions" DROP CONSTRAINT "coaching_sessions_origin_ck";--> statement-breakpoint
ALTER TABLE "coaching_messages" DROP CONSTRAINT "coaching_messages_tenant_id_session_id_coaching_sessions_tenant_id_id_fk";
--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD COLUMN "replay_of" uuid;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD COLUMN "replay_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD COLUMN "include_unreviewed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_tenant_id_session_id_coaching_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."coaching_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_tenant_id_replay_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","replay_conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_messages_session_replay_uq" ON "coaching_messages" USING btree ("tenant_id","session_id","replay_of");--> statement-breakpoint
CREATE INDEX "coaching_sessions_tenant_replay_idx" ON "coaching_sessions" USING btree ("tenant_id","replay_conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_replay_ck" CHECK (("coaching_messages"."kind" = 'replay') = ("coaching_messages"."replay_of" is not null));--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_kind_ck" CHECK ("coaching_messages"."kind" in ('question', 'answer', 'proposal', 'after', 'replay'));--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_replay_ck" CHECK (("coaching_sessions"."origin" = 'replay') = ("coaching_sessions"."replay_conversation_id" is not null));--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_origin_ck" CHECK ("coaching_sessions"."origin" in ('coach', 'setup', 'panel', 'replay'));
