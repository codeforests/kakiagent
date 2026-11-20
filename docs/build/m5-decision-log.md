# M5 decision log

Ken asked on 2026-11-20 for M5 (FEAT-061 → 059 → 062 → 070 → 063 → 010 → 067 → 065 → 066 → 071 → 072 → 073) to run without waiting for him, and to review every decision taken on his behalf on **2026-11-27**. Each stage appends here in the same commit as the decision (STATE.md, Ken's rules).

How to read it: newest feature at the bottom. **Revisit?** says how costly a different answer would be later: *cheap* (copy, a constant), *moderate* (a migration or a screen change), *costly* (data already written, or other features built on it).

| # | Date | Feature · stage | Decision (what was decided, and the options) | Why | Revisit? | Where |
|---|---|---|---|---|---|---|
| 0 | 2026-11-20 | M5 · orchestration | Ken: verify stages squash-merge on green without his approval (chosen over stacking unmerged PRs or pausing at each PR). Each stage runs in its own fresh cloud session started from the orchestrating session. | Ken's answer, 2026-11-20 | cheap: revert a merge | STATE.md, Ken's rules |
