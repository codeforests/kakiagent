-- FEAT-014: conflict detection at promote (KB-06; FEAT-014 §4, D8). Hand-written, no DDL.
-- When a source's finding disagrees with a fact the tenant already has, promote moves that
-- fact to `conflicted` (ADR-010 "approved → conflicted: new source disagrees"), so the
-- ingest trust zone may change a fact's status and version and its chunk's version. It
-- still can't change a fact's value, GST treatment or provenance, or delete facts.
GRANT UPDATE (status, version, updated_by, updated_at) ON facts TO app_ingest;--> statement-breakpoint
GRANT UPDATE (fact_version) ON kb_chunks TO app_ingest;
