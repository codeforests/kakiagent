-- FEAT-017: retrying a chat export keeps its redacted parts (FEAT-017 §5.6, D5). Hand-written,
-- no DDL. The export is deleted after the parse, so Retry moves the stored parts to the new
-- attempt and marks them unread; the dashboard trust zone may change only those columns.
GRANT UPDATE (attempt, extracted_at, facts_count) ON kb_source_pages TO app_dashboard;
