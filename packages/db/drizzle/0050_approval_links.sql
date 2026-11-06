CREATE TABLE "used_link_nonces" (
	"tenant_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "used_link_nonces_tenant_id_nonce_pk" PRIMARY KEY("tenant_id","nonce"),
	CONSTRAINT "used_link_nonces_nonce_ck" CHECK (length("used_link_nonces"."nonce") between 16 and 64)
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "approval_link" text;--> statement-breakpoint
ALTER TABLE "used_link_nonces" ADD CONSTRAINT "used_link_nonces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "used_link_nonces" ADD CONSTRAINT "used_link_nonces_approval_fk" FOREIGN KEY ("tenant_id","approval_id") REFERENCES "public"."approvals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "used_link_nonces_expiry_idx" ON "used_link_nonces" USING btree ("tenant_id","expires_at");--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_approval_link_ck" CHECK (("magic_links"."purpose" = 'sign_in' or "magic_links"."approval_link" is null) and ("magic_links"."invitation_id" is null or "magic_links"."approval_link" is null));--> statement-breakpoint
-- FEAT-056 §4, hand-written: RLS and grants. Only the dashboard zone opens links.
ALTER TABLE used_link_nonces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE used_link_nonces FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON used_link_nonces USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON used_link_nonces TO app_dashboard;
