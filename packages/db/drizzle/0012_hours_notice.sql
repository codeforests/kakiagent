ALTER TABLE "business_profiles" ADD COLUMN "hours" jsonb;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "open_on_public_holidays" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "notice" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "notice_kind" text;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_hours_ck" CHECK ("business_profiles"."hours" is null or jsonb_typeof("business_profiles"."hours") = 'object');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours')));