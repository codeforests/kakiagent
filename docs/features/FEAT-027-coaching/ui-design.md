# UI Design: FEAT-027 — Coaching mode

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-030 (new), SCR-APP-010 (new, partial: wizard frame is FEAT-035), quick coach panel on SCR-APP-019 and SCR-APP-028 (extended) · Mode: per-feature · Status: Draft · Date: 2026-10-24

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so every screen here is a code-native spec. Every value comes from design.md and `tokens.json`; front ends use `var(--…)` only. The domain components `answer-explainer` and `quick-coach-panel` are already defined in design.md §4.6; the chat reuses `message-bubble` and `composer` (without the takeover bar). No new component or token is introduced.

## Cross-screen: the coach chat (`coach-chat`)

One component, used by SCR-APP-030, SCR-APP-010 and the quick panel.

- **Thread:** owner questions as `message-bubble` on the right (info-soft fill, label "You"); agent answers on the left (surface with border, label "{bot name} · coaching"). Never the visitor-side colours, so a coaching thread can't be mistaken for a real conversation.
- **Coaching banner** (`banner`, info, once at the top of every thread): "This is a practice chat. Customers never see it, and it isn't counted in your usage."
- **Composer:** `composer` textarea (placeholder "Ask what a customer would ask, or tell your assistant what's changed"), Send `primary`. Enter sends, Shift+Enter adds a line. Disabled with an in-place `spinner` while answering.
- **Include unreviewed facts** `toggle` above the composer, off by default, label "Include facts you haven't reviewed", helper caption "Answers may then differ from what customers get." The value is sent with each question and kept per thread.
- **`answer-explainer`** under each answer (design.md §4.6), collapsed to one line: "Used {n} facts · Why?" (or "No facts used · Why?"). Expanded:
  - Fact chips (`chip` with type label and `label`, linking to `/knowledge/facts/:id`); a used fact is filled, considered-but-unused is outline; an unreviewed fact carries a warning chip "Unreviewed".
  - Why, one sentence per reason code: `matched_facts` "It matched {labels}." · `no_matching_fact` "Nothing in your facts matched, so it said it would check with your team." · `low_confidence` "It wasn't sure what was asked." · `out_of_scope` "This isn't about your business, so it gave the standard reply." · `advice`/`illegal` "It doesn't give that kind of advice." · `injection`/`impersonation` "The message tried to change its instructions or asked for internal data, so it refused." · `regenerated` "Its first draft quoted something not in your facts, so it rewrote it." · `segment_blocked` "Part of its draft didn't match your facts and was left out." · `escalated` "It offered to pass this to your team." · `hours_slot` "Opening hours come from your business profile." · `unreviewed_used` "It used a fact you haven't reviewed."
  - What customers get, from `visitorsWouldGet`: `same` (no line), `without_unreviewed` alert warning "Customers wouldn't get this answer: it uses facts you haven't approved.", `fallback_paused` alert info "Your assistant is paused, so customers get your fallback message.", `not_live` caption "Your assistant isn't live yet. This is what customers will get."
- **Proposal card** (`card` within the thread, kind `proposal`): heading "Proposed change", the fact's type and label, then the diff as in `correction-item` (old value struck through on danger-soft, new on success-soft; prices tabular with the GST label; hours as "Sat 9:00 am – 5:00 pm"). `add_faq` shows "New FAQ" with question and answer. Actions: `primary` "Confirm change", `ghost` "Not now". Caption: "Customers get this as soon as you confirm."
  - confirming: button loading; confirmed: card collapses to a success row "Changed. Customers get the new {price | answer | hours} now." with a link to the fact, then a **before/after** pair under it ("Before" and "Now" columns, stacked below 768 px, the same bubble rendering) for the coached question.
  - not now: the card becomes a neutral row "Not changed. You can find it later in Review › Corrections." (D6; the queue screen is FEAT-018).
  - `correction_stale`: alert warning "This fact changed since I suggested this. Ask again to get a new suggestion." Actions removed. `correction_closed`: refresh the card from the response. `invalid_correction`: alert danger "This change isn't valid any more. Edit the fact instead." with a link.
