# ADR-011: The ChannelAdapter contract

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** NFR-05, CHN-01, CHN-02, CHN-04, CHN-05, CHN-06, CHN-07, CHN-08, CHN-10, CHN-12, INB-01, INB-02, INB-08, LED-04, NFR-17, NFR-18, UC-25, UC-26, UC-27; Phase 2 WhatsApp (SRS §1.3)

**Context**
CHN-01 requires one abstraction (receive → normalise → agent → send) so that new channels, explicitly WhatsApp in Phase 2, plug in "without changing the core", needing "only a new adapter module and a config entry". MVP channels differ widely: the widget streams over SSE, email threads by `Message-ID`/`References` and must suppress auto-replies (CHN-10), Telegram is 1:1 only (CHN-05), and Meta and WhatsApp enforce a messaging window and template rules (CHN-06). All channels must detect revoked credentials (CHN-12) and must never drop a message (NFR-17).

**Decision**
Each channel is a module in `packages/channels/<name>` implementing:

```ts
interface ChannelAdapter {
  readonly kind: ChannelKind;                     // 'widget' | 'email' | 'telegram' | 'messenger' | 'instagram' | 'whatsapp' …
  readonly capabilities: ChannelCapabilities;     // streaming, maxLength, richContent, attachments,
                                                  // replyWindow?: { hours, outsideWindow: 'template' | 'block' }, typing indicator
  verifyInbound(req: RawInbound, creds: CredentialRef): Promise<VerifiedInbound | Rejection>; // signatures, tokens, origins
  normalise(v: VerifiedInbound): Promise<InboundEvent[]>;  // → canonical messages, postbacks, delivery receipts
  shouldIgnore(e: InboundEvent): IgnoreReason | null;      // auto-replies, groups, bulk mail, echoes (CHN-05, CHN-10)
  threadKey(e: InboundEvent): ExternalThreadKey;           // email References, Telegram chat id, PSID …
  send(msg: OutboundMessage, ctx: SendContext): Promise<SendResult>;   // idempotent on msg.id
  stream?(seg: VerifiedSegment, ctx: SendContext): Promise<void>;      // only if capabilities.streaming
  checkHealth(creds: CredentialRef): Promise<HealthStatus>;            // CHN-12
  connect?(setup: ConnectRequest): Promise<CredentialRef>;             // BotFather token, Meta OAuth, domain DNS checks
}
```

- **The core never branches on channel kind.** It consumes `InboundEvent` (canonical: tenant, channel connection, external user ID, text, attachments, locale hints, timestamp) and emits `OutboundMessage` (text with rendered slots, quick replies, attachments, handoff links). Capability differences are handled by a shared **outbound shaper** that reads `capabilities`: it splits long text, drops rich elements the channel lacks, and enforces `replyWindow` before `send` is called.
- **Registration is configuration:** a `channels.config.ts` registry entry maps `kind` to the adapter module, its webhook route, its credential schema and its plan gating (DSH-04). Webhook routes are mounted generically at `/hooks/:kind/:connectionId`.
- **Inbound flow:** webhook → `verifyInbound` → raw event persisted to `inbound_events` (idempotency key = provider message ID) → 200 returned to the provider → SQS FIFO by conversation (ADR-012) → `normalise`, then contact resolution (CHN-08), conversation lifecycle (INB-08) and agent turn.
- **Outbound flow:** agent or staff → `outbox` row in the same transaction as the message → dispatcher → `send`, with retries and exponential backoff for at least 24 hours; then the message is marked failed and surfaced to staff (NFR-17, CHN-12).
- **Credentials** are stored as KMS-encrypted blobs referenced by `CredentialRef`; adapters never see raw secrets outside the call (NFR-05).
- **Health:** a scheduler job calls `checkHealth` for every connection every 5 minutes, and any 401/403 from `send` marks the connection degraded immediately. Either path raises an Owner/Admin alert, which meets CHN-12's 15-minute detection target.
- **WhatsApp in Phase 2:** a `whatsapp` adapter for the WhatsApp Business Cloud API (webhook signature check, 24-hour customer-service window with template fallback via `replyWindow.outsideWindow = 'template'`) plus a registry entry. The core, the agent and the inbox are untouched; template management UI is an adapter-owned settings panel.

**Options considered**
- **Capability-described adapters behind canonical events (chosen)** — new channels are additive; the agent stays channel-agnostic. Con: the canonical model must be rich enough for every channel; extensions go in `InboundEvent.extensions[kind]`, which the core passes through but does not interpret.
- **Per-channel pipelines** — maximum flexibility. Lost: violates CHN-01 directly and duplicates guardrails per channel.
- **A third-party channel aggregator (for example a CPaaS)** — fewer integrations to write. Lost: adds a sub-processor that sees every message, possibly outside Singapore (GOV-11), and pricing markups the research flags as a pain point (P5).

**Consequences**
Each adapter has a contract-test suite (recorded webhook fixtures in, expected canonical events out; send idempotency; ignore rules). The widget is also an adapter, so the agent path for J2 and J9 is the same code. Revisit the canonical model when voice (out of scope) is considered.
