CREATE TABLE "approvals" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" jsonb NOT NULL,
	"draft" jsonb NOT NULL,
	"final" jsonb,
	"prices" jsonb NOT NULL,
	"rules_version" integer,
	"above_max" boolean DEFAULT false NOT NULL,
	"after_hours" boolean DEFAULT false NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"urgent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"delivered_message_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "approvals_kind_ck" CHECK ("approvals"."kind" in ('quote', 'discount', 'commitment')),
	CONSTRAINT "approvals_status_ck" CHECK ("approvals"."status" in ('pending', 'approved', 'edited_approved', 'rejected', 'expired', 'undeliverable')),
	CONSTRAINT "approvals_decided_ck" CHECK (("approvals"."decided_at" is null) = ("approvals"."status" in ('pending', 'expired')) and ("approvals"."decided_by" is null or "approvals"."decided_at" is not null)),
	CONSTRAINT "approvals_reason_ck" CHECK (("approvals"."status" <> 'rejected' or char_length(btrim(coalesce("approvals"."reason", ''))) > 0) and ("approvals"."reason" is null or char_length("approvals"."reason") <= 500)),
	CONSTRAINT "approvals_json_ck" CHECK (jsonb_typeof("approvals"."request") = 'object' and jsonb_typeof("approvals"."draft") = 'object' and jsonb_typeof("approvals"."prices") = 'array' and ("approvals"."final" is null or jsonb_typeof("approvals"."final") = 'object')),
	CONSTRAINT "approvals_version_ck" CHECK ("approvals"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "escalations" DROP CONSTRAINT "escalations_source_ck";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_notice_ck";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_ck";--> statement-breakpoint
ALTER TABLE "boundary_rules" ADD COLUMN "approval_sla_minutes" smallint DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_uq" ON "approvals" USING btree ("tenant_id","conversation_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_queue_idx" ON "approvals" USING btree ("tenant_id","status","sla_due_at");--> statement-breakpoint
ALTER TABLE "boundary_rules" ADD CONSTRAINT "boundary_rules_sla_ck" CHECK ("boundary_rules"."approval_sla_minutes" between 15 and 2880);--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_source_ck" CHECK ("escalations"."source" in ('visitor_button', 'visitor_asked', 'unverified', 'approval_sla'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_notice_ck" CHECK (("messages"."notice" is null) = ("messages"."notice_kind" is null) and ("messages"."notice_kind" is null or "messages"."notice_kind" in ('after_hours', 'chat_ended', 'staff_joined', 'staff_left', 'escalated', 'lead_captured', 'approval_waiting', 'approval_rejected', 'approval_expired')));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" in ('escalation', 'approval_pending', 'hot_lead', 'escalation_reminder', 'approval_undeliverable', 'test'));--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_card_ck";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_card_ck" CHECK ("messages"."card" is null or ("messages"."author" in ('agent', 'system') and "messages"."card"->>'kind' in ('consent', 'lead_form', 'quote')));--> statement-breakpoint

-- FEAT-055 §4, hand-written: RLS, grants, the approver list, the timers and auto-close.
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON approvals USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- The visitor zone drafts (and sends a D3 quote at once); it never updates a row. The
-- dashboard decides; only the decision columns move.
GRANT SELECT, INSERT ON approvals TO app_agent_visitor;--> statement-breakpoint
GRANT SELECT ON approvals TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (status, final, decided_by, decided_at, reason, delivered_message_id, version) ON approvals TO app_dashboard;--> statement-breakpoint

-- Approvers (the 0045 pattern): the visitor zone can't read memberships, so this returns the
-- current tenant's active owners, admins and agents with approval rights, IDs only.
GRANT SELECT (approval_rights) ON memberships TO kaki_escalation_route;--> statement-breakpoint
CREATE FUNCTION approval_candidates()
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.user_id FROM memberships m
    WHERE m.tenant_id = app_current_tenant() AND m.status = 'active'
      AND (m.role IN ('owner', 'admin') OR m.approval_rights)
    ORDER BY m.user_id
  $$;--> statement-breakpoint
ALTER FUNCTION approval_candidates() OWNER TO kaki_escalation_route;--> statement-breakpoint
REVOKE ALL ON FUNCTION approval_candidates() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION approval_candidates() TO app_agent_visitor, app_dashboard;--> statement-breakpoint

-- The timers (D10, ADR-012; the 0045 pattern): the scheduler's outbox zone runs the sweep
-- across tenants; it marks each due timer and writes one job on the turns topic, which the
-- agent-worker runs (`runApprovalTimer`, which re-checks `pending`).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_approvals_timer') THEN
    CREATE ROLE kaki_approvals_timer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_approvals_timer;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, status, sla_due_at, urgent_at, expires_at, escalated_at, version) ON approvals TO kaki_approvals_timer;--> statement-breakpoint
