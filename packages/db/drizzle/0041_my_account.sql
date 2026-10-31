CREATE TABLE "email_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"old_email" text NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"taken" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"notice_sent_at" timestamp with time zone,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_changes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_changes_live_user_uq" ON "email_changes" USING btree ("user_id") WHERE "email_changes"."confirmed_at" is null and "email_changes"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "email_changes_unsent_idx" ON "email_changes" USING btree ("next_attempt_at") WHERE "email_changes"."sent_at" is null or "email_changes"."notice_sent_at" is null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_ck" CHECK ("users"."display_name" is null or char_length("users"."display_name") between 1 and 60);--> statement-breakpoint
-- FEAT-008 §4: hand-written grants. Identity zone only: no grant to app_dashboard or
-- app_agent_visitor. email_changes belongs to a user, not a tenant (like magic_links): no RLS.
GRANT UPDATE (email, display_name) ON users TO app_identity;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON email_changes TO app_identity;--> statement-breakpoint
GRANT UPDATE (confirmed_at, cancelled_at, sent_at, notice_sent_at, send_attempts, next_attempt_at) ON email_changes TO app_identity;
