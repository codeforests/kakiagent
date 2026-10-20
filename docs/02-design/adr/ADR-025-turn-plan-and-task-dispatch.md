# ADR-025: Turn plan and task dispatch — the model interprets, code acts

**Status:** Accepted — product owner, 2026-10-20. Extends [ADR-007](ADR-007-model-routing-prompt-caching-and-cost.md) (the triage output) and [ADR-009](ADR-009-agent-scopes-visitor-vs-coaching.md) (the tools) without changing their decisions. To be implemented from FEAT-004 onward (implementation plan §4).
**Date:** 2026-10-20
**Requirements addressed:** AGT-06, AGT-04, AGT-13, AGT-16, AGT-07, LED-01, LED-02, LED-07, APR-01, APR-02, GOV-05, GOV-01, AGT-14

**Context**
A visitor message often carries more than one task: "how much for 50 kueh, can deliver Saturday, my number is 9123 4567" is a price question, a commitment that needs approval (APR-01, APR-02) and lead capture (LED-01). Only some of those tasks are the model's to do. The signed-off design already keeps business consequences out of the model: triage and routing (ADR-007), slot rendering and verification (ADR-008), scope-limited tools (ADR-009), the outbox (ADR-012) and the send gate (ADR-013). What it does not say is:

1. how one message becomes several tasks (ADR-007's triage returns a single intent);
2. which component turns a task or a model tool call into a side effect, and what it checks first (AGT-06 says nothing irreversible runs without approval; APR-01 sets boundary rules; LED-02 requires consent);
3. how requirements the agent must *recognise* but that have no AGT-06 tool are carried out: consent withdrawal (LED-07), data-subject requests in chat (GOV-05), crisis and abuse (AGT-13), low confidence and out of scope (AGT-04);
4. how a per-turn set of allowed tools fits ADR-007's cache layout, where tool definitions sit at the start of the cached prefix.

Without a decision each tool feature (FEAT-038, -044, -049, -051, -055) would wire its own path from model output to module.

**Decision**
1. **Triage produces a typed `TurnPlan`.** ADR-007's triage call (Haiku, structured output, no extra call) returns, besides language/register, complexity and safety flags, an ordered list of **tasks**. Each task has a `kind` from a closed enum and the arguments triage extracted:

   | Kind | Handled by | Owning module (public API) |
   |---|---|---|
   | `answer` | Reply model, grounded and verified (ADR-008) | `agent` |
   | `capture_lead` | Model-assisted tool | `leads.captureLead` (FEAT-049) |
   | `request_commitment` (quote, discount, custom commitment) | Model-assisted tool `draft_approval` | `approvals.draft` (FEAT-055) |
   | `escalate` (visitor asks for a person) | Code | `inbox` escalation (FEAT-044) |
   | `handoff_channel` | Model-assisted tool | `channels` (FEAT-038) |
   | `withdraw_consent` | Code | `leads.withdrawConsent` (FEAT-051) |
   | `data_request` | Code | `governance.dsr.*` (FEAT-061); escalate until it exists |
   | `crisis` | Code: crisis-contact text + escalation | `agent` texts, `inbox` (FEAT-025) |
   | `abuse` | Code: refuse; on repeat end the AI conversation and flag | `inbox` (FEAT-025, FEAT-042) |
   | `out_of_scope` / low confidence | Code: AGT-04 refusal, escalation or lead offer | `agent` (FEAT-023) |

   The plan is validated with Zod. An unparseable or empty plan falls back to `[answer]` with AGT-04 handling. New kinds are added only by amending this table.

2. **One dispatcher in `@kaki/agent`.** A registry maps each task kind and each tool name to the owning module's public interface. The dispatcher is the only place a task or a tool call becomes a side effect. Before it runs one, it checks, in code:
   - **scope** — the task is allowed in this turn's scope (ADR-009); owner functions are never registered for visitor scope;
   - **the send gate** (ADR-013);
   - **boundary rules** (APR-01) — maximum discount, forbidden commitments, whether quotes need approval;
   - **consent** (LED-02) before any personal data is stored;
   - **arguments** — Zod-validated (SG phone, email, quantities).
   Writes go through the module in one transaction with an outbox entry (ADR-012). Each dispatch, allowed or refused, is audit-logged with its task kind and outcome, never the visitor's text (AGT-06 acceptance, ADR-014).

3. **Two kinds of task.**
   - *Code-handled* tasks (`escalate`, `withdraw_consent`, `data_request`, `crisis`, `abuse`, `out_of_scope`) run straight from the plan. Their outcome never depends on the reply model choosing to call a tool. The visitor-facing text is a fixed or slotted text, or the reply model is told what happened.
   - *Model-assisted* tasks keep AGT-06's tools so the reply model can collect arguments in conversation (for example, ask for the visitor's name). A model tool call is a **proposal**: the dispatcher validates it as in decision 2 and may refuse it. A tool the plan did not enable for this turn is refused by the dispatcher.

