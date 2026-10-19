# ADR-004: Aurora PostgreSQL with pgvector as the single system of record

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** GOV-03, NFR-03, NFR-04, NFR-05, NFR-08, INB-11, KB-07, KB-14, AGT-17, GOV-05, AUTH-07

**Context**
The system needs relational data (tenants, members, conversations, leads, approvals, facts with versions), vector search over up to 1 million chunks (NFR-03), full-text conversation search over 12 months of data in ≤ 2 s (INB-11), and tenant isolation through Postgres row-level security (GOV-03 names Postgres explicitly). KB edits must reach answers within 60 seconds (KB-07, AGT-17), and PDPA deletion must remove a contact's data from every store, including vectors (GOV-05). Backups need 7-day PITR, 35-day daily retention, RPO ≤ 15 min and RTO ≤ 4 h (NFR-08).

**Decision**
We will use **Amazon Aurora PostgreSQL** (Multi-AZ, one writer and one reader; Serverless v2 capacity so the pilot pays for little) as the only durable store of structured data, with:
- **pgvector** for KB chunk embeddings in the same database (HNSW index; see ADR-005 for tenant-filtered search);
- **Postgres full-text search plus `pg_trgm`** trigram indexes for conversation search, so Chinese text, which `tsvector` does not segment, is still searchable by substring;
- **Aurora automated backups** with 35-day retention (covers both 7-day PITR and 35-day daily restore points), and a restore drill before pilot go-live and each quarter (NFR-08);
- **S3** (SSE-KMS, versioning, ap-southeast-1) for files: uploads, attachments, exports;
- **ElastiCache (Valkey)** only for ephemeral data: rate-limit counters (GOV-13), the kill-switch flag cache (GOV-08), pub/sub fan-out (ADR-017) and the hot tenant-config cache. Nothing in Valkey is the only copy of anything.

**Options considered**
- **Aurora PostgreSQL + pgvector (chosen)** — one transactional store, so facts, their chunks and their audit entries change atomically; RLS covers vectors too; deletion is one transaction. Con: vector search competes with OLTP for the same cluster, mitigated by sending vector reads to the reader instance.
- **Postgres + a dedicated vector database (OpenSearch, Pinecone)** — better at large-scale ANN. Lost: a second store to keep consistent and to delete from (GOV-05), tenant isolation outside RLS (GOV-03), and, for SaaS vector databases, another sub-processor and possibly data outside Singapore.
- **RDS PostgreSQL (non-Aurora)** — cheaper at steady load. Lost narrowly: Aurora's faster failover and storage-level durability help NFR-04 and NFR-08; revisit if Serverless v2 costs exceed a provisioned instance once load is known.

**Consequences**
One backup, one encryption key hierarchy (KMS), one place to enforce isolation and deletion. The 60-second freshness target is met by writing a fact and its chunks in one transaction and invalidating the tenant cache via pub/sub. Backups keep deleted data until they age out (35 days), which GOV-05 and AUTH-07 explicitly allow. Revisit vector storage if chunks grow well past NFR-03's 1 million, or if p95 retrieval exceeds 150 ms.
