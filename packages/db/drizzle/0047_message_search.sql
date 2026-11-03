-- FEAT-046 §4: substring search on message text (INB-11). Extensions are trusted on RDS PostgreSQL 16.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE INDEX "messages_search_trgm_idx" ON "messages" USING gin ("tenant_id","body" gin_trgm_ops);
--> statement-breakpoint

-- The search read (FEAT-046 build note B1): under RLS Postgres won't use a non-leakproof
-- operator such as ILIKE as an index condition, so through app_dashboard the trigram index
-- would only narrow by tenant and every search would recheck the tenant's whole history.
-- A NOLOGIN role's SECURITY DEFINER function (the 0045 pattern) reads messages under an
-- always-true policy and filters on app_current_tenant() itself, so both index columns are
-- used. It returns the latest matching message per conversation of the current tenant only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_inbox_search') THEN
    CREATE ROLE kaki_inbox_search NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_inbox_search;--> statement-breakpoint
GRANT SELECT (tenant_id, id, conversation_id, seq, author, body, created_at) ON messages TO kaki_inbox_search;--> statement-breakpoint
CREATE POLICY inbox_search_read ON messages FOR SELECT TO kaki_inbox_search USING (true);--> statement-breakpoint
CREATE FUNCTION inbox_search_hits(patterns text[])
  RETURNS TABLE (tenant_id uuid, conversation_id uuid, message_id uuid, author text, body text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  ROWS 100
  AS $$
    SELECT DISTINCT ON (m.conversation_id) m.tenant_id, m.conversation_id, m.id, m.author, m.body, m.created_at
    FROM messages m
    WHERE m.tenant_id = app_current_tenant() AND m.body ILIKE ANY (patterns)
    ORDER BY m.conversation_id, m.seq DESC
  $$;--> statement-breakpoint
ALTER FUNCTION inbox_search_hits(text[]) OWNER TO kaki_inbox_search;--> statement-breakpoint
REVOKE ALL ON FUNCTION inbox_search_hits(text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION inbox_search_hits(text[]) TO app_dashboard;
