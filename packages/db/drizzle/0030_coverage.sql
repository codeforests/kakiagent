ALTER TABLE "business_profiles" ADD COLUMN "coverage_skipped_topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gap_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gap_embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gap_correction_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_gap_correction_id_corrections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","gap_correction_id") REFERENCES "public"."corrections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_gap_backlog_idx" ON "messages" USING btree ("tenant_id","created_at") WHERE "messages"."gap_reason" is not null and "messages"."gap_correction_id" is null;--> statement-breakpoint
CREATE INDEX "messages_gap_correction_idx" ON "messages" USING btree ("tenant_id","gap_correction_id","created_at" DESC NULLS LAST) WHERE "messages"."gap_correction_id" is not null;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_coverage_skipped_ck" CHECK (cardinality("business_profiles"."coverage_skipped_topics") <= 100);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_gap_ck" CHECK (("messages"."gap_reason" is null) = ("messages"."gap_embedding" is null) and ("messages"."gap_correction_id" is null or "messages"."gap_reason" is not null) and ("messages"."gap_reason" is null or "messages"."gap_reason" in ('unavailable', 'unsure', 'escalated')));--> statement-breakpoint

-- FEAT-019 §4, hand-written. The turn marks its own visitor question as a gap (D2); the
-- dashboard keeps the owner's "Doesn't apply" topics (D8).
GRANT UPDATE (gap_reason, gap_embedding) ON messages TO app_agent_visitor;--> statement-breakpoint
GRANT UPDATE (coverage_skipped_topics) ON business_profiles TO app_dashboard;--> statement-breakpoint

-- Gap grouping (KB-09, KB-18; pattern of the stale scan, 0029): scheduler-worker's outbox
-- zone runs it every 10 minutes across tenants. Its NOLOGIN owner reads gap messages, files
-- them under coverage_gap items and closes items left with no message; the outbox zone can
-- only execute the function.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_gap_cluster') THEN
    CREATE ROLE kaki_gap_cluster NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_gap_cluster;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, created_at, gap_reason, gap_embedding, gap_correction_id), UPDATE (gap_correction_id) ON messages TO kaki_gap_cluster;--> statement-breakpoint
CREATE POLICY gap_cluster ON messages FOR ALL TO kaki_gap_cluster USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, decided_at, updated_at) ON corrections TO kaki_gap_cluster;--> statement-breakpoint
CREATE POLICY gap_cluster ON corrections FOR ALL TO kaki_gap_cluster USING (true) WITH CHECK (true);--> statement-breakpoint
-- First closes open coverage_gap items with no member message left (erased; FEAT-018 D8),
-- then takes up to 500 ungrouped gap messages, oldest first, one at a time: each joins the
-- open item of its nearest gap message from the last 60 days if that is within cosine
-- distance 0.25 (D5), else opens a new item. One at a time, so a burst of similar questions
-- forms one item. Returns one row per tenant with a change.
CREATE FUNCTION kb_gap_cluster()
  RETURNS TABLE (tenant_id uuid, grouped integer, opened integer, closed integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    join_distance CONSTANT double precision := 0.25;
    join_window CONSTANT interval := interval '60 days';
    r record;
    v_item uuid;
    v_distance double precision;
    v_grouped jsonb := '{}';
    v_opened jsonb := '{}';
    v_closed jsonb := '{}';
  BEGIN
    FOR r IN
      UPDATE corrections c SET status = 'dismissed', decided_at = now(), updated_at = now()
      WHERE c.source_type = 'coverage_gap' AND c.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.gap_correction_id = c.id
        )
      RETURNING c.tenant_id
    LOOP
      v_closed := jsonb_set(v_closed, ARRAY[r.tenant_id::text],
        to_jsonb(coalesce((v_closed ->> r.tenant_id::text)::int, 0) + 1));
    END LOOP;

    FOR r IN
      SELECT m.tenant_id, m.id, m.conversation_id, m.gap_embedding
      FROM messages m
      WHERE m.gap_reason IS NOT NULL AND m.gap_correction_id IS NULL
      ORDER BY m.created_at, m.id
      LIMIT 500
    LOOP
      SELECT g.gap_correction_id, g.gap_embedding <=> r.gap_embedding INTO v_item, v_distance
        FROM messages g
        JOIN corrections c ON c.tenant_id = g.tenant_id AND c.id = g.gap_correction_id
        WHERE g.tenant_id = r.tenant_id AND g.gap_correction_id IS NOT NULL
          AND g.created_at > now() - join_window
          AND c.source_type = 'coverage_gap' AND c.status = 'open'
        ORDER BY g.gap_embedding <=> r.gap_embedding
        LIMIT 1;
      IF v_item IS NULL OR v_distance > join_distance THEN
        INSERT INTO corrections (tenant_id, source_type, proposed_by, conversation_ref, proposed_change)
          VALUES (r.tenant_id, 'coverage_gap', 'system', r.conversation_id, '{"kind":"answer_gap"}')
          RETURNING corrections.id INTO v_item;
        v_opened := jsonb_set(v_opened, ARRAY[r.tenant_id::text],
          to_jsonb(coalesce((v_opened ->> r.tenant_id::text)::int, 0) + 1));
      END IF;
      UPDATE messages SET gap_correction_id = v_item WHERE messages.tenant_id = r.tenant_id AND messages.id = r.id;
      v_grouped := jsonb_set(v_grouped, ARRAY[r.tenant_id::text],
        to_jsonb(coalesce((v_grouped ->> r.tenant_id::text)::int, 0) + 1));
    END LOOP;

    RETURN QUERY
      SELECT k.id::uuid, coalesce((v_grouped ->> k.id)::int, 0),
             coalesce((v_opened ->> k.id)::int, 0), coalesce((v_closed ->> k.id)::int, 0)
      FROM (SELECT jsonb_object_keys(v_grouped || v_opened || v_closed) AS id) k ORDER BY 1;
  END
  $$;--> statement-breakpoint
ALTER FUNCTION kb_gap_cluster() OWNER TO kaki_gap_cluster;--> statement-breakpoint
REVOKE ALL ON FUNCTION kb_gap_cluster() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kb_gap_cluster() TO app_outbox;
