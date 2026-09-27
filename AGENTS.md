# Last Exit project instructions

## Start and resume

Inspect `git status` and current files before acting. When resuming an issue, read
its latest handoff comment on Forgejo, then `docs/00-index.md` and the numbered
files it points to for the area you are changing. The documentation and newer user
edits take precedence over stale handoff comments. Do not stage or overwrite
unrelated user changes.

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

- The current frozen characterization fixture is `behavior-netcode-1.json.gz`,
  captured at `95b7f1b`; its provenance is `5dd7d61` (captured at `0cd204e`) →
  `elements-1` (`9fe2d94`) → stored-arenas split (`aa833a6`) → `netcode-1`.
  Never regenerate it to make a refactor pass. Separate intentional gameplay
  changes and their new expectations/version decisions from behavior-preserving
  extraction.
- Preserve fixed-tick order, one-input-per-tick ordering, RNG/ID order, snapshot and replay
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

## Repository layout

This one repository holds the whole project. The game is at the root; the map
generator is in `mapgen/`, with its own `package.json`, tests, docs and a nested
`AGENTS.md` that applies when working there. The game does not import `mapgen/`
yet. `CLAUDE.md` files only import `AGENTS.md`; edit `AGENTS.md`, not them.

## Forgejo workflow

Local Forgejo (http://localhost:3000) is the source of truth. GitHub (`origin`) is
the public remote copy, which only the human pushes to; agents push only to
`forgejo`. Use the `forgejo` MCP tools, which act as your own agent account
(Antigravity loads them through `call_mcp_tool` with `ServerName: forgejo`).
`docs/34-forgejo-workflow.md` has the full loop and the worktree table.

- Work only in your own worktree, `../astra_test.agents/<agent>`, on a
  `<agent>/<feature>` branch started from fresh `forgejo/main`. Never commit in
  the primary checkout, on `main`, or in another agent's worktree.
- Claim issues with `assign_issue`, push with `git push -u forgejo HEAD`, open the
  PR with `create_pull_request` ("Fixes #N"), and review others' PRs with
  `submit_pull_request_review`.
- Humans merge. Do not merge.