4. **Tool definitions stay stable.** To keep ADR-007's cache layout, the tool definitions in the cached prefix are the full scope list and never vary per turn. "Allowed this turn" is enforced by the dispatcher (decision 3), not by changing the definitions.

5. **Results come back as slots.** What a dispatched task produced (an approval reference and SLA time, a handoff link, the next opening time) reaches the reply as a system slot rendered and verified under ADR-008, so the model never restates it from memory.

6. **Order and partial failure.** Safety tasks (`crisis`, `abuse`) run first and may end the turn. Then state changes (`withdraw_consent`, `capture_lead`, `request_commitment`, `escalate`, `data_request`, `handoff_channel`), then the visitor-facing `answer`, which reflects what actually happened. One task failing does not drop the others: the reply says what could not be done and offers AGT-04 handling. The turn stays idempotent (one reply per visitor message); each dispatched task carries an idempotency key of turn and task index.

7. **Coaching scope** (ADR-009) uses the same `TurnPlan` and dispatcher with its own registry (`lookup_kb`, `explain_answer`, `propose_correction`, `replay_conversation`). Replay runs with every handler stubbed.

8. **Evaluation (AGT-14, ADR-022).** The eval set gains a multi-task subset and a dispatch check: each case lists its expected tasks and dispatched calls. A route or prompt change ships only if task accuracy holds alongside the AGT thresholds.

**Options considered**
- **Typed turn plan from triage + deterministic dispatcher (chosen)** — no extra model call; policies live in code where AGT-07's adversarial input cannot reach them; one place to add a handler. Con: the task enum is a contract to maintain, and triage must be accurate on multi-task messages (measured by decision 8).
- **Reply model does everything with native tool use** — simplest. Lost: LED-07, AGT-13 and GOV-05 outcomes would depend on the model choosing to call a tool, and boundary checks would sit in prompts.
- **General planner-executor loop** (the model plans steps and calls tools repeatedly) — most flexible. Lost: several model round trips break NFR-01 (first token p95 ≤ 3 s) and D6 (≤ S$0.03 per conversation), and open-ended plans are hard to evaluate under AGT-14.

**Consequences**
- No SRS amendment: AGT-06, AGT-04, AGT-13, LED-07, GOV-05 and APR-01 already require the behaviour; this decides how. Consent withdrawal and data requests are code-handled tasks, not new AGT-06 tools.
- FEAT-004 introduces the `TurnPlan` schema, triage producing it, and the dispatcher with an empty registry. Each later feature registers its handler: FEAT-023 (`out_of_scope`), FEAT-025 (`crisis`, `abuse`), FEAT-038, -044, -049, -051, -055 and -061.
- FEAT-022's fixed pipeline (`lookup_kb` always, then a verified answer) becomes the `answer` path unchanged; `lookup_kb` stays a code step run in parallel with triage, not a model choice.
- Triage output grows by a few tokens per task; the ADR-007 cost estimate is not materially affected.
