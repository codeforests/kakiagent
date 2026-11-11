CREATE TABLE "handoff_links" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_chat_id" bigint,
	CONSTRAINT "handoff_links_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "handoff_links_channel_ck" CHECK ("handoff_links"."channel" in ('telegram', 'email')),
	CONSTRAINT "handoff_links_email_ck" CHECK (("handoff_links"."email" is not null) = ("handoff_links"."channel" = 'email') and ("handoff_links"."email" is null or (char_length("handoff_links"."email") <= 254 and "handoff_links"."email" = lower("handoff_links"."email")))),
	CONSTRAINT "handoff_links_expiry_ck" CHECK ("handoff_links"."expires_at" > "handoff_links"."created_at")
);
--> statement-breakpoint
ALTER TABLE "contact_identities" DROP CONSTRAINT "contact_identities_source_ck";--> statement-breakpoint
ALTER TABLE "contact_identities" DROP CONSTRAINT "contact_identities_telegram_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "handoff_links" ADD CONSTRAINT "handoff_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_links" ADD CONSTRAINT "handoff_links_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_links" ADD CONSTRAINT "handoff_links_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_links_conversation_idx" ON "handoff_links" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_link_ck" CHECK ("contact_identities"."source" <> 'link' or "contact_identities"."verified_at" is not null);--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_source_ck" CHECK ("contact_identities"."source" in ('email', 'telegram', 'lead_form', 'link'));--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_telegram_ck" CHECK ("contact_identities"."kind" <> 'telegram' or ("contact_identities"."source" in ('telegram', 'link') and "contact_identities"."verified_at" is not null and "contact_identities"."value" ~ '^[0-9]{1,20}$'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated', 'lead_captured', 'approval_waiting', 'approval_rejected', 'approval_expired', 'consent_withdrawn', 'text_only', 'handoff_recap', 'handoff_moved')));--> statement-breakpoint

-- FEAT-038 §4, hand-written: RLS, grants, the purge and the confirm page's tenant lookup.
ALTER TABLE handoff_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE handoff_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON handoff_links USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The widget route creates links; the Telegram webhook and the confirm page redeem them.
GRANT SELECT, INSERT, UPDATE (used_at, used_chat_id) ON handoff_links TO app_agent_visitor;--> statement-breakpoint
-- The redeem moves the same conversation to the new channel (D2). The visitor zone still can't
-- set `channel` itself (FEAT-025's guard): only this function, only widget → telegram/email,
-- compare-and-set on `version`. Returns the new version, or null when nothing moved.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_handoff_move') THEN
    CREATE ROLE kaki_handoff_move NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_handoff_move;--> statement-breakpoint
GRANT SELECT (tenant_id, id, channel, version), UPDATE (channel, version) ON conversations TO kaki_handoff_move;--> statement-breakpoint
CREATE POLICY handoff_move_read ON conversations FOR SELECT TO kaki_handoff_move USING (tenant_id = app_current_tenant());--> statement-breakpoint
CREATE POLICY handoff_move_update ON conversations FOR UPDATE TO kaki_handoff_move USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
CREATE FUNCTION conversation_move_channel(p_conversation uuid, p_to text, p_version integer)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE conversations c SET channel = p_to, version = c.version + 1
    WHERE c.tenant_id = app_current_tenant() AND c.id = p_conversation
      AND c.channel = 'widget' AND p_to IN ('telegram', 'email') AND c.version = p_version
    RETURNING c.version
  $$;--> statement-breakpoint
ALTER FUNCTION conversation_move_channel(uuid, text, integer) OWNER TO kaki_handoff_move;--> statement-breakpoint
REVOKE ALL ON FUNCTION conversation_move_channel(uuid, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION conversation_move_channel(uuid, text, integer) TO app_agent_visitor;--> statement-breakpoint

-- Links hold a typed address: deleted 7 days after expiry, across tenants (ADR-015).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_handoff_purge') THEN
    CREATE ROLE kaki_handoff_purge NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_handoff_purge;--> statement-breakpoint
GRANT SELECT (tenant_id, id, expires_at), DELETE ON handoff_links TO kaki_handoff_purge;--> statement-breakpoint
CREATE POLICY handoff_purge_read ON handoff_links FOR SELECT TO kaki_handoff_purge USING (true);--> statement-breakpoint
CREATE POLICY handoff_purge_delete ON handoff_links FOR DELETE TO kaki_handoff_purge USING (true);--> statement-breakpoint
CREATE FUNCTION handoff_links_purge()
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH gone AS (
      DELETE FROM handoff_links l WHERE l.expires_at < now() - interval '7 days' RETURNING 1
    ) SELECT count(*)::int FROM gone
  $$;--> statement-breakpoint
ALTER FUNCTION handoff_links_purge() OWNER TO kaki_handoff_purge;--> statement-breakpoint
REVOKE ALL ON FUNCTION handoff_links_purge() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION handoff_links_purge() TO app_outbox;--> statement-breakpoint

-- The confirm page has no tenant context (§5.4): link ID → tenant, as channel_hook_route() does.
-- The signed code is still checked against the tenant afterwards, so a guessed ID proves nothing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_handoff_route') THEN
    CREATE ROLE kaki_handoff_route NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_handoff_route;--> statement-breakpoint
GRANT SELECT (tenant_id, id) ON handoff_links TO kaki_handoff_route;--> statement-breakpoint
CREATE POLICY handoff_route_read ON handoff_links FOR SELECT TO kaki_handoff_route USING (true);--> statement-breakpoint
CREATE FUNCTION handoff_link_tenant(p_link uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT l.tenant_id FROM handoff_links l WHERE l.id = p_link
  $$;--> statement-breakpoint
ALTER FUNCTION handoff_link_tenant(uuid) OWNER TO kaki_handoff_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION handoff_link_tenant(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION handoff_link_tenant(uuid) TO app_agent_visitor;
