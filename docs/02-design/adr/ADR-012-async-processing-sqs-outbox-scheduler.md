# ADR-012: Asynchronous processing with SQS, a transactional outbox and a durable scheduler

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** NFR-16, NFR-17, NFR-03, NFR-04, NFR-11, CHN-12, INB-05, INB-08, APR-04, APR-06, LED-04, LED-06, LED-07, GOV-05, GOV-06, AUTH-07, KB-08, KB-12, KB-17, GOV-09, UC-22 (5d), UC-27 (3c)

**Context**
NFR-17 says that no inbound or outbound message is lost, and that work against an unavailable dependency is queued and retried with backoff for at least 24 hours, then surfaced to staff. Many requirements are timers: escalation reminders every N minutes (INB-05), auto-close after 30 minutes or 72 hours (INB-08), approval SLAs in business hours and 7-day expiry (APR-04, APR-06), quiet-hours digests (LED-04), deletion grace periods (AUTH-07), retention purges (GOV-06), weekly re-crawls (KB-08), DSR due-date alerts (GOV-05). Messages within a conversation must be processed in order.

**Decision**
- **Transactional outbox:** any state change that must cause work (send a message, alert, webhook, index a chunk) writes an `outbox` row in the same Postgres transaction. A dispatcher publishes outbox rows to SQS and marks them sent; consumers are idempotent on the outbox ID. No "write DB, then call API" gaps.
- **SQS queues per workload:** `conversation-turns.fifo` (MessageGroupId = conversation ID, so turns are serialised per conversation and processed in parallel across conversations), `outbound-send` (standard queue, idempotent sends), `ingest-*` (crawl, parse, extract, embed), `notifications`, `webhooks`. Each queue has a dead-letter queue, and DLQ depth alerts (NFR-11).
- **Retry policy:** exponential backoff with jitter from 10 s up to 30 min. A message's retry budget is 24 hours (tracked in the message, not only by SQS receive count); after that it is marked `failed`, shown to staff in the inbox or source status, and the Owner/Admin is alerted.
- **Durable timers in Postgres:** a `timers` table (`due_at`, `kind`, `subject_ref`, `tenant_id`, `version`) polled every 5 seconds by the scheduler worker with `FOR UPDATE SKIP LOCKED`. A timer firing checks the subject's current version, so a stale timer (an approval already decided, a conversation already reopened) does nothing. Business-hours arithmetic (APR-04) is done when the timer is set, using the tenant's hours and the SG public-holiday calendar.
- **Recurring jobs** (re-crawl, stale scan, purge, oversight prompts, DSR reminders, health checks) are EventBridge Scheduler rules that enqueue a job; the job fans out per tenant.

**Options considered**
- **SQS + outbox + Postgres timers (chosen)** — managed queues, exactly the guarantees needed, timers that are transactional with the state they guard. Con: a polling scheduler; 5-second granularity is far tighter than any timer requirement.
- **EventBridge Scheduler one-off schedules per timer** — no polling. Lost: thousands of short-lived schedules to create and cancel, with no transactional link to the approval or conversation state.
- **Step Functions per workflow** — visual workflows. Lost: cost and complexity for flows that are mostly "wait, then check state"; kept as an option for complex ingestion later.
- **Kafka/MSK** — replay and high throughput. Lost: far beyond MVP throughput and another cluster to operate.

**Consequences**
Every consumer must be idempotent and must tolerate at-least-once delivery, which is enforced through shared consumer helpers and tests. The FIFO queue caps throughput per message group, which is fine because one conversation never needs more than a few turns a second. Kill-switch and takeover checks happen when the turn is consumed, not when it is enqueued, so a pause takes effect for turns already queued (GOV-08, INB-02).
