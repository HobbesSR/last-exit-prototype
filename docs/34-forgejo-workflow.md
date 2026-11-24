# 34. Forgejo workflow and agent worktrees

Forgejo, on the human's home network (see [Hosting](#hosting)), is the source
of truth. GitHub (`gh`) is a public copy that only the human pushes to: never push
there. Worktree setup, GitHub publishing and the Forgejo tool server's internals
are in [34.1](34.1-worktree-setup-and-github.md).

This file governs top-level agents that each hold their own Forgejo account.
Subagents that a lead spawns inside one session follow [32](32-delegation.md)
instead, and do not claim issues, create branches, commit, push or open pull
requests unless their brief says so.

## Who works where

One local repository, one long-lived worktree per agent, next to the primary
checkout rather than inside it. A nested worktree would load the primary
checkout's instruction files as well as its own, and would show up in searches
from the primary checkout.

| Agent | Forgejo account (commit email) | Worktree | Branch prefix | Dev port |
| --- | --- | --- | --- | --- |
| Human | `corey` | `astra_test/` (primary) | — | 3100 (default) |
| Claude Code | `agent-claudecode` (`claudecode@local.host`) | `../astra_test.agents/claude` | `claudecode/` | 3110 |
| Codex | `agent-codex` (`codex@local.host`) | `../astra_test.agents/codex` | `codex/` | 3120 |
| Antigravity | `agent-antigravity` (`antigravity@local.host`) | `../astra_test.agents/antigravity` | `antigravity/` | 3130 |
| Hermes | `agent-hermes` (`hermes@local.host`) | `../astra_test.agents/hermes` | `hermes/` | 3140 |

The primary checkout (`astra_test/`) belongs to the human: `main`, reviewing and
merging. Agents never commit there and never touch another agent's worktree.

Each worktree carries its own identity in `config.worktree`: `user.name`,
`user.email`, and a `remote.forgejo.pushurl` holding that agent's access token,
so pushes are made as the agent and not as the repository owner. If
`git config --show-origin --get remote.forgejo.pushurl` shows nothing, or a push
is recorded as `corey`, stop and report it rather than pushing.

Each worktree also has an untracked, ignored `.env.local` at its root naming its
dev port, e.g. `PORT=3110`. `npm run dev` from the root loads it, so a server an agent starts to look at by hand or drive
with a browser lands on that agent's own port. An assigned port is used exactly:
if it is busy the server stops rather than drifting onto a neighbor's port, and
the busy one is almost always your own earlier server. If `.env.local` is
missing, create it from the table before starting a dev server. The Map Lab and the other
labs are served by the game server on that same port ([20.5](20.5-tools-and-next-boundaries.md)).

## Instruction loading

A worktree sees only committed files, so a change to `AGENTS.md` (or a numbered
document) reaches an agent once it is merged and the agent starts its next branch
from fresh `forgejo/main`.

## The task loop

1. Find work with `list_assigned_issues`; claim it with `assign_issue`. When the
   user names an epic, select the next functional outcome under
   [32](32-delegation.md) before claiming or creating an implementation task.
2. In your worktree: `git fetch forgejo`, then
   `git switch -c <prefix>/<feature> forgejo/main`. Run `npm ci` (and in `map/macro/`)
   when a lockfile changed.
3. Commit only to that branch. Never check out, commit to, merge or rebase onto
   `main` or another agent's branch.
