# Evaluation cases

One JSON file per case set, each an array of cases matching `Case` in `../src/cases.ts`.
The set starts empty. Agent features add their own cases (implementation plan §3:
FEAT-022 prices and groundedness, FEAT-023 Singlish, Chinese and out-of-scope,
FEAT-025 red-team and harmful content, FEAT-051 withdrawal). Mark a case `fast: true`
to include it in the PR subset.
