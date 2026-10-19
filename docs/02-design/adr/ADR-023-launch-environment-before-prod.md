# ADR-023: One lean launch environment until the prod trigger

**Status:** Accepted — product owner, 2026-10-19. Supersedes, until the prod trigger below, the environment, AZ, minimum-task, NAT and VPC-endpoint parts of [ADR-003](ADR-003-aws-singapore-ecs-fargate-terraform.md), the canary interval in [ADR-021](ADR-021-observability-and-usage-metering.md), and the WAF Bot Control item in architecture §8.1.
**Date:** 2026-10-19
**Requirements addressed:** NFR-03, NFR-04, NFR-06, NFR-07, NFR-08, NFR-11, NFR-12, GOV-13

**Context**
The owner wants to keep capital cost as low as possible until there are paying customers, and upgrade later. ADR-003's production design (three accounts, 3 AZs, two or more tasks per role, Multi-AZ data stores, a NAT per AZ, interface endpoints) costs about US$1,000–1,500 a month for prod alone. [launch-cost-analysis.md](../../03-planning/launch-cost-analysis.md) costs the alternatives from the AWS price list (2026-10-19). The owner chose the launch environment with cuts C1–C4 from its §6.

**Decision**
Until the prod trigger, KakiAgent runs in **one AWS environment**: the account that will become prod, sized with a **launch profile** (staging-spec). There is no cloud dev environment; development stays local (implementation plan §7).

| Aspect | Launch profile | ADR-003 (restored at the trigger) |
|---|---|---|
| Accounts | AWS Organizations with one workload account (`prod`); the SCP region lock applies as in ADR-003 | dev, staging, prod |
| AZs | 2 (the minimum for ALB and DB subnet groups) | 3 |
| ECS minimum tasks | 1 per role on ARM Fargate; ingest-worker scales to zero. Auto-scaling maximums unchanged. | api, realtime, agent-worker ≥ 2; scheduler 2; ingest 1 warm |
| Database | RDS PostgreSQL, single AZ ([ADR-024](ADR-024-rds-postgres-for-launch.md)) | Aurora, writer + reader |
| Valkey | One `cache.t4g.micro` node | Primary + replica |
| Outbound | **C1:** one NAT instance (`t4g.nano`, a maintained NAT AMI such as fck-nat) in an Auto Scaling group of one, so it replaces itself if it fails | A NAT gateway per AZ |
| VPC endpoints | S3 gateway endpoint only; other AWS APIs go through the NAT | Interface endpoints for SQS, KMS, Secrets Manager, CloudWatch, Bedrock |
| WAF | Managed common rules, IP reputation and rate rules. **C4:** Bot Control deferred; it is added when abuse shows up in WAF logs or the GOV-13 alarms. | Plus Bot Control |
| Synthetic canary | **C3:** one widget conversation every 15 minutes, run by scheduler-worker against the canary tenant, reported as a CloudWatch metric | CloudWatch Synthetics every 5 minutes |

Sizes, minimums and these switches are Terraform variables of the launch profile, so the upgrade is a configuration change plus the ADR-024 database move, not a redesign.

**Prod trigger:** **10 paying tenants** (owner, 2026-10-19), or earlier at the owner's call. At the trigger:
1. Switch the `prod` account to the ADR-003 profile: 3 AZs, minimum tasks, a NAT gateway per AZ, interface endpoints, Valkey replica, Bot Control, 5-minute Synthetics canary.
2. Move the database to Aurora as described in ADR-024, inside a maintenance window (02:00–06:00 SGT, NFR-04).
3. Create the staging account from the same modules and restore the dev → staging → prod promotion path with the eval gate (ADR-022).

Because the launch account is the future prod account, customer data never moves between accounts.

**Options considered**
- **Launch profile in the future prod account (chosen)** — lowest cost, and no cross-account data migration later. Con: until the trigger there is no staging to test releases on before customers see them.
- **Launch in a staging account, build prod later** — matches the "staging first" idea literally. Lost: customer data would have to move to the new prod account at the trigger, with DNS and channel webhooks re-pointed.
- **Full ADR-003 from day one** — best availability and release safety. Lost: about US$1,000+ a month extra before there is revenue.

**Consequences**
- **Cost:** about US$167–191 a month for infrastructure, plus Bedrock usage (about US$16 per 1,000 conversations); see the analysis §4–§6.
- **NFR-04 risk accepted for the launch period:** single tasks, one database instance, one NAT instance and one cache node mean an AZ outage or an instance replacement causes downtime (minutes for a task or the NAT instance, longer for the database; ADR-024). The 99.5% target is unchanged and still measured by the canary; the design no longer guarantees it. No SRS change.
- **Release safety without staging:** the CI pipeline and eval gate (ADR-022) run before every deploy; ECS circuit-breaker rollback; ad hoc preview stacks from the same modules when a risky change needs a cloud test.
- **NFR-06, NFR-15:** the NAT instance is a server to patch. It uses a maintained AMI, is rebuilt from the latest image on a schedule, and is in the asset inventory.
- **NFR-03:** the ceilings are unchanged, so load still scales out; it starts from one task, so scale-out takes longer. The M6 load test runs against this environment.
- **GOV-13:** the per-visitor and per-tenant limits in Valkey and the WAF rate rules stay; only Bot Control waits.