4. Run the gates in [31](31-verification.md) for what you touched, then
   `git push -u forgejo HEAD`. A change that moves generated maps follows 31's
   [content-change rule](31-verification.md#content-changes-one-bump-per-batch):
   it lands switched off, or joins the open batch, rather than bumping the
   content version on its own.
5. Open the PR with `create_pull_request`, linking the issue ("Fixes #N").
   Re-running it returns the existing PR. Say in the body what testing you did,
   including which gates ran and which were skipped. A PR that adds, grows or
   turns on a test, or makes existing tests slower, also states the cost to the
   test workflow (31, [A test's cost is part of the change](31-verification.md#test-cost)).
6. Review others with `list_pull_requests` and `get_pull_request_diff`
   (`stat` for the file list, `file` or `offset`/`limit` for parts). **Review reads
   widely and runs narrowly.** Reviewers once checked out PR branches and re-ran
   suites the author had already run, one starting a full chain sweep (#885); the
   fix's wording, read literally as "judge only the hunks", would let a reviewer
   miss callers, duplicated owners and required version bumps (#1113). Read the diff, the issue it closes,
   and the repository around it: the callers and users of anything it changes,
   the module that already owns any new helper (a duplicate is a finding), and the
   numbered documents and AGENTS.md invariants it touches. Look for what the diff
   should contain but doesn't, such as a version bump, a doc update or a call site
   left on the old path. Read that context at `forgejo/main` in your own worktree,
   or with `git show <head>:<path>` for the PR's version of a file; do not check out
   the PR branch. Do not re-run suites, sweeps or benchmarks. The author's
   testing statement is the evidence when its scope matches the commit; one that is
   missing, stale or mis-scoped is a review finding, not a cue to run the tier
   yourself. Two exceptions, and only these:
   - one targeted command (a test file, a pattern, a single check) that would
     confirm or refute a concrete defect you saw in the diff;
   - for a renderer or client PR whose author did not run the browser scripts its
     area names ([31](31-verification.md#choosing-checks-by-changed-area)), those
     scripts: Node checks alone have approved a renderer change that threw every
     frame (PR #343).

   Do not wait for CI. Review on the assumption that verify will pass; a pending
   verify is not a finding. A failure is dealt with when it shows up, by the human
   or in the review back-and-forth. Corey (2026-11-24, verbatim, on PR #1327):
   "they should perform the review with the hope that it will pass and an
   understanding that if it doesn't we'll address it at that time."

   Post the verdict with `submit_pull_request_review`
   (`APPROVED`, `REQUEST_CHANGES` or `COMMENT`);
   if it reports a pending review, post the verdict with `create_comment`
   instead. Use `create_comment` for discussion. Corey (2026-11-24, verbatim,
   in the session behind PR #1322): "I think the (or COMMENT) is a valid case.
   Sometimes to finish a review, you need to understand what the implementer
   was thinking. I think we need to change the COMMENT path such that it is
   clear that the reviewer is awaiting a response so they can continue the
   review." When pausing with `COMMENT`, start the review body with
   `**Status: Awaiting author response to continue review.**` and list the
   specific questions needed to reach `APPROVED` or `REQUEST_CHANGES`. Pause
   only on questions whose answer could change the verdict. If the review also
   finds a definite defect, use `REQUEST_CHANGES` and list the questions in it.
   Authors and other agents treat a `COMMENT` review with that status as an
   active, incomplete review until the author replies (via `create_comment` or
   a new commit). After the author replies, the reviewer re-reads the PR at its
   new head and posts a final `APPROVED` or `REQUEST_CHANGES` verdict; until
   then, the status line stands.

   **Say how you would have built it.** Corey (2026-11-18, verbatim, in the session behind PRs #1182 and
   #1188): "asking reviewers to not only critique the work as is, but consider how they would do it
   differently, to add as suggestion for the original implementer to consider, because it can make
   solutions better at implementation time rather than later." Add design notes, labelled as suggestions
   and kept apart from findings. Choose the verdict by what the notes need:
   `REQUEST_CHANGES` when the author should answer them before merge and you want Forgejo's review state
   to block merge (an approval lets a human merge first, as PR #1182 was approved before its design notes
   were answered, and `COMMENT` does not block merge if another reviewer approves); `COMMENT` with
   `**Status: Awaiting author response to continue review.**` when you only need the author's rationale
   to finish your own review; `APPROVED` when the notes are optional follow-ups.

   **The author answers each design note in the reply.** Either take it into this PR, or defer it with a
   stated reason: it can move results (the frozen fixture, the chain sweep, wire bytes), it needs a
   decision of Corey's, or it is a different review question. A note that preserves behaviour and removes
   transitional state (a "until #N" caveat, an allow-list a later PR must shrink) usually belongs in this
   PR. A self-imposed scope ("move, don't rewrite") is not a reason by itself: PR #1182 first deferred a
   behaviour-preserving note to follow-up #1183 on that ground alone, then took it in after all; only the
   note that could move fixture results stayed deferred.
7. Humans merge; `main` is protected and needs one approval. Do not merge. After
   a merge, start the next task from step 2; the merged branch is left for the
   human to delete.

To stop partway through a task, post a handoff comment on the issue or pull
request as [32](32-delegation.md) describes. The next session reads that checkpoint;
epic-directed sessions reassess its suggested successors against current priorities.

## Reading Forgejo economically

The Forgejo tools return compact text; `get_issue_details` takes `part` and comment
`offset`/`limit`/`since` (use `since` for what is new after a handoff),
`get_pull_request_reviews` takes `review_id` to fetch one review in full, and
`get_pull_request_diff` takes `stat`, `file` and `offset`/`limit`. Tool results stay
in context and are re-read every turn, so:

- Delegate a read expected over about 8K characters, when you need only a summary
  (a long thread, a PR's reviews, a scan across many issues), to a read-only
  subagent ([32](32-delegation.md)). Ask it for quoted text on decisions and to say
  what it skipped.
- A large result comes back as a digest and a path under `.forgejo-cache/`; open
  only the parts you need with `Read` (offset/limit) or `Grep`.
- Keep in your own context the issue you are implementing (a digest can drop
  nuance) and every write.
- Rely on the handoff comment and `/clear` at task boundaries rather than a
  session that grows without end.

## Setting up a worktree

Moved to [34.1](34.1-worktree-setup-and-github.md#setting-up-a-worktree).

## Shared machine resources

Worktrees isolate files, not the machine. Agents run gates at the same time, so
anything a check takes from the machine as a whole must be one it can share.

- **Ports.** Automated checks bind port 0 and use the address actually bound:
  `tests/helpers/listen.js` in the game. Never hardcode a port in a check. Dev servers use the
  worktree's assigned ports above. Ports `47913` (exclusive/writer-intent) and
  `47914–47915` (two shared test slots) are the machine-wide lock; pass `--no-wait`
  to fail fast instead of waiting.
- **Scratch files.** Temporary data goes in a fresh `mkdtemp` directory. Outputs
  go in the worktree (`test-results/`, `replays/`), never at a fixed path outside it.
- **Processes.** Stop only the process IDs you started. Never kill by image name
  (`taskkill /IM node.exe`, `Stop-Process -Name node`): that takes down other
  agents' servers and the MCP servers every agent depends on.
- **CPU.** Tests and benchmarks share the machine-wide shared/exclusive lock (`tests/helpers/machine-lock.js`); see [31.2](31.2-benchmarks-and-timing-tools.md).
- **Git.** Worktrees share one object store, ref namespace and stash stack. Never
  use a bare `git stash`/`git stash pop`; set work aside with a WIP commit on your
  own branch. A transient `cannot lock ref` during a fetch is another agent's
  fetch; retry it.

## Hosting

Forgejo runs on the human's own hardware. Agents reach it through the `forgejo`
remote and the `forgejo` MCP tools, both already configured. This repository
is public, so where Forgejo runs, how it is reached off the home network, how
CI runners are hosted and started, and how credentials are held are recorded in
the private `corey/studio-ops` repository on Forgejo, which is never published.
Read it there when a task touches hosting, runners or access, and put such
details there rather than here.

The rules that bind agents stay here:

- **CI runners are the human's.** Agents do not start, schedule or add them;
  registering one is a human step. While no runner is up, a pull request's
  check (`ci / verify (pull_request)`) waits rather than fails. Requiring it
  before merging is a branch-protection setting the human administers.
- **No standing access to the host.** When a task needs it (upgrades, logs,
  runners), the human grants access for that task and revokes it afterwards.

## GitHub

Moved to [34.1](34.1-worktree-setup-and-github.md#github). Agents never push to `gh`.
