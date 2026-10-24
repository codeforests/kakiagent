ALTER TABLE "coaching_sessions" DROP CONSTRAINT "coaching_sessions_origin_ck";--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD COLUMN "replay_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD COLUMN "correction_id" uuid;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD COLUMN "replay_question_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD COLUMN "replay_matched" integer;--> statement-breakpoint
ALTER TABLE "corrections" ADD COLUMN "accepted_change" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "fact_review_months" jsonb DEFAULT '{"product":6,"faq":6,"policy":6,"promotion":6}'::jsonb NOT NULL;--> statement-breakpoint
-- FEAT-018 D9, hand-written: FEAT-028's replayed answers take their session's conversation
-- before the check below requires it.
UPDATE coaching_messages m SET replay_conversation_id = s.replay_conversation_id
  FROM coaching_sessions s
  WHERE m.kind = 'replay' AND s.tenant_id = m.tenant_id AND s.id = m.session_id;--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_tenant_id_replay_conversation_id_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","replay_conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_tenant_id_correction_id_corrections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","correction_id") REFERENCES "public"."corrections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coaching_sessions_correction_uq" ON "coaching_sessions" USING btree ("tenant_id","correction_id");--> statement-breakpoint
CREATE INDEX "corrections_tenant_status_decided_idx" ON "corrections" USING btree ("tenant_id","status","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "corrections_open_stale_uq" ON "corrections" USING btree ("tenant_id",("fact_refs"[1])) WHERE "corrections"."source_type" = 'stale' and "corrections"."status" = 'open';--> statement-breakpoint
CREATE INDEX "messages_fact_ids_gin" ON "messages" USING gin ("fact_ids");--> statement-breakpoint
ALTER TABLE "coaching_messages" ADD CONSTRAINT "coaching_messages_replay_conversation_ck" CHECK (("coaching_messages"."kind" = 'replay') = ("coaching_messages"."replay_conversation_id" is not null));--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_correction_ck" CHECK (("coaching_sessions"."origin" = 'correction') = ("coaching_sessions"."correction_id" is not null));--> statement-breakpoint
ALTER TABLE "coaching_sessions" ADD CONSTRAINT "coaching_sessions_origin_ck" CHECK ("coaching_sessions"."origin" in ('coach', 'setup', 'panel', 'replay', 'correction'));--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_accepted_change_ck" CHECK (("corrections"."status" = 'edited_and_accepted') = ("corrections"."accepted_change" is not null));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_fact_review_months_ck" CHECK (jsonb_typeof("tenants"."fact_review_months" -> 'product') = 'number' and ("tenants"."fact_review_months" -> 'product')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof("tenants"."fact_review_months" -> 'faq') = 'number' and ("tenants"."fact_review_months" -> 'faq')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof("tenants"."fact_review_months" -> 'policy') = 'number' and ("tenants"."fact_review_months" -> 'policy')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24) and jsonb_typeof("tenants"."fact_review_months" -> 'promotion') = 'number' and ("tenants"."fact_review_months" -> 'promotion')::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24));--> statement-breakpoint

-- FEAT-018 §4, hand-written. The dashboard records an edited fix and the review intervals.
GRANT UPDATE (accepted_change) ON corrections TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (fact_review_months) ON tenants TO app_dashboard;--> statement-breakpoint

-- The stale-fact scan (KB-17, D1; pattern of the cost governor, 0009): scheduler-worker's
-- outbox zone runs it daily across tenants. Its NOLOGIN owner reads facts and the review
-- intervals and writes stale items; the outbox zone can only execute the function.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_stale_scan') THEN
    CREATE ROLE kaki_stale_scan NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_stale_scan;--> statement-breakpoint
