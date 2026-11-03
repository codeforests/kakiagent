-- FEAT-046 §4: substring search on message text (INB-11). Extensions are trusted on RDS PostgreSQL 16.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE INDEX "messages_search_trgm_idx" ON "messages" USING gin ("tenant_id","body" gin_trgm_ops);
