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

## Delegation

The user asks for cost-aware delegation, used proactively where tools and runtime
rules permit it. The lead keeps architecture, ambiguous diagnosis, cross-system
contracts and integration review; [32](docs/32-delegation.md) routes the rest by
work type and model, and holds the worker brief. Claude Code leads name a model on
every spawn, since an unnamed one inherits the lead's
([32](docs/32-delegation.md#claude-code-workers)).

## Project invariants

- The frozen characterization fixture is `behavior-physics-1.v8.gz`, the physics
  engine every match runs. [31](docs/31-verification.md) owns verification policy; the
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
- Before adding third-party code, assets or a newly served package, check that its licence is
  compatible with the project's MIT licence, and record it with its notices
  ([21.1](docs/21.1-third-party-licenses.md)). Escalate copyleft, non-commercial or
  unlicensed material; never add it without asking.
- When a rule changes, update its numbered document in the same change.
  `docs/33-maintenance.md` says where each kind of fact belongs.

## Verification

[31](docs/31-verification.md) holds the rules; these are the ones to act on without
looking them up.

- Run test scripts through the thin reporter, `npm run brief -- <script>`. Start long
  runs in the background and wait for the exit notification; do not poll their output.
- Choose checks by changed area from
  [31's table](docs/31-verification.md#choosing-checks-by-changed-area), not by
  default: never `test:all`, `test:browser` or the benchmarks unless your area calls
  for them. `npm test` is the gate before a PR.
- Adding, growing or slowing a test carries a cost statement in the PR
  ([31](docs/31-verification.md#test-cost)).

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
[32](docs/32-delegation.md) instead. [34](docs/34-forgejo-workflow.md) has the full
loop, the agent accounts, the worktree table and how to review.

Forgejo (the `forgejo` remote) is the source of truth; GitHub (`gh`) is a public copy
only the human pushes to. Hosting, runner, network and credential details live in
the private `corey/studio-ops` repository, never here. Use the `forgejo` MCP tools,
which act as your own agent account (Antigravity loads them through `call_mcp_tool`
with `ServerName: forgejo`).

- Work only in your own worktree, on a `<agent>/<feature>` branch from fresh
  `forgejo/main`. Never commit in the primary checkout, on `main`, or in another
  agent's worktree.
- Review from the diff; do not re-run the author's tests except as 34 allows.
- Humans merge. Do not merge.
