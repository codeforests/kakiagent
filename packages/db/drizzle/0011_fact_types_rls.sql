-- FEAT-011: deletion grants and the visitor view for the new fact types (ADR-005,
-- ADR-010 decision 2; FEAT-011 §4). Hand-written; drizzle-kit owns the DDL in 0010.

-- Dashboard: deletes a fact with its chunk and versions in one transaction (D1).
-- fact_versions stays without UPDATE for every role.
GRANT DELETE ON facts, fact_versions, kb_chunks TO app_dashboard;--> statement-breakpoint

-- The only facts a visitor turn can read: approved, started, unexpired, and no price
-- with an unknown GST treatment at a GST-registered tenant (KB-15), whatever its type.
-- Validity columns are appended so the renderer can state an end date. CREATE OR
-- REPLACE keeps the owner (kaki_visitor_views) and the visitor_chunks view on top.
CREATE OR REPLACE VIEW visitor_facts WITH (security_barrier = true) AS
  SELECT f.tenant_id, f.id, f.type, f.version, f.value, f.gst_treatment, f.valid_from, f.valid_until
  FROM facts f
  WHERE f.tenant_id = app_current_tenant()
    AND f.status = 'approved'
    AND (f.valid_from IS NULL OR f.valid_from <= now())
    AND (f.valid_until IS NULL OR f.valid_until > now())
    AND NOT (
      f.gst_treatment IS NOT NULL AND f.gst_treatment = 'unknown'
      AND coalesce((SELECT bp.gst_registered FROM business_profiles bp WHERE bp.tenant_id = f.tenant_id), true)
    );--> statement-breakpoint
ALTER VIEW visitor_facts OWNER TO kaki_visitor_views;
