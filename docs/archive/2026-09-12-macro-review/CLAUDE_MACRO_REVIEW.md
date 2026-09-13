# Claude task: independent macro composition review

Status: ARCHIVED / COMPLETE. Results ingested by Codex on 2026-09-12.

## Objective and context

Review the experimental macro composer for concrete correctness gaps before
generator integration. Read AGENTS.md, README.md, docs/DESIGN_DECISIONS.md,
docs/NEXT_TASKS.md, docs/MACRO_STRUCTURES.md, src/macro-types.ts, src/macro.ts,
tests/macro.test.ts and relevant shared navigation/region helpers.

The implemented milestone is the versioned contract and executable composition
fixtures. The GUI/CLI/MCP still use the old generator by design. Existing evidence:
65 passing tests, browser pass, and 200/200 legacy generation seeds. No randomized
macro placement pass exists yet. There is no Git repository at this root.

## Scope and ownership

Review source read-only. Your sole writable output is
`docs/CLAUDE_MACRO_REVIEW_RESULTS.md`. Do not change code, schemas, other docs or
dependencies, spawn agents, contact external services, or modify ../astra_test.
Preserve current files and inspect them rather than assuming the brief is current.
Codex owns fixes and integration; this assignment is an independent review.

Check all four cell/segment rotations, asymmetric spans, order independence,
overlapping ownership, arbitrary/disconnected masks, filled-cell navigation
exclusion, malformed author input, route constraints and corridor reservations
near ownership boundaries. Prefer small concrete failures over speculative
redesign. Continuous navigation completeness is deliberately not promised:
the half-cell lattice proves found routes but may miss real routes.

Read-only diagnostic commands are allowed. Existing acceptance command:
`node --test tests/macro.test.ts`. `npm test` includes typecheck. Do not claim
checks were run unless you ran them. Avoid rerunning the browser or 200-seed
batch; they exercise the legacy generator, outside this review's focus.

## Required result

Write a self-contained result file with status COMPLETE or BLOCKED, files reviewed,
actual validation commands/results, then prioritized actionable findings. Each
finding needs a source line reference, the violated contract, and a small
reproducer or precise test proposal. Separate correctness bugs from optional
improvements. If no bugs are found, say so. Escalate unresolved schema ambiguity
in the result file instead of changing the contract. End with suggested next
action for Codex. Do not implement fixes.

Launch prompt: Read AGENTS.md and docs/CLAUDE_MACRO_REVIEW.md, perform the review,
and write docs/CLAUDE_MACRO_REVIEW_RESULTS.md.
