ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "flag_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "abuse_turns" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_tenant_flagged_idx" ON "conversations" USING btree ("tenant_id","flagged_at" DESC NULLS LAST) WHERE "conversations"."flagged_at" is not null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_flag_ck" CHECK ("conversations"."flag_reasons" <@ array['abuse', 'crisis']::text[] and ("conversations"."flagged_at" is null) = (cardinality("conversations"."flag_reasons") = 0));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_abuse_turns_ck" CHECK (cardinality("conversations"."abuse_turns") <= 20);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended')));