# ADR-021: Observability and per-tenant usage metering

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** NFR-11, NFR-13, NFR-20, NFR-01, NFR-04, NFR-18, GOV-13, DSH-04, DSH-06, DSH-08, CHN-12, GOV-10, UC-34, UC-38

**Context**
NFR-11 asks for structured logs, traces and metrics, per-tenant LLM cost and token tracking, health checks for every service and channel, and alerts on error rate, latency, job backlog and channel failures. GOV-13 requires an operator alert when a tenant's daily LLM spend exceeds 3× its 30-day average. DSH-08 shows usage against limits, and NFR-20 sets operator acknowledgement times. Telemetry must not move personal data out of Singapore.

**Decision**
- **OpenTelemetry SDK** in every role, exported through the **AWS Distro for OpenTelemetry** collector to **CloudWatch** (logs, metrics) and **X-Ray** (traces) in ap-southeast-1. Trace attributes carry tenant ID, conversation ID, model, route and guardrail result, and never message text.
- **Structured JSON logs** (pino) with the redaction rules of ADR-015; 30-day retention for application logs, 1 year for security logs.
- **Usage ledger:** a `usage_events` table (tenant, conversation or coaching session, purpose, model, input / cache-write / cache-read / output tokens, cost in USD at the configured price table) written with every LLM and embedding call. It also counts conversations, sources and channels. It feeds DSH-08, the DSH-04 limits, the ADR-007 cost governor and the operator console.
- **Key SLIs and alarms:** reply first-segment and full-reply latency (p95), API latency, 5xx rate, queue age and DLQ depth, verifier failure rate, cache hit rate, Bedrock throttles, channel health status, SES bounce rate > 5% (NFR-18), daily spend > 3× its 30-day average (GOV-13), and backup and restore job status.
- **Alert routing:** CloudWatch alarms → SNS → operator email and an operator Telegram group, with an on-call rota for the pilot hours in NFR-20. The incident runbook (GOV-10) links each alarm to a response.
- **Health checks:** `/healthz` (liveness) and `/readyz` (database, Valkey, queue reachability) per role; synthetic canaries every 5 minutes run a widget conversation against a canary tenant end to end (NFR-04 measurement).

**Options considered**
- **OpenTelemetry → CloudWatch/X-Ray (chosen)** — in-region, no new sub-processor, vendor-neutral instrumentation. Con: CloudWatch dashboards are less pleasant than SaaS tools.
- **Datadog / Grafana Cloud / Sentry** — better UX. Lost: a sub-processor receiving operational data that could include tenant identifiers, possibly outside Singapore; can be added later behind the same OpenTelemetry instrumentation if declared.

**Consequences**
Cost per conversation, cache hit rate and verifier failure rate become product metrics, not just operational ones. The usage ledger is the basis for future billing (Stripe is out of scope for the MVP).
