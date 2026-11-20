CREATE TABLE "dsr_requests" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text NOT NULL,
	"received_on" date NOT NULL,
	"due_on" date GENERATED ALWAYS AS (received_on + 30) STORED NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"requester_phone" text,
	"requester_telegram_id" text,
	"requester_erased_at" timestamp with time zone,
	"note" text,
	"conversation_id" uuid,
	"contact_id" uuid,
	"verify_method" text,
	"verify_note" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"close_reason" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"outcome" jsonb,
	"objects_pending" integer DEFAULT 0 NOT NULL,
	"objects_done_at" timestamp with time zone,
	"due_alerted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dsr_requests_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "dsr_requests_type_ck" CHECK ("dsr_requests"."type" in ('access', 'correction', 'deletion')),
	CONSTRAINT "dsr_requests_status_ck" CHECK ("dsr_requests"."status" in ('open', 'verified', 'completed', 'unverified', 'closed')),
	CONSTRAINT "dsr_requests_source_ck" CHECK ("dsr_requests"."source" in ('dashboard', 'conversation')),
	CONSTRAINT "dsr_requests_method_ck" CHECK ("dsr_requests"."verify_method" is null or "dsr_requests"."verify_method" in ('verified_channel', 'email_reply', 'phone_call', 'in_person', 'other')),
	CONSTRAINT "dsr_requests_closed_ck" CHECK (("dsr_requests"."status" in ('completed', 'unverified', 'closed')) = ("dsr_requests"."closed_at" is not null)),
	CONSTRAINT "dsr_requests_verified_ck" CHECK ("dsr_requests"."status" <> 'verified' or ("dsr_requests"."verify_method" is not null and "dsr_requests"."verified_at" is not null)),
	CONSTRAINT "dsr_requests_reason_ck" CHECK ("dsr_requests"."status" not in ('unverified', 'closed') or "dsr_requests"."close_reason" is not null),
	CONSTRAINT "dsr_requests_identifier_ck" CHECK ("dsr_requests"."requester_erased_at" is not null or "dsr_requests"."source" = 'conversation' or "dsr_requests"."requester_email" is not null or "dsr_requests"."requester_phone" is not null or "dsr_requests"."requester_telegram_id" is not null),
	CONSTRAINT "dsr_requests_phone_ck" CHECK ("dsr_requests"."requester_erased_at" is not null or "dsr_requests"."requester_phone" is null or "dsr_requests"."requester_phone" ~ '^[+]65[3689][0-9]{7}$'),
	CONSTRAINT "dsr_requests_telegram_ck" CHECK ("dsr_requests"."requester_erased_at" is not null or "dsr_requests"."requester_telegram_id" is null or "dsr_requests"."requester_telegram_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "dsr_requests_text_ck" CHECK (coalesce(length("dsr_requests"."note"), 0) <= 500 and coalesce(length("dsr_requests"."verify_note"), 0) <= 500 and coalesce(length("dsr_requests"."close_reason"), 0) <= 500 and coalesce(length("dsr_requests"."requester_name"), 0) <= 120),
	CONSTRAINT "dsr_requests_objects_ck" CHECK ("dsr_requests"."objects_pending" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_subject_ck";--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dsr_requests_status_due_idx" ON "dsr_requests" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "dsr_requests_conversation_uq" ON "dsr_requests" USING btree ("tenant_id","conversation_id") WHERE status in ('open', 'verified');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'consent_withdrawn', 'channel_degraded', 'escalation_reminder', 'approval_undeliverable', 'test', 'dsr_due_soon'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subject_ck" CHECK ("notifications"."subject_type" in ('conversation', 'approval', 'lead', 'user', 'channel', 'data_request'));
-- FEAT-061 §4, hand-written: RLS, grants and the three functions.
ALTER TABLE dsr_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE dsr_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON dsr_requests USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- Owners and Admins log and work requests (§5.1); the source and creator are fixed at insert.
GRANT SELECT, INSERT ON dsr_requests TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (type, status, received_on, requester_name, requester_email, requester_phone, requester_telegram_id,
  requester_erased_at, note, contact_id, verify_method, verify_note, verified_by, verified_at, close_reason, closed_by,
  closed_at, outcome, objects_pending, objects_done_at, updated_at, version) ON dsr_requests TO app_dashboard;--> statement-breakpoint
CREATE POLICY dsr_dashboard_insert ON dsr_requests AS RESTRICTIVE FOR INSERT TO app_dashboard
  WITH CHECK (source = 'dashboard' AND created_by IS NOT NULL AND status = 'open');--> statement-breakpoint
-- A visitor's "delete my data" opens a request (§5.5, D6); the agent-worker marks files removed (§5.6).
GRANT INSERT ON dsr_requests TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, status) ON dsr_requests TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (objects_pending, objects_done_at, updated_at) ON dsr_requests TO app_agent_visitor;--> statement-breakpoint
CREATE POLICY dsr_visitor_insert ON dsr_requests AS RESTRICTIVE FOR INSERT TO app_agent_visitor
  WITH CHECK (source = 'conversation' AND created_by IS NULL AND status = 'open');--> statement-breakpoint

-- dsr_erase (§5.4, D1, D2): the only cross-store delete. Runs under the tenant_isolation
-- policies with the tenant from app_current_tenant(), deletes children before parents and
-- returns per-store counts and the attachment object keys for the S3 job.
-- SQLSTATE KD000 request not found, KD001 not a verified deletion request.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_dsr_erase') THEN
    CREATE ROLE kaki_dsr_erase NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_dsr_erase;--> statement-breakpoint
-- The row lock needs an UPDATE grant; the function updates nothing on the request.
GRANT SELECT (tenant_id, id, type, status), UPDATE (updated_at) ON dsr_requests TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, merged_into), DELETE ON contacts TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, visitor_id), DELETE ON conversations TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON messages TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, object_key), DELETE ON email_attachments TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, conversation_id), UPDATE (conversation_id), DELETE ON consents TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, superseded_by), UPDATE (superseded_by), DELETE ON leads TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_ref, source_type), DELETE ON corrections TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, correction_id), DELETE ON coaching_sessions TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, session_id), DELETE ON coaching_messages TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON approvals TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, approval_id), DELETE ON used_link_nonces TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON escalations TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id), DELETE ON conversation_owners TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON conversation_summaries TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, contact_id), DELETE ON handoff_links TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON suggestions TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, message_id, conversation_id), DELETE ON message_deliveries TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id), DELETE ON email_messages TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, conversation_id), DELETE ON email_threads TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, chat_id, contact_id), DELETE ON telegram_chats TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id), DELETE ON contact_identities TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, survivor_id, merged_id), DELETE ON contact_merges TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id), DELETE ON audit_pii TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, visitor_id), DELETE ON visitor_events TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, visitor_id), DELETE ON visitor_tracking_choices TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id), DELETE ON facts TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, fact_id), DELETE ON fact_versions TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id, fact_id), DELETE ON kb_chunks TO kaki_dsr_erase;--> statement-breakpoint
GRANT SELECT (tenant_id, id), DELETE ON kb_staged_facts TO kaki_dsr_erase;--> statement-breakpoint
CREATE FUNCTION dsr_erase(req uuid, contact_ids uuid[], conversation_ids uuid[], fact_ids uuid[], staged_ids uuid[])
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    t uuid := app_current_tenant();
    r record;
    cids uuid[];
    convs uuid[];
    visitors uuid[];
    corr uuid[];
    sessions uuid[];
    appr uuid[];
    lead_ids uuid[];
    keys text[];
    counts jsonb := '{}'::jsonb;
    n integer;
  BEGIN
    SELECT type, status INTO r FROM dsr_requests WHERE tenant_id = t AND id = req FOR UPDATE;
    IF t IS NULL OR NOT FOUND THEN
      RAISE EXCEPTION 'dsr_erase: request not found' USING ERRCODE = 'KD000';
    END IF;
    IF r.type <> 'deletion' OR r.status <> 'verified' THEN
      RAISE EXCEPTION 'dsr_erase: not a verified deletion request' USING ERRCODE = 'KD001';
    END IF;

    -- The contacts and every contact merged into them, at any depth.
    WITH RECURSIVE c(id) AS (
      SELECT id FROM contacts WHERE tenant_id = t AND id = ANY (coalesce(contact_ids, '{}'))
      UNION
      SELECT x.id FROM contacts x JOIN c ON x.merged_into = c.id WHERE x.tenant_id = t
    ) SELECT coalesce(array_agg(id), '{}') INTO cids FROM c;
    -- Their conversations whole (D2), plus the ticked conversations that mention them.
    SELECT coalesce(array_agg(id), '{}') INTO convs FROM conversations
      WHERE tenant_id = t AND (contact_id = ANY (cids) OR id = ANY (coalesce(conversation_ids, '{}')));
    -- Tracking rows of visitor IDs no surviving conversation uses.
    SELECT coalesce(array_agg(DISTINCT visitor_id), '{}') INTO visitors FROM conversations v
      WHERE v.tenant_id = t AND v.id = ANY (convs)
        AND NOT EXISTS (SELECT 1 FROM conversations o WHERE o.tenant_id = t
                          AND o.visitor_id = v.visitor_id AND NOT (o.id = ANY (convs)));
    SELECT coalesce(array_agg(object_key), '{}') INTO keys FROM email_attachments
      WHERE tenant_id = t AND conversation_id = ANY (convs) AND object_key IS NOT NULL;

    -- Corrections raised from these conversations, with the coaching sessions replaying them.
    SELECT coalesce(array_agg(id), '{}') INTO corr FROM corrections
      WHERE tenant_id = t AND conversation_ref = ANY (convs)
        AND source_type IN ('thumbs_down', 'staff_reply', 'staff_edit', 'oversight');
    SELECT coalesce(array_agg(id), '{}') INTO sessions FROM coaching_sessions
      WHERE tenant_id = t AND correction_id = ANY (corr);
    DELETE FROM coaching_messages WHERE tenant_id = t AND session_id = ANY (sessions);
    DELETE FROM coaching_sessions WHERE tenant_id = t AND id = ANY (sessions);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('coaching_sessions', n);
    DELETE FROM corrections WHERE tenant_id = t AND id = ANY (corr);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('corrections', n);

    SELECT coalesce(array_agg(id), '{}') INTO appr FROM approvals WHERE tenant_id = t AND conversation_id = ANY (convs);
    DELETE FROM used_link_nonces WHERE tenant_id = t AND approval_id = ANY (appr);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('used_link_nonces', n);
    DELETE FROM approvals WHERE tenant_id = t AND id = ANY (appr);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('approvals', n);
    DELETE FROM escalations WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('escalations', n);
    DELETE FROM conversation_owners WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('conversation_owners', n);
    DELETE FROM conversation_summaries WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('conversation_summaries', n);
    DELETE FROM handoff_links WHERE tenant_id = t AND (conversation_id = ANY (convs) OR contact_id = ANY (cids));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('handoff_links', n);
    DELETE FROM suggestions WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('suggestions', n);
    DELETE FROM email_attachments WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('email_attachments', n);
    DELETE FROM message_deliveries WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('message_deliveries', n);
    DELETE FROM email_messages WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('email_messages', n);
    DELETE FROM email_threads WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('email_threads', n);

    -- Leads before consents (leads_consent_fk). A surviving lead superseded by a deleted one
    -- becomes unsuperseded; another person's consent recorded in a deleted conversation keeps
    -- its evidence without the conversation link.
    SELECT coalesce(array_agg(id), '{}') INTO lead_ids FROM leads WHERE tenant_id = t AND contact_id = ANY (cids);
    UPDATE leads SET superseded_by = NULL
      WHERE tenant_id = t AND superseded_by = ANY (lead_ids) AND NOT (id = ANY (lead_ids));
    DELETE FROM leads WHERE tenant_id = t AND id = ANY (lead_ids);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('leads', n);
    UPDATE consents SET conversation_id = NULL
      WHERE tenant_id = t AND conversation_id = ANY (convs) AND contact_id IS NOT NULL AND NOT (contact_id = ANY (cids));
    DELETE FROM consents WHERE tenant_id = t AND (contact_id = ANY (cids) OR conversation_id = ANY (convs));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('consents', n);
    DELETE FROM telegram_chats WHERE tenant_id = t AND contact_id = ANY (cids);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('telegram_chats', n);

    DELETE FROM messages WHERE tenant_id = t AND conversation_id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('messages', n);
    DELETE FROM visitor_events WHERE tenant_id = t AND visitor_id = ANY (visitors);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('visitor_events', n);
    DELETE FROM visitor_tracking_choices WHERE tenant_id = t AND visitor_id = ANY (visitors);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('visitor_tracking_choices', n);
    DELETE FROM conversations WHERE tenant_id = t AND id = ANY (convs);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('conversations', n);

    DELETE FROM contact_merges WHERE tenant_id = t AND (survivor_id = ANY (cids) OR merged_id = ANY (cids));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('contact_merges', n);
    DELETE FROM contact_identities WHERE tenant_id = t AND contact_id = ANY (cids);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('contact_identities', n);
    DELETE FROM audit_pii WHERE tenant_id = t AND contact_id = ANY (cids);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('audit_pii', n);
    DELETE FROM contacts WHERE tenant_id = t AND id = ANY (cids);
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('contacts', n);

    -- KB items the Admin ticked (D10), as kb deleteFact removes a fact.
    DELETE FROM kb_chunks WHERE tenant_id = t AND fact_id = ANY (coalesce(fact_ids, '{}'));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('kb_chunks', n);
    DELETE FROM fact_versions WHERE tenant_id = t AND fact_id = ANY (coalesce(fact_ids, '{}'));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('fact_versions', n);
    DELETE FROM facts WHERE tenant_id = t AND id = ANY (coalesce(fact_ids, '{}'));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('facts', n);
    DELETE FROM kb_staged_facts WHERE tenant_id = t AND id = ANY (coalesce(staged_ids, '{}'));
    GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('kb_staged_facts', n);

    RETURN jsonb_build_object('counts', counts, 'objectKeys', to_jsonb(keys), 'contactIds', to_jsonb(cids));
  END
  $$;--> statement-breakpoint
