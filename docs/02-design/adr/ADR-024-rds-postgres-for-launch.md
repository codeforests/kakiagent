# ADR-024: RDS PostgreSQL instead of Aurora until the prod trigger

**Status:** Accepted — product owner, 2026-10-19. Supersedes, until the [ADR-023](ADR-023-launch-environment-before-prod.md) prod trigger, the database engine and topology in [ADR-004](ADR-004-aurora-postgres-pgvector-system-of-record.md) (Aurora PostgreSQL, Multi-AZ, Serverless v2). Everything else in ADR-004 stands.
**Date:** 2026-10-19
**Requirements addressed:** NFR-03, NFR-04, NFR-08, GOV-03, GOV-05, INB-11

**Context**
Aurora Serverless v2 has a floor of 0.5 ACU (about 1 GiB of memory) per instance at US$0.20 per ACU-hour, so a single writer costs at least US$73 a month, and about US$110–118 with light load and storage. ADR-004 already named RDS PostgreSQL as the cheaper option at steady load. Cut C2 in [launch-cost-analysis.md](../../03-planning/launch-cost-analysis.md) prices RDS `db.t4g.small` with 20 GB of gp3 at about US$40 a month, with twice the memory of Aurora's floor.

**Decision**
During the launch period the system of record is **Amazon RDS for PostgreSQL**, single AZ, in ap-southeast-1:
- **Instance:** `db.t4g.small` (2 vCPU burstable, 2 GiB). Upsize to `db.t4g.medium` if CPU credits run low, memory pressure appears, or vector p95 exceeds 150 ms (ADR-004).
- **Storage:** 20 GB gp3, storage autoscaling on, KMS encryption.
- **Same engine features as ADR-004:** PostgreSQL 16, pgvector (HNSW), full-text search and `pg_trgm`, forced RLS and the role model of ADR-005, Drizzle migrations. Nothing in the application depends on Aurora-only features, and none may be introduced before the move.
- **Backups (NFR-08):** automated backups with 35-day retention and point-in-time restore (RPO about 5 minutes), in-region only; the restore drill and the deletion-journal replay of ADR-015 apply unchanged.
- **Maintenance window:** inside 02:00–06:00 SGT (NFR-04).

Where other ADRs and architecture.md say "Aurora" (for example ADR-014, ADR-015, ADR-019), read "the PostgreSQL system of record" during the launch period.

**Move to Aurora at the trigger:** create an Aurora PostgreSQL read replica of the RDS instance, let it catch up, then promote it in a maintenance window. Writes pause only for the cut-over. Then add the Aurora reader and switch to Serverless v2 or provisioned capacity, per ADR-004 and risk R12.

**Options considered**
- **RDS PostgreSQL `db.t4g.small` (chosen)** — cheapest store that runs the whole ADR-004 design. Con: no automatic scaling; a resize is a short restart.
- **Aurora Serverless v2 writer only, 0.5 ACU floor** — no engine change at the trigger. Lost: about US$35–78 a month more, with less memory at the floor.
- **Aurora Serverless v2 with auto-pause (0 ACU)** — near zero when idle. Lost: resuming takes seconds, which breaks the reply latency target (NFR-01) for the first visitor after a pause.

**Consequences**
- **NFR-04:** single-AZ RDS has no standby. A host failure means RDS replaces the instance (typically minutes, sometimes longer), and an AZ outage means a point-in-time restore into the other AZ, within the NFR-08 RTO of 4 hours. Accepted for the launch period (ADR-023).
- **NFR-03:** fine for early tenants. At 1 million chunks of 1,024 dimensions the vectors alone are about 4 GB, which needs a larger instance or Aurora. The trigger, the upsizing rules above and the M6 load test catch this before it bites.
- **Burstable CPU:** watch CPU credit balance; an alarm is added with the other database alarms (ADR-021).
- **One more migration later:** the RDS → Aurora move is planned work at the trigger, not an emergency.
