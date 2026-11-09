CREATE TABLE "telegram_alert_links" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" bigint,
	"telegram_name" text,
	"code_hash" "bytea",
	"code_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"staff_notice_at" timestamp with time zone,
	CONSTRAINT "telegram_alert_links_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "telegram_alert_links_state_ck" CHECK (("telegram_alert_links"."chat_id" is null) = ("telegram_alert_links"."linked_at" is null) and ("telegram_alert_links"."code_hash" is null) = ("telegram_alert_links"."code_expires_at" is null) and ("telegram_alert_links"."telegram_name" is null or char_length("telegram_alert_links"."telegram_name") between 1 and 64))
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"tenant_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"last_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone,
	CONSTRAINT "telegram_chats_tenant_id_chat_id_pk" PRIMARY KEY("tenant_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"bot_username" text NOT NULL,
	"bot_name" text NOT NULL,
	"webhook_secret_hash" "bytea" NOT NULL,
	"last_received_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "telegram_settings_bot_ck" CHECK (char_length("telegram_settings"."bot_username") between 1 and 64 and char_length("telegram_settings"."bot_name") between 1 and 128 and octet_length("telegram_settings"."webhook_secret_hash") = 32),
	CONSTRAINT "telegram_settings_version_ck" CHECK ("telegram_settings"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "channel_connections" DROP CONSTRAINT "channel_connections_offline_mode_ck";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_channel_ck";--> statement-breakpoint
ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_outcome_ck";--> statement-breakpoint
ALTER TABLE "message_deliveries" DROP CONSTRAINT "message_deliveries_status_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "notification_prefs" DROP CONSTRAINT "notification_prefs_muted_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_subject_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_skip_ck";--> statement-breakpoint
DROP INDEX "notifications_dedupe_uq";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "telegram_id" bigint;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD COLUMN "telegram_muted" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_alert_links" ADD CONSTRAINT "telegram_alert_links_tenant_id_user_id_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_contact_fk" FOREIGN KEY ("tenant_id","contact_id") REFERENCES "public"."contacts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_settings" ADD CONSTRAINT "telegram_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_settings" ADD CONSTRAINT "telegram_settings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."channel_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_alert_links_chat_uq" ON "telegram_alert_links" USING btree ("tenant_id","chat_id") WHERE "telegram_alert_links"."chat_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_alert_links_code_uq" ON "telegram_alert_links" USING btree ("code_hash") WHERE "telegram_alert_links"."code_hash" is not null;--> statement-breakpoint
CREATE INDEX "telegram_chats_conversation_idx" ON "telegram_chats" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_settings_bot_uq" ON "telegram_settings" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_telegram_uq" ON "contacts" USING btree ("tenant_id","telegram_id") WHERE "contacts"."telegram_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("tenant_id","user_id","channel","dedupe_key");--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_offline_mode_ck" CHECK ("channel_connections"."offline_mode" in ('hidden', 'message') and ("channel_connections"."kind" in ('widget', 'email', 'telegram') or "channel_connections"."offline_mode" = 'message'));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_telegram_ck" CHECK ("contacts"."telegram_username" is null or char_length("contacts"."telegram_username") between 1 and 32);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_ck" CHECK ("conversations"."channel" in ('widget', 'email', 'telegram'));--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_outcome_ck" CHECK ("inbound_events"."outcome" in ('accepted', 'ignored', 'failed') and ("inbound_events"."outcome" = 'ignored') = ("inbound_events"."ignore_reason" is not null) and ("inbound_events"."ignore_reason" is null or "inbound_events"."ignore_reason" in ('auto_reply', 'bounce', 'bulk', 'list', 'spam', 'unsafe', 'echo', 'loop', 'group', 'unsupported', 'staff_chat')));--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_status_ck" CHECK ("message_deliveries"."status" in ('pending', 'sent', 'failed') and ("message_deliveries"."status" = 'failed') = ("message_deliveries"."failed_reason" is not null) and ("message_deliveries"."failed_reason" is null or "message_deliveries"."failed_reason" in ('bounced', 'rejected', 'timed_out', 'blocked')) and ("message_deliveries"."status" <> 'sent' or "message_deliveries"."sent_at" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated', 'lead_captured', 'approval_waiting', 'approval_rejected', 'approval_expired', 'consent_withdrawn', 'text_only')));--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_muted_ck" CHECK ("notification_prefs"."email_muted" <@ array['escalation','approval_pending','hot_lead','consent_withdrawn','channel_degraded']::text[] and "notification_prefs"."telegram_muted" <@ array['escalation','approval_pending','hot_lead','consent_withdrawn','channel_degraded']::text[]);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_ck" CHECK ("notifications"."channel" in ('email', 'telegram'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'consent_withdrawn', 'channel_degraded', 'escalation_reminder', 'approval_undeliverable', 'test'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subject_ck" CHECK ("notifications"."subject_type" in ('conversation', 'approval', 'lead', 'user', 'channel'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_skip_ck" CHECK (("notifications"."skip_reason" is null or "notifications"."skip_reason" in ('muted', 'inactive', 'no_channel')) and ("notifications"."skip_reason" is not null) = ("notifications"."status" = 'skipped'));--> statement-breakpoint
-- FEAT-037 §4, hand-written: RLS, grants, the hook route and the link helpers.
ALTER TABLE telegram_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE telegram_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON telegram_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE telegram_chats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE telegram_chats FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON telegram_chats USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE telegram_alert_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE telegram_alert_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON telegram_alert_links USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The dashboard zone sees only the signed-in member's own link (AC-7): `app.user_id` is set
-- by `withMember` (@kaki/db) from the verified session; without it nothing matches.
CREATE POLICY own_row ON telegram_alert_links AS RESTRICTIVE TO app_dashboard
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

-- Dashboard zone: connect, replace, disconnect (§5.2). The credential columns are write-only
-- for the dashboard (it seals the token and never reads it back, FEAT-034).
GRANT INSERT (credential_ciphertext, credential_key_ref),
  UPDATE (credential_ciphertext, credential_key_ref) ON channel_connections TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_settings TO app_dashboard;--> statement-breakpoint
GRANT SELECT, DELETE ON telegram_chats TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (code_hash, code_expires_at), DELETE ON telegram_alert_links TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (telegram_muted) ON notification_prefs TO app_dashboard;--> statement-breakpoint
-- Visitor zone: the webhook (§5.3), the sender (§5.4) and the alert sender (§5.5).
GRANT SELECT, UPDATE (last_received_at) ON telegram_settings TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (contact_id, conversation_id, last_inbound_at, blocked_at) ON telegram_chats TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, UPDATE (chat_id, telegram_name, code_hash, code_expires_at, linked_at, staff_notice_at), DELETE ON telegram_alert_links TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (telegram_username) ON contacts TO app_agent_visitor;--> statement-breakpoint
-- Outbox zone: the health job's channel_degraded alert (§5.5) and its cancel on recovery.
GRANT SELECT, INSERT, UPDATE (status) ON notifications TO app_outbox;--> statement-breakpoint
-- The degraded alert's recipients (CHN-12): the tenant's active Owners and Admins, for every
-- zone that records a channel's health (the 0045 escalation_candidates() pattern).
CREATE FUNCTION channel_alert_recipients()
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.user_id FROM memberships m
    WHERE m.tenant_id = app_current_tenant() AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
    ORDER BY m.user_id
  $$;--> statement-breakpoint
ALTER FUNCTION channel_alert_recipients() OWNER TO kaki_escalation_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_alert_recipients() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_alert_recipients() TO app_outbox, app_agent_visitor, app_dashboard;--> statement-breakpoint

-- The visitor zone reads no connection row (FEAT-034); a channel's sender opens its sealed
-- credential through this function, for the current tenant only.
CREATE FUNCTION channel_credential(p_connection uuid)
  RETURNS TABLE (ciphertext bytea, key_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.credential_ciphertext, c.credential_key_ref FROM channel_connections c
    WHERE c.id = p_connection AND c.tenant_id = app_current_tenant()
      AND c.credential_ciphertext IS NOT NULL
  $$;--> statement-breakpoint
GRANT SELECT (credential_ciphertext, credential_key_ref) ON channel_connections TO kaki_channels;--> statement-breakpoint
ALTER FUNCTION channel_credential(uuid) OWNER TO kaki_channels;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_credential(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_credential(uuid) TO app_agent_visitor, app_dashboard;--> statement-breakpoint

-- The webhook has no tenant context until it knows the connection (§5.3; the email_route()
-- pattern, 0053): connection + kind → tenant and the webhook secret's hash, one row or none.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_channel_hooks') THEN
    CREATE ROLE kaki_channel_hooks NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_channel_hooks;--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind) ON channel_connections TO kaki_channel_hooks;--> statement-breakpoint
CREATE POLICY channel_hooks_read ON channel_connections FOR SELECT TO kaki_channel_hooks USING (true);--> statement-breakpoint
GRANT SELECT (tenant_id, connection_id, webhook_secret_hash) ON telegram_settings TO kaki_channel_hooks;--> statement-breakpoint
CREATE POLICY channel_hooks_read ON telegram_settings FOR SELECT TO kaki_channel_hooks USING (true);--> statement-breakpoint
CREATE FUNCTION channel_hook_route(p_connection uuid, p_kind text)
  RETURNS TABLE (tenant_id uuid, secret_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.tenant_id, s.webhook_secret_hash FROM channel_connections c
    JOIN telegram_settings s ON s.tenant_id = c.tenant_id AND s.connection_id = c.id
    WHERE c.id = p_connection AND c.kind = p_kind AND p_kind = 'telegram'
  $$;--> statement-breakpoint
ALTER FUNCTION channel_hook_route(uuid, text) OWNER TO kaki_channel_hooks;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_hook_route(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_hook_route(uuid, text) TO app_agent_visitor;--> statement-breakpoint

-- Members' links seen by the business, not by one member (§5.2): the page's count and the
-- disconnect's clean-up, through the dashboard's own-row policy.
GRANT SELECT (tenant_id, chat_id), DELETE ON telegram_alert_links TO kaki_channel_hooks;--> statement-breakpoint
CREATE POLICY channel_hooks_read ON telegram_alert_links FOR SELECT TO kaki_channel_hooks USING (true);--> statement-breakpoint
CREATE POLICY channel_hooks_delete ON telegram_alert_links FOR DELETE TO kaki_channel_hooks USING (true);--> statement-breakpoint
CREATE FUNCTION telegram_alert_link_count()
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT count(*)::int FROM telegram_alert_links l
    WHERE l.tenant_id = app_current_tenant() AND l.chat_id IS NOT NULL
  $$;--> statement-breakpoint
ALTER FUNCTION telegram_alert_link_count() OWNER TO kaki_channel_hooks;--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_alert_link_count() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_alert_link_count() TO app_dashboard;--> statement-breakpoint
CREATE FUNCTION telegram_alert_links_clear()
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH gone AS (
      DELETE FROM telegram_alert_links l WHERE l.tenant_id = app_current_tenant() RETURNING 1
    ) SELECT count(*)::int FROM gone
  $$;--> statement-breakpoint
ALTER FUNCTION telegram_alert_links_clear() OWNER TO kaki_channel_hooks;--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_alert_links_clear() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_alert_links_clear() TO app_dashboard;
