# ADR-007: Model routing, prompt caching and the LLM cost budget (settles D6 / NFR-13)

**Status:** Proposed (awaiting product-owner sign-off; see sign-off question Q2)
**Date:** 2026-10-19
**Requirements addressed:** NFR-13, D6, DSH-04, DSH-08, GOV-13, NFR-01, NFR-10, NFR-11, AGT-08, AGT-01, AGT-02, AGT-03, AGT-04, AGT-12, KB-05

**Context**
D6 sets an average LLM cost target of **≤ S$0.03 per conversation**, to be reached with prompt caching and routing simple turns to a smaller model, and asks architecture to check it against current pricing. Quality targets are strict: groundedness ≥ 95% (AGT-01), 100% price accuracy (AGT-02), intent accuracy ≥ 90% on Singlish and Chinese (AGT-03). First-token p95 ≤ 3 s (NFR-01).

Current Claude API list prices (USD per million tokens, from the pricing page on 2026-10-19):

| Model | Input | 5-min cache write | Cache read | Output |
|---|---|---|---|---|
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2.00 | $2.50 | $0.10 | $10.00 |
| Claude Haiku 5.5 (`claude-haiku-5-5`), prompt ≤ 100k tokens | $0.10 | $0.125 | $0.01 | $0.50 |
| Claude Opus 5.5 (`claude-opus-5-5`), reference only | $4.00 | $5.00 | $0.20 | $20.00 |

Bedrock prices were not readable from the AWS pricing page. Anthropic states regional and multi-region (geographic) endpoints carry a 10% premium over global. We therefore model **list price × 1.10** for the `au.` route (ADR-006) and **US$1 = S$1.35** (a deliberately conservative exchange rate).

**Decision**
1. **Two-stage turn with routing.**
   - *Triage* on **Haiku 5.5** (low effort, structured output): language and register, intent, whether the turn needs tools or a commitment, retrieval query rewrite, a complexity score, and safety flags. About 1.2k cached + 0.5k new input tokens, about 80 output tokens.
   - *Reply* on **Haiku 5.5** for simple grounded turns (FAQ, hours, single price, location, after-hours notice), and on **Sonnet 5.5** for multi-item quotes, `draft_approval`, complaints, multi-constraint questions, low triage confidence, and any turn that failed verification once. Both run with adaptive thinking at low effort (Sonnet's `between_tools` mode where thinking adds latency without value).
   - Routing thresholds are per-tenant configuration and are tuned against the evaluation set (ADR-022); a route change ships only if all AGT thresholds hold.
2. **Prompt-cache layout** (byte-stable prefix first): tool definitions → platform system prompt and guardrail rules → tenant block (persona settings from AGT-08 — bot name, tone, greeting, emoji — business profile, boundary rules, hours; versioned, changes only when the owner edits settings) → **cache breakpoint** → conversation history (append-only; stores fact IDs, not fact text) → **breakpoint** → this turn's retrieved facts and page context (never cached, never written into history) → the visitor message. No timestamps or request IDs in cached sections; the current SGT time goes into the uncached tail.
3. **Cost governor.** Every call records tokens and cost per tenant (ADR-021). If a tenant's rolling 7-day average exceeds S$0.025 per conversation, the router raises that tenant's Sonnet threshold one step and alerts the operator. GOV-13's 3×-average daily spend alert stays independent of this.
4. **Other LLM uses:** fact extraction (KB-05) on Sonnet 5.5, because price accuracy matters most there (about US$0.40–0.60 per 30-page onboarding crawl, a one-off per source); chat-export Q&A mining and conversation summaries (AGT-12) on Haiku 5.5; evaluation judging (ADR-022) on Opus 5.5 in CI only. Coaching mode (AGT-17) uses the same router as visitors so the owner sees what visitors would get.

**Cost estimate per conversation** (script-computed; 4-turn conversation, 3.5k-token cached static prefix, about 1.5k tokens of retrieved facts per turn, Haiku output about 200 tokens and Sonnet about 400 including low-effort thinking, 5% of turns regenerated after a failed check, 50–60% chance the tenant prefix is cold, plus one Haiku lead-scoring call):

| Scenario | USD | SGD |
|---|---|---|
| Haiku only (floor) | 0.0026 | **0.004** |
| Lean: 4 turns, 15% of turns on Sonnet | 0.0109 | **0.015** |
| **Base: 4 turns, 25% on Sonnet** | 0.0160 | **0.022** |
| 4 turns, 30% on Sonnet | 0.0184 | **0.025** |
| Heavy: 6 turns, 35% on Sonnet | 0.0304 | **0.041** |
| Stress: 8 turns, 50% on Sonnet, 10% regenerated | 0.0575 | **0.078** |
| Sonnet only, 4 turns | 0.0429 | **0.058** |
| Base on the Global profile (no 10% premium) | 0.0145 | **0.020** |

**Verdict:** ≤ S$0.03 **is achievable as a platform average** if no more than about 35–40% of turns go to Sonnet in a typical 4-turn enquiry. Sonnet-only does not meet it, and long, complex conversations (catering quotes) cost 2–3× the target. At Starter fair use (1,000 conversations), base-case LLM cost is about S$22 against S$49 of revenue. That is viable, but the margin is thin, and pilot data must confirm the conversation length and the Sonnet share.

**Options considered**
- **Haiku triage + Haiku/Sonnet reply with caching (chosen)** — meets the target in the base case while keeping Sonnet for the turns where accuracy and reasoning matter. Con: two model calls per turn add about 300–500 ms; mitigated by running triage and retrieval in parallel with a speculative embedding of the raw message.
- **Sonnet 5.5 for every turn** — simplest, highest quality. Lost: about S$0.058 per conversation, roughly double D6.
- **Haiku 5.5 for every turn** — about S$0.004. Lost: risk to AGT-03 (Singlish nuance) and multi-item quotes; kept as the tenant-level fallback if the cost governor trips repeatedly and the evaluation set shows Haiku still passes for that tenant's vertical.
- **No separate triage (one call decides and answers)** — fewer calls. Lost: routing is impossible without a first decision, and safety classification would happen inside the expensive model.

**Consequences**
Cost per conversation becomes a first-class metric on the operator console. Cache hit rate is monitored (`cache_read_input_tokens`), and a drop below 60% on warm tenants alerts. The estimate rests on assumptions (conversation length, Sonnet share, the Bedrock price premium, the exchange rate) that the pilot must confirm; the AWS Pricing Calculator check for ap-southeast-2 `au.` profile prices is a task for implementation planning.
