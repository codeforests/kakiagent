ALTER TABLE "conversations" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_close_queued_at" timestamp with time zone;--> statement-breakpoint
-- FEAT-042 §4, hand-written: closed rows get a close time and reason before the check below.
UPDATE conversations SET closed_at = last_message_at,
  close_reason = CASE WHEN 'abuse' = ANY(flag_reasons) THEN 'abuse' ELSE 'visitor' END
  WHERE status = 'closed';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_kinds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_open_idle_idx" ON "conversations" USING btree ("last_message_at") WHERE "conversations"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "conversations_tenant_status_last_idx" ON "conversations" USING btree ("tenant_id","status","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_status_ck" CHECK ("conversations"."status" in ('ai', 'escalated', 'human', 'waiting_approval', 'closed'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_close_reason_ck" CHECK ("conversations"."close_reason" is null or "conversations"."close_reason" in ('staff', 'inactive', 'visitor', 'abuse'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_closed_ck" CHECK (("conversations"."status" = 'closed') = ("conversations"."closed_at" is not null and "conversations"."close_reason" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_kinds_ck" CHECK ("messages"."task_kinds" <@ array['answer', 'capture_lead', 'request_commitment', 'escalate', 'handoff_channel', 'withdraw_consent', 'data_request', 'crisis', 'abuse', 'out_of_scope', 'correct']::text[]);--> statement-breakpoint

-- FEAT-042 §4, hand-written. The dashboard closes conversations (lifecycle columns only);
-- the visitor zone closes and reopens them too.
GRANT UPDATE (status, version, closed_at, close_reason) ON conversations TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (version, closed_at, close_reason) ON conversations TO app_agent_visitor;--> statement-breakpoint

-- The auto-close scan (INB-08, D3; pattern of kb_stale_scan, 0029): scheduler-worker's outbox
-- zone runs it every minute across tenants. Its NOLOGIN owner reads the open conversations,
-- marks each due one queued and writes one auto-close job per conversation on the turns
-- topic; the agent-worker closes it (it has the audit chain). The idle rule lives here only,
-- mirrored by IDLE_MS in @kaki/inbox for the worker's re-check.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_inbox_timer') THEN
    CREATE ROLE kaki_inbox_timer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_inbox_timer;--> statement-breakpoint
GRANT SELECT (tenant_id, id, channel, status, last_message_at, auto_close_queued_at), UPDATE (auto_close_queued_at) ON conversations TO kaki_inbox_timer;--> statement-breakpoint
CREATE POLICY inbox_timer_read ON conversations FOR SELECT TO kaki_inbox_timer USING (true);--> statement-breakpoint
CREATE POLICY inbox_timer_update ON conversations FOR UPDATE TO kaki_inbox_timer USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT INSERT ON outbox TO kaki_inbox_timer;--> statement-breakpoint
CREATE POLICY inbox_timer_insert ON outbox FOR INSERT TO kaki_inbox_timer WITH CHECK (true);--> statement-breakpoint
-- Picks up to 500 open conversations idle past their channel's limit (widget 30 minutes,
-- any other channel 72 hours) and not queued since their last message. Returns one row per
-- tenant with the number queued.
CREATE FUNCTION inbox_queue_auto_close()
  RETURNS TABLE (tenant_id uuid, queued integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    WITH due AS (
      SELECT c.tenant_id, c.id FROM conversations c
      WHERE c.status <> 'closed'
        AND c.last_message_at < now() - CASE c.channel WHEN 'widget' THEN interval '30 minutes'
                                                       ELSE interval '72 hours' END
        AND (c.auto_close_queued_at IS NULL OR c.auto_close_queued_at < c.last_message_at)
      ORDER BY c.last_message_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    ), marked AS (
      UPDATE conversations c SET auto_close_queued_at = now()
      FROM due d WHERE c.tenant_id = d.tenant_id AND c.id = d.id
      RETURNING c.tenant_id, c.id
    ), queued AS (
      INSERT INTO outbox (tenant_id, topic, group_key, payload)
      SELECT m.tenant_id, 'conversation-turns', m.id::text,
             jsonb_build_object('kind', 'auto_close', 'tenantId', m.tenant_id, 'conversationId', m.id)
      FROM marked m
    )
    -- The insert runs though nothing reads it; marked and queued are the same rows (the
    -- owner may write outbox rows but not read them back, as every writer role).
    SELECT m.tenant_id, count(*)::int FROM marked m GROUP BY m.tenant_id ORDER BY 1;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION inbox_queue_auto_close() OWNER TO kaki_inbox_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION inbox_queue_auto_close() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION inbox_queue_auto_close() TO app_outbox;
