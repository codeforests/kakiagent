ALTER TABLE "messages" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_language_ck" CHECK ("messages"."language" in ('en', 'zh'));