ALTER FUNCTION dsr_erase(uuid, uuid[], uuid[], uuid[], uuid[]) OWNER TO kaki_dsr_erase;--> statement-breakpoint
REVOKE ALL ON FUNCTION dsr_erase(uuid, uuid[], uuid[], uuid[], uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dsr_erase(uuid, uuid[], uuid[], uuid[], uuid[]) TO app_dashboard;--> statement-breakpoint

-- dsr_search_hits (§5.2): substring hits for the identifiers in message text (the 0047 index
-- pattern: an always-true read policy, the tenant filtered here) and in KB facts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_dsr_search') THEN
    CREATE ROLE kaki_dsr_search NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_dsr_search;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, body) ON messages TO kaki_dsr_search;--> statement-breakpoint
CREATE POLICY dsr_search_read ON messages FOR SELECT TO kaki_dsr_search USING (true);--> statement-breakpoint
GRANT SELECT (tenant_id, id, value) ON facts TO kaki_dsr_search;--> statement-breakpoint
GRANT SELECT (tenant_id, id, value, quote) ON kb_staged_facts TO kaki_dsr_search;--> statement-breakpoint
CREATE FUNCTION dsr_search_hits(patterns text[])
  RETURNS TABLE (kind text, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT 'conversation', m.conversation_id FROM messages m
      WHERE m.tenant_id = app_current_tenant() AND m.body ILIKE ANY (patterns)
    UNION ALL
    SELECT 'fact', f.id FROM facts f
      WHERE f.tenant_id = app_current_tenant() AND f.value::text ILIKE ANY (patterns)
    UNION ALL
    SELECT 'staged', s.id FROM kb_staged_facts s
      WHERE s.tenant_id = app_current_tenant() AND (s.value::text ILIKE ANY (patterns) OR s.quote ILIKE ANY (patterns))
  $$;--> statement-breakpoint
ALTER FUNCTION dsr_search_hits(text[]) OWNER TO kaki_dsr_search;--> statement-breakpoint
REVOKE ALL ON FUNCTION dsr_search_hits(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dsr_search_hits(text[]) TO app_dashboard;--> statement-breakpoint

-- dsr_queue_due_alerts (§5.6, D8): across tenants, marks open requests 7 days or less from
-- due (Singapore dates) as alerted, once, and returns them for the scheduler to notify.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_dsr_timer') THEN
    CREATE ROLE kaki_dsr_timer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_dsr_timer;--> statement-breakpoint
GRANT SELECT (tenant_id, id, status, due_on, due_alerted_at), UPDATE (due_alerted_at) ON dsr_requests TO kaki_dsr_timer;--> statement-breakpoint
CREATE POLICY dsr_timer_read ON dsr_requests FOR SELECT TO kaki_dsr_timer USING (true);--> statement-breakpoint
CREATE POLICY dsr_timer_update ON dsr_requests FOR UPDATE TO kaki_dsr_timer USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION dsr_queue_due_alerts()
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE dsr_requests r SET due_alerted_at = now()
      WHERE r.status IN ('open', 'verified') AND r.due_alerted_at IS NULL
        AND r.due_on - 7 <= (now() AT TIME ZONE 'Asia/Singapore')::date
      RETURNING r.tenant_id, r.id
  $$;--> statement-breakpoint
ALTER FUNCTION dsr_queue_due_alerts() OWNER TO kaki_dsr_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION dsr_queue_due_alerts() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dsr_queue_due_alerts() TO app_outbox;
--> statement-breakpoint

-- dsr_correct (§5.3, D4, D15): the dashboard still never writes contacts, leads or identities
-- directly (FEAT-049/050); a verified correction request changes contact display fields and
-- the lead's free-text fields here. A changed email or phone replaces the old value's typed
-- (lead_form, unverified) identity; identities the channel verified stay. `fields` holds only
-- the keys to change (null clears). Returns the changed field names.
-- SQLSTATE KD000 request not found, KD002 not a verified correction request, KD003 contact or
-- lead not found.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_dsr_correct') THEN
    CREATE ROLE kaki_dsr_correct NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_dsr_correct;--> statement-breakpoint
GRANT SELECT (tenant_id, id, type, status), UPDATE (updated_at) ON dsr_requests TO kaki_dsr_correct;--> statement-breakpoint
GRANT SELECT (tenant_id, id, name, email, phone), UPDATE (name, email, phone, updated_at) ON contacts TO kaki_dsr_correct;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, need, budget, preferred_time), UPDATE (need, budget, preferred_time, updated_at) ON leads TO kaki_dsr_correct;--> statement-breakpoint
GRANT SELECT (tenant_id, id, contact_id, kind, value, source, verified_at), INSERT, DELETE ON contact_identities TO kaki_dsr_correct;--> statement-breakpoint
CREATE FUNCTION dsr_correct(req uuid, contact uuid, fields jsonb, lead uuid, lead_fields jsonb)
  RETURNS text[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    t uuid := app_current_tenant();
    r record;
    c record;
    changed text[] := '{}';
    k text;
    old_v text;
    new_v text;
  BEGIN
    SELECT type, status INTO r FROM dsr_requests WHERE tenant_id = t AND id = req FOR UPDATE;
    IF t IS NULL OR NOT FOUND THEN
      RAISE EXCEPTION 'dsr_correct: request not found' USING ERRCODE = 'KD000';
    END IF;
    IF r.type <> 'correction' OR r.status <> 'verified' THEN
      RAISE EXCEPTION 'dsr_correct: not a verified correction request' USING ERRCODE = 'KD002';
    END IF;
    SELECT id, name, email, phone INTO c FROM contacts WHERE tenant_id = t AND id = contact FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dsr_correct: contact not found' USING ERRCODE = 'KD003';
    END IF;
    fields := coalesce(fields, '{}'::jsonb);
    IF fields ? 'name' THEN
      UPDATE contacts SET name = fields->>'name', updated_at = now() WHERE tenant_id = t AND id = contact;
      changed := changed || 'contact.name';
    END IF;
    FOREACH k IN ARRAY ARRAY['email', 'phone'] LOOP
      IF fields ? k THEN
        old_v := CASE k WHEN 'email' THEN c.email ELSE c.phone END;
        new_v := fields->>k;
        IF k = 'email' THEN
          UPDATE contacts SET email = new_v, updated_at = now() WHERE tenant_id = t AND id = contact;
        ELSE
          UPDATE contacts SET phone = new_v, updated_at = now() WHERE tenant_id = t AND id = contact;
        END IF;
        IF old_v IS NOT NULL THEN
          DELETE FROM contact_identities WHERE tenant_id = t AND contact_id = contact AND kind = k
            AND value = old_v AND source = 'lead_form' AND verified_at IS NULL;
        END IF;
        IF new_v IS NOT NULL THEN
          INSERT INTO contact_identities (tenant_id, contact_id, kind, value, source)
            VALUES (t, contact, k, new_v, 'lead_form')
            ON CONFLICT (tenant_id, contact_id, kind, value, source) DO NOTHING;
        END IF;
        changed := changed || ('contact.' || k);
      END IF;
    END LOOP;
    IF lead IS NOT NULL THEN
      PERFORM 1 FROM leads WHERE tenant_id = t AND id = lead AND contact_id = contact FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'dsr_correct: lead not found' USING ERRCODE = 'KD003';
      END IF;
      lead_fields := coalesce(lead_fields, '{}'::jsonb);
      IF lead_fields ? 'need' THEN
        UPDATE leads SET need = lead_fields->>'need', updated_at = now() WHERE tenant_id = t AND id = lead;
        changed := changed || 'lead.need';
      END IF;
      IF lead_fields ? 'budget' THEN
        UPDATE leads SET budget = lead_fields->>'budget', updated_at = now() WHERE tenant_id = t AND id = lead;
        changed := changed || 'lead.budget';
      END IF;
      IF lead_fields ? 'preferredTime' THEN
        UPDATE leads SET preferred_time = lead_fields->>'preferredTime', updated_at = now() WHERE tenant_id = t AND id = lead;
        changed := changed || 'lead.preferredTime';
      END IF;
    END IF;
    RETURN changed;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION dsr_correct(uuid, uuid, jsonb, uuid, jsonb) OWNER TO kaki_dsr_correct;--> statement-breakpoint
REVOKE ALL ON FUNCTION dsr_correct(uuid, uuid, jsonb, uuid, jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dsr_correct(uuid, uuid, jsonb, uuid, jsonb) TO app_dashboard;
