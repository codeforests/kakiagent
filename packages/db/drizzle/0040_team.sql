CREATE TABLE "invitations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"send_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "invitations_id_unique" UNIQUE("id"),
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_role_ck" CHECK ("invitations"."role" in ('admin', 'agent')),
	CONSTRAINT "invitations_accepted_ck" CHECK (("invitations"."accepted_at" is null) = ("invitations"."accepted_by" is null))
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "approval_rights" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_live_email_uq" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_unsent_idx" ON "invitations" USING btree ("next_attempt_at") WHERE "invitations"."sent_at" is null;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_invitation_ck" CHECK ("magic_links"."purpose" = 'sign_in' or "magic_links"."invitation_id" is null);--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_rights_ck" CHECK ("memberships"."approval_rights" = false or "memberships"."role" = 'agent');--> statement-breakpoint
-- FEAT-007 §4: hand-written RLS, grants and the workspaces function. drizzle-kit owns only the DDL above.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The lookup and the sweep find a row by token hash or due time before any tenant context,
-- as identity_read does for memberships. Read-only; writes still go through tenant_isolation.
CREATE POLICY identity_lookup ON invitations FOR SELECT TO app_identity USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON invitations TO app_identity;--> statement-breakpoint
GRANT UPDATE (accepted_at, accepted_by, revoked_at, sent_at, send_attempts, next_attempt_at) ON invitations TO app_identity;--> statement-breakpoint
GRANT UPDATE (role, status, approval_rights) ON memberships TO app_identity;--> statement-breakpoint

-- The tenant switcher needs the names of every workspace a user belongs to, which
-- tenant_isolation on tenants hides from the identity zone: a NOLOGIN role's SECURITY
-- DEFINER function returns only the given user's rows (the 0037 pattern).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_workspaces') THEN
    CREATE ROLE kaki_workspaces NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_workspaces;--> statement-breakpoint
GRANT SELECT (tenant_id, user_id, role, status) ON memberships TO kaki_workspaces;--> statement-breakpoint
CREATE POLICY workspaces ON memberships FOR SELECT TO kaki_workspaces USING (true);--> statement-breakpoint
GRANT SELECT (id, name, status) ON tenants TO kaki_workspaces;--> statement-breakpoint
CREATE POLICY workspaces ON tenants FOR SELECT TO kaki_workspaces USING (true);--> statement-breakpoint
CREATE FUNCTION user_workspaces(p_user uuid)
  RETURNS TABLE (tenant_id uuid, name text, status text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.name, t.status, m.role
    FROM memberships m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user AND m.status = 'active'
    ORDER BY t.name, t.id
  $$;--> statement-breakpoint
ALTER FUNCTION user_workspaces(uuid) OWNER TO kaki_workspaces;--> statement-breakpoint
REVOKE ALL ON FUNCTION user_workspaces(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_workspaces(uuid) TO app_identity;
