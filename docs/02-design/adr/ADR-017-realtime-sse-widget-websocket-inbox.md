# ADR-017: Real-time delivery — SSE for the widget, WebSocket for the inbox, Valkey fan-out

**Status:** Proposed (awaiting product-owner sign-off)
**Date:** 2026-10-19
**Requirements addressed:** INB-01, INB-02, CHN-02, NFR-01, NFR-03, NFR-04, NFR-17, GOV-08, DSH-01, LED-04, INB-05

**Context**
INB-01: new messages appear in the inbox within 2 seconds without a refresh. CHN-02 and NFR-01: replies stream to the widget, with first visible text p95 ≤ 3 s. NFR-03: 1,000 concurrent conversations at peak, plus staff dashboards. Agent workers, which produce segments, and connection holders, which own sockets, are different processes and scale differently.

**Decision**
- **Widget ← server: Server-Sent Events** over HTTPS (`GET /widget/v1/conversations/:id/stream`), with `Last-Event-ID` resume. **Widget → server:** plain `POST` requests. SSE works through corporate proxies and CDNs, needs no extra library (fits ADR-016's budget) and reconnects automatically. A long-poll fallback is used where SSE is blocked.
- **Dashboard ↔ server: WebSocket** (one per signed-in tab), carrying inbox events, typing and presence, takeover notices, approval and alert badges.
- **`realtime` service** (ECS, behind the ALB with long idle timeouts) holds the connections and is stateless otherwise. Agent workers and the API publish events to **Valkey pub/sub** channels `t:{tenant}:conv:{id}` and `t:{tenant}:inbox`; realtime nodes subscribe for the connections they hold.
- **Durability comes from Postgres, not pub/sub.** Every event that matters (message, state change) is first committed; pub/sub only notifies. On reconnect, clients fetch missed events by sequence number, so a dropped pub/sub message costs latency, never data (NFR-17).
- **Web push** (LED-04 "S") through the standard Web Push protocol with encrypted payloads that carry IDs only.

**Options considered**
- **SSE + WebSocket via a realtime role and Valkey (chosen)** — each surface gets the simplest suitable transport; horizontal scaling by connection count. Con: two transports to support.
- **API Gateway WebSocket APIs** — managed connections. Lost: no SSE, per-message pricing, and the callback model complicates verified-segment streaming from workers.
- **AWS AppSync / IoT Core** — managed pub/sub. Lost: extra services, and their auth models don't match our tenant/visitor tokens.
- **Third-party realtime SaaS** — lost on sub-processors and residency (GOV-11).

**Consequences**
The realtime role needs sticky-free design (any node can serve any client) and graceful drain during deploys (clients reconnect and resume). Load testing for NFR-03 includes 1,000 concurrent SSE streams plus 300 dashboard sockets.
