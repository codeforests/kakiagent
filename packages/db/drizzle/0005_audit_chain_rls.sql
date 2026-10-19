-- FEAT-002: the per-tenant audit hash chain (ADR-014). Hand-written; drizzle-kit owns
-- the DDL in 0004. The functions are owned by NOLOGIN roles that are neither superusers
-- nor table owners, so the forced tenant policies apply when they run (as in 0003).

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_entries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_entries USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE audit_heads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_heads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_heads USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE audit_pii ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_pii FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_pii USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_audit_chain') THEN
    CREATE ROLE kaki_audit_chain NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaki_audit_anchor') THEN
    CREATE ROLE kaki_audit_anchor NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kaki_audit_chain, kaki_audit_anchor;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON audit_heads TO kaki_audit_chain;--> statement-breakpoint

-- Takes the current tenant's head under a row lock, creating the genesis head (seq 0,
-- 64 zeros) on first use, and returns the entry time. The lock serialises appends per
-- tenant until the caller's transaction ends (ADR-014 decision 4). No tenant context
-- fails closed.
CREATE FUNCTION audit_head_lock()
  RETURNS TABLE (seq bigint, hash text, ts timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    t uuid := app_current_tenant();
  BEGIN
    IF t IS NULL THEN
      RAISE EXCEPTION 'audit: no tenant context' USING ERRCODE = '42501';
    END IF;
    INSERT INTO audit_heads (tenant_id, seq, hash) VALUES (t, 0, repeat('0', 64))
      ON CONFLICT (tenant_id) DO NOTHING;
    RETURN QUERY
      SELECT h.seq, h.hash, date_trunc('milliseconds', clock_timestamp())
      FROM audit_heads h WHERE h.tenant_id = t FOR UPDATE;
  END $$;--> statement-breakpoint
ALTER FUNCTION audit_head_lock() OWNER TO kaki_audit_chain;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_head_lock() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_head_lock() TO app_dashboard, app_agent_visitor;--> statement-breakpoint

-- Every entry must extend its tenant's chain by exactly one: seq = head + 1 and
-- prev_hash = head hash. Then the head moves to the new entry. The hash value itself is
-- computed by the application (RFC 8785, design D2) and checked by verification.
CREATE FUNCTION audit_entries_link() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    h record;
  BEGIN
    SELECT a.seq, a.hash INTO h FROM audit_heads a WHERE a.tenant_id = NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'audit: no chain head for this tenant; append through audit_head_lock()'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.seq <> h.seq + 1 OR NEW.prev_hash <> h.hash THEN
      RAISE EXCEPTION 'audit: entry % does not extend the chain at %', NEW.seq, h.seq
        USING ERRCODE = '23514';
    END IF;
    UPDATE audit_heads SET seq = NEW.seq, hash = NEW.hash, updated_at = now()
      WHERE tenant_id = NEW.tenant_id;
    RETURN NEW;
  END $$;--> statement-breakpoint
ALTER FUNCTION audit_entries_link() OWNER TO kaki_audit_chain;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_entries_link() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER audit_entries_link BEFORE INSERT ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_entries_link();--> statement-breakpoint

-- Append-only for every role, the owner included (ADR-014 decision 4). The retention
-- purge (FEAT-059) will need a narrow, audited exception.
CREATE FUNCTION audit_entries_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    RAISE EXCEPTION 'audit: entries are append-only (%)', TG_OP USING ERRCODE = '42501';
  END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_entries_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER audit_entries_immutable BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_entries_immutable();--> statement-breakpoint
CREATE TRIGGER audit_entries_no_truncate BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_immutable();--> statement-breakpoint

-- Anchoring (ADR-014 decision 5): the scheduler's zone reads heads that moved since
-- their last anchor, across tenants, and records what it anchored. Heads carry a count
-- and a hash, no content; the outbox zone gets nothing else.
GRANT SELECT (tenant_id, seq, hash, anchored_seq), UPDATE (anchored_seq) ON audit_heads TO kaki_audit_anchor;--> statement-breakpoint
CREATE POLICY audit_anchor ON audit_heads FOR ALL TO kaki_audit_anchor USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION audit_heads_to_anchor()
  RETURNS TABLE (tenant_id uuid, seq bigint, hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT h.tenant_id, h.seq, h.hash FROM audit_heads h WHERE h.seq > h.anchored_seq ORDER BY h.tenant_id $$;--> statement-breakpoint
ALTER FUNCTION audit_heads_to_anchor() OWNER TO kaki_audit_anchor;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_heads_to_anchor() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_heads_to_anchor() TO app_outbox;--> statement-breakpoint
CREATE FUNCTION audit_mark_anchored(p_tenant uuid, p_seq bigint) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ UPDATE audit_heads SET anchored_seq = greatest(anchored_seq, p_seq) WHERE tenant_id = p_tenant $$;--> statement-breakpoint
ALTER FUNCTION audit_mark_anchored(uuid, bigint) OWNER TO kaki_audit_anchor;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_mark_anchored(uuid, bigint) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_mark_anchored(uuid, bigint) TO app_outbox;--> statement-breakpoint

-- Writers per trust zone. The dashboard reads entries (viewer, verification) and
-- deletes PII rows (erasure); the visitor zone only appends. No role touches
-- audit_heads directly.
GRANT SELECT, INSERT ON audit_entries TO app_dashboard;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON audit_pii TO app_dashboard;--> statement-breakpoint
GRANT INSERT ON audit_entries, audit_pii TO app_agent_visitor;
