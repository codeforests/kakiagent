# Handoff: FEAT-033 — Widget visitor controls and EN / 中文 chrome
Branch: feat/FEAT-033-widget-controls · PR: none · Updated: 2026-10-26 by build (backend)
Stage done: build (T1–T4 of 9)
Next: build (UI, T5–T9) — kickoff: "Build FEAT-033 (UI) on branch feat/FEAT-033-widget-controls. Read docs/build/STATE.md, then run .claude/skills/feature-stage/SKILL.md, stage build."

## What the next stage needs
- Contracts (`@kaki/contracts`): `Message.language: 'en' | 'zh' | null`; `WidgetConfigResponse.privacyNoticeUrl: string | null` and `.controls: { talkToPerson: boolean }`; `EndConversationResponse` (`{ status: 'closed' }`).
- Route: `POST /widget/v1/conversations/:id/end`, no body, `Authorization: Bearer <token>` + Origin like the messages route. 200 `{ status: 'closed' }` every time (idempotent); 404 `not_found` for an unknown or someone else's id; 401 on token/Origin.
- `POST …/:id/messages` on a closed chat: 409 `{ error: 'chat_ended', message: 'This chat has ended.' }` (map to `ChatEndedError` in `api.ts`). A retry of an already stored `clientMessageId` is still 200.
- Config always returns `privacyNoticeUrl: null`, `controls.talkToPerson: false`: stub the config with `page.route` + `route.fetch()` to see the privacy link (code-map E2E pitfalls).
- Agent replies (and system fallbacks from a turn) carry `language` from the turn; visitor and staff messages are `null`; replies stored before 0032 are `null`.
- T1 already gave `preview.ts` the two config fields and `language: null` on its sample messages; `chat.test.ts`/`api.test.ts` fixtures have `language: null`.
- Ending notifies the dashboard inbox with a `conversation` summary (status `closed`, last message kept), so the E2E can check the inbox list shows it closed.
- D5 changed one FEAT-025 test (`packages/agent/test/safety.int.test.ts`): after an abuse end, a new message is now refused with `ConversationClosedError` instead of being stored and ignored; the gate's silence on a message stored before the close is covered by the new case in `language-hours.int.test.ts`. The verifier should review this as a design-mandated change, not a weakened test.
- Removed an unused `TENANT_B` import in `apps/api/test/widget.int.test.ts` that failed `pnpm lint` on main.

## Left to CI or later
- `apps/api/test/uploads.int.test.ts` "S3 presigner" needs Docker or `KAKI_TEST_S3_ENDPOINT`; it fails in cloud sessions on main too. All other api, inbox and agent integration tests pass here.
- E2E `widget-controls.e2e.ts` and the size budget run in Ken's local CI: the feature touches the widget, so CI is due before merge.

## Pending for Ken
- Nothing blocks the UI build. Ken's local CI before merge (widget touched).
