# Launch Cost Analysis: one staging-spec environment before prod

> Status: **Decided by the product owner, 2026-10-19:** launch environment with cuts C1–C4 (C5 not adopted), prod trigger at 10 paying tenants. Recorded in [ADR-023](../02-design/adr/ADR-023-launch-environment-before-prod.md) and [ADR-024](../02-design/adr/ADR-024-rds-postgres-for-launch.md). · Prices retrieved 2026-10-19
> Inputs: [architecture.md](../02-design/architecture.md) §7, §8.5, §11 · [ADR-003](../02-design/adr/ADR-003-aws-singapore-ecs-fargate-terraform.md) · [ADR-004](../02-design/adr/ADR-004-aurora-postgres-pgvector-system-of-record.md) · [ADR-007](../02-design/adr/ADR-007-model-routing-prompt-caching-and-cost.md) · [ADR-021](../02-design/adr/ADR-021-observability-and-usage-metering.md) · [implementation-plan.md](implementation-plan.md) (MD Deploy, M6)
> This document is the cost evidence for those ADRs. Its numbers are estimates; the usage ledger and the AWS bill replace them once the environment runs.

## 1. Summary

The owner wants to keep capital cost as low as possible until there are customers. The idea: drop the dev environment, run customers on a single **staging-spec** environment, and build prod only once there is revenue.

| Option | US$ / month | S$ / month (at 1.35) |
|---|---|---|
| Production design as signed off (ADR-003 estimate; staging about ⅓ extra, dev extra) | 1,000–1,500 | 1,350–2,025 |
| **Launch environment, every ADR component kept, one of each** (§4) | **272–340** | **367–458** |
| Launch environment with all the cost cuts in §6 (needs ADR changes) | about 170–190 | about 230–260 |

On top of these comes Bedrock usage, which scales with customers: about **US$16 per 1,000 conversations** (§5).

Other findings:
- **Risk R1 is resolved.** Bedrock `au.` regional prices are now in the AWS price list and equal list price × 1.10, exactly as ADR-007 assumed. ADR-007's per-conversation estimates stand.
- **The 5-minute synthetic canary (ADR-021) is a noticeable fixed cost** at this scale: about US$15 a month for CloudWatch Synthetics plus about US$9 of Bedrock calls.
- **The ADR-003 production design has VPC interface endpoints in 3 AZs**, which cost about US$160–230 a month on their own. The launch environment drops them and relies on the free S3 gateway endpoint plus the NAT.

## 2. Scope

**Included:** the AWS run cost of one customer-facing environment in ap-southeast-1, plus Bedrock usage.

**Not included, because they belong to tasks that haven't started** (implementation plan MD and M6): AI evaluation runs in CI (about US$10–20 per full run, ADR-022), the k6 load test, the penetration test, and the legal review. They're listed so they aren't forgotten, not costed here. Also excluded: domain registration, GitHub, and staff time.

## 3. Launch environment vs the signed-off design

| Aspect | ADR-003 / architecture §7 | Launch environment |
|---|---|---|
| Environments | dev, staging, prod, each in its own AWS account | **One** account and environment, built to staging spec, serving the first customers. Development stays local (Docker Compose, plan §7). Prod is built later from the same Terraform. |
| Availability Zones | 3 | **2** (the least AWS allows: ALB and Aurora subnet groups need two) |
| ECS minimum tasks | api ×2, realtime ×2, agent-worker ×2, ingest ×1 warm, scheduler ×2 | **One of each**, auto-scaling still on with the same maximums. ingest-worker scales to zero when idle. |
| CPU architecture | not specified | ARM (Graviton) Fargate, 20% cheaper |
| Aurora | Writer + reader, Multi-AZ, 0.5–16 ACU | **Writer only**, 0.5–16 ACU. Storage is still replicated across AZs by Aurora; backups unchanged (35 days, PITR). |
| Valkey | Primary + replica | **One node** (`cache.t4g.micro`) |
| NAT | One per AZ (3) | **One** NAT gateway |
| VPC endpoints | S3 + interface endpoints for SQS, KMS, Secrets Manager, CloudWatch, Bedrock | **S3 gateway endpoint only** (free); everything else goes through the NAT |
| Edge | CloudFront + WAF (managed rules, rate rules, Bot Control) | Same |
| Everything else | SES, GuardDuty malware scanning, KMS, Secrets Manager, CloudWatch, X-Ray, Config | Same |

