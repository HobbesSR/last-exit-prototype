# Last Exit project instructions

## Start and resume

Inspect `git status` and current files before acting. Read `FRESH_SESSION.md` when
present for checkpoint context, then `docs/00-index.md` and the numbered files it
points to for the area you are changing. The documentation and newer user edits
take precedence over stale handoff summaries. Preserve `FRESH_SESSION.md` and its
earlier notes; it must remain untracked. Do not stage or overwrite unrelated user
changes.

Load the documentation you need, not all of it. `docs/1x` is product, `2x` is
engineering, `3x` is process, `4x` is plan and history. Cite the number, not a
heading, in briefs and handoffs.

## Model delegation requested by the user

Use cost-aware delegation proactively when tools and runtime rules permit it.
Keep architecture, ambiguous diagnosis, cross-system contracts and integration
review with the lead (Astra when available). Prefer `gpt-5.6-terra` with medium
reasoning for bounded implementation/tests; use `gpt-5.6-luna` with low/medium
reasoning for mechanical edits and focused inventories. Check actual available
models; do not silently spawn flagship workers for routine tasks.

Delegate only when the task is independently actionable and the lead has useful
work alongside it. Assign non-overlapping file ownership, supply a compact brief,
and review the result. Keep tiny tasks local. Workers must escalate changes to
contracts or unresolved requirements rather than invent product decisions.
See `docs/32-delegation.md` for the task brief and manual-switch handoff convention.

## Project invariants and verification

- The frozen characterization fixture comes from `5dd7d61`. Never regenerate it
  to make a refactor pass. Separate intentional gameplay changes and their new
  expectations/version decisions from behavior-preserving extraction.
- Preserve fixed-tick order, input latching, RNG/ID order, snapshot and replay
  compatibility unless the task explicitly calls for a reviewed change.
- Follow existing ownership boundaries. Server application code must not use the
  diagnostic `room.game` escape hatch; tests and benchmarks may arrange scenarios.
- Read current requirements before implementing accepted gameplay additions.
  "Accepted" does not imply implemented; resolve concrete open choices through
  existing user answers in `docs/17-open-questions.md` or explicitly recorded
  assumptions appropriate to the task.
- Run focused checks for changed behavior. Integration checkpoints use
  `npm run check`, `npm test`, `npm run test:browser`, `npm run bench` and
  `npm run bench:client` as appropriate to the affected subsystem. Run timing
  comparisons sequentially without competing tests/benchmarks; repeat suspected
  regressions three times. Do not claim the reported slowdown fixed without evidence.
- When a rule changes, update its numbered document in the same change.
  `docs/33-maintenance.md` says where each kind of fact belongs.
