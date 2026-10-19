# Evaluation cases

One JSON file per case set, each an array of cases matching `Case` in `../src/cases.ts`.
Cases run through the agent's `composeReply` on a fixture tenant (`../fixtures/`), with
in-memory retrieval over its facts. `recorded` holds the fake model's output per attempt
(slots written as `[[f:<first 8 hex of the fact ID>.<field>]]`); without it the fake
answers from the facts in its prompt. Expectations: `contains`, `not-contains`,
`matches`, `prices-from-facts` (every `S$` amount is a visitor-facing price of the
tenant's facts) and `cites` (the fact IDs used include `ids`, all of them with
`exact`, and none from another tenant). Agent features add their own cases (implementation plan §3:
FEAT-022 prices and groundedness, FEAT-023 Singlish, Chinese and out-of-scope,
FEAT-025 red-team and harmful content, FEAT-051 withdrawal). Mark a case `fast: true`
to include it in the PR subset.
