# Evaluation cases

One JSON file per case set, each an array of cases matching `Case` in `../src/cases.ts`.
Cases run through the agent's `composeReply` on a fixture tenant (`../fixtures/`), with
in-memory retrieval over its facts. `recorded` holds the fake model's output per attempt
(slots written as `[[f:<first 8 hex of the fact ID>.<field>]]`); without it the fake
answers from the facts in its prompt. Expectations: `contains`, `not-contains`,
`matches`, `prices-from-facts` (every `S$` amount is a visitor-facing price of the
tenant's facts) and `cites` (the fact IDs used include `ids`, all of them with
`exact`, and none from another tenant).

Every case also runs the agent's triage, routing and dispatch first (FEAT-004). `plan`
holds the triage model's recorded output, in the wire shape (arguments as
`{ "name", "value" }` pairs), or a string played back as is to test the fallback;
without it the fake triager plans from keywords. `expectTasks` (the plan's task kinds,
in any order) and `expectRoute` (`reply.simple` or `reply.complex` at the default
policy) score the plan and the route; such cases go in the `multi-task` subset. Every
case must also pass the dispatch check: each non-`answer` task is reported
`unhandled` by the empty registry. The run ends with the cost per conversation. Agent features add their own cases (implementation plan §3:
FEAT-022 prices and groundedness, FEAT-004 multi-task, FEAT-023 Singlish, Chinese and out-of-scope,
FEAT-025 red-team and harmful content, FEAT-051 withdrawal). Mark a case `fast: true`
to include it in the PR subset.

FEAT-023 runs the turn's reply decision (`answerTurn`: the fixed out-of-scope and
"unsure" texts, or the verified reply plus closing texts) in the reply language
(`replyLanguage`) with the fixture's opening hours. A case's `at` (an ISO instant,
default Wed 21 Oct 2026 11:00 SGT, when the bakery is open) is when the visitor writes,
so the hours slots and the after-hours notice don't depend on when CI runs; each case is
one conversation, so the notice is due whenever the business is closed. The dispatch
check expects `done` for task kinds the visitor registry handles (`out_of_scope`) and
`unhandled` for the rest. New expectations: `language` (`zh`: Han characters are at
least 30% of the letters; `en`: none), `outcome` (`answered`, `escalated`,
`out_of_scope`, `unsure`, `unavailable`), `notice` (`present`, with an optional
`contains`), `retrieves` (fact IDs in the retrieved set) and `judge` (`language`,
`register`, `out-of-scope` or `grounded`, scored by the LLM judge with a real model only;
on the fake provider they are reported as pending). A case marked
`needs: "semantic-embedder"` (pure-Chinese retrieval) is skipped and reported until the
multilingual embedder is in (P3).

The judge's agreement sample is `../labels/agreement-sample.json`, for the eval-set
version in `../version.json`. Every run checks that the versions match and that the
sample has at least 10% as many items as there are `judge` expectations; with a real
model the judge must agree with at least 90% of the labels, and the run refuses a
sample whose `labelledBy` starts with `draft` until a person has confirmed every label.
