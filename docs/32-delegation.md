# 32. Delegation and model handoffs

The user requests persistent cost-aware delegation. The lead owns the plan,
cross-system reasoning, task boundaries and final verification. Workers own bounded
deliverables. Delegation should reduce total context/rework, not just elapsed time.

## Task selection

### Epic-directed work

When the user asks to advance an epic, select and execute the next useful outcome
within its accepted scope. The user's direction supplies that authorization;
this workflow document does not grant it. The user need not choose a child issue
or repeat that implementation is authorized. Read the epic's current direction,
relevant child status and latest handoffs, then check current code and owning
requirements where needed. A handoff's next-step suggestion is evidence to
evaluate, not a mandate.
If the outcome needs an unanswered product choice or a reviewed contract/fixture
decision, consult the owning [17](17-open-questions.md) record, record an assumption
only where the existing requirements permit it, or escalate the unresolved decision.

Work in tiers of function and detail:

1. Establish missing primary capabilities and their necessary prerequisites.
2. Expand useful composition, coverage and quality across representative real
   workloads after the primary capabilities exist.
3. Refine rare cases, optimize and polish where evidence warrants the cost.

These tiers guide selection, not a compulsory serial waterfall. Fix a correctness,
safety, compatibility or serious performance blocker whenever it prevents the
selected outcome. Otherwise prefer a substantial functional gap over diminishing
returns in an already-working area. Compare candidates across the epic by user
benefit, reach, dependency readiness, effort and risk; explain the choice briefly.
Do not require every child to be exhausted before another workstream can advance.

Before implementation, state the observable outcome, representative acceptance
evidence, explicit non-goals and stopping condition. A task should deliver a
coherent functional improvement; bounded does not mean the smallest possible
change. Investigations need a decision they enable and a stopping point. If that
decision would only enable low-value polish, retain the evidence and return to
epic selection instead of automatically commissioning another investigation.

Complete relevant verification under [31](31-verification.md). Functional tiers
do not relax contracts, hide failed checks or justify unsupported completion
claims. Reaching the agreed outcome ends the task; incidental limitations remain
recorded for later triage unless they invalidate that outcome.

At a task boundary, report the capability delivered, evidence and limitations,
which epic outcomes still lack useful implementation, and why the next candidate
has greater value than further refinement here. Distinguish required blockers
from deferred improvements. Do not mint a child issue for every observation or
require a successor task in every handoff. Close a workstream only when its stated
acceptance is met or its remaining scope has explicitly been deferred; openness
alone does not make it the next priority. Keep epic-specific sequencing in
[41](41-roadmap.md) and its Forgejo tracker, rather than embedding it in this policy.

Reusable epic kickoff (replace `#N` with the epic number):

> Advance epic #N. Read its current direction and relevant child status, choose the highest-value ready functional improvement, and implement it. Work in tiers of function and detail; prioritize missing capabilities over incidental polish. Briefly explain your choice and stopping criteria, run the relevant checks, and open a PR. Treat handoff suggestions as candidates, not mandates.

### Routing by work type

| Work | Preferred owner |
| --- | --- |
| Physics ownership, replay/content compatibility, conflicting requirements, uncertain performance causes | Lead; GPT-6.1 Sol (`gpt-6.1-sol`) preferred for deep reasoning and broad context |
| Creative direction and imagining the end result and physical behavior of systems | Lead; GPT-6 Astra (`gpt-6-astra`) preferred when choosing a GPT lead |
| Algorithmic/spatial logic, non-trivial state machines, complex refactors within defined contracts | GPT-6.1 Sol, medium (`gpt-6.1-sol`) |
| Implement an agreed inventory gesture, extract a specified adapter, add meaningful tests for a defined contract | GPT-6.1 Sol, medium (`gpt-6.1-sol`); GPT-6 Luna, medium (`gpt-6-luna`) when fully specified and mechanical |
| Bounded call-site inventory, mechanical edits, documentation updates with settled facts | GPT-6 Luna, low/medium (`gpt-6-luna`) |
| Testing tools, labs, HUD and other GUI elements through screenshots; reading images, art references and documents | GPT-6.1 Terra (`gpt-6.1-terra`); it reports findings, and fixes route by the rows above. Not for live game playing |
| Integration review and decisions affecting multiple tasks | Lead |

These are routing preferences, not guaranteed price or availability claims. Use
the current tool's actual model identifiers. Avoid copying the whole chat into a
worker; reread the necessary sources and write a small complete brief. A task that
depends on unwritten context is not ready to delegate. Do not create workers just
to demonstrate delegation, run a single short command or wait for another worker.

## Required worker brief

```text
Task and status: <one bounded outcome; ready / in progress / blocked / done>
Model and reasoning: <available model; why it fits>
Starting checkpoint: <commit; relevant dirty files; never assume a clean tree>
Objective: <observable result>
Read: <specific files/sections and established decisions>
Write ownership: <files this worker may edit; other workers' boundaries>
Invariants: <behavior/order/format/API constraints>
Non-goals: <explicit exclusions>
Acceptance: <meaningful tests/commands and expected behavior>
Escalate if: <missing product choice, contract change, invariant failure>
Return: <changed files, actual checks/results, uncertainties and remaining work>
Epic task: <functional outcome, tier, stopping condition; omit for non-epic work>
```

Workers must preserve concurrent edits and should not make commits or launch other
agents unless assigned that responsibility. The lead inspects their changes and
validation, resolves integration, and runs shared checks once the pieces are ready.
Benchmarks must not compete with other CPU-heavy workers. A focused worker failure
is a cue to refine the brief or escalate, not to repeat an ambiguous assignment.

## Manual model switch or fresh conversation

If subagents/model overrides are unavailable, post the next task as a handoff
comment on the Forgejo issue (or its pull request), using the brief above. Include
the branch and worktree, what is complete, current dirty files, unresolved failures
and the precise next action. For epic work, include the selection/stopping
checkpoint above and label proposed successors as candidates for reassessment.
Add a new comment rather than editing earlier ones.
Do not tell a fresh model to infer missing decisions from the old chat.

Tell the user the recommended model and why switching is useful. Name the exact
issue or pull request where the comment was posted in the pickup prompt:

> Read AGENTS.md and the latest handoff comment on issue #N or PR #N. For a specific task, implement its agreed scope. For an epic, reassess current workstreams under docs/32-delegation.md, choose and implement the highest-value ready functional outcome, and stop at its acceptance boundary. Run the relevant checks and post an updated checkpoint there.

For escalation back to the lead (Sol or Astra when choosing a GPT lead, per the
table above), request: "Review the blocked task, resolve the cross-system
decision, and prepare the next bounded implementation task."

No gameplay task is newly authorized by this workflow document. Consult current
user instructions and requirements before selecting the next deliverable.

## Persistence

Instruction loading and machine-specific setup belong to
[34](34-forgejo-workflow.md#instruction-loading). These files cannot grant
missing tool capabilities. This document owns the delegation and handoff policy.

Official references checked September 11, 2026:
- [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Subagents and model selection](https://learn.chatgpt.com/docs/agent-configuration/subagents)
