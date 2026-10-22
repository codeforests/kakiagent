-- FEAT-012: knowledge sources, their pages and staged facts (KB-01, KB-05, KB-12, KB-13;
-- FEAT-012 §4). Hand-written; drizzle-kit owns the DDL in 0020. The ingest worker gets its
-- own trust zone, app_ingest (ADR-005), created by `pnpm db:setup` with the other login
-- roles: it reads and writes sources, pages and staging, inserts extracted facts as
-- needs_review, and can't read conversations, contacts or identity tables, or delete facts.
-- The visitor role is unchanged: visitor_facts already admits approved facts only.
ALTER TABLE kb_sources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE kb_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON kb_sources USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE kb_source_pages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE kb_source_pages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON kb_source_pages USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE kb_staged_facts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE kb_staged_facts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON kb_staged_facts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- Dashboard: adds, lists, retries and deletes sources (with their pages, staging and
-- facts), and adds confirmed domains to the widget's allowed origins (KB-13 → CHN-11).
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_sources TO app_dashboard;--> statement-breakpoint
GRANT SELECT, DELETE ON kb_source_pages, kb_staged_facts TO app_dashboard;--> statement-breakpoint
GRANT UPDATE (allowed_origins) ON tenants TO app_dashboard;--> statement-breakpoint

-- Ingest: the crawl, extract and promote stages (ADR-018).
GRANT USAGE ON SCHEMA public TO app_ingest;--> statement-breakpoint
GRANT SELECT, UPDATE ON kb_sources TO app_ingest;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kb_source_pages, kb_staged_facts TO app_ingest;--> statement-breakpoint
GRANT SELECT, INSERT ON facts, fact_versions, kb_chunks TO app_ingest;--> statement-breakpoint
GRANT INSERT ON outbox, usage_events, audit_entries TO app_ingest;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_head_lock() TO app_ingest;