- **No proposal** (the agent couldn't tell what to change): the agent's fixed text, no card.
- **Answering:** a typing indicator bubble with `aria-live="polite"` "Your assistant is answering…". Answers are announced once complete (no streaming).
- **Errors on send:** `alert` danger inline under the composer, text kept: 429 "You're sending questions quickly. Wait a minute, then try again."; network or 5xx "Couldn't get an answer. Try again." [Retry]. An `unavailable` outcome renders as an answer with the explainer line "Your assistant couldn't reach its AI service, so customers would get your fallback message."
- **Keyboard and a11y:** the thread is a `log` region; each answer's explainer toggle is a `button` with `aria-expanded`; focus moves to the proposal's Confirm button when a proposal arrives; colour is never the only signal (struck-through text plus "Was"/"Now" labels in the diff).

## SCR-APP-030 — Coach

- **Strategy and source:** code-native (this section).
- **Route:** `/coach` (replaces the placeholder), `?session=:id` opens a thread, `?ask=` prefills the composer (used by the quick panel on mobile). Roles: Owner, Admin (`coach.use`); others get the permission state "Only the Owner and Admins can coach the assistant."
- **Contract bindings:** `GET /api/v1/coach/sessions`, `POST /api/v1/coach/sessions` (origin `coach`), `GET /api/v1/coach/sessions/:id`, `POST /api/v1/coach/sessions/:id/messages`, `POST /api/v1/coach/corrections/:id/confirm`, `POST /api/v1/coach/corrections/:id/dismiss`, `GET /api/v1/coach/suggestions`.
- **Layout:** desktop two columns: left 280 px list of practice chats (title or "New chat", relative time, creator's name), "New chat" `secondary` at the top; right the coach chat. Below 1024 px the list collapses behind a "Chats" `icon-button` in the page head (a sheet). Page title "Coach", lede "Practise with your assistant and teach it what's changed."

### empty (no chats yet, or a new chat)

- `empty-state` inside the thread: heading "Ask your assistant something", body "Try a question your customers often ask.", then up to 6 suggestion `chip`s from `/coach/suggestions`; tapping one sends it. The session is created on the first send.

### answering, populated, proposed change, confirmed

- As in the cross-screen section.

### loading, error, not-found

- loading: skeleton list rows and three skeleton bubbles. error: `error-state` "Couldn't load your practice chats." [Retry]. Unknown or other-tenant `?session` (404): `empty-state` "This chat isn't available." [Start a new chat].

## SCR-APP-010 — Wizard · Test your assistant (partial)

- **Strategy and source:** code-native (this section). Partial: the wizard frame is FEAT-035, as SCR-APP-008.
- **Route:** `/setup/test`. The review step's Continue goes here; this step's Continue goes to `/`.
- **Contract bindings:** `POST /api/v1/coach/sessions` (origin `setup`), `POST …/messages`, the correction routes, `GET /api/v1/coach/suggestions`.
- **Page:** lede "Step 4 of the setup", title "Test your assistant", body "Ask the questions your customers ask. If an answer is wrong, tell your assistant what's right." Then the coach chat with the suggestions shown as chips above the composer (always visible on this step, not only when empty). Footer: `primary` "Continue" and caption "You can keep practising any time in Coach." The include-unreviewed toggle is shown here too, because most facts may still be unreviewed during setup.
- **States:** empty (suggestions), answering, populated, proposed change, confirmed, error, as SCR-APP-030. No facts approved yet: alert info above the chat "You haven't approved any facts yet, so your assistant can't answer much. Approve facts in the previous step, or include unreviewed facts to try them out." with a link back to `/setup/review`.

## Quick coach panel (`quick-coach-panel`) on SCR-APP-019 and SCR-APP-028

- **Strategy and source:** code-native (this section); the component is design.md §4.6's.
- **Entry points:** an "Ask Coach" `ghost` button with the coach icon on each Review fact card (SCR-APP-019) and in the Fact page head (SCR-APP-028). The Conversation screen entry point is left to FEAT-028.
- **Behaviour:** ≥ 768 px opens the right slide-over (400 px, shadow-lg, focus trapped, Esc closes, focus returns to the trigger) with a new session (origin `panel`) and the composer prefilled, not sent: product "How much is {name}?", FAQ "{question}", policy "What's your {title}?", promotion "Is the {title} still on?". The include-unreviewed toggle starts **on** when the fact is `needs_review`, so the owner can test it. Header "Coach" with "Open in Coach" link (`/coach?session=:id`) and close `icon-button` ("Close coach"). Below 768 px, the button navigates to `/coach?ask={prefill}` instead (UX-Q3).
- **States:** as the coach chat. A confirm in the panel needs the same tap; the panel never changes facts silently (design.md §4.6). After a confirm on the Fact page, the page refetches the fact.

## Gaps and escalations

- Gaps: wizard frame (FEAT-035); the corrections queue the "Not now" text points to (FEAT-018); Conversation-screen entry point and replay (FEAT-028).
- Escalations: none. No design-system change is needed.
