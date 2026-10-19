# ADR-003: AWS ap-southeast-1 on ECS Fargate, provisioned with Terraform

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** NFR-01, C1, NFR-03, NFR-04, NFR-05, NFR-06, NFR-07, NFR-08, NFR-12, NFR-15, GOV-11

**Context**
All tenant data at rest, including backups, must stay in ap-southeast-1 (C1, NFR-07, GOV-11). The agent and widget API and the dashboard need 99.5% monthly availability (NFR-04). Replies stream for several seconds over long-lived connections (CHN-02, NFR-01), crawls run a headless browser for minutes (KB-01, NFR-16), and workers must scale horizontally (NFR-03). Infrastructure must be code (Terraform, NFR-12), and controls must line up with Cyber Essentials (NFR-06) and vulnerability-management rules (NFR-15).

**Decision**
- Single region **ap-southeast-1**, spread across **three Availability Zones**. All data stores (Aurora, S3, ElastiCache, SQS, Secrets Manager, CloudWatch Logs) live only there; cross-region replication and backups to other regions are disabled by policy (an SCP denies data-store creation outside ap-southeast-1, with an explicit, documented exception only for the inference call in ADR-006).
- **ECS on Fargate** for every runtime role (ADR-001), each as its own ECS service with its own auto-scaling: `api` and `realtime` on CPU and connection count; workers on SQS queue depth (age of oldest message).
- **ALB** in front of `api` and `realtime`; **CloudFront** for the widget, dashboard assets and the public API edge, with **AWS WAF** (managed rule sets + rate rules backing GOV-13).
- **Terraform** (with a remote state bucket and a DynamoDB lock table in ap-southeast-1), one root module per environment (`dev`, `staging`, `prod`) composed from shared modules. Separate AWS accounts per environment under AWS Organizations.
- **CI/CD**: GitHub Actions with OIDC role assumption (no long-lived AWS keys), image build, dependency and container scanning (NFR-15), deploy to staging, AI evaluation gate (ADR-022), then a manually approved promotion to prod. ECS rolling deploys with circuit-breaker rollback.

**Options considered**
- **ECS Fargate (chosen)** — no servers to patch (helps NFR-06/NFR-15), supports long-lived SSE/WebSocket connections and headless Chromium, simple per-role scaling. Con: slower scale-out than Lambda (tens of seconds), so we keep a warm minimum of two tasks per latency-critical role.
- **Lambda + API Gateway** — scale to zero. Lost: 29-second integration timeouts and response-streaming limits complicate verified streaming (ADR-008), headless browser crawling fits poorly, and per-invocation cold starts threaten NFR-01.
- **EKS** — maximum control. Lost: the cluster itself is another system to patch, secure and staff, with no MVP benefit.

**Consequences**
One region keeps the residency story simple and auditable. A full regional outage of ap-southeast-1 would take the service down; with three-AZ redundancy that is an accepted risk at 99.5% (about 3.6 hours a month of budget), and NFR-08's RTO ≤ 4 h covers a restore inside the same region. A rough order-of-magnitude production run cost (Fargate, Aurora, ElastiCache, NAT, ALB, CloudFront/WAF, logs) is US$1,000–1,500 per month at MVP volumes, to be refined in implementation planning; staging is about a third of that.
