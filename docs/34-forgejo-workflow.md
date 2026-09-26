# 34. Forgejo workflow and agent worktrees

Local Forgejo at `http://localhost:3000` is the source of truth; GitHub (`origin`)
is the public remote copy, described under [GitHub](#github) below.
`corey/astra_test` is the only project repository: the map
generator lives in `mapgen/` (see [20](20-micro-generation.md)). The old
`corey/last_exit_map` repository is retired: open no work against it.

This file governs top-level agents that each hold their own Forgejo account.
Subagents that a lead spawns inside one session follow [32](32-delegation.md)
instead, and do not commit unless their brief says so.

## Who works where

One local repository, one long-lived worktree per agent, next to the primary
checkout rather than inside it. A nested worktree would load the primary
checkout's instruction files as well as its own, and would show up in searches
from the primary checkout.

| Agent | Forgejo account (commit email) | Worktree | Branch prefix |
| --- | --- | --- | --- |
| Claude Code | `agent-claudecode` (`claudecode@local.host`) | `../astra_test.agents/claude` | `claude/` |
| Codex | `agent-codex` (`codex@local.host`) | `../astra_test.agents/codex` | `codex/` |
| Antigravity | `agent-antigravity` (`antigravity@local.host`) | `../astra_test.agents/antigravity` | `antigravity/` |

The primary checkout (`astra_test/`) belongs to the human: `main`, reviewing and
merging. Agents never commit there and never touch another agent's worktree.

Each worktree carries its own identity in `config.worktree`: `user.name`,
`user.email`, and a `remote.forgejo.pushurl` holding that agent's access token,
so pushes are made as the agent and not as the repository owner. If
`git config --show-origin --get remote.forgejo.pushurl` shows nothing, or a push
is recorded as `corey`, stop and report it rather than pushing.

## Instruction loading

`AGENTS.md` is the single source of instructions, with a nested `mapgen/AGENTS.md`
for that directory. Codex reads both natively. Each directory's `CLAUDE.md` holds
only `@AGENTS.md`, which Claude Code imports at session start. A worktree sees only
committed files, so an instruction change reaches an agent once it is merged and
the agent starts its next branch from fresh `forgejo/main`.

## The task loop

1. Find work with `list_assigned_issues`; claim it with `assign_issue`.
2. In your worktree: `git fetch forgejo`, then
   `git switch -c <prefix>/<feature> forgejo/main`. Run `npm ci` (and in `mapgen/`)
   when a lockfile changed.
3. Commit only to that branch. Never check out, commit to, merge or rebase onto
   `main` or another agent's branch.
4. Run the gates in [31](31-verification.md) for what you touched, then
   `git push -u forgejo HEAD`.
5. Open the PR with `create_pull_request`, linking the issue ("Fixes #N").
   Re-running it returns the existing PR. Say in the body which gates ran and
   which were skipped.
6. Review others with `list_pull_requests` and `get_pull_request_diff`
   (`git fetch forgejo pull/N/head` if the diff is truncated). Post the verdict
   with `submit_pull_request_review` (`APPROVED`, `REQUEST_CHANGES` or `COMMENT`);
   if it reports a pending review, post the verdict with `create_comment`
   instead. Use `create_comment` for discussion.
7. Humans merge; `main` is protected and needs one approval. Do not merge. After
   a merge, start the next task from step 2; the merged branch is left for the
   human to delete.

## Setting up a worktree

Done once per agent by the human or the lead, from the primary checkout.
`extensions.worktreeConfig` must be on (it is set once for the repository).

```sh
git worktree add --detach ../astra_test.agents/<agent> forgejo/main
git -C ../astra_test.agents/<agent> config --worktree user.name  <account>
git -C ../astra_test.agents/<agent> config --worktree user.email <commit email>
git -C ../astra_test.agents/<agent> config --worktree remote.forgejo.pushurl \
  http://<account>:<token>@localhost:3000/corey/astra_test.git
(cd ../astra_test.agents/<agent> && npm ci && npm --prefix mapgen ci)
```

## GitHub

`origin` is `github.com/HobbesSR/last-exit-prototype`, which is public. It makes
the project reachable away from this machine and lets work start elsewhere.
The local side is managed with git and the Forgejo tools; the GitHub side with
`gh`.

- **Only the human pushes to `origin`.** An agent never pushes there: its
  worktree carries a Forgejo push identity only, so a push to `origin` would
  go out under the human's GitHub credentials.
- **`main` moves on Forgejo first.** In the primary checkout, `main` pulls from
  `forgejo` and pushes to `origin` (`branch.main.remote` and
  `branch.main.pushRemote`), so after a merge `git pull` then `git push`
  publishes it. Nothing is merged on GitHub, which keeps the two `main`s from
  diverging.
- **Branches made on GitHub are reviewed on Forgejo.** For work pushed to
  GitHub from elsewhere, list it with `gh pr list` or `git fetch origin`, bring
  it across with `git push forgejo origin/<branch>:refs/heads/<branch>`, and
  open the PR on Forgejo. Delete the GitHub branch with `gh` once it has merged.
- **No Forgejo push mirror.** A push mirror runs `git push --mirror`, which
  deletes every GitHub branch that Forgejo lacks, including branches started
  on GitHub.