GRANT UPDATE (urgent_at, escalated_at, status, version) ON approvals TO kaki_approvals_timer;--> statement-breakpoint
CREATE POLICY approvals_timer_read ON approvals FOR SELECT TO kaki_approvals_timer USING (true);--> statement-breakpoint
CREATE POLICY approvals_timer_update ON approvals FOR UPDATE TO kaki_approvals_timer USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT INSERT ON outbox TO kaki_approvals_timer;--> statement-breakpoint
CREATE POLICY approvals_timer_insert ON outbox FOR INSERT TO kaki_approvals_timer WITH CHECK (true);--> statement-breakpoint
-- One job per due timer, each queued once: `urgent` clears `urgent_at`, `sla` sets
-- `escalated_at`, and `expire` marks the row `expired` here (so the visitor zone never
-- updates an approval); the worker then sends the expiry notice.
CREATE FUNCTION approvals_queue_due()
  RETURNS TABLE (tenant_id uuid, queued integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  BEGIN
    RETURN QUERY
    WITH due AS (
      SELECT a.tenant_id, a.id, a.conversation_id,
             CASE WHEN a.expires_at <= now() THEN 'expire'
                  WHEN a.sla_due_at <= now() AND a.escalated_at IS NULL THEN 'sla'
                  ELSE 'urgent' END AS timer
      FROM approvals a
      WHERE a.status = 'pending'
        AND (a.expires_at <= now()
             OR (a.sla_due_at <= now() AND a.escalated_at IS NULL)
             OR a.urgent_at <= now())
      ORDER BY a.sla_due_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    ), marked AS (
      UPDATE approvals a SET
        urgent_at = NULL,
        escalated_at = CASE WHEN d.timer = 'sla' THEN now() ELSE a.escalated_at END,
        status = CASE WHEN d.timer = 'expire' THEN 'expired' ELSE a.status END,
        version = CASE WHEN d.timer = 'expire' THEN a.version + 1 ELSE a.version END
      FROM due d WHERE a.tenant_id = d.tenant_id AND a.id = d.id
      RETURNING a.tenant_id, a.id, a.conversation_id, d.timer
    ), queued AS (
      INSERT INTO outbox (tenant_id, topic, group_key, payload)
      SELECT m.tenant_id, 'conversation-turns', m.conversation_id::text,
             jsonb_build_object('kind', 'approval_timer', 'tenantId', m.tenant_id,
                                'approvalId', m.id, 'timer', m.timer)
      FROM marked m
    )
    SELECT m.tenant_id, count(*)::int FROM marked m GROUP BY m.tenant_id ORDER BY 1;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION approvals_queue_due() OWNER TO kaki_approvals_timer;--> statement-breakpoint
REVOKE ALL ON FUNCTION approvals_queue_due() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION approvals_queue_due() TO app_outbox;--> statement-breakpoint

-- Auto-close skips waiting_approval too (D6): a pending request ends by decision, staff
-- close or expiry, never silently by the idle timer. Same owner and grants as 0045.
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
      WHERE c.status NOT IN ('closed', 'escalated', 'waiting_approval')
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
