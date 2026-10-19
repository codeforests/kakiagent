# ADR-005: Tenant isolation with Postgres RLS and tenant-filtered vector search

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** GOV-03, AGT-07, AGT-16, DSH-06, NFR-05, NFR-03, AUTH-04

**Context**
GOV-03 requires every tenant-scoped row to be protected by Postgres row-level security in addition to application checks, and vector search always filtered by tenant, verified by automated cross-tenant tests in CI. AGT-07 and AGT-16 require zero leaks of other tenants' data even under prompt injection. One user can belong to several tenants (AUTH-04), and operators reach tenant content only through a time-limited support grant (DSH-06). NFR-03 puts 1 million chunks across 200 tenants (about 5,000 per tenant on average, with a long tail).

**Decision**
- **Shared schema, `tenant_id uuid NOT NULL` on every tenant-scoped table**, part of every primary key and leading every index.
- **RLS enabled and forced** (`ALTER TABLE … FORCE ROW LEVEL SECURITY`) on every tenant-scoped table, with a policy `tenant_id = current_setting('app.tenant_id')::uuid`. The application connects as roles that **do not own the tables and lack `BYPASSRLS`**. Migrations run as a separate owner role that the application never uses.
- **Per-transaction tenant context:** every unit of work runs inside `withTenant(tenantId, fn)`, which opens a transaction and issues `SET LOCAL app.tenant_id`. The tenant ID comes only from the authenticated session (dashboard), the verified channel credential (webhooks) or the signed widget token, never from request bodies or model output. If the setting is missing, `current_setting(..., true)` returns NULL and the policy matches nothing (fail closed).
- **Separate database roles per trust zone:** `app_dashboard`, `app_agent_visitor` (SELECT on the visitor-safe views from ADR-009 only, plus INSERT on its own conversation tables), `app_ingest`, `app_operator` (sees only tenants with an active support grant, enforced by a second RLS policy joined to `support_grants`).
- **Vector search** runs as SQL against `kb_chunks` under the same RLS policy and **also** carries an explicit `WHERE tenant_id = $1 AND status = 'approved'` predicate. Query plan:
  - tenants below a threshold (default 20,000 chunks): exact k-NN over the tenant's rows via the `(tenant_id)` B-tree index, which takes a few milliseconds at this size and has perfect recall;
  - larger tenants: the global HNSW index with pgvector 0.8 iterative index scans (`hnsw.iterative_scan = relaxed_order`) so filtering by tenant does not return too few results.
- **Valkey and S3 keys are tenant-prefixed** (`t/{tenantId}/…`), and S3 access goes through presigned URLs that the API mints only after a tenant-scoped authorization check.
- **CI cross-tenant suite:** for every repository function and API route, a generated test seeds two tenants and asserts that tenant A's context can never read, update or delete tenant B's rows, chunks or files; a lint rule fails the build if a new tenant-scoped table has no RLS policy.

**Options considered**
- **Shared schema + forced RLS (chosen)** — one migration path and one connection pool, works with 200+ tenants, satisfies GOV-03 literally. Con: a forgotten `SET LOCAL` would leak — mitigated by fail-closed policies and the CI suite.
- **Schema per tenant** — strong separation. Lost: 200+ schemas multiply migrations and pgvector indexes, and GOV-03 asks for RLS anyway.
- **Database per tenant** — strongest isolation. Lost: cost and operating effort far beyond MVP scale.
- **Partitioning the chunk table by tenant** — good pruning. Deferred: the threshold-based plan meets NFR-03; revisit if one tenant grows past ~200,000 chunks.

**Consequences**
Isolation is enforced by the database even if application code has a bug, and the agent's database role physically cannot read unreviewed facts or other contacts (supports AGT-16). Connection pooling must be transaction-scoped (no session-level settings leak between requests); we use RDS Proxy or the app pool in transaction mode accordingly. Analytics that span tenants (operator console usage) go through dedicated aggregate views owned by the operator role.