GRANT SELECT (tenant_id, id, type, status, value, version, valid_until, last_confirmed_at) ON facts TO kaki_stale_scan;--> statement-breakpoint
CREATE POLICY stale_scan ON facts FOR SELECT TO kaki_stale_scan USING (true);--> statement-breakpoint
GRANT SELECT (id, fact_review_months) ON tenants TO kaki_stale_scan;--> statement-breakpoint
CREATE POLICY stale_scan ON tenants FOR SELECT TO kaki_stale_scan USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, decided_at, updated_at) ON corrections TO kaki_stale_scan;--> statement-breakpoint
CREATE POLICY stale_scan ON corrections FOR ALL TO kaki_stale_scan USING (true) WITH CHECK (true);--> statement-breakpoint
-- First closes open stale items whose fact is no longer an overdue approved fact at the
-- flagged version (re-confirmed, edited, disabled or deleted; D8), then flags each approved
-- fact not confirmed within its type's interval, except an expired promotion. One open item
-- per fact (corrections_open_stale_uq). Returns one row per tenant with a change.
CREATE FUNCTION kb_stale_scan()
  RETURNS TABLE (tenant_id uuid, flagged integer, closed integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    v_closed jsonb;
    v_flagged jsonb;
  BEGIN
    WITH overdue AS (
      SELECT f.tenant_id, f.id, f.type, f.value, f.version, f.last_confirmed_at
      FROM facts f JOIN tenants t ON t.id = f.tenant_id
      WHERE f.status = 'approved'
        AND f.last_confirmed_at < now() - make_interval(months => (t.fact_review_months ->> f.type)::int)
        AND (f.type <> 'promotion' OR f.valid_until > now())
    ), closed AS (
      UPDATE corrections c SET status = 'dismissed', decided_at = now(), updated_at = now()
      WHERE c.source_type = 'stale' AND c.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM overdue o
          WHERE o.tenant_id = c.tenant_id AND o.id = c.fact_refs[1]
            AND o.version = (c.proposed_change ->> 'factVersion')::int
        )
      RETURNING c.tenant_id
    )
    SELECT coalesce(jsonb_object_agg(n.tenant_id, n.count), '{}') INTO v_closed
      FROM (SELECT c.tenant_id, count(*) FROM closed c GROUP BY c.tenant_id) n;

    WITH overdue AS (
      SELECT f.tenant_id, f.id, f.type, f.value, f.version, f.last_confirmed_at
      FROM facts f JOIN tenants t ON t.id = f.tenant_id
      WHERE f.status = 'approved'
        AND f.last_confirmed_at < now() - make_interval(months => (t.fact_review_months ->> f.type)::int)
        AND (f.type <> 'promotion' OR f.valid_until > now())
    ), flagged AS (
      INSERT INTO corrections (tenant_id, source_type, proposed_by, fact_refs, proposed_change)
      SELECT o.tenant_id, 'stale', 'system', ARRAY[o.id],
             jsonb_build_object(
               'kind', 'reconfirm', 'factId', o.id, 'factVersion', o.version, 'factType', o.type,
               'label', CASE o.type WHEN 'product' THEN o.value ->> 'name'
                                    WHEN 'faq' THEN o.value ->> 'question'
                                    ELSE o.value ->> 'title' END,
               'lastConfirmedAt', to_char(o.last_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM overdue o
      ON CONFLICT (tenant_id, (fact_refs[1])) WHERE source_type = 'stale' AND status = 'open' DO NOTHING
      RETURNING corrections.tenant_id
    )
    SELECT coalesce(jsonb_object_agg(n.tenant_id, n.count), '{}') INTO v_flagged
      FROM (SELECT f.tenant_id, count(*) FROM flagged f GROUP BY f.tenant_id) n;

    RETURN QUERY
      SELECT k.id::uuid, coalesce((v_flagged ->> k.id)::int, 0), coalesce((v_closed ->> k.id)::int, 0)
      FROM (SELECT jsonb_object_keys(v_flagged || v_closed) AS id) k ORDER BY 1;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION kb_stale_scan() OWNER TO kaki_stale_scan;--> statement-breakpoint
REVOKE ALL ON FUNCTION kb_stale_scan() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kb_stale_scan() TO app_outbox;