Fargate task sizes (my estimates; the architecture doesn't fix them): api 0.5 vCPU / 1 GB, realtime 0.25 / 0.5, agent-worker 0.5 / 1, scheduler 0.25 / 0.5, ingest-worker 2 / 4 (headless Chromium and Tesseract).

## 4. Monthly cost breakdown (US$)

"Quiet" is the floor with a handful of tenants; "typical" assumes light real use. Usage figures are assumptions, listed in each row.

| Area | Item | Quiet | Typical |
|---|---|---|---|
| Compute | Fargate ARM, always on: 1.5 vCPU, 3 GB in total | 53.97 | 53.97 |
| | ingest-worker 2 vCPU / 4 GB, 10 h / 40 h a month | 0.99 | 3.94 |
| Database | Aurora Serverless v2 writer, 0.5 ACU floor / 0.75 average | 73.00 | 109.50 |
| | Aurora storage 5 / 15 GB and I/O 5M / 30M requests | 1.65 | 8.25 |
| Cache | Valkey `cache.t4g.micro`, one node | 14.02 | 14.02 |
| Network | NAT gateway ×1, 5 / 30 GB processed | 43.37 | 44.84 |
| | Public IPv4 ×3 (NAT 1, ALB 2) | 10.95 | 10.95 |
| | ALB, 0.2 / 1 LCU average | 19.56 | 24.24 |
| | CloudFront (inside the always-free tier: 1 TB, 10M requests) | 0 | 0 |
| Edge security | WAF web ACL, 4 rules, 0.5M / 2M requests | 9.30 | 10.20 |
| | WAF Bot Control, 0.5M / 2M requests | 10.50 | 12.00 |
| Security | Secrets Manager ×6 | 2.40 | 2.40 |
| | KMS customer keys ×3 and requests | 3.10 | 3.30 |
| | GuardDuty Malware Protection for S3 (first 1,000 PUTs and 1 GB free) | 0 | 1.00 |
| Monitoring | CloudWatch logs 5 / 15 GB, 20 custom metrics, 15 alarms | 11.15 | 18.45 |
| | Synthetics canary every 5 minutes (8,640 runs, ADR-021) | 14.69 | 14.69 |
| | X-Ray, sampled (inside 100k free traces) | 0 | 0 |
| Messaging | SQS (mostly inside 1M free requests) | 0 | 1.00 |
| | SES, about 1k / 5k emails | 0.20 | 1.00 |
| Storage | S3 5 / 20 GB and requests | 0.42 | 1.50 |
| | ECR images, 3 GB | 0.30 | 0.30 |
| Other | Route 53 hosted zone and queries | 0.90 | 0.90 |
| | AWS Config recorder (estimate, not from the price list) | 1.50 | 3.00 |
| | Terraform state (S3 and DynamoDB lock) | 0.10 | 0.10 |
| **Total** | | **272.07** | **339.55** |

Biggest lines: Aurora (27–35%), Fargate (17–20%), NAT and public IPs (16–20%).

## 5. Bedrock usage (variable)

| Use | Cost | Source |
|---|---|---|
| Visitor conversations, base routing (4 turns, 25% Sonnet) | US$0.016 each, **US$16 per 1,000** (S$22) | ADR-007 base scenario; confirmed by the prices below |
| Onboarding extraction (Sonnet) | US$0.40–0.60 per 30-page site, once per source | ADR-007 |
| Embeddings (Cohere Embed Multilingual v3, ap-southeast-1) | US$0.10 per million tokens; negligible | Price list |
| Canary conversations (1 Haiku turn every 5 minutes) | about US$9 a month | Estimate at about US$0.001 each |

Bedrock prices for the Sydney (`au.`) route, US$ per million tokens:

| Model | Input | Cache write (5 min) | Cache read | Output |
|---|---|---|---|---|
| Sonnet 5.5, regional | 2.20 | 2.75 | 0.11 | 11.00 |
| Haiku 5.5, regional | 0.11 | 0.1375 | 0.011 | 0.55 |
| Sonnet 5.5, Global (for reference) | 2.00 | 2.50 | 0.10 | 10.00 |
| Haiku 5.5, Global (for reference) | 0.10 | 0.125 | 0.01 | 0.50 |

Regional is exactly Global × 1.10, which matches ADR-007's assumption. This closes architecture risk R1 and the "price check (R1)" item in the plan's MD milestone, subject to the owner's confirmation.

## 6. Further cost cuts

Each cut departs from a signed-off ADR or plan item, so each needs an owner decision.

| # | Change | Saves US$/month | Trade-off | Affects |
|---|---|---|---|---|
| C1 | NAT instance (`t4g.nano`, for example fck-nat) instead of the NAT gateway | about 38 | One more server to patch (NFR-06, NFR-15) and a single point of failure for outbound calls, including Bedrock | ADR-003 |
| C2 | RDS PostgreSQL `db.t4g.small` (2 GB, 20 GB gp3, single AZ) instead of Aurora Serverless v2 | about 35 quiet, about 78 typical | Twice the memory of Aurora's 0.5 ACU floor, but no automatic scaling; resizing is a restart. Moving to Aurora later is a planned migration. | ADR-004 |
| C3 | Canary every 15 minutes, run by scheduler-worker instead of CloudWatch Synthetics | about 15, plus about 6 of Bedrock | Coarser availability measurement for NFR-04 | ADR-021 |
| C4 | Defer WAF Bot Control until abuse shows up | about 10 | Still have the WAF rate rules and the per-visitor and per-tenant limits in Valkey (GOV-13) | Architecture §8.1 |
| C5 | Valkey Serverless (100 MB minimum) instead of a node | about 7 | Survives an AZ failure. **Unverified:** whether it supports the pub/sub that realtime relies on (ADR-017). Check before adopting. | ADR-004, ADR-017 |

All five together: about US$167 (quiet) to US$191 (typical), plus about US$6 less Bedrock from C3. **Adopted: C1–C4.** Without C5 (about US$7), the adopted launch environment is about **US$174–198 a month**.

## 7. What the launch environment gives up

| Requirement | Effect | Comment |
|---|---|---|
| NFR-04 (99.5% monthly, about 3.6 h of downtime budget) | Single tasks, one database writer, one NAT and one cache node. An AZ outage, or replacing a failed Aurora writer (about 10 minutes or more), takes the service down. | Rolling deploys still have no downtime. The budget is probably met in a normal month, but it's no longer what the design guarantees. Needs an owner decision to accept it for the launch period. |
| NFR-03 (200 tenants, 1,000 concurrent conversations) | Not affected at the ceiling: auto-scaling maximums and the Aurora 16 ACU maximum are unchanged. Scale-out from one task is slower. | The M6 k6 load test runs against this environment. |
| NFR-08 (backups, RPO, RTO) | Not affected. Aurora backups and PITR are the same. | — |
| NFR-07 (residency) | Not affected. | — |
| ADR-003 promotion path (dev → staging → prod, eval gate, manual approval) | With one environment, there's nowhere to test a release before customers see it. | Mitigations: the CI eval gate (ADR-022) still runs before deploy; ECS circuit-breaker rollback; a short-lived preview stack when needed. |
| Implementation plan MD Deploy ("Terraform apply to dev, then staging") | MD would apply one environment instead of two. | Not changed here: MD hasn't started. It's updated once the owner decides. |

**Moving to prod later.** Prod is a new account built from the same Terraform modules. Customer data has to move across (a database snapshot copy within ap-southeast-1, S3 copy, re-pointing DNS and channel webhooks). This needs a planned cut-over with a short maintenance window (02:00–06:00 SGT, NFR-04). Alternatively, the launch environment can be scaled up in place to become prod, which avoids the migration but leaves the account layout different from ADR-003.

## 8. Decisions needed (candidate ADR changes)

If the owner adopts this, the next free ADR number is **ADR-023**.

1. **ADR-023, Launch environment** (supersedes ADR-003's environments, AZ count and minimum task counts for the launch period): one staging-spec environment in 2 AZs serving the first customers; the trigger for building prod (for example, a number of paying tenants or monthly revenue); and acceptance of the NFR-04 risk until then.
2. **C1–C5:** adopt each or not. C2 would need its own ADR superseding ADR-004. C3 changes ADR-021's canary interval.
3. **Close R1** with the prices in §5.
4. **Implementation plan:** update MD Deploy to match, once the decisions are made.

## 9. Things to check before relying on these numbers

- AWS credits: new AWS accounts and AWS Activate (startup programme) offer credits. Check eligibility, and whether credits cover Claude on Bedrock, which is billed through AWS Marketplace.
- Bedrock quotas: default tokens-per-minute limits on the `au.` profile. Request increases before onboarding customers.
- Prices from memory rather than the price list: the CloudFront free tier, Route 53 and AWS Config.
- C5's pub/sub support on Valkey Serverless.
- GuardDuty Malware Protection for S3 is priced in ap-southeast-1, which suggests it's available there (R7), but availability itself still needs confirming at MD.

## 10. How the prices were obtained

From the AWS Price List bulk API, region files for ap-southeast-1 (and ap-southeast-2 for Bedrock), retrieved 2026-10-19:
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/<region>/index.json`, with offers `AmazonECS`, `AmazonRDS`, `AmazonElastiCache`, `AmazonEC2` (NAT gateway, t4g.nano), `AmazonVPC` (endpoints, public IPv4), `AWSELB`, `awswaf`, `AmazonCloudFront`, `AWSSecretsManager`, `awskms`, `AmazonCloudWatch`, `AWSXRay`, `AmazonSES`, `AmazonGuardDuty`, `AWSQueueService`, `AmazonS3`, `AmazonECR`, `AmazonBedrockFoundationModels`.

Key unit prices (on-demand, ap-southeast-1 unless noted):

| Item | Price |
|---|---|
| Fargate ARM | US$0.04045 per vCPU-hour, US$0.00442 per GB-hour (x86: 0.05056 / 0.00553) |
| Aurora PostgreSQL Serverless v2 | US$0.20 per ACU-hour; storage US$0.11 per GB-month; I/O US$0.22 per million |
| RDS PostgreSQL Single-AZ | db.t4g.micro US$0.025/h, db.t4g.small US$0.051/h; gp3 US$0.138 per GB-month |
| ElastiCache Valkey | cache.t4g.micro US$0.0192/h, cache.t4g.small US$0.0384/h; Serverless US$0.101 per GB-hour of data, US$0.0027 per million ECPUs |
| NAT gateway | US$0.059 per hour and per GB processed |
| EC2 t4g.nano (Linux) | US$0.0053/h |
| VPC interface endpoint | US$0.013 per hour per AZ, US$0.01 per GB |
| Public IPv4 | US$0.005 per hour |
| ALB | US$0.0252 per hour, US$0.008 per LCU-hour |
| WAF | US$5 per web ACL, US$1 per rule, US$0.60 per million requests; Bot Control US$10 a month plus US$1 per million requests |
| Secrets Manager | US$0.40 per secret a month |
| KMS | US$1 per key a month; US$0.03 per 10,000 requests |
| CloudWatch | Logs US$0.70 per GB ingested, US$0.03 per GB-month stored; US$0.30 per metric; US$0.10 per alarm; Synthetics US$0.0017 per run |
| GuardDuty Malware Protection for S3 | First 1,000 objects and 1 GB a month free, then US$0.000323 per object and US$0.135 per GB |
| SQS | First 1M requests free; US$0.40 per million (standard), US$0.50 (FIFO) |
| S3 Standard | US$0.025 per GB-month |
| ECR | US$0.10 per GB-month |
| Cohere Embed Multilingual v3 | US$0.10 per million tokens |
