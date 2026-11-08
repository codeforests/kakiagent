CREATE TABLE "email_attachments" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text,
	"size" integer NOT NULL,
	"status" text DEFAULT 'scanning' NOT NULL,
	"reject_reason" text,
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_attachments_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "email_attachments_status_ck" CHECK ("email_attachments"."status" in ('scanning', 'clean', 'rejected') and ("email_attachments"."status" = 'rejected') = ("email_attachments"."reject_reason" is not null) and ("email_attachments"."reject_reason" is null or "email_attachments"."reject_reason" in ('unsupported_type', 'too_large', 'malware', 'encrypted', 'too_many')) and ("email_attachments"."object_key" is null or "email_attachments"."status" = 'clean')),
	CONSTRAINT "email_attachments_name_ck" CHECK (char_length("email_attachments"."name") between 1 and 200 and "email_attachments"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"tenant_id" uuid NOT NULL,
	"rfc_message_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_tenant_id_rfc_message_id_pk" PRIMARY KEY("tenant_id","rfc_message_id"),
	CONSTRAINT "email_messages_direction_ck" CHECK ("email_messages"."direction" in ('in', 'out')),
	CONSTRAINT "email_messages_id_ck" CHECK (char_length("email_messages"."rfc_message_id") between 1 and 998)
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"forwarding_local" text NOT NULL,
	"domain_address" text,
	"domain" text,
	"domain_state" text,
	"dkim_tokens" text[] DEFAULT '{}'::text[] NOT NULL,
	"mail_from_domain" text,
	"domain_checked_at" timestamp with time zone,
	"domain_verified_at" timestamp with time zone,
	"domain_failing_since" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"forwarding_confirmation" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_local_ck" CHECK ("email_settings"."forwarding_local" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "email_settings_domain_ck" CHECK (("email_settings"."domain" is null) = ("email_settings"."domain_address" is null) and ("email_settings"."domain" is null) = ("email_settings"."domain_state" is null) and ("email_settings"."domain_state" is null or "email_settings"."domain_state" in ('pending', 'verified', 'failing'))),
	CONSTRAINT "email_settings_confirmation_ck" CHECK ("email_settings"."forwarding_confirmation" is null or jsonb_typeof("email_settings"."forwarding_confirmation") = 'object'),
	CONSTRAINT "email_settings_version_ck" CHECK ("email_settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "email_threads" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_inbound_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_threads_tenant_id_conversation_id_pk" PRIMARY KEY("tenant_id","conversation_id"),
	CONSTRAINT "email_threads_subject_ck" CHECK (char_length("email_threads"."subject") <= 200),
	CONSTRAINT "email_threads_references_ck" CHECK (cardinality("email_threads"."references") <= 20)
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"ignore_reason" text,
	CONSTRAINT "inbound_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "inbound_events_outcome_ck" CHECK ("inbound_events"."outcome" in ('accepted', 'ignored', 'failed') and ("inbound_events"."outcome" = 'ignored') = ("inbound_events"."ignore_reason" is not null) and ("inbound_events"."ignore_reason" is null or "inbound_events"."ignore_reason" in ('auto_reply', 'bounce', 'bulk', 'list', 'spam', 'unsafe', 'echo', 'loop'))),
	CONSTRAINT "inbound_events_provider_ck" CHECK (char_length("inbound_events"."provider_event_id") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "message_deliveries" (
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"failed_reason" text,
	"external_id" text,
	"sent_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "message_deliveries_tenant_id_message_id_pk" PRIMARY KEY("tenant_id","message_id"),
	CONSTRAINT "message_deliveries_status_ck" CHECK ("message_deliveries"."status" in ('pending', 'sent', 'failed') and ("message_deliveries"."status" = 'failed') = ("message_deliveries"."failed_reason" is not null) and ("message_deliveries"."failed_reason" is null or "message_deliveries"."failed_reason" in ('bounced', 'rejected', 'timed_out')) and ("message_deliveries"."status" <> 'sent' or "message_deliveries"."sent_at" is not null)),
	CONSTRAINT "message_deliveries_attempts_ck" CHECK ("message_deliveries"."attempts" >= 0 and "message_deliveries"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "channel_connections" DROP CONSTRAINT "channel_connections_offline_mode_ck";--> statement-breakpoint
ALTER TABLE "escalations" DROP CONSTRAINT "escalations_source_ck";--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "ai_reply_cap" smallint;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."channel_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_attachments_message_idx" ON "email_attachments" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE INDEX "email_attachments_conversation_idx" ON "email_attachments" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "email_messages_conversation_idx" ON "email_messages" USING btree ("tenant_id","conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_messages_message_idx" ON "email_messages" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_settings_forwarding_local_uq" ON "email_settings" USING btree ("forwarding_local");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_uq" ON "inbound_events" USING btree ("tenant_id","connection_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "inbound_events_received_idx" ON "inbound_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_deliveries_due_idx" ON "message_deliveries" USING btree ("next_attempt_at") WHERE "message_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "message_deliveries_conversation_idx" ON "message_deliveries" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_reply_cap_ck" CHECK ("channel_connections"."ai_reply_cap" is null or "channel_connections"."ai_reply_cap" between 1 and 50);--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_offline_mode_ck" CHECK ("channel_connections"."offline_mode" in ('hidden', 'message') and ("channel_connections"."kind" in ('widget', 'email') or "channel_connections"."offline_mode" = 'message'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_ck" CHECK ("conversations"."channel" in ('widget', 'email'));--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_source_ck" CHECK ("escalations"."source" in ('visitor_button', 'visitor_asked', 'unverified', 'approval_sla', 'data_request', 'reply_cap', 'delivery_failed'));--> statement-breakpoint

-- FEAT-036 §4, hand-written: RLS, grants, the delivery trigger, the inbound route and the
-- delivery sweep.
ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_settings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON inbound_events USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_messages USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE email_threads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_threads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_threads USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE message_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE message_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON message_deliveries USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE email_attachments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_attachments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_attachments USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- Dashboard: sets email up (the connection and settings), manages the sending domain and the
-- reply cap, reads threads, deliveries and attachments, and retries a failed delivery.
GRANT SELECT (ai_reply_cap), UPDATE (ai_reply_cap) ON channel_connections TO app_dashboard;--> statement-breakpoint
GRANT INSERT (tenant_id, kind, state, offline_mode, health, ai_reply_cap) ON channel_connections TO app_dashboard;--> statement-breakpoint
CREATE POLICY channel_connections_dashboard_insert ON channel_connections AS RESTRICTIVE FOR INSERT TO app_dashboard WITH CHECK (kind <> 'widget');--> statement-breakpoint
GRANT SELECT, INSERT ON email_settings TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (domain_address, domain, domain_state, dkim_tokens, mail_from_domain, domain_checked_at,
  domain_verified_at, domain_failing_since, version) ON email_settings TO app_dashboard;--> statement-breakpoint
GRANT SELECT ON inbound_events, email_messages, email_threads, message_deliveries, email_attachments TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (status, attempts, first_attempt_at, next_attempt_at, failed_reason, version)
  ON message_deliveries TO app_dashboard;--> statement-breakpoint

-- Visitor zone (the agent-worker's inbound and delivery consumers).
GRANT SELECT ON email_settings TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (last_received_at, forwarding_confirmation) ON email_settings TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, INSERT ON inbound_events, email_messages, email_attachments TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (subject, "references", last_inbound_id, updated_at) ON email_threads TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, UPDATE (status, attempts, next_attempt_at, failed_reason, external_id, sent_at, version)
  ON message_deliveries TO app_agent_visitor;--> statement-breakpoint

-- Ingest zone: the attachment scan (§5.2 step 4) moves an attachment out of `scanning`.
GRANT SELECT, UPDATE (status, reject_reason, object_key, content_type) ON email_attachments TO app_ingest;--> statement-breakpoint

-- The reply cap travels with the channel state (§5.4): visitor_channel() gains a column, so
-- it is dropped and recreated with the same owner and grants as 0034.
GRANT SELECT (ai_reply_cap) ON channel_connections TO kaki_tenant_state;--> statement-breakpoint
DROP FUNCTION visitor_channel(text);--> statement-breakpoint
CREATE FUNCTION visitor_channel(p_kind text)
  RETURNS TABLE (
    state text, offline_mode text, offline_message_en text, offline_message_zh text,
    contact_email text, contact_phone text, ai_reply_cap smallint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.state, c.offline_mode, c.offline_message_en, c.offline_message_zh,
      bp.contact_email, bp.contact_phone, c.ai_reply_cap
    FROM channel_connections c
      LEFT JOIN business_profiles bp ON bp.tenant_id = c.tenant_id
    WHERE c.tenant_id = app_current_tenant() AND c.kind = p_kind
  $$;--> statement-breakpoint
ALTER FUNCTION visitor_channel(text) OWNER TO kaki_tenant_state;--> statement-breakpoint
REVOKE ALL ON FUNCTION visitor_channel(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION visitor_channel(text) TO app_agent_visitor, app_dashboard;--> statement-breakpoint

-- D2: every staff, agent or system message in a conversation on an adapter channel gets its
-- delivery and its `channel-send` job in the writer's transaction (ADR-012). The widget is
-- the one channel delivered by the stored row; nothing else here branches on kind (ADR-011).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_channel_delivery') THEN
    CREATE ROLE kaki_channel_delivery NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_channel_delivery;--> statement-breakpoint
GRANT SELECT (tenant_id, id, channel) ON conversations TO kaki_channel_delivery;--> statement-breakpoint
CREATE POLICY channel_delivery_read ON conversations FOR SELECT TO kaki_channel_delivery USING (true);--> statement-breakpoint
GRANT SELECT (tenant_id, id, kind) ON channel_connections TO kaki_channel_delivery;--> statement-breakpoint
CREATE POLICY channel_delivery_read ON channel_connections FOR SELECT TO kaki_channel_delivery USING (true);--> statement-breakpoint
GRANT INSERT ON message_deliveries TO kaki_channel_delivery;--> statement-breakpoint
CREATE POLICY channel_delivery_insert ON message_deliveries FOR INSERT TO kaki_channel_delivery WITH CHECK (true);--> statement-breakpoint
GRANT INSERT ON outbox TO kaki_channel_delivery;--> statement-breakpoint
CREATE POLICY channel_delivery_insert ON outbox FOR INSERT TO kaki_channel_delivery WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION messages_channel_delivery() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_channel text;
    v_connection uuid;
  BEGIN
    IF NEW.author = 'visitor' THEN RETURN NULL; END IF;
    SELECT c.channel INTO v_channel FROM conversations c
      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversation_id;
    IF v_channel IS NULL OR v_channel = 'widget' THEN RETURN NULL; END IF;
    SELECT cc.id INTO v_connection FROM channel_connections cc
      WHERE cc.tenant_id = NEW.tenant_id AND cc.kind = v_channel;
    IF v_connection IS NULL THEN
      RAISE EXCEPTION 'no % connection for tenant %', v_channel, NEW.tenant_id;
    END IF;
    INSERT INTO message_deliveries (tenant_id, message_id, conversation_id, connection_id)
      VALUES (NEW.tenant_id, NEW.id, NEW.conversation_id, v_connection);
    INSERT INTO outbox (tenant_id, topic, group_key, payload)
      VALUES (NEW.tenant_id, 'channel-send', NEW.conversation_id::text,
              jsonb_build_object('tenantId', NEW.tenant_id, 'messageId', NEW.id));
    RETURN NULL;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION messages_channel_delivery() OWNER TO kaki_channel_delivery;--> statement-breakpoint
REVOKE ALL ON FUNCTION messages_channel_delivery() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER messages_channel_delivery AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_channel_delivery();--> statement-breakpoint

-- The inbound consumer has no tenant context yet (§5.2 step 2): the forwarding address's
-- local part → tenant and connection, one row or none (the 0001 widget-key pattern).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_email_route') THEN
    CREATE ROLE kaki_email_route NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_email_route;--> statement-breakpoint
GRANT SELECT (tenant_id, connection_id, forwarding_local) ON email_settings TO kaki_email_route;--> statement-breakpoint
CREATE POLICY email_route_read ON email_settings FOR SELECT TO kaki_email_route USING (true);--> statement-breakpoint
CREATE FUNCTION email_route(p_local text)
  RETURNS TABLE (tenant_id uuid, connection_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.tenant_id, s.connection_id FROM email_settings s
    WHERE s.forwarding_local = lower(p_local)
  $$;--> statement-breakpoint
ALTER FUNCTION email_route(text) OWNER TO kaki_email_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION email_route(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION email_route(text) TO app_agent_visitor;--> statement-breakpoint

-- The delivery sweep (§5.3, UC-27 3c; the 0049 timer pattern): the scheduler's outbox zone
-- runs it across tenants. A due retry is queued once on `channel-send` (its timer cleared);
-- a delivery still pending 24 hours after its first attempt is marked failed/timed_out here
-- and a `delivery_failed` job goes on the turns topic, where the agent-worker escalates.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_channel_timer') THEN
    CREATE ROLE kaki_channel_timer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_channel_timer;--> statement-breakpoint
GRANT SELECT (tenant_id, message_id, conversation_id, status, first_attempt_at, next_attempt_at, failed_reason, version),
  UPDATE (status, failed_reason, next_attempt_at, version) ON message_deliveries TO kaki_channel_timer;--> statement-breakpoint
CREATE POLICY channel_timer_read ON message_deliveries FOR SELECT TO kaki_channel_timer USING (true);--> statement-breakpoint
CREATE POLICY channel_timer_update ON message_deliveries FOR UPDATE TO kaki_channel_timer USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT INSERT ON outbox TO kaki_channel_timer;--> statement-breakpoint
CREATE POLICY channel_timer_insert ON outbox FOR INSERT TO kaki_channel_timer WITH CHECK (true);--> statement-breakpoint
GRANT SELECT (tenant_id, received_at), DELETE ON inbound_events TO kaki_channel_timer;--> statement-breakpoint
CREATE POLICY channel_timer_read ON inbound_events FOR SELECT TO kaki_channel_timer USING (true);--> statement-breakpoint
CREATE POLICY channel_timer_delete ON inbound_events FOR DELETE TO kaki_channel_timer USING (true);--> statement-breakpoint
CREATE FUNCTION channel_deliveries_due(p_limit integer DEFAULT 500)
  RETURNS TABLE (tenant_id uuid, message_id uuid, conversation_id uuid, outcome text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    WITH due AS (
      SELECT d.tenant_id, d.message_id, d.conversation_id,
             CASE WHEN d.first_attempt_at <= now() - interval '24 hours' THEN 'timed_out'
                  ELSE 'due' END AS outcome
      FROM message_deliveries d
      WHERE d.status = 'pending'
        AND (d.first_attempt_at <= now() - interval '24 hours' OR d.next_attempt_at <= now())
      ORDER BY d.first_attempt_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ), marked AS (
      UPDATE message_deliveries d SET
        next_attempt_at = NULL,
        status = CASE WHEN u.outcome = 'timed_out' THEN 'failed' ELSE d.status END,
        failed_reason = CASE WHEN u.outcome = 'timed_out' THEN 'timed_out' ELSE d.failed_reason END,
        version = d.version + 1
      FROM due u WHERE d.tenant_id = u.tenant_id AND d.message_id = u.message_id
      RETURNING d.tenant_id, d.message_id, d.conversation_id, u.outcome
    ), queued AS (
      INSERT INTO outbox (tenant_id, topic, group_key, payload)
      SELECT m.tenant_id,
             CASE WHEN m.outcome = 'due' THEN 'channel-send' ELSE 'conversation-turns' END,
             m.conversation_id::text,
             CASE WHEN m.outcome = 'due'
                  THEN jsonb_build_object('tenantId', m.tenant_id, 'messageId', m.message_id)
                  ELSE jsonb_build_object('kind', 'delivery_failed', 'tenantId', m.tenant_id,
                                          'conversationId', m.conversation_id,
                                          'messageId', m.message_id) END
      FROM marked m
    )
    SELECT m.tenant_id, m.message_id, m.conversation_id, m.outcome FROM marked m ORDER BY 1, 2;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION channel_deliveries_due(integer) OWNER TO kaki_channel_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_deliveries_due(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_deliveries_due(integer) TO app_outbox;--> statement-breakpoint
-- inbound_events keep no content but are only needed for redelivery and the 7-day counts.
CREATE FUNCTION inbound_events_purge()
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH gone AS (
      DELETE FROM inbound_events WHERE received_at < now() - interval '30 days' RETURNING 1
    ) SELECT count(*)::int FROM gone
  $$;--> statement-breakpoint
ALTER FUNCTION inbound_events_purge() OWNER TO kaki_channel_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION inbound_events_purge() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION inbound_events_purge() TO app_outbox;
--> statement-breakpoint

-- The send path (§5.3, CHN-12): a 401/403 from a channel degrades its connection at once.
-- The visitor zone reads no connection row (FEAT-034), so it reports through this function,
-- owned by kaki_channels; it returns 'degraded' when the connection was healthy before.
GRANT SELECT (health, health_failures, degraded_since),
  UPDATE (health, health_reason, health_failures, health_checked_at, degraded_since, updated_at)
  ON channel_connections TO kaki_channels;--> statement-breakpoint
CREATE POLICY channels_owner_update ON channel_connections FOR UPDATE TO kaki_channels USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION channel_send_rejected(p_connection uuid)
  RETURNS TABLE (transition text, kind text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    v_was text;
    v_kind text;
  BEGIN
    SELECT c.health, c.kind INTO v_was, v_kind FROM channel_connections c
      WHERE c.id = p_connection AND c.tenant_id = app_current_tenant() FOR UPDATE;
    IF v_was IS NULL THEN RETURN; END IF;
    UPDATE channel_connections c SET
      health = 'degraded', health_reason = 'send_rejected',
      health_failures = c.health_failures + 1,
      degraded_since = coalesce(c.degraded_since, now()),
      health_checked_at = now(), updated_at = now()
    WHERE c.id = p_connection AND c.tenant_id = app_current_tenant();
    RETURN QUERY SELECT CASE WHEN v_was = 'degraded' THEN NULL ELSE 'degraded' END, v_kind;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION channel_send_rejected(uuid) OWNER TO kaki_channels;--> statement-breakpoint
REVOKE ALL ON FUNCTION channel_send_rejected(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION channel_send_rejected(uuid) TO app_agent_visitor, app_outbox, app_dashboard;--> statement-breakpoint

-- A configuration-set bounce names only SES's ID for our reply (§5.3): its tenant and
-- message, before any tenant context, from the `out` rows (the email_route pattern).
GRANT SELECT (tenant_id, rfc_message_id, message_id, direction) ON email_messages TO kaki_email_route;--> statement-breakpoint
CREATE POLICY email_route_read ON email_messages FOR SELECT TO kaki_email_route USING (true);--> statement-breakpoint
CREATE FUNCTION email_bounce_route(p_rfc_id text)
  RETURNS TABLE (tenant_id uuid, message_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.tenant_id, m.message_id FROM email_messages m
    WHERE m.rfc_message_id = p_rfc_id AND m.direction = 'out' AND m.message_id IS NOT NULL
  $$;--> statement-breakpoint
ALTER FUNCTION email_bounce_route(text) OWNER TO kaki_email_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION email_bounce_route(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION email_bounce_route(text) TO app_agent_visitor;
