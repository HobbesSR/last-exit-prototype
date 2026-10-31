# Last Exit project instructions

## Start and resume

Inspect `git status` and current files before acting. When resuming an issue or
pull request, read its latest handoff comment on Forgejo, then `docs/00-index.md`
and the numbered files it points to for the area you are changing. The documentation
and newer user edits take precedence over stale handoff comments. Do not stage or overwrite
unrelated user changes. Handoffs describe checkpoints and suggestions, not new
requirements or automatic priority. For epic-directed work, reassess the whole
epic before choosing the next task, using the functional-tier selection and
stopping rules in [32](docs/32-delegation.md).

Load the documentation you need, not all of it. `docs/1x` is product, `2x` is
engineering, `3x` is process, `4x` is plan and history, `5x` is map generation.
Large numbered documents are reading guides to decimal children (for example,
51.7). Follow the relevant route; do not load every child. Cite the most specific
owning number, not a heading, in briefs and handoffs. See 00 and 33 for numbering.

## Model delegation requested by the user

Use cost-aware delegation proactively when tools and runtime rules permit it.
Keep architecture, ambiguous diagnosis, cross-system contracts and integration
review with the lead. When choosing a GPT lead, prefer `gpt-6.1-sol` for deep
reasoning and broad context, and `gpt-6-astra` for creative direction and
imagining systems' physical behavior. Prefer `gpt-6.1-sol` with medium reasoning
for bounded implementation/tests, especially algorithmically dense or
high-invariant ones, and `gpt-6-luna` with low/medium reasoning for mechanical
edits, focused inventories and simple, fully specified tests. Use `gpt-6.1-terra`
for visual work: testing tools, labs and other GUI elements through screenshots,
and ingesting images and documents. Not for live game playing. Check
actual available models; do not silently spawn flagship workers for routine tasks.

Delegate only when the task is independently actionable and the lead has useful
work alongside it. Assign non-overlapping file ownership, supply a compact brief,
and review the result. Keep tiny tasks local. Workers must escalate changes to
contracts or unresolved requirements rather than invent product decisions.
See `docs/32-delegation.md` for the task brief and manual-switch handoff convention.

## Project invariants and verification

- The current frozen characterization fixture is `behavior-nav-1.json.gz`.
  [31](docs/31-verification.md) owns verification policy; the
  [fixture README](tests/fixtures/README.md) owns the full provenance and digests.
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
- Run focused checks for changed behavior. `npm test` is the fast tier for
  iterating; `npm run test:all` adds the slow seed sweeps and whole-match runs.
  Choose the rest by changed area from the table in
  [31](docs/31-verification.md#choosing-checks-by-changed-area): it gives each
  area's inner-loop, pre-PR and integration checks and what each `tests/slow/` file
  can move. Do not default to `test:all`, `test:browser` or the benchmarks. Run timing
  comparisons sequentially without competing tests/benchmarks; repeat suspected
  regressions three times. Do not claim the reported slowdown fixed without evidence.
  Forgejo CI runs the fast gates on each PR and the slow tier after merge, filing an
  issue per slow failure (`docs/31`), so a PR may be opened on `npm test` alone; it
  does not replace the other checks your change needs. Fix a failed PR run before the
  PR is ready; run `npm run test:slow` first when your change is likely to move it.
- A new or grown test file stays under 15 s (fast tier) or 60 s (`tests/slow/`); check it with
  `npm run test:times -- <file>`. Optimize, split or gate expensive cases behind an environment
  variable rather than adding minutes to every run (`docs/31`).
- Before adding third-party code, assets or a newly served package, check that its licence is
  compatible with the project's MIT licence, and record it with its notices
  ([21.1](docs/21.1-third-party-licenses.md)). Escalate copyleft, non-commercial or
  unlicensed material; never add it without asking.
- When a rule changes, update its numbered document in the same change.
  `docs/33-maintenance.md` says where each kind of fact belongs.

## Repository layout

This one repository holds the whole project. The game is at the root, and
`shared/` is its portable core, which the server and the browser both run. Map
generation is in `map/`:
- `map/macro/` is the map generator ("mapgen"), with its own `package.json`
  and tests, and a nested `AGENTS.md` that applies when working there. It owns
  macro generation.
- `map/micro/` owns what fills a region.
- `map/kernel/` holds what both must agree on. It imports nothing outside
  itself.

`map/` builds on the core, and `shared/` never imports `map/`; a test holds
both rules. Map generation is documented in `docs/5x` together with 19 and 20
(`docs/50`), and mapgen's former docs are archived. `CLAUDE.md` files only
import `AGENTS.md`; edit `AGENTS.md`, not them.

## Forgejo workflow

These rules are for top-level agents; in-session subagents follow
`docs/32-delegation.md` instead (see 34).

Forgejo, on the human's home network (the `forgejo` remote), is the source of
truth. GitHub (`gh`) is the public remote copy, which only the human pushes to;
agents push only to `forgejo`. Because this repository is public, hosting,
runner, network and credential details live in the private `corey/studio-ops`
repository on Forgejo, never here. Use the `forgejo` MCP tools, which act as your own agent account
(Antigravity loads them through `call_mcp_tool` with `ServerName: forgejo`).
`docs/34-forgejo-workflow.md` has the full loop, the agent accounts and the
worktree table.

- Work only in your own worktree, `../astra_test.agents/<agent>`, on a
  `<agent>/<feature>` branch started from fresh `forgejo/main`. Never commit in
  the primary checkout, on `main`, or in another agent's worktree.
- Claim issues with `assign_issue`, push with `git push -u forgejo HEAD`, open the
  PR with `create_pull_request` ("Fixes #N", saying what testing you did), and
  review others' PRs with `submit_pull_request_review` (trusting the author's
  testing assertions when the scope matches the commit, while retaining discretion
  to re-run focused checks if validation appears stale or incomplete).
- Humans merge. Do not merge.
