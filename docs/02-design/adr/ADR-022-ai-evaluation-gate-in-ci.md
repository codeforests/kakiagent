# ADR-022: AI evaluation gate in CI

**Status:** Accepted — architecture phase signed off by the product owner on 2026-10-19
**Date:** 2026-10-19
**Requirements addressed:** AGT-14, AGT-01, AGT-02, AGT-03, AGT-04, AGT-07, AGT-13, AGT-16, LED-07, NFR-12, NFR-13, GOV-03, GOV-09, D1

**Context**
AGT-14 requires a versioned evaluation set for the pilot vertical (F&B, bakery and catering, D1) with at least 300 cases: groundedness, prices (≥ 50), Singlish (≥ 100), Simplified Chinese (≥ 50), out-of-scope (≥ 50), harmful content (≥ 20), plus the red-team suite (≥ 50, AGT-07). It runs in CI, and a release that lowers any threshold in AGT-01..04, AGT-07 or AGT-13 is blocked. The automated scorer must agree with human labels on ≥ 90% of a 10% sample, re-checked for each new evaluation-set version.

**Decision**
- **Location and format:** `evals/` in the monorepo, JSONL cases with a semantic version, fixture tenants (a bakery and a caterer with a known KB, plus a second tenant for cross-tenant probes), and expected outcomes per case: expected fact IDs, allowed price slots, expected intent, expected action (answer / refuse / escalate / capture lead / withdraw consent).
- **Runner:** a TypeScript CLI that drives the **real** agent pipeline (triage, retrieval, generation, slot rendering, verifier, tool calls stubbed to recorders) against Bedrock with production model IDs and prompts.
- **Scorers:**
  - *Deterministic:* price and slot correctness, verifier hits, tool calls, cross-tenant and internal-data leakage (AGT-16, GOV-03), and LED-07 withdrawal detection.
  - *LLM judge:* Claude Opus 5.5 (a different model from the generators) with a rubric, for groundedness, intent and register (AGT-03), and harmful-content handling.
  - *Agreement check:* each new evaluation-set version ships with a human-labelled 10% sample; CI fails the eval job if judge–human agreement falls below 90%.
- **Gates:**
  - A fast subset (~60 cases) runs on every PR touching `agent`, `kb`, prompts or model config.
  - The full suite runs on every release candidate in the staging pipeline.
  - Thresholds live in `evals/thresholds.json`, and any drop below a threshold blocks promotion to prod.
  - Reports include cost per case to watch NFR-13.
- **Cost:** a full run is about 400 cases × (pipeline + judge), on the order of US$10–20; the fast subset is about US$2–4.

**Options considered**
- **In-repo TypeScript runner on the real pipeline (chosen)** — tests what ships, versioned with the code, fits C1. Con: we maintain the runner.
- **A hosted eval platform** — dashboards out of the box. Lost: sends tenant-like data and prompts to another processor; harder to run the real verifier code.
- **Human review only** — accurate. Lost: cannot gate every release.

**Consequences**
Prompt, model and routing changes are treated like code changes, with measurable effects. Building the evaluation set (especially the Singlish and Chinese cases) is real work that implementation planning must schedule early; pilot SMEs (SRS §8 item 1) are a source of realistic cases. GOV-09 oversight findings can be promoted into new evaluation cases.
