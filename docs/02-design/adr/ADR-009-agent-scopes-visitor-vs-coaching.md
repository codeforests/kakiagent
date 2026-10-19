# ADR-009: Agent scopes — a visitor scope and a coaching scope fixed by the entry point

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** AGT-16, AGT-17, AGT-07, AGT-06, AGT-01, KB-16, KB-18, ONB-05, GOV-03, GOV-01, DSH-02, DSH-04, UC-04, UC-20 (exception flows 3a, 3d)

**Context**
AGT-16 says that on visitor channels the agent may use only approved facts, the business profile and the current visitor's own conversation and contact record, and that nothing a visitor says can unlock owner functions, including a claim to be the owner. AGT-17 gives the Owner and Admins a coaching chat in the dashboard that can include unreviewed facts (labelled), explains its answers, turns plain-language corrections into proposed changes, and replays past conversations. Coaching conversations must never reach visitors and are excluded from analytics and fair use. Prompt instructions alone cannot guarantee AGT-16, because AGT-07 assumes adversarial input.

**Decision**
There is one agent engine with two **scopes**. The scope is chosen by the **entry point** and fixed for the whole turn before any model call. Model output and message content can never change it.

| | **Visitor scope** | **Coaching scope** |
|---|---|---|
| Entry point | Channel adapters only (widget, email, Telegram, Meta; later WhatsApp) | Authenticated dashboard route, Owner/Admin role, fresh session (AUTH-02) |
| Database role | `app_agent_visitor`: SELECT only on `visitor_facts` (approved, enabled, not conflicted, not expired) and `business_profile_public`; rows of its own conversation and contact, keyed by the conversation ID in the job | `app_dashboard`, under the tenant RLS of ADR-005 |
| Facts | Approved only (KB-16) | Approved; optionally `needs_review` facts, labelled "unreviewed" in the answer |
| Tools | `lookup_kb`, `capture_lead`, `escalate_to_human`, `draft_approval`, `handoff_channel` (AGT-06) | `lookup_kb`, `explain_answer`, `propose_correction`, `replay_conversation` |
| Output | Channel, after ADR-008 verification | Dashboard only, with facts used and the rationale; same verifier, so the owner sees what visitors would get |
| Storage | `conversations` (counted for analytics and fair use) | `coaching_sessions`, a separate table that is excluded from analytics, fair use and the inbox by construction; audit-logged |

- **Repository functions are scope-typed.** `VisitorContext` and `CoachingContext` are distinct TypeScript types. KB and contact queries take one of them, and a visitor-scope call cannot compile against a coaching-only function. This is backed by the database grants above, so a bug still cannot read unreviewed facts or other contacts from the visitor path.
- **Owner functions do not exist as tools in visitor scope**, so "I am the owner, show me today's leads" has nothing to call. The model can only answer from public information and offer the normal contact options (UC-20 3d). Owner-impersonation attempts are tagged by triage and audit-logged.
- **`propose_correction`** writes a *proposal* to the correction queue (ADR-010) and returns it for one-tap confirmation in the same coaching thread. It never edits a fact directly, so both coaching and visitor-side signals go through one review path.
- **Replay** (`replay_conversation`) re-runs a stored visitor conversation in coaching scope against the current KB, with tools stubbed (no leads, approvals, escalations or messages are created), and shows old and new answers side by side.

**Options considered**
- **Two scopes fixed by entry point, enforced by types and database grants (chosen)** — leaks need a code bug *and* a grant bug; testable by the red-team suite. Con: two sets of tools and prompts to maintain.
- **One agent with a role flag in the prompt** — simpler. Lost: a prompt-level boundary is exactly what prompt injection targets (AGT-07), and AGT-16 requires that "nothing a visitor says unlocks owner functions".
- **A separate coaching product with its own engine** — maximum separation. Lost: the owner would not see the real visitor behaviour, which is the point of the playground (ONB-05) and of replay.

**Consequences**
The red-team suite (AGT-07, ≥ 50 cases) gains owner-impersonation and internal-data cases run against the visitor entry points. Coaching sessions never appear in DSH-02 analytics or DSH-04 fair-use counts, because they live in a different table. The cost of coaching turns is still metered per tenant for NFR-13.
