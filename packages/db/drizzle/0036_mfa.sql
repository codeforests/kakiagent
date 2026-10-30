CREATE TABLE "mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'totp' NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"key_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "mfa_factors_kind_ck" CHECK ("mfa_factors"."kind" in ('totp'))
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "recovery_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "purpose" text DEFAULT 'sign_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mfa_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_factors_confirmed_uq" ON "mfa_factors" USING btree ("user_id") WHERE "mfa_factors"."confirmed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_factors_pending_uq" ON "mfa_factors" USING btree ("user_id") WHERE "mfa_factors"."confirmed_at" is null;--> statement-breakpoint
CREATE INDEX "recovery_codes_unused_idx" ON "recovery_codes" USING btree ("user_id") WHERE "recovery_codes"."used_at" is null;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_purpose_ck" CHECK ("magic_links"."purpose" in ('sign_in', 'reauth'));--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_session_ck" CHECK (("magic_links"."purpose" = 'reauth') = ("magic_links"."session_id" is not null));