CREATE TABLE "escalation_routing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'round_robin' NOT NULL,
	"person_user_id" uuid,
	"reminder_minutes" integer DEFAULT 10 NOT NULL,
	"last_assigned_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "escalation_routing_mode_ck" CHECK ("escalation_routing"."mode" in ('round_robin', 'person')),
	CONSTRAINT "escalation_routing_person_ck" CHECK ("escalation_routing"."mode" <> 'person' or "escalation_routing"."person_user_id" is not null),
	CONSTRAINT "escalation_routing_minutes_ck" CHECK ("escalation_routing"."reminder_minutes" between 1 and 240)
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"urgent" boolean NOT NULL,
	"after_hours" boolean NOT NULL,
	"assignee_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminders" integer DEFAULT 0 NOT NULL,
	"next_reminder_at" timestamp with time zone,
	"reminder_queued_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by" uuid,
	CONSTRAINT "escalations_source_ck" CHECK ("escalations"."source" in ('visitor_button', 'visitor_asked', 'unverified')),
	CONSTRAINT "escalations_resolution_ck" CHECK (("escalations"."resolution" is null or "escalations"."resolution" in ('claimed', 'closed', 'returned')) and ("escalations"."resolved_at" is null) = ("escalations"."resolution" is null)),
	CONSTRAINT "escalations_reminders_ck" CHECK ("escalations"."reminders" >= 0)
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_ck";--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_open_uq" ON "escalations" USING btree ("tenant_id","conversation_id") WHERE "escalations"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "escalations_due_idx" ON "escalations" USING btree ("next_reminder_at") WHERE "escalations"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "escalations_assignee_idx" ON "escalations" USING btree ("tenant_id","assignee_user_id") WHERE "escalations"."resolved_at" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated')));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'escalation_reminder', 'test'));--> statement-breakpoint

-- FEAT-044 §4, hand-written: RLS, grants, the routing function and the reminder timer.
ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE escalations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON escalations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE escalation_routing ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE escalation_routing FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON escalation_routing USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The visitor zone (widget button, the agent's handler, reminders) opens, routes, reminds and
-- resolves escalations; the dashboard resolves them (take-over, close) and edits routing.
GRANT SELECT, INSERT ON escalations TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (urgent, reminders, next_reminder_at, reminder_queued_at, assignee_user_id, resolved_at, resolution, resolved_by) ON escalations TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT, INSERT ON escalation_routing TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (last_assigned_user_id) ON escalation_routing TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON escalations TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (resolved_at, resolution, resolved_by) ON escalations TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT ON escalation_routing TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (mode, person_user_id, reminder_minutes, updated_at, updated_by) ON escalation_routing TO app_dashboard;--> statement-breakpoint

-- Routing candidates (D3, the 0037 pattern): the visitor zone can't read memberships, so a
-- NOLOGIN role's SECURITY DEFINER function returns the current tenant's active members' IDs
-- and roles, never names or emails.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_escalation_route') THEN
    CREATE ROLE kaki_escalation_route NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_escalation_route;--> statement-breakpoint
GRANT SELECT (tenant_id, user_id, role, status) ON memberships TO kaki_escalation_route;--> statement-breakpoint
CREATE POLICY escalation_route ON memberships FOR SELECT TO kaki_escalation_route USING (tenant_id = app_current_tenant());--> statement-breakpoint
CREATE FUNCTION escalation_candidates()
  RETURNS TABLE (user_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.user_id, m.role::text FROM memberships m
    WHERE m.tenant_id = app_current_tenant() AND m.status = 'active'
    ORDER BY m.user_id
  $$;--> statement-breakpoint
ALTER FUNCTION escalation_candidates() OWNER TO kaki_escalation_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION escalation_candidates() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION escalation_candidates() TO app_agent_visitor, app_dashboard;--> statement-breakpoint

-- The reminder timer (ADR-012; the auto-close pattern, 0042): the scheduler's outbox zone
-- runs it across tenants; it marks each due open escalation queued and writes one reminder
-- job on the turns topic, which the agent-worker runs (`remindEscalation`).
GRANT SELECT (tenant_id, id, conversation_id, next_reminder_at, reminder_queued_at, resolved_at), UPDATE (next_reminder_at, reminder_queued_at) ON escalations TO kaki_inbox_timer;--> statement-breakpoint
CREATE POLICY inbox_timer_read ON escalations FOR SELECT TO kaki_inbox_timer USING (true);--> statement-breakpoint
CREATE POLICY inbox_timer_update ON escalations FOR UPDATE TO kaki_inbox_timer USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION inbox_queue_escalation_reminders()
  RETURNS TABLE (tenant_id uuid, queued integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    WITH due AS (
      SELECT e.id FROM escalations e
      WHERE e.resolved_at IS NULL AND e.next_reminder_at <= now()
      ORDER BY e.next_reminder_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    ), marked AS (
      UPDATE escalations e SET next_reminder_at = NULL, reminder_queued_at = now()
      FROM due d WHERE e.id = d.id
      RETURNING e.tenant_id, e.id, e.conversation_id
    ), queued AS (
      INSERT INTO outbox (tenant_id, topic, group_key, payload)
      SELECT m.tenant_id, 'conversation-turns', m.conversation_id::text,
             jsonb_build_object('kind', 'escalation_reminder', 'tenantId', m.tenant_id, 'escalationId', m.id)
      FROM marked m
    )
    SELECT m.tenant_id, count(*)::int FROM marked m GROUP BY m.tenant_id ORDER BY 1;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION inbox_queue_escalation_reminders() OWNER TO kaki_inbox_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION inbox_queue_escalation_reminders() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION inbox_queue_escalation_reminders() TO app_outbox;--> statement-breakpoint

-- Auto-close skips escalated conversations too (D5): an unclaimed request for a person is
-- closed by staff or taken over, never silently by the idle timer. Same owner and grants.
CREATE OR REPLACE FUNCTION inbox_queue_auto_close()
  RETURNS TABLE (tenant_id uuid, queued integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    WITH due AS (
      SELECT c.tenant_id, c.id FROM conversations c
      WHERE c.status NOT IN ('closed', 'escalated')
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
    SELECT m.tenant_id, count(*)::int FROM marked m GROUP BY m.tenant_id ORDER BY 1;
  END
  $$;
